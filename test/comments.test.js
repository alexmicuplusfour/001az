// Comments on cards (planning/comments-plan.md, Stage 1): the four routes, who
// may do what (only the author edits or deletes, D4), the text rules (D6), the
// card's count and stamp (D7, D8), and what deleting a card or an account does
// to a thread (D3, D5). Elsewhere, beside their kind: outsiders in
// access.test.js's route matrix, the board announcement in events.test.js,
// merges in derived-identity.test.js, the round trip in backup.test.js.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";

let srv, db, base;
let admin, ann, sam, leaver;
let board;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  ann = await seedUser(db, "ann@test.local");
  sam = await seedUser(db, "sam@test.local");
  leaver = await seedUser(db, "leaver@test.local");
  await db.query("UPDATE users SET name = 'Sam Rivera' WHERE id = $1", [sam.id]);
  board = await seedBoard(db, "Comments", [ann.id, sam.id, leaver.id]);
});

after(() => srv.close());

const as = (who, method, path, body) => req(base, method, path, { sid: who.sid, body });
const thread = async (who, card) => (await as(who, "GET", `/api/items/${card.id}/comments`)).json.comments;
const post = (who, card, body) => as(who, "POST", `/api/items/${card.id}/comments`, { body });
const at = (card, id) => `/api/items/${card.id}/comments/${id}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("a member posts, reads, edits and deletes their own", async () => {
  const card = await seedItem(db, board);
  const first = await post(ann, card, "  The pinned summary is the part to copy.  ");
  assert.equal(first.status, 200);
  assert.equal(first.json.comment.body, "The pinned summary is the part to copy.", "trimmed");
  assert.equal(first.json.comment.author, "ann@test.local", "no name: the email, as the hearts list shows it");
  assert.equal(first.json.comment.mine, true);
  assert.equal(first.json.comment.edited_at, null);

  const second = await post(sam, card, "Agreed.\nThe promo field stays closed too.");
  assert.equal(second.json.comment.author, "Sam Rivera");

  assert.deepEqual((await thread(ann, card)).map((c) => [c.body, c.author, c.mine]), [
    ["The pinned summary is the part to copy.", "ann@test.local", true],
    ["Agreed.\nThe promo field stays closed too.", "Sam Rivera", false],
  ], "oldest first, line breaks kept, mine marked for the caller");

  const id = first.json.comment.id;
  const edited = await as(ann, "PATCH", at(card, id), { body: "The pinned summary: copy it." });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.comment.body, "The pinned summary: copy it.");
  assert.equal(typeof edited.json.comment.edited_at, "number");

  assert.equal((await as(ann, "DELETE", at(card, id))).status, 200);
  assert.deepEqual((await thread(sam, card)).map((c) => c.body), ["Agreed.\nThe promo field stays closed too."]);
});

test("only the author edits or deletes: another member and an admin get 403, and nothing changes", async () => {
  const card = await seedItem(db, board);
  const { json } = await post(ann, card, "Ann's note");
  for (const who of [sam, admin]) {
    const edit = await as(who, "PATCH", at(card, json.comment.id), { body: "rewritten" });
    assert.equal(edit.status, 403);
    assert.equal(edit.json.error, "Only its author can change a comment.");
    assert.equal((await as(who, "DELETE", at(card, json.comment.id))).status, 403);
  }
  const [kept] = await thread(ann, card);
  assert.equal(kept.body, "Ann's note");
  assert.equal(kept.edited_at, null);
});

test("an id that isn't on this card, or isn't an id, is 404", async () => {
  const a = await seedItem(db, board);
  const b = await seedItem(db, board);
  const { json } = await post(ann, a, "on a");
  // 1e20 counts as an integer, and overflows the column.
  const ids = [at(b, json.comment.id), at(a, "abc"), at(a, "1.5"), at(a, 99000001), at(a, "1e20"), at(a, "99999999999999999999")];
  for (const url of ids) {
    const edit = await as(ann, "PATCH", url, { body: "moved?" });
    assert.deepEqual([edit.status, edit.json.error], [404, "That comment isn't there any more."], url);
    assert.equal((await as(ann, "DELETE", url)).status, 404, url);
  }
  assert.deepEqual((await thread(ann, a)).map((c) => c.body), ["on a"]);
});

test("empty and over-long text is refused with 400 and stores nothing", async () => {
  const card = await seedItem(db, board);
  for (const body of ["", "  \n ", undefined, 42]) {
    assert.equal((await post(ann, card, body)).status, 400, JSON.stringify(body));
  }
  const long = await post(ann, card, "é".repeat(10001));
  assert.equal(long.status, 400);
  assert.equal(long.json.error, "A comment can be at most 10,000 characters.");
  assert.equal((await thread(ann, card)).length, 0, "nothing stored");

  // 10,000 characters is 20,000 UTF-16 units here: the cap counts what a
  // person counts.
  const most = await post(ann, card, "😀".repeat(10000));
  assert.equal(most.status, 200);
  const blank = await as(ann, "PATCH", at(card, most.json.comment.id), { body: " " });
  assert.equal(blank.status, 400);
  assert.equal((await thread(ann, card))[0].body, "😀".repeat(10000), "a blank edit changes nothing");
});

test("saving the same text leaves edited_at empty", async () => {
  const card = await seedItem(db, board);
  const { json } = await post(ann, card, "Same words");
  const r = await as(ann, "PATCH", at(card, json.comment.id), { body: "  Same words " });
  assert.equal(r.status, 200);
  assert.equal(r.json.comment.edited_at, null);
});

test("the card carries its count, and a delta returns it after a post, an edit and a delete", async () => {
  const card = await seedItem(db, board);
  const full = await as(sam, "GET", `/api/items?board=${board}`);
  assert.equal(full.json.find((i) => i.id === card.id).comments, 0);

  const since = async () => {
    await sleep(5);
    const t = Date.now();
    await sleep(5);
    return t;
  };
  const cardSince = async (t) =>
    (await as(sam, "GET", `/api/items?board=${board}&since=${t}`)).json.items.find((i) => i.id === card.id);

  let t = await since();
  assert.equal(await cardSince(t), undefined, "setup: nothing has touched the card since");
  const { json } = await post(ann, card, "one");
  assert.equal((await cardSince(t))?.comments, 1, "after a post");

  t = await since();
  await as(ann, "PATCH", at(card, json.comment.id), { body: "one, edited" });
  assert.equal((await cardSince(t))?.comments, 1, "after an edit");

  t = await since();
  await as(ann, "DELETE", at(card, json.comment.id));
  assert.equal((await cardSince(t))?.comments, 0, "after a delete");
});

test("deleting the card deletes its thread", async () => {
  const card = await seedItem(db, board);
  await post(ann, card, "goes with the card");
  assert.equal((await as(sam, "DELETE", `/api/items/${card.id}`)).status, 200, "any member can delete a card (D4)");
  const { rows } = await db.query("SELECT COUNT(*)::int AS n FROM comments WHERE entity_id = $1", [card.id]);
  assert.equal(rows[0].n, 0);
});

test("deleting an account keeps its comments, signed by nobody, and nobody can change them", async () => {
  const card = await seedItem(db, board);
  const { json } = await post(leaver, card, "Shipping gets its own step.");
  assert.equal((await as(admin, "DELETE", `/api/admin/users/${leaver.id}`)).status, 200);

  const [kept] = await thread(ann, card);
  assert.equal(kept.body, "Shipping gets its own step.");
  assert.equal(kept.author, null, "the page signs it Former member");
  assert.equal(kept.mine, false);
  for (const who of [ann, admin]) {
    assert.equal((await as(who, "PATCH", at(card, json.comment.id), { body: "x" })).status, 403);
    assert.equal((await as(who, "DELETE", at(card, json.comment.id))).status, 403);
  }
});

test("a post onto a card that went after the access check is 404, not a server error", async () => {
  const card = await seedItem(db, board);
  // The card goes between the guard and the insert, as when someone deletes it
  // or a move empties it mid-post: a test-only trigger deletes it as the
  // comment is written, so the insert's foreign key finds it gone.
  await db.query(`CREATE FUNCTION vanish_card() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN DELETE FROM entities WHERE id = NEW.entity_id; RETURN NEW; END $$`);
  await db.query("CREATE TRIGGER vanish BEFORE INSERT ON comments FOR EACH ROW EXECUTE FUNCTION vanish_card()");
  try {
    const r = await post(ann, card, "too late");
    assert.equal(r.status, 404);
    assert.equal(r.json.error, "That card isn't on this board any more.");
  } finally {
    await db.query("DROP TRIGGER vanish ON comments");
    await db.query("DROP FUNCTION vanish_card()");
  }
});
