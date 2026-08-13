// Board access seen and edited from the members side. The Boards tab's picker
// writes board_members one board at a time (board-manage.test.js); this is the
// same table pivoted — one member, every board — so the tests that matter are
// the ones about the two not treading on each other, and about global admins,
// whose access doesn't live in that table at all.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { setBoardMembers } from "../server/db.js";

let srv, db, base;
let admin, member, other;
let boardA, boardB;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  other = await seedUser(db, "other@test.local");
  // Seeded through setBoardMembers rather than seedBoard's member list, which
  // can't express the board-admin role this file is about.
  boardA = await seedBoard(db, "A");
  boardB = await seedBoard(db, "B");
  await setBoardMembers(db, boardA, [member.id, other.id], [member.id]);
});

after(() => srv.close());

const listUsers = async () => (await req(base, "GET", "/api/admin/users", { sid: admin.sid })).json;
const findUser = async (id) => (await listUsers()).find((u) => u.id === id);
const patch = (id, body, sid = admin.sid) =>
  req(base, "PATCH", `/api/admin/users/${id}/boards`, { sid, body });
// The expected `boards` payload for someone who is on board A and nothing else.
const onA = (role = "member") => [{ id: boardA, name: "A", role }];

test("the member list carries each member's boards, with roles", async () => {
  assert.deepEqual((await findUser(member.id)).boards, onA("admin"));
  assert.deepEqual((await findUser(other.id)).boards, onA());
});

// The column this replaced. Nothing reads it any more, and the correlated
// COUNT(*) over favorites went with it.
test("the member list no longer counts hearts", async () => {
  const u = await findUser(member.id);
  assert.equal("hearts_given" in u, false);
});

// canAccessBoard grants a global admin every board from is_admin alone, without
// a board_members row — so an empty list here is the truth, and the client says
// "all" off is_admin rather than counting to zero.
test("a global admin's board list is empty, and can't be written", async () => {
  const a = await findUser(admin.id);
  assert.equal(a.is_admin, true);
  assert.deepEqual(a.boards, []);

  const r = await patch(admin.id, { boardIds: [boardA] });
  assert.equal(r.status, 409);
  assert.match(r.json.error, /every board/);
  assert.deepEqual((await findUser(admin.id)).boards, []);
});

// seedAdmin promotes on an ADMIN_EMAIL conflict (ON CONFLICT DO UPDATE SET
// is_admin = TRUE), so a plain member with board_members rows can become a
// global admin and keep them. The rows are dead weight from that moment on —
// canAccessBoard never reads them — which is why the members table keys its
// cell on is_admin rather than on the length of this list.
test("a promoted member keeps stale rows, and is_admin still outranks them", async () => {
  const promoted = await seedUser(db, "promoted@test.local");
  await patch(promoted.id, { boardIds: [boardA] });
  await db.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [promoted.id]);

  const u = await findUser(promoted.id);
  assert.equal(u.is_admin, true);
  assert.deepEqual(u.boards, onA()); // stale, not cleared
  // The row grants nothing they didn't already have: B has no row at all.
  assert.equal((await req(base, "GET", `/api/boards/${boardB}`, { sid: promoted.sid })).status, 200);
  assert.equal((await patch(promoted.id, { boardIds: [] })).status, 409);
});

test("granting access takes effect on the board itself", async () => {
  const before = await req(base, "GET", `/api/boards/${boardB}`, { sid: member.sid });
  assert.equal(before.status, 404);

  const r = await patch(member.id, { boardIds: [boardA, boardB], adminBoardIds: [boardA] });
  assert.equal(r.status, 200);

  const after = await req(base, "GET", `/api/boards/${boardB}`, { sid: member.sid });
  assert.equal(after.status, 200);
  assert.equal(after.json.manage, false); // a plain member on B
  assert.deepEqual(
    (await findUser(member.id)).boards.map((b) => `${b.id}:${b.role}`),
    [`${boardA}:admin`, `${boardB}:member`]
  );
});

test("board-admin here is the same grant the Boards tab makes", async () => {
  await patch(member.id, { boardIds: [boardB], adminBoardIds: [boardB] });
  const settings = await req(base, "GET", `/api/boards/${boardB}/settings`, { sid: member.sid });
  assert.equal(settings.status, 200);
  const rename = await req(base, "PATCH", `/api/boards/${boardB}`, { sid: member.sid, body: { name: "B" } });
  assert.equal(rename.status, 200);
});

test("revoking drops the row — and only this member's", async () => {
  await patch(member.id, { boardIds: [] });
  assert.deepEqual((await findUser(member.id)).boards, []);
  assert.equal((await req(base, "GET", `/api/boards/${boardA}`, { sid: member.sid })).status, 404);
  // The other member of A was not in the payload at all, and keeps their seat.
  assert.deepEqual((await findUser(other.id)).boards, onA());
  assert.equal((await req(base, "GET", `/api/boards/${boardA}`, { sid: other.sid })).status, 200);

  // An absent boardIds key means the same thing as an empty one, rather than
  // throwing on the way in.
  assert.equal((await patch(member.id, {})).status, 200);
  assert.deepEqual((await findUser(member.id)).boards, []);
});

// Board ids are TEXT and come from the client, so a stale one has to be dropped
// rather than handed to the foreign key — which would answer with a 500.
test("unknown board ids are dropped, not a 500", async () => {
  const r = await patch(member.id, { boardIds: [boardA, "no-such-board"] });
  assert.equal(r.status, 200);
  assert.deepEqual((await findUser(member.id)).boards, onA());
});

test("a board-admin grant without membership is dropped, not stored", async () => {
  const r = await patch(member.id, { boardIds: [boardA], adminBoardIds: [boardA, boardB] });
  assert.equal(r.status, 200);
  assert.deepEqual((await findUser(member.id)).boards, onA("admin"));
  // No manage right left behind on a board they can't even see.
  assert.equal((await req(base, "GET", `/api/boards/${boardB}/settings`, { sid: member.sid })).status, 403);
});

// requireAdmin answers both the logged-in non-admin and the anonymous caller
// with 403 — a member can't tell an admin route from a missing one either way.
test("only global admins may write it", async () => {
  assert.equal((await patch(other.id, { boardIds: [boardB] }, member.sid)).status, 403);
  assert.equal((await req(base, "PATCH", `/api/admin/users/${other.id}/boards`, { body: { boardIds: [] } })).status, 403);
  assert.deepEqual((await findUser(other.id)).boards, onA());
});

test("an unknown or non-integer member id is a 404, not a 500", async () => {
  assert.equal((await patch(99999, { boardIds: [] })).status, 404);
  assert.equal((await patch("abc", { boardIds: [] })).status, 404);
});
