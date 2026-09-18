// The board event channel (planning/board-events-stage-1.md §3): who may open a
// stream, who receives what, and that a connection is let go of when it closes.
//
// Node has no global EventSource (checked, 22.16), so these read the raw stream.
// That is a feature here: the frames are the contract a browser will parse, and
// asserting on them is asserting on the wire rather than on a client library's
// interpretation of it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, req, until } from "./helpers.js";
import { createBoard, createEntity, insertItem, setUserBoards } from "../server/db.js";
import { openStreamCount } from "../server/events.js";

let srv, base, admin, boardA, boardB;

before(async () => {
  srv = await startServer();
  ({ base } = srv);
  admin = await adminSession(srv.db);
  boardA = await createBoard(srv.db, "Board A", [], "");
  boardB = await createBoard(srv.db, "Board B", [], "");
});
after(() => srv.close());

// helpers.js's req() — cookie, content-type and JSON parsing in one place. A
// function rather than a bound constant: `admin` is assigned in before(), so
// anything reading admin.sid at module scope reads undefined.
//
// NOT used for the streams below: req() buffers the whole body, so against a
// response that never ends it would simply never return.
const asAdmin = (method, path, body) => req(base, method, path, { sid: admin.sid, body });

// Open a stream and hand back a reader plus the abort that closes it. Every test
// aborts in a finally — a leaked stream holds a client in the server's Set and
// the count assertion at the end of the file is what notices.
async function open(board, { sid = admin.sid } = {}) {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events${board ? `?board=${board}` : ""}`, {
    headers: { Cookie: `sid=${sid}`, Accept: "text/event-stream", "Accept-Encoding": "gzip" },
    signal: ac.signal,
  });
  return { res, ac, reader: res.body?.getReader() };
}

// Collect frames for a fixed window. Not "until one arrives": several cases below
// assert that NOTHING arrives, and those need the window to elapse.
//
// ONE call per reader. Losing a Promise.race abandons a read() that is still
// outstanding, and that read swallows the next chunk — the trap that made the
// first draft of test/sse.test.js fail looking exactly like the bug it tested.
async function collect(reader, ms) {
  const started = Date.now();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const left = ms - (Date.now() - started);
    if (left <= 0) break;
    const next = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r("done"), left)),
    ]);
    if (next === "done" || next.done) break;
    buf += dec.decode(next.value, { stream: true });
  }
  // `: open` and `: ping` are comments, not events — filtered out, so a test
  // asserting silence is not fooled by the handshake.
  return buf
    .split("\n\n")
    .filter((f) => f.startsWith("event:"))
    .map((f) => {
      const type = /^event: (.+)$/m.exec(f)?.[1];
      const data = /^data: (.*)$/m.exec(f)?.[1];
      return { type, data: data ? JSON.parse(data) : null };
    });
}

test("a stream opens, and says so before it has anything to say", async () => {
  const { res, ac, reader } = await open(boardA);
  try {
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    // The header that keeps compression() off it. Without this every stream in
    // the app is silently buffered — measured, and pinned in test/sse.test.js.
    assert.match(res.headers.get("cache-control") || "", /no-transform/);
    // A page cannot tell "connected and quiet" from "never connected" unless the
    // headers are flushed up front, and a stream may be quiet for hours.
    const first = await Promise.race([
      reader.read(),
      new Promise((r) => setTimeout(() => r(null), 1000)),
    ]);
    assert.ok(first && !first.done, "the stream sent nothing on connect");
  } finally {
    ac.abort();
  }
});





test("a board you cannot reach is refused at connect", async () => {
  const outsider = await seedUser(srv.db, "outsider@test.dev");
  const { res, ac } = await open(boardA, { sid: outsider.sid });
  ac.abort();
  // 404 and not 403: a 403 would confirm to someone who cannot see a board that
  // it exists — the same answer the board route gives, for the same reason.
  assert.equal(res.status, 404);
});

test("anonymous is refused", async () => {
  const ac = new AbortController();
  const res = await fetch(`${base}/api/events?board=${boardA}`, {
    headers: { Accept: "text/event-stream" },
    signal: ac.signal,
  });
  ac.abort();
  assert.equal(res.status, 401);
});

test("closing a stream lets go of it", async () => {
  // Without this the Set grows for the life of the process, and every emit walks
  // a list of dead responses. The count is read from the module rather than
  // inferred, because a leak is invisible from the outside until it is a problem.
  const before = openStreamCount();
  const { ac, reader } = await open(boardA);
  await collect(reader, 150); // let the server finish registering it
  assert.equal(openStreamCount(), before + 1);
  ac.abort();
  // The close lands on the server's next tick, not synchronously with abort().
  await until(() => openStreamCount() === before);
});

// --- the emit hook (planning/board-events-stage-1.md §2) ---------------------
//
// These are the cases that matter most, because the hook's whole claim is that
// it fires for the twelve item-mutating routes WITHOUT any of them mentioning
// it. A route-by-route list would pass while proving only that the list is the
// list; what has to hold is that going through the access guards is enough.

test("a heart by one person reaches another person's stream", async () => {
  // The defect this whole arc exists for, at its smallest: two people on one
  // board, one of them acts, and today the other's screen is silently wrong.
  const eid = await createEntity(srv.db, boardA, { identity: "hearted" });
  await insertItem(srv.db, boardA, { identity: "hearted", files: [], fields: {} }, "tagged", eid);

  const watcher = await open(boardA);
  try {
    const r = await asAdmin("POST", `/api/items/${eid}/favorite`);
    assert.equal(r.status, 200);
    const frames = await collect(watcher.reader, 500);
    assert.deepEqual(frames.map((f) => f.type), ["items"]);
  } finally {
    watcher.ac.abort();
  }
});

test("a GET says nothing, and neither does a refusal", async () => {
  // Both halves of the hook's guard. Without the GET check every read on the
  // board would tell every watcher to re-read it — a feedback loop that would
  // look like the feature working. Without the status check, a 404 would
  // announce a change that did not happen.
  const eid = await createEntity(srv.db, boardA, { identity: "quiet" });
  await insertItem(srv.db, boardA, { identity: "quiet", files: [], fields: {} }, "tagged", eid);

  const watcher = await open(boardA);
  try {
    await asAdmin("GET", `/api/items/${eid}/hearts`);
    // An entity that does not exist: passes requireAuth, fails the access guard.
    const missing = await asAdmin("POST", "/api/items/99000001/favorite");
    assert.equal(missing.status, 404);
    assert.deepEqual(await collect(watcher.reader, 400), []);
  } finally {
    watcher.ac.abort();
  }
});

test("a change on one board does not wake a watcher of another", async () => {
  // The isolation claim again, but through the real path rather than a direct
  // emitBoard() call — the hook has to pass the right board, not just a board.
  const eid = await createEntity(srv.db, boardB, { identity: "elsewhere" });
  await insertItem(srv.db, boardB, { identity: "elsewhere", files: [], fields: {} }, "tagged", eid);

  const watcher = await open(boardA);
  try {
    await asAdmin("POST", `/api/items/${eid}/favorite`);
    assert.deepEqual(await collect(watcher.reader, 400), []);
  } finally {
    watcher.ac.abort();
  }
});

// --- the other three slices (planning/board-events-stage-1.md §5) ------------
//
// They are not three copies of one rule: each has its own visibility, so each
// has its own audience. Crates are the board's (a public crate is everyone's);
// filter configs are strictly one person's; the boards list is one person's and
// moves when an admin changes their access.

test("creating a crate tells the board, and only about crates", async () => {
  // A brand new crate holds no cards, so `items` must NOT fire — the button
  // appearing is the whole change.
  const { ac, reader } = await open(boardA);
  try {
    const r = await asAdmin("POST", "/api/crates", { name: "Live crate", board_id: boardA });
    assert.equal(r.status, 200);
    assert.deepEqual((await collect(reader, 500)).map((f) => f.type), ["crates"]);
  } finally {
    ac.abort();
  }
});

test("putting a card in a crate moves BOTH the list and the cards", async () => {
  // The trap this arc nearly shipped. Membership rides item.crateIds on the
  // ITEMS payload, and this route resolves its own board instead of going
  // through requireEntityAccess — so without req.touchedBoard the cards in
  // another tab would keep believing they are not in the crate, and the button
  // would filter the grid to nothing.
  const { json: { crate: made } } = await asAdmin("POST", "/api/crates", { name: "Holds one", board_id: boardA });
  const eid = await createEntity(srv.db, boardA, { identity: "to-crate" });
  await insertItem(srv.db, boardA, { identity: "to-crate", files: [], fields: {} }, "tagged", eid);

  const { ac, reader } = await open(boardA);
  try {
    const r = await asAdmin("POST", `/api/crates/${made.id}/items/${eid}`);
    assert.equal(r.status, 200);
    assert.deepEqual((await collect(reader, 500)).map((f) => f.type).sort(), ["crates", "items"]);
  } finally {
    ac.abort();
  }
});

test("deleting a crate moves both too, because crate_items cascades", async () => {
  // Easy to miss: the crate list obviously changed, but so did every card that
  // was in it — each quietly lost a crateId.
  const { json: { crate: made } } = await asAdmin("POST", "/api/crates", { name: "Doomed", board_id: boardA });
  const { ac, reader } = await open(boardA);
  try {
    const r = await asAdmin("DELETE", `/api/crates/${made.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual((await collect(reader, 500)).map((f) => f.type).sort(), ["crates", "items"]);
  } finally {
    ac.abort();
  }
});

test("saved filters go to the person, not the board", async () => {
  // listFilterConfigs is WHERE user_id = $1, so nobody else's list can have
  // moved. A board-scoped emit would have everyone on the board refetch
  // something only one of them could have changed — and this proves the address
  // is the user by watching a stream on a DIFFERENT board get it anyway.
  const elsewhere = await open(boardB);
  try {
    const r = await asAdmin("POST", "/api/filter-configs", { name: "Mine", board_id: boardA, config: { kind: ["a"] } });
    assert.equal(r.status, 200);
    assert.deepEqual((await collect(elsewhere.reader, 500)).map((f) => f.type), ["filterConfigs"]);
  } finally {
    elsewhere.ac.abort();
  }
});

test("granting someone a board tells THEM, not the admin who did it", async () => {
  const other = await seedUser(srv.db, "granted@test.dev");
  // The grantee is watching boardB, which they can reach as… nothing yet. Give
  // them access first so the stream can open, then change it and watch.
  await asAdmin("PATCH", `/api/admin/users/${other.id}/boards`, { boardIds: [boardB], adminBoardIds: [] });

  const theirs = await open(boardB, { sid: other.sid });
  const mine = await open(boardA);
  try {
    const r = await asAdmin("PATCH", `/api/admin/users/${other.id}/boards`, { boardIds: [boardA, boardB], adminBoardIds: [] });
    assert.equal(r.status, 200);
    assert.deepEqual((await collect(theirs.reader, 500)).map((f) => f.type), ["boards"]);
    // The admin's own tab hears nothing: their list did not change.
    assert.deepEqual(await collect(mine.reader, 400), []);
  } finally {
    theirs.ac.abort();
    mine.ac.abort();
  }
});

test("an admin cannot open a stream against a board that does not exist", async () => {
  // canAccessBoard short-circuits TRUE for a global admin without looking the
  // board up, so `canAccessBoard` alone let an admin open a stream against any
  // string at all — a connection nothing could ever emit to, held open for as
  // long as they liked. Every sibling route pairs boardExists with it
  // (/api/crates, /api/filter-configs); this one had not.
  // Settle first: earlier tests' aborts land on the server a tick later, so a
  // raw snapshot here is a number still on its way down and any comparison
  // against it measures that instead of this.
  await until(() => openStreamCount() === 0); // every test above aborts in a finally
  const before = 0;
  const { res, ac } = await open("no-such-board-id");
  ac.abort();
  assert.equal(res.status, 404);
  assert.equal(openStreamCount(), before, "a refused connect must not be registered");
});

// Reported from two real windows: A adds cards to a new crate, then makes it
// public; the crate appears in B's toolbar live, but clicking it says "No items
// match these filters."
//
// Because `crateIds` on a card is FILTERED BY CRATE VISIBILITY (db.js listItems:
// `WHERE c.board_id = $2 AND (c.user_id = $1 OR c.public = TRUE)`), the flip
// changes what every card in that crate reports — to everyone else. Two things
// were missing, and either alone leaves the bug:
//
//   1. the route announced `crates` only, so nobody refetched items
//   2. and it would not have helped: the flip stamps no entity, so the delta —
//      which selects on entities.updated_at / items.updated_at — carries nothing
//
// Every other crate write stamps (addCrateItems, both halves of toggleCrateItem,
// and db.js says why in as many words). setCratePublic was the one that did not.
test("making a crate public reaches the other members' CARDS, not just their list", async () => {
  const other = await seedUser(srv.db, "sees-public@test.dev");
  await setUserBoards(srv.db, other.id, [boardA], []);
  const asOther = (method, path, body) => req(base, method, path, { sid: other.sid, body });

  const eid = await createEntity(srv.db, boardA, { identity: "goes-public" });
  await insertItem(srv.db, boardA, { identity: "goes-public", files: [], fields: {} }, "tagged", eid);

  const { json: { crate } } = await asAdmin("POST", "/api/crates", { name: "Going public", board_id: boardA });
  await asAdmin("POST", `/api/crates/${crate.id}/items/${eid}`);

  // A private crate is invisible to them, cards included. That is correct, and
  // it is the state the flip has to move them out of.
  const mine = (r) => (Array.isArray(r.json) ? r.json : r.json.items).find((i) => i.id === eid);
  assert.deepEqual(mine(await asOther("GET", `/api/items?board=${boardA}&limit=200`)).crateIds, []);

  // A cursor of NOW, rather than the `now` a fetch returns: that one is
  // deliberately 2s behind (server.js, the delta's safety margin), so a test
  // using it would be reading changes from before the flip and pass regardless.
  const cursor = Date.now();
  const watcher = await open(boardA, { sid: other.sid });
  try {
    const r = await asAdmin("PATCH", `/api/crates/${crate.id}`, { public: true });
    assert.equal(r.status, 200);

    // The list AND the cards — the flip moves both.
    assert.deepEqual((await collect(watcher.reader, 500)).map((f) => f.type).sort(), ["crates", "items"]);

    // …and the delta can actually carry it, which is the half an event alone
    // could not fix.
    const delta = await asOther("GET", `/api/items?board=${boardA}&since=${cursor}`);
    assert.ok(mine(delta), "the flip changed no row the delta selects on, so the cards never learn");
    assert.deepEqual(mine(delta).crateIds, [crate.id]);
  } finally {
    watcher.ac.abort();
  }
});
