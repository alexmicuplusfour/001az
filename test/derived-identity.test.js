// Derived identity (slice 4): buildFieldsPrompt with identity key, mapping
// validation for the identity slot, merge-on-collision DB mechanics,
// removeFileFromItem, identity_provisional flag, reasoning endpoint files field.
// No live AI — the merge path is exercised in the live verify.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { buildFieldsPrompt } from "../server/worker.js";
import {
  getItemByIdentity,
  setItemIdentity,
  appendItemFiles,
  removeFileFromItem,
  insertItem,
} from "../server/db.js";

// ─── pure: buildFieldsPrompt with derived identity ───────────────────────────

test("buildFieldsPrompt: identity key injected first when mapping.identity.from = 'ai'", () => {
  const mapping = {
    identity: { from: "ai", hint: "the person's full name" },
    fields: [{ key: "role", kind: "text", from: "ai", hint: "job title" }],
  };
  const { schema, systemText } = buildFieldsPrompt(mapping);

  // identity must be the first required key
  assert.equal(schema.required[0], "identity");
  assert.equal(schema.required[1], "role");

  // identity field shape: why-before-value, nullable string
  const id = schema.properties.identity;
  assert.equal(id.type, "object");
  assert.deepEqual(id.required, ["why", "value"]);
  assert.equal(Object.keys(id.properties)[0], "why");
  assert.deepEqual(id.properties.value.type, ["string", "null"]);
  assert.equal(id.description, "the person's full name");

  // system text mentions identity consistency
  assert.match(systemText, /unique key/);
  assert.match(systemText, /same entity always produces the same value/);
});

test("buildFieldsPrompt: identity key absent when mapping.identity.from = 'raw'", () => {
  const mapping = {
    identity: { from: "raw" },
    fields: [{ key: "role", kind: "text", from: "ai" }],
  };
  const { schema } = buildFieldsPrompt(mapping);
  assert.equal(schema.properties.identity, undefined);
  assert.deepEqual(schema.required, ["role"]);
});

test("buildFieldsPrompt: identity key absent when identity slot omitted", () => {
  const { schema } = buildFieldsPrompt({ fields: [{ key: "x", kind: "text", from: "ai" }] });
  assert.equal(schema.properties.identity, undefined);
});

// ─── integration ─────────────────────────────────────────────────────────────

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

async function patchBoard(id, body) {
  return req(base, "PATCH", `/api/admin/boards/${id}`, { sid: admin.sid, body });
}
async function createBoard(name, extra = {}) {
  return req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name, ...extra } });
}
async function insertTestItem(boardId, identity, files = []) {
  return insertItem(db, boardId, { identity, files, fields: {} }, "tagged");
}

// ── validateMapping: identity slot ───────────────────────────────────────────

test("mapping PATCH: identity from:ai with hint is valid", async () => {
  const { json: board } = await createBoard("id-valid");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "ai", hint: "full name" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: identity from:raw is valid", async () => {
  const { json: board } = await createBoard("id-raw");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "raw" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

test("mapping PATCH: identity from:ai without hint → 400", async () => {
  const { json: board } = await createBoard("id-nohint");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "ai" }, fields: [] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /hint/);
});

test("mapping PATCH: identity from:connector is now valid (connector slice shipped)", async () => {
  const { json: board } = await createBoard("id-connector");
  const r = await patchBoard(board.id, {
    mapping: { identity: { from: "connector" }, fields: [] },
  });
  assert.equal(r.status, 200);
});

// ── DB helpers: getItemByIdentity / setItemIdentity ──────────────────────────

test("getItemByIdentity: finds item by derived identity", async () => {
  const boardId = await seedBoard(db, "get-by-id");
  await insertTestItem(boardId, "jordan okafor");
  const found = await getItemByIdentity(db, boardId, "jordan okafor");
  assert.ok(found);
  assert.equal(found.payload.identity, "jordan okafor");
});

test("getItemByIdentity: returns null when not found", async () => {
  const boardId = await seedBoard(db, "get-by-id-miss");
  const found = await getItemByIdentity(db, boardId, "nobody");
  assert.equal(found, null);
});

test("setItemIdentity: updates identity and clears provisional flag", async () => {
  const boardId = await seedBoard(db, "set-id");
  const id = await insertTestItem(boardId, "provisional-filename.pdf");
  // Mark provisional manually.
  await db.query("UPDATE items SET payload = payload || '{\"identity_provisional\":true}'::jsonb WHERE id=$1", [id]);

  await setItemIdentity(db, id, "jordan okafor");

  const { rows: [row] } = await db.query("SELECT payload FROM items WHERE id=$1", [id]);
  assert.equal(row.payload.identity, "jordan okafor");
  assert.equal(row.payload.identity_provisional, false);
});

test("setItemIdentity: throws 23505 on collision with existing identity", async () => {
  const boardId = await seedBoard(db, "set-id-collision");
  await insertTestItem(boardId, "jordan okafor");
  const provisionalId = await insertTestItem(boardId, "provisional2.pdf");

  let caught = null;
  try {
    await setItemIdentity(db, provisionalId, "jordan okafor");
  } catch (err) {
    caught = err;
  }
  assert.ok(caught, "expected an error");
  assert.equal(caught.code, "23505");
});

// ── appendItemFiles ───────────────────────────────────────────────────────────

test("appendItemFiles: adds files to existing entity", async () => {
  const boardId = await seedBoard(db, "append-files");
  const id = await insertItem(db, boardId, {
    identity: "jordan okafor",
    files: [{ name: "a.pdf", original_name: "resume_v1.pdf", kind: "pdf" }],
    fields: {},
  }, "tagged");

  await appendItemFiles(db, id, [{ name: "b.pdf", original_name: "resume_v2.pdf", kind: "pdf" }]);

  const { rows: [row] } = await db.query("SELECT payload FROM items WHERE id=$1", [id]);
  assert.equal(row.payload.files.length, 2);
  assert.equal(row.payload.files[1].original_name, "resume_v2.pdf");
});

// ── removeFileFromItem ────────────────────────────────────────────────────────

test("removeFileFromItem: removes correct file by index", async () => {
  const boardId = await seedBoard(db, "remove-file");
  const id = await insertItem(db, boardId, {
    identity: "entity",
    files: [
      { name: "a.pdf", original_name: "first.pdf", kind: "pdf" },
      { name: "b.pdf", original_name: "second.pdf", kind: "pdf" },
      { name: "c.pdf", original_name: "third.pdf", kind: "pdf" },
    ],
    fields: {},
  }, "tagged");

  const updated = await removeFileFromItem(db, id, 1); // remove "second.pdf"
  assert.equal(updated.files.length, 2);
  assert.equal(updated.files[0].original_name, "first.pdf");
  assert.equal(updated.files[1].original_name, "third.pdf");
});

test("removeFileFromItem: returns empty files array when last file removed", async () => {
  const boardId = await seedBoard(db, "remove-last-file");
  const id = await insertItem(db, boardId, {
    identity: "entity",
    files: [{ name: "a.pdf", original_name: "only.pdf", kind: "pdf" }],
    fields: {},
  }, "tagged");

  const updated = await removeFileFromItem(db, id, 0);
  assert.deepEqual(updated.files, []);
});

// ── DELETE /api/items/:id/files/:index route ──────────────────────────────────

test("file remove route: removes file and re-queues for extraction when mapping present", async () => {
  const boardId = await seedBoard(db, "route-remove-file");
  const id = await insertItem(db, boardId, {
    identity: "entity",
    files: [
      { name: "a.txt", original_name: "doc1.txt", kind: "text" },
      { name: "b.txt", original_name: "doc2.txt", kind: "text" },
    ],
    mapping: { identity: { from: "ai", hint: "name" }, fields: [] },
    fields: {},
  }, "tagged");

  const r = await req(base, "DELETE", `/api/items/${id}/files/0`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "pending_extract");

  const { rows: [row] } = await db.query("SELECT payload, status FROM items WHERE id=$1", [id]);
  assert.equal(row.status, "pending_extract");
  assert.equal(row.payload.files.length, 1);
  assert.equal(row.payload.files[0].original_name, "doc2.txt");
});

test("file remove route: 409 when trying to remove the only file", async () => {
  const boardId = await seedBoard(db, "route-remove-only");
  const id = await insertItem(db, boardId, {
    identity: "entity",
    files: [{ name: "a.txt", original_name: "only.txt", kind: "text" }],
    fields: {},
  }, "tagged");

  const r = await req(base, "DELETE", `/api/items/${id}/files/0`, { sid: admin.sid });
  assert.equal(r.status, 409);
});

test("file remove route: 400 for out-of-range index", async () => {
  const boardId = await seedBoard(db, "route-remove-oob");
  const id = await insertItem(db, boardId, {
    identity: "entity",
    files: [
      { name: "a.txt", original_name: "a.txt", kind: "text" },
      { name: "b.txt", original_name: "b.txt", kind: "text" },
    ],
    fields: {},
  }, "tagged");

  const r = await req(base, "DELETE", `/api/items/${id}/files/9`, { sid: admin.sid });
  assert.equal(r.status, 400);
});

// ── reasoning endpoint: files + identity_provisional ─────────────────────────

test("reasoning endpoint returns files array from payload", async () => {
  const boardId = await seedBoard(db, "reasoning-files");
  const files = [
    { name: "a.pdf", original_name: "resume_v1.pdf", kind: "pdf" },
    { name: "b.pdf", original_name: "resume_v2.pdf", kind: "pdf" },
  ];
  const { rows: [{ id }] } = await db.query(
    "INSERT INTO items (board_id, payload, status, created_at, updated_at) VALUES ($1,$2,'tagged',$3,$3) RETURNING id",
    [boardId, JSON.stringify({ identity: "jordan okafor", files, fields: {} }), Date.now()]
  );

  const r = await req(base, "GET", `/api/items/${id}/reasoning`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.files.length, 2);
  assert.equal(r.json.files[0].original_name, "resume_v1.pdf");
  assert.equal(r.json.identity_provisional, false);
});

test("reasoning endpoint returns identity_provisional true when set", async () => {
  const boardId = await seedBoard(db, "reasoning-provisional");
  const { rows: [{ id }] } = await db.query(
    "INSERT INTO items (board_id, payload, status, created_at, updated_at) VALUES ($1,$2,'pending',$3,$3) RETURNING id",
    [boardId, JSON.stringify({ identity: "some-file.pdf", files: [], fields: {}, identity_provisional: true }), Date.now()]
  );

  const r = await req(base, "GET", `/api/items/${id}/reasoning`, { sid: admin.sid });
  assert.equal(r.json.identity_provisional, true);
});
