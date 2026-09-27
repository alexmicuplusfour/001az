// The add-only crate route (planning/alert-crating-plan.md, Stage 2):
// POST /api/crates/:id/items {ids}. The gallery's other crate route toggles,
// which is a checkbox's job; this one only puts cards in, so a repeat, or a
// card already there, changes nothing. The bulk bar and the card menu's "New
// crate…" use it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedUser, seedBoard, seedItem, req } from "./helpers.js";
import { setBoardMembers, crateItemIds, addCrateItems } from "../server/db.js";

let srv, db, base, member, other;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  member = await seedUser(db, "adder@test.local");
  other = await seedUser(db, "other-adder@test.local");
});
after(() => srv.close());

const as = (user, method, path, body) => req(base, method, path, { sid: user.sid, body });
const makeCrate = async (user, boardId, name) =>
  (await as(user, "POST", "/api/crates", { name, board_id: boardId })).json.crate.id;
const inCrate = async (crateId) => [...(await crateItemIds(db, crateId))].sort((a, b) => a - b);
const add = (user, crateId, ids) => as(user, "POST", `/api/crates/${crateId}/items`, { ids });

test("adds the cards, and a repeat adds nothing and takes nothing out", async () => {
  const board = await seedBoard(db, "adds", [member.id]);
  const crate = await makeCrate(member, board, "adds");
  const a = await seedItem(db, board);
  const b = await seedItem(db, board);

  const first = await add(member, crate, [a.id, b.id]);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, { added: 2, already: 0, count: 2 });
  const again = await add(member, crate, [a.id, b.id]);
  assert.equal(again.status, 200);
  assert.deepEqual(again.json, { added: 0, already: 2, count: 2 });
  assert.deepEqual(await inCrate(crate), [a.id, b.id]);
});

test("another person's crate is not found, and nothing goes in", async () => {
  const board = await seedBoard(db, "theirs", [member.id, other.id]);
  const crate = await makeCrate(other, board, "theirs");
  const a = await seedItem(db, board);

  const r = await add(member, crate, [a.id]);
  assert.equal(r.status, 404);
  assert.deepEqual(await inCrate(crate), []);
});

test("nor can the checkbox route take a card out of another person's crate", async () => {
  // That route asks about the card's board only; the crate is the writer's
  // own check, the one getCrateBoard answers for both writers.
  const board = await seedBoard(db, "theirs, ticked", [member.id, other.id]);
  const crate = await makeCrate(other, board, "theirs, ticked");
  const a = await seedItem(db, board);
  await add(other, crate, [a.id]);

  const r = await as(member, "POST", `/api/crates/${crate}/items/${a.id}`);
  assert.equal(r.status, 404);
  assert.deepEqual(await inCrate(crate), [a.id], "still in");
});

test("addCrateItems answers null for another person's crate, whoever calls it", async () => {
  // Every caller checks the crate first; this is the writer's own check behind them.
  const board = await seedBoard(db, "theirs, direct", [member.id, other.id]);
  const crate = await makeCrate(other, board, "theirs, direct");
  const a = await seedItem(db, board);

  assert.equal(await addCrateItems(db, member.id, crate, [a.id]), null);
  assert.deepEqual(await inCrate(crate), []);
});

test("a card from another board is skipped, and the rest go in", async () => {
  const board = await seedBoard(db, "home", [member.id]);
  const away = await seedBoard(db, "away", [member.id]);
  const crate = await makeCrate(member, board, "home");
  const here = await seedItem(db, board);
  const there = await seedItem(db, away);

  const r = await add(member, crate, [here.id, there.id]);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { added: 1, already: 0, count: 1 });
  assert.deepEqual(await inCrate(crate), [here.id]);
});

test("someone who has lost access to the board can't add to their crate there", async () => {
  // Their crate stays when they're taken off the board; the route has to ask
  // about the board, the way the checkbox route does.
  const board = await seedBoard(db, "left", [member.id]);
  const crate = await makeCrate(member, board, "left behind");
  const a = await seedItem(db, board);
  await setBoardMembers(db, board, []);

  const r = await add(member, crate, [a.id]);
  assert.equal(r.status, 404);
  assert.deepEqual(await inCrate(crate), []);
});

test("bad ids are refused, and a crate id that isn't one is not found", async () => {
  const board = await seedBoard(db, "bad", [member.id]);
  const crate = await makeCrate(member, board, "bad");
  const a = await seedItem(db, board);

  for (const ids of [undefined, [], "1", [String(a.id)], [1.5], [-1], [0], [2 ** 53]]) {
    const r = await add(member, crate, ids);
    assert.equal(r.status, 400, JSON.stringify(ids));
  }
  for (const id of ["abc", "1e20", "0"]) {
    const r = await add(member, id, [a.id]);
    assert.equal(r.status, 404, id);
  }
  assert.deepEqual(await inCrate(crate), []);
});
