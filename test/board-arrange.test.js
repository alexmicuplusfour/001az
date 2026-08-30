// Per-reader board arrangement (planning/board-arrangement-plan.md): the order
// lives on the READER, is written through PATCH /api/account, and is applied by
// the server to every listing a reader sees — so the boards index and the
// gallery's board switcher agree without either one sorting.
//
// What's pinned here is the part that has to survive the world moving under it:
// a board created after the last drag, a board deleted out of a stored order, a
// second reader who never arranged anything, and the admin ledger, which stays
// in created_at order on purpose.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";

let srv, db, base;
let admin, member;
let a, b, c;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "arranger@test.local");
  // Created in this order, so created_at ASC — the unarranged answer — is A B C.
  a = await seedBoard(db, "A", [member.id]);
  b = await seedBoard(db, "B", [member.id]);
  c = await seedBoard(db, "C", [member.id]);
});

after(() => srv.close());

const names = async (sid) => (await req(base, "GET", "/api/boards", { sid })).json.map((x) => x.name);
const setOrder = (sid, order) => req(base, "PATCH", "/api/account", { sid, body: { board_order: order } });

test("with no arrangement, boards come back in created_at order", async () => {
  assert.deepEqual(await names(member.sid), ["A", "B", "C"]);
});

test("a saved order is applied to the switcher and the index alike", async () => {
  const saved = await setOrder(member.sid, [c, a, b]);
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.json.board_order, [c, a, b]);
  assert.deepEqual(await names(member.sid), ["C", "A", "B"]);
  // The index is the other half of the promise: one arrangement, both surfaces,
  // neither client sorting.
  const overview = await req(base, "GET", "/api/boards/overview", { sid: member.sid });
  assert.deepEqual(overview.json.map((x) => x.name), ["C", "A", "B"]);
});

test("it is the reader's, not the board's — nobody else moved", async () => {
  assert.deepEqual(await names(admin.sid), ["A", "B", "C"]);
});

test("a board the arrangement doesn't name falls to the end, in created_at order", async () => {
  const d = await seedBoard(db, "D", [member.id]);
  const e = await seedBoard(db, "E", [member.id]);
  // Still ranked C A B; D and E have no rank and arrive after, oldest first.
  assert.deepEqual(await names(member.sid), ["C", "A", "B", "D", "E"]);
  await req(base, "DELETE", `/api/admin/boards/${d}`, { sid: admin.sid });
  await req(base, "DELETE", `/api/admin/boards/${e}`, { sid: admin.sid });
});

test("an id for a board that is gone ranks nothing and needs no cleanup", async () => {
  const gone = await seedBoard(db, "Gone", [member.id]);
  await setOrder(member.sid, [gone, c, a, b]);
  await req(base, "DELETE", `/api/admin/boards/${gone}`, { sid: admin.sid });
  assert.deepEqual(await names(member.sid), ["C", "A", "B"]);
  // …and the stale id is still stored, inert, until the next drag rewrites it.
  const { rows } = await db.query("SELECT board_order FROM users WHERE id=$1", [member.id]);
  assert.equal(rows[0].board_order.length, 4);
});

test("an empty order forgets the arrangement", async () => {
  await setOrder(member.sid, []);
  assert.deepEqual(await names(member.sid), ["A", "B", "C"]);
  await setOrder(member.sid, [c, a, b]); // put it back for the tests below
});

test("the admin board ledger keeps created_at order whatever the admin arranged", async () => {
  await setOrder(admin.sid, [c, b, a]);
  assert.deepEqual(await names(admin.sid), ["C", "B", "A"]);
  const ledger = await req(base, "GET", "/api/admin/boards", { sid: admin.sid });
  assert.deepEqual(ledger.json.map((x) => x.name), ["A", "B", "C"]);
});

test("duplicates collapse rather than fighting over one position", async () => {
  const r = await setOrder(member.sid, [b, a, b, c, a]);
  assert.deepEqual(r.json.board_order, [b, a, c]);
  assert.deepEqual(await names(member.sid), ["B", "A", "C"]);
  await setOrder(member.sid, [c, a, b]);
});

test("the column can't be used as storage", async () => {
  for (const bad of [
    "c,a,b",                                  // not a list
    [1, 2, 3],                                // not ids
    [""],                                     // not an id either
    ["x".repeat(65)],                         // longer than any id gets
    Array.from({ length: 501 }, (_, i) => `b${i}`), // more than anyone has boards
  ]) {
    assert.equal((await setOrder(member.sid, bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  // …and none of it landed.
  assert.deepEqual(await names(member.sid), ["C", "A", "B"]);
});

test("name and order are independent halves of the same route", async () => {
  // The profile page sends a name alone and must not disturb the arrangement.
  const named = await req(base, "PATCH", "/api/account", { sid: member.sid, body: { name: "Arranger" } });
  assert.equal(named.json.name, "Arranger");
  assert.equal(named.json.board_order, undefined);
  assert.deepEqual(await names(member.sid), ["C", "A", "B"]);
  // …and an order alone must not clear the name.
  await setOrder(member.sid, [a, b, c]);
  assert.equal((await req(base, "GET", "/api/me", { sid: member.sid })).json.name, "Arranger");
  // An empty patch is a caller bug, not a no-op to accept.
  assert.equal((await req(base, "PATCH", "/api/account", { sid: member.sid, body: {} })).status, 400);
});

test("signing out of the question entirely: unauthenticated can't arrange", async () => {
  assert.equal((await req(base, "PATCH", "/api/account", { body: { board_order: [a] } })).status, 401);
});
