// Per-board admin authorization. A board member promoted to role='admin' may
// edit that board's content from the gallery (GET /:id/settings, PATCH /:id) —
// but only content: the AI key and the admin routes stay global-admin-only.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { setBoardMembers, createAiKey, createBoard, getBoard, NEW_BOARD_DEFAULTS } from "../server/db.js";

let srv, db, base;
let admin, boardAdmin, member, outsider;
let board;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
  boardAdmin = await seedUser(db, "boardadmin@test.local");
  member = await seedUser(db, "member@test.local");
  outsider = await seedUser(db, "outsider@test.local");
  board = await seedBoard(db, "Manage", [member.id, boardAdmin.id]);
  // boardAdmin gets the per-board admin role; member stays a plain member.
  await setBoardMembers(db, board, [member.id, boardAdmin.id], [boardAdmin.id]);
});

after(() => srv.close());

test("GET /api/boards/:id reports manage per role", async () => {
  const asAdmin = await req(base, "GET", `/api/boards/${board}`, { sid: admin.sid });
  assert.equal(asAdmin.json.manage, true);
  const asBoardAdmin = await req(base, "GET", `/api/boards/${board}`, { sid: boardAdmin.sid });
  assert.equal(asBoardAdmin.json.manage, true);
  const asMember = await req(base, "GET", `/api/boards/${board}`, { sid: member.sid });
  assert.equal(asMember.json.manage, false);
});

test("GET /:id/settings — admin & board-admin ok, member forbidden, anon unauthorized", async () => {
  const url = `/api/boards/${board}/settings`;
  assert.equal((await req(base, "GET", url, { sid: admin.sid })).status, 200);
  assert.equal((await req(base, "GET", url, { sid: boardAdmin.sid })).status, 200);
  assert.equal((await req(base, "GET", url, { sid: member.sid })).status, 403);
  assert.equal((await req(base, "GET", url, { sid: outsider.sid })).status, 403);
  assert.equal((await req(base, "GET", url)).status, 401);
});

test("PATCH /api/boards/:id — board-admin allowed, member forbidden, anon unauthorized", async () => {
  const ok = await req(base, "PATCH", `/api/boards/${board}`, { sid: boardAdmin.sid, body: { name: "By board-admin" } });
  assert.equal(ok.status, 200);
  const denied = await req(base, "PATCH", `/api/boards/${board}`, { sid: member.sid, body: { name: "By member" } });
  assert.equal(denied.status, 403);
  const anon = await req(base, "PATCH", `/api/boards/${board}`, { body: { name: "By nobody" } });
  assert.equal(anon.status, 401);
});

test("facet keys can't claim the ~ system-facet namespace (create + edit)", async () => {
  const bad = [{ key: "~objects", label: "Sneaky", values: ["x"] }];
  const patch = await req(base, "PATCH", `/api/boards/${board}`, { sid: admin.sid, body: { facets: bad } });
  assert.equal(patch.status, 400);
  assert.match(patch.json.error, /reserved/);
  const create = await req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name: "tilde", facets: bad } });
  assert.equal(create.status, 400);
  assert.match(create.json.error, /reserved/);
  // A normal facet edit still lands.
  const ok = await req(base, "PATCH", `/api/boards/${board}`, { sid: admin.sid, body: { facets: [{ key: "kind", label: "Kind", values: ["a"] }] } });
  assert.equal(ok.status, 200);
});

test("board-manager PATCH is content-only: name applies, ai_key_id is ignored", async () => {
  const keyId = await createAiKey(db, "k", "anthropic", "sk-ant-test");
  // Admin sets the board's tagger key.
  let r = await req(base, "PATCH", `/api/admin/boards/${board}`, { sid: admin.sid, body: { ai_key_id: keyId } });
  assert.equal(r.status, 200);
  // Board-admin renames and tries to clear the key in the same request.
  r = await req(base, "PATCH", `/api/boards/${board}`, { sid: boardAdmin.sid, body: { name: "Renamed", ai_key_id: null } });
  assert.equal(r.status, 200);
  const row = (await db.query("SELECT name, ai_key_id FROM boards WHERE id=$1", [board])).rows[0];
  assert.equal(row.name, "Renamed");                 // content field applied
  assert.equal(Number(row.ai_key_id), Number(keyId)); // key untouched by the content-only route
});

test("settings exposes the AI override only to global admins", async () => {
  const keyId = await createAiKey(db, "gallery-key", "anthropic", "sk-ant-gallery");
  const model = "claude-test";
  const updated = await req(base, "PATCH", `/api/admin/boards/${board}`, {
    sid: admin.sid,
    body: { ai_key_id: keyId, ai_model: model },
  });
  assert.equal(updated.status, 200);

  const asAdmin = await req(base, "GET", `/api/boards/${board}/settings`, { sid: admin.sid });
  assert.equal(Number(asAdmin.json.ai_key_id), Number(keyId));
  assert.equal(asAdmin.json.ai_model, model);

  const asBoardAdmin = await req(base, "GET", `/api/boards/${board}/settings`, { sid: boardAdmin.sid });
  assert.equal("ai_key_id" in asBoardAdmin.json, false);
  assert.equal("ai_model" in asBoardAdmin.json, false);
});

test("board-admins cannot reach the admin board routes", async () => {
  const r = await req(base, "PATCH", `/api/admin/boards/${board}`, { sid: boardAdmin.sid, body: { name: "hax" } });
  assert.equal(r.status, 403);
});

test("admin PATCH grants the board-admin role via adminIds", async () => {
  const promoted = await seedUser(db, "promoted@test.local");
  const r = await req(base, "PATCH", `/api/admin/boards/${board}`, {
    sid: admin.sid,
    body: { memberIds: [member.id, boardAdmin.id, promoted.id], adminIds: [boardAdmin.id, promoted.id] },
  });
  assert.equal(r.status, 200);
  // Newly promoted member can now manage; the plain member still cannot.
  assert.equal((await req(base, "GET", `/api/boards/${board}`, { sid: promoted.sid })).json.manage, true);
  assert.equal((await req(base, "GET", `/api/boards/${board}`, { sid: member.sid })).json.manage, false);
});

// The save is ROLE-layered, not route-layered: /api/boards/:id and
// /api/admin/boards/:id run one handler, and what a body may change follows
// from who sent it. So a global admin's pins and mapping land through the
// gallery route too — and are judged by the admin rules there, not silently
// absorbed the way they are for a board-admin (the test above).
test("an admin's pins and mapping land via /api/boards/:id — same handler as the admin route", async () => {
  const keyId = await createAiKey(db, "layered", "anthropic", "sk-ant-layered");
  const r = await req(base, "PATCH", `/api/boards/${board}`, {
    sid: admin.sid,
    body: { ai_key_id: keyId, mapping: { input: "files", fields: [] } },
  });
  assert.equal(r.status, 200);
  const row = (await db.query("SELECT ai_key_id, mapping FROM boards WHERE id=$1", [board])).rows[0];
  assert.equal(Number(row.ai_key_id), Number(keyId));
  assert.equal(row.mapping.input, "files");
  const bad = await req(base, "PATCH", `/api/boards/${board}`, { sid: admin.sid, body: { ai_key_id: 999999 } });
  assert.equal(bad.status, 400, "an admin's bad pin is refused here, never ignored");
});

// Create runs the same content trunk as the PATCH mounts — it used to
// hand-copy the checks and had drifted: an unparsable auto_tag_every_min was
// a 400 on PATCH but silently defaulted to daily on create.
test("create validates like the PATCH mounts: a bad auto_tag_every_min is refused, a schedule arms the timer", async () => {
  const bad = await req(base, "POST", "/api/admin/boards", {
    sid: admin.sid,
    body: { name: "bad-every", auto_tag_every_min: "soon" },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /auto_tag_every_min/);

  const ok = await req(base, "POST", "/api/admin/boards", {
    sid: admin.sid,
    body: { name: "armed-at-birth", auto_tag_periodic: true, auto_tag_every_min: 60 },
  });
  assert.equal(ok.status, 200);
  const row = (await db.query(
    "SELECT auto_tag_periodic, auto_tag_every_min, auto_tag_next_run_at FROM boards WHERE id=$1",
    [ok.json.id]
  )).rows[0];
  assert.equal(row.auto_tag_periodic, true);
  assert.equal(Number(row.auto_tag_every_min), 60);
  assert.ok(row.auto_tag_next_run_at != null, "the schedule set at birth is armed at birth");
});

// The create route judges its body against NEW_BOARD_DEFAULTS as a synthetic
// prev; createBoard's INSERT writes its own defaults. The two live in
// different files — this is the assertion that keeps them the same row.
test("NEW_BOARD_DEFAULTS is what createBoard actually writes", async () => {
  const id = await createBoard(db, "defaults-pin");
  const row = await getBoard(db, id);
  for (const [col, v] of Object.entries(NEW_BOARD_DEFAULTS)) {
    assert.deepEqual(row[col], v, `NEW_BOARD_DEFAULTS.${col} matches the inserted row`);
  }
});

test("a board cannot be renamed to nothing — the shared trunk refuses an empty name", async () => {
  const r = await req(base, "PATCH", `/api/boards/${board}`, { sid: admin.sid, body: { name: "   " } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /name required/);
});
