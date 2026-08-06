// Extraction slice (slice 2): buildFieldsPrompt schema shape, callTagger tool
// parameterisation, mapping PATCH/GET round-trip, ingest status routing,
// releaseHeld, reextract endpoint, reasoning endpoint carrying fields.
// No live AI — the actual extraction call is exercised during live verify.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, seedBoard, req } from "./helpers.js";
import { markExtracted } from "../server/db.js";
import { buildFieldsPrompt, htmlToMarkdown } from "../server/worker.js";
import { anthropicRequest } from "../server/ai-providers/wires/anthropic.js";

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

test("buildFieldsPrompt: object fields are excluded from the schema + system text (detector pass owns them)", () => {
  const { schema, systemText } = buildFieldsPrompt({
    fields: [
      { key: "name",  kind: "text",   from: "ai", hint: "the author's full name" },
      { key: "logos", kind: "object", from: "ai", hint: "every visible logo" },
    ],
  });
  assert.ok(!("logos" in schema.properties), "object field absent from the record_fields schema");
  assert.deepEqual(schema.required, ["name"]);
  assert.ok(schema.properties.name, "scalar field still present");
  assert.doesNotMatch(systemText, /logos/, "object field not listed in the prompt");
});

test("buildFieldsPrompt: an object-only mapping yields an empty schema (extractOne skips the LLM)", () => {
  const { schema, systemText } = buildFieldsPrompt({ fields: [{ key: "logos", kind: "object", from: "ai" }] });
  assert.deepEqual(schema.properties, {});
  assert.deepEqual(schema.required, []);
  assert.doesNotMatch(systemText, /Fields to extract/); // nothing for the model to do
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

// Unconditional on this wire (unlike compat's guarded quirk): every Claude
// model accepts temperature, and the app never enables extended thinking — the
// one mode that would forbid a non-default value. Same rationale as the compat
// side: closed-vocabulary classification wants the mode, not a sample.
test("anthropicRequest: tagging samples at temperature 0, research included", () => {
  const args = {
    model: "m", systemText: "s",
    schema: { type: "object", properties: {}, required: [] },
    parts: [{ kind: "text", text: "t" }],
  };
  assert.equal(anthropicRequest(args).temperature, 0);
  assert.equal(anthropicRequest({ ...args, research: true }).temperature, 0);
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

test("mapping PATCH: object kind is accepted (detection field) and round-trips", async () => {
  const { json: board } = await createBoard("map-object");
  const mapping = { fields: [{ key: "car", kind: "object", from: "ai", hint: "car" }] };
  const r = await patchBoard(board.id, { mapping });
  assert.equal(r.status, 200);
  const { json: got } = await getPublicBoard(board.id);
  assert.deepEqual(got.mapping, mapping);
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

test("mapping PATCH: field key 'identity' → 400 (reserved for the identity slot)", async () => {
  const { json: board } = await createBoard("map-reserved");
  const r = await patchBoard(board.id, {
    mapping: { fields: [{ key: "identity", kind: "text", from: "ai" }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /reserved/);
});

// ── mapping on create (the modal's Mapping tab works on new boards too) ──────

test("create: mapping rides POST /api/admin/boards and lands in GET + settings", async () => {
  const r = await createBoard("map-on-create", { mapping: MAPPING, retag_on_refresh: true });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.mapping, MAPPING);

  const { json: got } = await getPublicBoard(r.json.id);
  assert.deepEqual(got.mapping, MAPPING);

  const { json: settings } = await req(base, "GET", `/api/boards/${r.json.id}/settings`, { sid: admin.sid });
  assert.deepEqual(settings.mapping, MAPPING);
  assert.equal(settings.has_items, false);
  assert.equal(settings.retag_on_refresh, true);
});

test("create: invalid mapping → 400, board not created", async () => {
  const r = await createBoard("map-on-create-bad", {
    mapping: { fields: [{ key: "x", kind: "emoji", from: "ai" }] },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /invalid kind/);
  const { rows } = await db.query("SELECT 1 FROM boards WHERE name=$1", ["map-on-create-bad"]);
  assert.equal(rows.length, 0);
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

  // …and flips settings.has_items, which locks the modal's template picker.
  const { json: settings } = await req(base, "GET", `/api/boards/${board.id}/settings`, { sid: admin.sid });
  assert.equal(settings.has_items, true);
});

test("ingest: plain board → pending, no payload.mapping", async () => {
  const boardId = await seedBoard(db, "plain-ingest");

  const { uploaded } = await uploadTxt(boardId);
  assert.equal(uploaded[0].status, "pending");

  const row = await itemStatus(uploaded[0]);
  assert.equal(row.status, "pending");
  assert.equal(row.payload.mapping, undefined);
});

test("ingest: mapped board + auto_tag off → extract leg anyway, stamped and parked", async () => {
  // Extraction defines the item (identity, fields); auto_tag gates only
  // tagging — `park` makes markExtracted park the item in held afterwards.
  const { json: board } = await createBoard("map-held", { auto_tag: false });
  await patchBoard(board.id, { mapping: MAPPING });

  const { uploaded } = await uploadTxt(board.id);
  assert.equal(uploaded[0].status, "pending_extract");

  const row = await itemStatus(uploaded[0]);
  assert.deepEqual(row.payload.mapping, MAPPING);
  assert.equal(row.payload.park, true);
});

// ── releaseHeld routing ──────────────────────────────────────────────────────

test("releaseHeld: stamped → extract leg, extracted → tag leg, plain → pending", async () => {
  const boardId = await seedBoard(db, "release-routing");
  const insertHeld = async (payload) => {
    const { rows: [{ id }] } = await db.query(
      `INSERT INTO items (board_id, payload, status, created_at, updated_at)
       VALUES ($1, $2, 'held', $3, $3) RETURNING id`,
      [boardId, JSON.stringify(payload), Date.now()]
    );
    return id;
  };
  const stamped   = await insertHeld({ identity: "a.txt", files: [], fields: {}, mapping: MAPPING });
  const extracted = await insertHeld({ identity: "b.txt", files: [], fields: {}, mapping: MAPPING, extracted_at: 123 });
  const plain     = await insertHeld({ identity: "c.txt", files: [], fields: {} });

  await req(base, "POST", `/api/admin/boards/${boardId}/tag-held`, { sid: admin.sid });

  const status = async (id) => (await db.query("SELECT status FROM items WHERE id=$1", [id])).rows[0].status;
  assert.equal(await status(stamped),   "pending_extract");
  assert.equal(await status(extracted), "pending", "already extracted — never pays a second extraction");
  assert.equal(await status(plain),     "pending");
});

test("markExtracted: parked item returns to held, definition in hand", async () => {
  const { json: board } = await createBoard("extract-park", { auto_tag: false });
  await patchBoard(board.id, { mapping: MAPPING });
  const { uploaded: [item] } = await uploadTxt(board.id); // born with park
  const instId = item.instances[0].id;

  // markExtracted is fenced to claimed rows — stamp the in-flight status first.
  await db.query("UPDATE items SET status='extracting' WHERE id=$1", [instId]);
  await markExtracted(db, instId, { author: { v: "x", why: "y" } });
  const { rows: [row] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [instId]);
  assert.equal(row.status, "held");
  assert.equal(row.payload.park, undefined, "park is spent once the definition legs finish");
  assert.ok(row.payload.extracted_at > 0);
  assert.equal(row.payload.fields.author.v, "x");

  // A later release routes it to the tag leg.
  await req(base, "POST", `/api/admin/boards/${board.id}/tag-held`, { sid: admin.sid });
  const { rows: [after] } = await db.query("SELECT status FROM items WHERE id=$1", [instId]);
  assert.equal(after.status, "pending");
});

test("markExtracted: without park (explicit run) flows to tagging even with auto-tag off", async () => {
  const { json: board } = await createBoard("extract-noparkcross", { auto_tag: false });
  await patchBoard(board.id, { mapping: MAPPING });
  const { uploaded: [item] } = await uploadTxt(board.id);
  const instId = item.instances[0].id;

  // Simulate a release/reprocess-issued extract: those paths strip park.
  await db.query("UPDATE items SET payload = payload - 'park', status='extracting' WHERE id=$1", [instId]);
  await markExtracted(db, instId, {});
  const { rows: [row] } = await db.query("SELECT status FROM items WHERE id=$1", [instId]);
  assert.equal(row.status, "pending");
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

// ── current board mapping adoption ───────────────────────────────────────────
// User-initiated reprocess/re-extract apply the CURRENT board mapping; the
// stamp an item was built with only governs automatic replay. Held items with
// no stamp adopt the board mapping when released — the board may have gained
// it after they were uploaded.

test("reextract: unstamped instance adopts a mapping the board gained later", async () => {
  const boardId = await seedBoard(db, "reextract-adopt");
  const { uploaded: [item] } = await uploadTxt(boardId); // unmapped board → no stamp
  const instId = item.instances[0].id;
  await patchBoard(boardId, { mapping: MAPPING });

  const r = await req(base, "POST", `/api/instances/${instId}/reextract`, { sid: admin.sid });
  assert.equal(r.status, 200);

  const { rows: [row] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [instId]);
  assert.equal(row.status, "pending_extract");
  assert.deepEqual(row.payload.mapping, MAPPING);
});

test("reextract: re-stamps the current board mapping over a stale stamp", async () => {
  const { json: board } = await createBoard("reextract-restamp");
  await patchBoard(board.id, { mapping: MAPPING });
  const { uploaded: [item] } = await uploadTxt(board.id); // stamped with MAPPING
  const instId = item.instances[0].id;

  const edited = { identity: { from: "ai", hint: "the invoice month, as Month - YYYY" }, fields: [] };
  await patchBoard(board.id, { mapping: edited });
  await req(base, "POST", `/api/instances/${instId}/reextract`, { sid: admin.sid });

  const { rows: [row] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [instId]);
  assert.equal(row.status, "pending_extract");
  assert.deepEqual(row.payload.mapping, edited);
});

test("reprocess: entity adopts a board mapping added after upload", async () => {
  const boardId = await seedBoard(db, "reprocess-adopt");
  const { uploaded: [item] } = await uploadTxt(boardId); // no stamp
  await patchBoard(boardId, { mapping: MAPPING });

  const r = await req(base, "POST", `/api/items/${item.id}/reprocess`, { sid: admin.sid });
  assert.equal(r.status, 200);

  const row = await itemStatus(item);
  assert.equal(row.status, "pending_extract");
  assert.deepEqual(row.payload.mapping, MAPPING);
});

test("releaseHeld: unstamped held item adopts the board mapping gained since upload", async () => {
  const { json: board } = await createBoard("release-adopt", { auto_tag: false });
  const { uploaded: [item] } = await uploadTxt(board.id); // held, unmapped at upload
  assert.equal(item.status, "held");
  await patchBoard(board.id, { mapping: MAPPING });

  await req(base, "POST", `/api/admin/boards/${board.id}/tag-held`, { sid: admin.sid });
  const row = await itemStatus(item);
  assert.equal(row.status, "pending_extract");
  assert.deepEqual(row.payload.mapping, MAPPING);
});

test("auto-tag-on sweep: un-extracted held mapped items route through the extract leg", async () => {
  const { json: board } = await createBoard("sweep-extract", { auto_tag: false });
  const { rows: [{ id }] } = await db.query(
    `INSERT INTO items (board_id, payload, status, created_at, updated_at)
     VALUES ($1, $2, 'held', $3, $3) RETURNING id`,
    [board.id, JSON.stringify({ identity: "h.txt", files: [], fields: {}, mapping: MAPPING }), Date.now()]
  );

  await patchBoard(board.id, { auto_tag: true }); // flips the sweep (queueUntagged)
  const { rows: [row] } = await db.query("SELECT status FROM items WHERE id=$1", [id]);
  assert.equal(row.status, "pending_extract");
});

test("auto-tag-on sweep: a FAILED extraction resumes the extract leg, not the tag leg", async () => {
  const { json: board } = await createBoard("sweep-failed-extract", { auto_tag: false });
  const insert = async (payload) => {
    const { rows: [{ id }] } = await db.query(
      `INSERT INTO items (board_id, payload, status, created_at, updated_at)
       VALUES ($1, $2, 'failed', $3, $3) RETURNING id`,
      [board.id, JSON.stringify(payload), Date.now()]
    );
    return id;
  };
  const failedExtract = await insert({ identity: "fe.txt", files: [], fields: {}, mapping: MAPPING });
  const failedTag     = await insert({ identity: "ft.txt", files: [], fields: {}, mapping: MAPPING, extracted_at: 1 });

  await patchBoard(board.id, { auto_tag: true });
  const status = async (id) => (await db.query("SELECT status FROM items WHERE id=$1", [id])).rows[0].status;
  assert.equal(await status(failedExtract), "pending_extract", "definition never ran — re-extract");
  assert.equal(await status(failedTag), "pending", "already extracted — straight to tagging");
});

// ── retagBoard routing ───────────────────────────────────────────────────────
// Retag only touches settled items (tagged/failed/held) — in-pipeline items
// already end in the tag leg when their legs finish, and flipping them would
// skip extraction/face entirely. Settled items resume the right leg, with the
// same routing as releaseHeld.

test("retag: leaves in-pipeline items alone, routes settled items to the right leg", async () => {
  const { json: board } = await createBoard("retag-routing");
  await patchBoard(board.id, { mapping: MAPPING });
  const FACE_MAPPING = {
    input: { connector: "crypto" },
    identity: { from: "connector" },
    face: { from: "connector", producer: "chart", period: "1y" },
    fields: [],
  };
  const insert = async (status, payload) => {
    const { rows: [{ id }] } = await db.query(
      `INSERT INTO items (board_id, payload, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [board.id, JSON.stringify(payload), status, Date.now()]
    );
    return id;
  };

  // In-pipeline: a retag firing mid-upload must not yank these out of their legs.
  const midExtractQ = await insert("pending_extract", { identity: "a", files: [], fields: {}, mapping: MAPPING });
  const midExtract  = await insert("extracting",      { identity: "b", files: [], fields: {}, mapping: MAPPING });
  const midFaceQ    = await insert("pending_face",    { identity: "c", files: [], fields: {}, mapping: FACE_MAPPING });
  const midFace     = await insert("facing",          { identity: "d", files: [], fields: {}, mapping: FACE_MAPPING });
  const midTag      = await insert("processing",      { identity: "e", files: [], fields: {} });

  // Settled: routed per definition state.
  const taggedDone    = await insert("tagged", { identity: "f", files: [], fields: {}, mapping: MAPPING, extracted_at: 1 });
  const taggedNoDef   = await insert("tagged", { identity: "g", files: [], fields: {}, mapping: MAPPING }); // stamped but never extracted — heals
  const failedExtract = await insert("failed", { identity: "h", files: [], fields: {}, mapping: MAPPING });
  const failedTag     = await insert("failed", { identity: "i", files: [], fields: {}, mapping: MAPPING, extracted_at: 1 });
  const bareVehicle   = await insert("tagged", { identity: "j", files: [], fields: {}, mapping: FACE_MAPPING, extracted_at: 1, source: { provider: "coingecko", id: "j" } });
  const plainTagged   = await insert("tagged", { identity: "k", files: [], fields: {} }); // unstamped + tagged: stays tag-only, no adoption

  const r = await req(base, "POST", `/api/admin/boards/${board.id}/retag`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.queued, 6, "only the settled items count");

  const status = async (id) => (await db.query("SELECT status FROM items WHERE id=$1", [id])).rows[0].status;
  assert.equal(await status(midExtractQ), "pending_extract");
  assert.equal(await status(midExtract),  "extracting");
  assert.equal(await status(midFaceQ),    "pending_face");
  assert.equal(await status(midFace),     "facing");
  assert.equal(await status(midTag),      "processing");

  assert.equal(await status(taggedDone),    "pending", "already extracted — never pays a second extraction");
  assert.equal(await status(taggedNoDef),   "pending_extract", "definition never ran — retag heals it");
  assert.equal(await status(failedExtract), "pending_extract", "an extraction failure resumes in the extract leg");
  assert.equal(await status(failedTag),     "pending");
  assert.equal(await status(bareVehicle),   "pending_face", "an unrendered vehicle gets another shot at the chart");
  assert.equal(await status(plainTagged),   "pending");
});

test("retag: held unstamped item adopts the board mapping gained since upload", async () => {
  const { json: board } = await createBoard("retag-adopt", { auto_tag: false });
  const { uploaded: [item] } = await uploadTxt(board.id); // held, unmapped at upload
  assert.equal(item.status, "held");
  await patchBoard(board.id, { mapping: MAPPING });

  await req(base, "POST", `/api/admin/boards/${board.id}/retag`, { sid: admin.sid });
  const row = await itemStatus(item);
  assert.equal(row.status, "pending_extract");
  assert.deepEqual(row.payload.mapping, MAPPING);
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

// ── pure: htmlToMarkdown (docx extraction input) ─────────────────────────────

test("htmlToMarkdown: hyperlinks become [label](url) — the whole point", () => {
  const md = htmlToMarkdown(
    `<p>Portfolio: <a href="https://dribbble.com/jordan">Dribbble</a> · ` +
    `<a href="https://linkedin.com/in/jordan"><strong>LinkedIn</strong></a></p>`
  );
  assert.ok(md.includes("[Dribbble](https://dribbble.com/jordan)"));
  // nested tags inside the anchor are stripped from the label, URL kept
  assert.ok(md.includes("[LinkedIn](https://linkedin.com/in/jordan)"));
});

test("htmlToMarkdown: anchor with empty label degrades to the bare URL", () => {
  const md = htmlToMarkdown(`<a href="https://example.com"><img src="x.png"></a>`);
  assert.equal(md, "https://example.com");
});

test("htmlToMarkdown: headings, bold, lists, entities; style/head stripped", () => {
  const md = htmlToMarkdown(
    `<head><meta charset="utf-8"></head><style>body{color:red}</style>` +
    `<h1>Jane Doe</h1><h2>Experience</h2>` +
    `<p><strong>Designer</strong> at Acme &amp; Co</p>` +
    `<ul><li>Shipped v1</li><li>Led research</li></ul>`
  );
  assert.ok(md.includes("## Jane Doe"));
  assert.ok(md.includes("### Experience"));
  assert.ok(md.includes("**Designer** at Acme & Co"));
  assert.ok(md.includes("- Shipped v1"));
  assert.ok(!md.includes("color:red"));
  assert.ok(!md.includes("charset"));
});
