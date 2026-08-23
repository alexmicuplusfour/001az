// File-metadata fields (source:"file") — the media registry projection, its
// mapping validation, the catalog endpoint, and ingest writing file fields onto
// payload.fields. Pure projection (no file re-open), so most of this is unit
// tests over synthetic entries; a couple of integration cases drive real uploads.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, adminSession, req } from "./helpers.js";
import { mediaCatalog, getMediaField, extractFileFields } from "../server/media/index.js";
import { buildFieldsPrompt } from "../server/worker.js";

const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const ff = (fn, kind) => ({ key: fn, fn, source: "file", kind });

// ─── pure: catalog shape ─────────────────────────────────────────────────────

test("mediaCatalog: every descriptor is well-formed and grouped", () => {
  const cat = mediaCatalog();
  assert.ok(cat.length >= 12);
  for (const d of cat) {
    assert.ok(d.key && d.fn && d.kind && d.label && d.group);
    assert.ok(d.appliesTo !== undefined);
  }
  const groups = new Set(cat.map((d) => d.group));
  assert.ok(groups.has("All files") && groups.has("Images") && groups.has("Documents"));
});

test("getMediaField: known fn resolves, unknown is null", () => {
  assert.equal(getMediaField("file_size").kind, "number");
  assert.equal(getMediaField("width").kind, "number");
  assert.equal(getMediaField("bogus"), null);
});

// ─── pure: projection per kind ───────────────────────────────────────────────

test("extractFileFields: image entry fills image + universal fields, doc fields null", () => {
  const entry = {
    name: "a.webp", original_name: "photo.PNG", kind: "image", size: 12345,
    meta: { width: 1920, height: 1080, format: "png" },
    addedAt: 1_720_000_000_000, modifiedAt: 1_719_000_000_000, createdAt: null,
  };
  const out = extractFileFields(entry, [
    ff("width", "number"), ff("height", "number"), ff("megapixels", "number"),
    ff("aspect_ratio", "text"), ff("format", "text"), ff("file_size", "number"),
    ff("extension", "text"), ff("file_type", "text"),
    ff("added", "date"), ff("modified", "date"), ff("created", "date"),
    ff("pages", "number"), // doc field — N/A on an image
  ]);
  assert.equal(out.width.v, 1920);
  assert.equal(out.height.v, 1080);
  assert.equal(out.megapixels.v, 2.1); // 1920*1080 = 2,073,600 → 2.1 MP
  assert.equal(out.aspect_ratio.v, "16:9");
  assert.equal(out.format.v, "png");
  assert.equal(out.file_size.v, 12345);
  assert.equal(out.extension.v, "png"); // from original_name, lowercased
  assert.equal(out.file_type.v, "image");
  assert.equal(out.added.v, iso(1_720_000_000_000));
  assert.equal(out.modified.v, iso(1_719_000_000_000));
  assert.equal(out.created.v, null); // unavailable for uploads
  assert.equal(out.pages.v, null); // doc-only field is null on an image
  // Every value carries file provenance + its kind.
  assert.equal(out.width.src, "file");
  assert.equal(out.width.kind, "number");
});

test("extractFileFields: pdf entry fills doc fields, image fields null", () => {
  const entry = {
    name: "b.pdf", original_name: "report.pdf", kind: "pdf", size: 5000,
    meta: { pages: 12, title: "Q3 Report" }, addedAt: 1_720_000_000_000,
  };
  const out = extractFileFields(entry, [
    ff("pages", "number"), ff("title", "text"), ff("width", "number"),
  ]);
  assert.equal(out.pages.v, 12);
  assert.equal(out.title.v, "Q3 Report");
  assert.equal(out.width.v, null); // image-only field is null on a pdf
});

test("extractFileFields: aspect ratio degrades to decimal for odd crops", () => {
  const entry = { kind: "image", meta: { width: 1049, height: 591 } };
  const out = extractFileFields(entry, [ff("aspect_ratio", "text")]);
  assert.equal(out.aspect_ratio.v, "1.77:1");
});

test("extractFileFields: no file fields requested → empty object", () => {
  assert.deepEqual(extractFileFields({ kind: "image" }, [{ key: "x", source: "extract" }]), {});
});

// ─── pure: file fields stay out of the AI extraction schema ───────────────────

test("buildFieldsPrompt: only extract fields enter the schema, file fields are skipped", () => {
  const { schema } = buildFieldsPrompt({
    fields: [
      { key: "author", kind: "text", source: "extract", instruction: "the author" },
      { key: "file_size", kind: "number", source: "file", fn: "file_size" },
    ],
  });
  assert.deepEqual(Object.keys(schema.properties), ["author"]);
  assert.deepEqual(schema.required, ["author"]);
});

// ─── integration ─────────────────────────────────────────────────────────────

let srv, db, base, admin;

before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
  admin = await adminSession(db);
});

after(() => srv.close());

const createBoard = (name, extra = {}) =>
  req(base, "POST", "/api/admin/boards", { sid: admin.sid, body: { name, ...extra } });
const patchBoard = (id, body) =>
  req(base, "PATCH", `/api/admin/boards/${id}`, { sid: admin.sid, body });

async function uploadTxt(boardId, content, name, lastModified) {
  const fd = new FormData();
  fd.append("files", new File([content], name, { type: "text/plain" }));
  if (lastModified !== undefined) fd.append("lastModified", String(lastModified));
  const res = await fetch(`${base}/api/upload?board=${boardId}`, {
    method: "POST", headers: { Cookie: `sid=${admin.sid}` }, body: fd,
  });
  return res.json();
}
async function itemPayload(instanceId) {
  const { rows } = await db.query("SELECT payload FROM items WHERE id=$1", [instanceId]);
  return rows[0].payload;
}

const FILE_MAPPING = {
  fields: [
    { key: "file_size", kind: "number", source: "file", fn: "file_size" },
    { key: "extension", kind: "text", source: "file", fn: "extension" },
    { key: "word_count", kind: "number", source: "file", fn: "word_count" },
    { key: "line_count", kind: "number", source: "file", fn: "line_count" },
    { key: "modified", kind: "date", source: "file", fn: "modified" },
  ],
};

test("GET /api/file-fields: returns the catalog", async () => {
  const r = await req(base, "GET", "/api/file-fields", { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.ok(r.json.some((d) => d.fn === "file_size"));
  assert.ok(r.json.some((d) => d.fn === "pages" && d.group === "Documents"));
});

test("validateMapping: accepts a file field, rejects unknown fn / kind mismatch / connector board", async () => {
  const { json: board } = await createBoard("file-valid");
  assert.equal((await patchBoard(board.id, { mapping: FILE_MAPPING })).status, 200);

  const bad = await patchBoard(board.id, {
    mapping: { fields: [{ key: "x", kind: "number", source: "file", fn: "nope" }] },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /unknown file field/);

  const mism = await patchBoard(board.id, {
    mapping: { fields: [{ key: "file_size", kind: "text", source: "file", fn: "file_size" }] },
  });
  assert.equal(mism.status, 400);
  assert.match(mism.json.error, /must have kind/);

  const onConn = await patchBoard(board.id, {
    mapping: {
      input: { connector: "crypto" }, identity: { source: "connector" },
      fields: [{ key: "file_size", kind: "number", source: "file", fn: "file_size" }],
    },
  });
  assert.equal(onConn.status, 400);
  assert.match(onConn.json.error, /files board/);
});

test("validateMapping: file fields don't count against the 12 extract-field cap", async () => {
  const { json: board } = await createBoard("file-cap");
  const fileFields = [
    ["file_size", "number"], ["extension", "text"], ["file_type", "text"], ["added", "date"],
    ["modified", "date"], ["width", "number"], ["height", "number"], ["pages", "number"],
  ].map(([fn, kind]) => ({ key: fn, kind, source: "file", fn }));
  const aiFields = Array.from({ length: 12 }, (_, i) => ({ key: `a${i}`, kind: "text", source: "extract" }));
  // 8 file + 12 extract = 20 total, but only 12 are extract → accepted.
  const ok = await patchBoard(board.id, { mapping: { fields: [...fileFields, ...aiFields] } });
  assert.equal(ok.status, 200);
  // A 13th extract field is still rejected.
  const bad = await patchBoard(board.id, {
    mapping: { fields: [...aiFields, { key: "a12", kind: "text", source: "extract" }] },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /12 extract/);
});

test("ingest: file fields land on payload.fields at upload, no AI needed", async () => {
  const { json: board } = await createBoard("file-ingest");
  await patchBoard(board.id, { mapping: FILE_MAPPING });

  const mtime = 1_700_000_000_000;
  const { uploaded } = await uploadTxt(board.id, "one two\nthree four five", "notes.txt", mtime);
  // A file-only mapping isn't "AI" → the item is pending, not pending_extract,
  // and the mapping isn't stamped — but the file fields are still computed.
  assert.equal(uploaded[0].status, "pending");
  const payload = await itemPayload(uploaded[0].instances[0].id);
  assert.equal(payload.mapping, undefined);
  assert.equal(payload.fields.file_size.src, "file");
  assert.ok(payload.fields.file_size.v > 0);
  assert.equal(payload.fields.extension.v, "txt");
  assert.equal(payload.fields.word_count.v, 5);
  assert.equal(payload.fields.line_count.v, 2);
  assert.equal(payload.fields.modified.v, iso(mtime));
});

test("backfill: legacy entries (no stored meta) are re-derived from the file on disk", async () => {
  const { json: board } = await createBoard("file-legacy");
  const { uploaded } = await uploadTxt(board.id, "alpha beta gamma delta", "legacy.txt");
  const instId = uploaded[0].instances[0].id;
  // Mimic a pre-feature entry: strip size/meta/dates but keep the real filename,
  // so the stored file is still on disk for metaFor to re-read.
  const { rows: [row0] } = await db.query("SELECT payload FROM items WHERE id=$1", [instId]);
  const legacyEntry = { name: row0.payload.files[0].name, original_name: "legacy.txt", kind: "text" };
  await db.query("UPDATE items SET payload = payload || $1::jsonb WHERE id=$2",
    [JSON.stringify({ files: [legacyEntry], fields: {} }), instId]);

  await patchBoard(board.id, { mapping: { fields: [
    { key: "file_size", kind: "number", source: "file", fn: "file_size" },
    { key: "word_count", kind: "number", source: "file", fn: "word_count" },
    { key: "extension", kind: "text", source: "file", fn: "extension" },
    { key: "added", kind: "date", source: "file", fn: "added" },
  ] } });

  const payload = await itemPayload(instId);
  assert.ok(payload.fields.file_size.v > 0, "size re-derived via fs.stat");
  assert.equal(payload.fields.word_count.v, 4, "word count re-derived from the file text");
  assert.equal(payload.fields.extension.v, "txt");
  assert.ok(payload.fields.added.v, "added sourced from the item's created_at");
  // The enriched entry is persisted so the re-read cost is paid once.
  const { rows: [row1] } = await db.query("SELECT payload FROM items WHERE id=$1", [instId]);
  assert.notEqual(row1.payload.files[0].meta, undefined);
});

test("backfill: adding a file field to a board recomputes existing instances", async () => {
  const { json: board } = await createBoard("file-backfill");
  // Start with just file_size, then upload.
  await patchBoard(board.id, { mapping: { fields: [{ key: "file_size", kind: "number", source: "file", fn: "file_size" }] } });
  const { uploaded } = await uploadTxt(board.id, "alpha beta gamma", "b.txt");
  const instId = uploaded[0].instances[0].id;
  let payload = await itemPayload(instId);
  assert.equal(payload.fields.word_count, undefined); // not requested yet

  // Add word_count → the existing instance is backfilled in place.
  await patchBoard(board.id, {
    mapping: { fields: [
      { key: "file_size", kind: "number", source: "file", fn: "file_size" },
      { key: "word_count", kind: "number", source: "file", fn: "word_count" },
    ] },
  });
  payload = await itemPayload(instId);
  assert.equal(payload.fields.word_count.v, 3);
  assert.equal(payload.fields.file_size.src, "file");

  // Remove all file fields → they're stripped from the instance.
  await patchBoard(board.id, { mapping: null });
  payload = await itemPayload(instId);
  assert.equal(payload.fields.word_count, undefined);
  assert.equal(payload.fields.file_size, undefined);
});
