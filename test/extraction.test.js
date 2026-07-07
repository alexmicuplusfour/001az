// Extraction slice (slice 2): buildFieldsPrompt schema shape, callTagger tool
// parameterisation, mapping PATCH/GET round-trip, ingest status routing,
// releaseHeld, reextract endpoint, reasoning endpoint carrying fields.
// No live AI — the actual extraction call is exercised during live verify.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { buildFieldsPrompt } from "../server/worker.js";
import { anthropicRequest } from "../server/providers.js";

// ─── pure: buildFieldsPrompt ─────────────────────────────────────────────────

test("buildFieldsPrompt: why-before-value, nullable value, kind→JSON type", () => {
  const mapping = {
    fields: [
      { key: "name",  kind: "text",   from: "ai", hint: "the author's full name" },
      { key: "score", kind: "number", from: "ai" },
      { key: "link",  kind: "url",    from: "ai" },
      { key: "born",  kind: "date",   from: "ai" },
    ],
  };
  const { schema, systemText } = buildFieldsPrompt(mapping);

  // envelope
  assert.equal(schema.type, "object");
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ["name", "score", "link", "born"]);

  // per-field shape: why declared before value (reasoning-first discipline)
  const name = schema.properties.name;
  assert.equal(name.type, "object");
  assert.deepEqual(name.required, ["why", "value"]);
  assert.equal(Object.keys(name.properties)[0], "why");
  assert.equal(name.additionalProperties, false);

  // hint becomes the field description
  assert.equal(name.description, "the author's full name");

  // nullable value types per kind
  assert.deepEqual(schema.properties.name.properties.value.type,  ["string", "null"]);
  assert.deepEqual(schema.properties.score.properties.value.type, ["number", "null"]);
  assert.deepEqual(schema.properties.link.properties.value.type,  ["string", "null"]);
  assert.deepEqual(schema.properties.born.properties.value.type,  ["string", "null"]);

  // system text instructs the model to call record_fields
  assert.match(systemText, /record_fields/);
});

test("buildFieldsPrompt: field without hint uses key as description", () => {
  const { schema } = buildFieldsPrompt({ fields: [{ key: "year", kind: "number", from: "ai" }] });
  assert.equal(schema.properties.year.description, "year");
});

test("buildFieldsPrompt: empty mapping produces empty-but-valid schema", () => {
  const { schema } = buildFieldsPrompt({ fields: [] });
  assert.deepEqual(schema.required, []);
  assert.deepEqual(schema.properties, {});
  assert.equal(schema.additionalProperties, false);
});

// ─── pure: anthropicRequest tool parameterisation ────────────────────────────

test("anthropicRequest: custom tool name emits in tools[] and tool_choice", () => {
  const { schema } = buildFieldsPrompt({ fields: [{ key: "x", kind: "text", from: "ai" }] });
  const r = anthropicRequest({
    model: "claude-haiku-4-5",
    systemText: "extract",
    schema,
    parts: [{ kind: "text", text: "a document" }],
    tool: { name: "record_fields", description: "Record extracted fields." },
  });
  assert.equal(r.tools.length, 1);
  assert.equal(r.tools[0].name, "record_fields");
  assert.deepEqual(r.tool_choice, { type: "tool", name: "record_fields" });
});

test("anthropicRequest: default tool is still record_tags when no tool arg", () => {
  const r = anthropicRequest({
    model: "m", systemText: "s",
    schema: { type: "object", properties: {}, required: [] },
    parts: [{ kind: "text", text: "t" }],
  });
  assert.equal(r.tools[0].name, "record_tags");
  assert.deepEqual(r.tool_choice, { type: "tool", name: "record_tags" });
});

// ─── integration ─────────────────────────────────────────────────────────────

const MAPPING = {
  fields: [
    { key: "author", kind: "text",   from: "ai", hint: "the document author" },
    { key: "year",   kind: "number", from: "ai", hint: "year of publication"  },
  ],
};

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

async function createBoard(name, extra = {}) {
  return req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name, ...extra } });
}
async function patchBoard(id, body) {
  return req(base, "PATCH", `/api/admin/boards/${id}`, { sid: admin.sid, body });
}
async function getPublicBoard(id) {
  return req(base, "GET", `/api/boards/${id}`, { sid: admin.sid });
}
async function uploadTxt(boardId) {
  const fd = new FormData();
  fd.append("files", new File(["Field one\nField two\nField three."], "doc.txt", { type: "text/plain" }));
  const res = await fetch(`${base}/api/upload?board=${boardId}`, {
    method: "POST", headers: { Cookie: `sid=${admin.sid}` }, body: fd,
  });
  return res.json();
}
// Upload rows carry the entity id as `id`; the items row (queue state,
// stamped mapping) is the instance — instances[0].id in the response.
async function itemStatus(uploadedRow) {
  const { rows } = await db.query("SELECT status, payload FROM items WHERE id=$1", [uploadedRow.instances[0].id]);
  return rows[0];
}

// ── mapping PATCH / GET ──────────────────────────────────────────────────────

test("mapping PATCH: valid mapping saves; GET /api/boards/:id returns it", async () => {
  const { json: board } = await createBoard("map-save");
  const patch = await patchBoard(board.id, { mapping: MAPPING });
  assert.equal(patch.status, 200);

  const { json: got } = await getPublicBoard(board.id);
  assert.deepEqual(got.mapping, MAPPING);
});

test("mapping PATCH: null clears the mapping", async () => {
  const { json: board } = await createBoard("map-clear");
  await patchBoard(board.id, { mapping: MAPPING });
  await patchBoard(board.id, { mapping: null });

  const { json: got } = await getPublicBoard(board.id);
  assert.equal(got.mapping, null);
});

test("mapping PATCH: bad kind → 400", async () => {
  const { json: board } = await createBoard("map-badkind");
  const r = await patchBoard(board.id, {
    mapping: { fields: [{ key: "x", kind: "emoji", from: "ai" }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /invalid kind/);
});

test("mapping PATCH: duplicate key → 400", async () => {
  const { json: board } = await createBoard("map-dupkey");
  const r = await patchBoard(board.id, {
    mapping: { fields: [
      { key: "dup", kind: "text",   from: "ai" },
      { key: "dup", kind: "number", from: "ai" },
    ] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /duplicate/i);
});

test("mapping PATCH: >12 fields → 400", async () => {
  const { json: board } = await createBoard("map-oversize");
  const fields = Array.from({ length: 13 }, (_, i) => ({ key: `f${i}`, kind: "text", from: "ai" }));
  const r = await patchBoard(board.id, { mapping: { fields } });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /12/);
});

// ── ingest routing ───────────────────────────────────────────────────────────

test("ingest: mapped board → pending_extract + payload.mapping stamped", async () => {
  const { json: board } = await createBoard("map-ingest");
  await patchBoard(board.id, { mapping: MAPPING });

  const { uploaded } = await uploadTxt(board.id);
  assert.equal(uploaded.length, 1);
  assert.equal(uploaded[0].status, "pending_extract");

  const row = await itemStatus(uploaded[0]);
  assert.equal(row.status, "pending_extract");
  assert.deepEqual(row.payload.mapping, MAPPING);

  // The upload also created the entity shell, provisionally keyed by the file.
  const { rows: [ent] } = await db.query("SELECT identity FROM entities WHERE id=$1", [uploaded[0].id]);
  assert.equal(ent.identity, uploaded[0].name);
});

test("ingest: plain board → pending, no payload.mapping", async () => {
  const boardId = await seedBoard(db, "plain-ingest");

  const { uploaded } = await uploadTxt(boardId);
  assert.equal(uploaded[0].status, "pending");

  const row = await itemStatus(uploaded[0]);
  assert.equal(row.status, "pending");
  assert.equal(row.payload.mapping, undefined);
});

test("ingest: mapped board + auto_tag off → held, mapping still stamped", async () => {
  const { json: board } = await createBoard("map-held", { auto_tag: false });
  await patchBoard(board.id, { mapping: MAPPING });

  const { uploaded } = await uploadTxt(board.id);
  assert.equal(uploaded[0].status, "held");

  const row = await itemStatus(uploaded[0]);
  assert.deepEqual(row.payload.mapping, MAPPING);
});

// ── releaseHeld routing ──────────────────────────────────────────────────────

test("releaseHeld: mapped held item → pending_extract; plain held item → pending", async () => {
  // Mapped board with auto_tag off — upload gives held + mapping stamped.
  const { json: mappedBoard } = await createBoard("release-mapped", { auto_tag: false });
  await patchBoard(mappedBoard.id, { mapping: MAPPING });
  const { uploaded: [mappedItem] } = await uploadTxt(mappedBoard.id);
  assert.equal(mappedItem.status, "held");

  // Plain board — insert a held item directly without payload.mapping.
  const plainBoardId = await seedBoard(db, "release-plain");
  const { rows: [{ id: plainId }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, created_at, updated_at)
     VALUES ($1, $2, 'held', $3, $3) RETURNING id`,
    [plainBoardId, JSON.stringify({ identity: "x.txt", files: [], fields: {} }), Date.now()]
  );

  // Release both boards via the tag-held endpoint.
  await req(base, "POST", `/api/admin/boards/${mappedBoard.id}/tag-held`,  { sid: admin.sid });
  await req(base, "POST", `/api/admin/boards/${plainBoardId}/tag-held`, { sid: admin.sid });

  const { rows: [mapped] } = await db.query("SELECT status FROM items WHERE id=$1", [mappedItem.instances[0].id]);
  const { rows: [plain]  } = await db.query("SELECT status FROM items WHERE id=$1", [plainId]);
  assert.equal(mapped.status, "pending_extract");
  assert.equal(plain.status,  "pending");
});

// ── reextract endpoint ───────────────────────────────────────────────────────

test("reextract: instance with stamped mapping resets to pending_extract", async () => {
  const { json: board } = await createBoard("reextract-ok");
  await patchBoard(board.id, { mapping: MAPPING });
  const { uploaded: [item] } = await uploadTxt(board.id);
  const instId = item.instances[0].id;

  // Force to tagged so the status change is unambiguous.
  await db.query("UPDATE items SET status='tagged' WHERE id=$1", [instId]);

  const r = await req(base, "POST", `/api/instances/${instId}/reextract`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.status, "pending_extract");

  const { rows } = await db.query("SELECT status FROM items WHERE id=$1", [instId]);
  assert.equal(rows[0].status, "pending_extract");
});

test("reextract: instance without mapping → 409", async () => {
  const boardId = await seedBoard(db, "reextract-nomapping");
  const { uploaded: [item] } = await uploadTxt(boardId);

  const r = await req(base, "POST", `/api/instances/${item.instances[0].id}/reextract`, { sid: admin.sid });
  assert.equal(r.status, 409);
});

// ── reasoning endpoint carries fields ────────────────────────────────────────

test("reasoning endpoint returns payload.fields alongside tag_reasoning", async () => {
  const boardId = await seedBoard(db, "reasoning-fields");
  const fields = { author: { v: "Ada Lovelace", why: "listed at the top of the document" } };
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, created_at, updated_at)
     VALUES ($1, $2, 'tagged', $3, $3) RETURNING id`,
    [boardId, JSON.stringify({ identity: "doc.txt", files: [], fields }), Date.now()]
  );
  await db.query(
    "UPDATE items SET tag_reasoning=$1 WHERE id=$2",
    [JSON.stringify({ fit: "match" }), id]
  );

  const r = await req(base, "GET", `/api/instances/${id}/reasoning`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.reasoning, { fit: "match" });
  assert.deepEqual(r.json.fields, fields);
});
