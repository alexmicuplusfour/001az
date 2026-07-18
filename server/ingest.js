// The one upload door: files arrive here, a source handler (by file type)
// turns each into a stored file entry, and the item is created with the
// generic payload ({ identity, files, fields }). Raw identity = the stored
// filename. Images and documents (pdf/txt/md/csv) are accepted; new file
// types plug in as new source handlers, this route stays format-blind.
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import { getBoard, canAccessBoard, createEntity, insertItem } from "./db.js";
import { requireAuth } from "./auth.js";
import { extractFileFields } from "./media/index.js";
import { mediaLimitLookup } from "./plugins.js";
import { UPLOAD_HARD_CEILING } from "./upload-limits.js";

// multer's ONLY global size limit is UPLOAD_HARD_CEILING (server/upload-limits.js)
// — an absolute per-file backstop. The real, per-media-type limits (manifest
// defaults, admin-adjustable, clamped to the ceiling) are enforced in admitFile,
// so one gate covers both the upload door and folder/remote ingestion.
const MAX_FILES = 200; // per request

// Express 4 doesn't forward rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// The shared file-admission path: turn a spooled file into a stored entry and
// a newborn entity+item, with the full birth logic (file-field projection,
// mapping stamp, park, status routing). Used by the upload route and by
// folder ingestion (server/ingestion/folder.js) so the two doors can never
// drift. Never unlinks or mutates tmpPath — the caller owns the tmp lifecycle.
// dbc: the pool or a tx client. Returns null for unsupported file types;
// throws with err.reason for user-explainable refusals (e.g. PDF page cap).
export async function admitFile(dbc, sources, board, tmpPath, originalName,
  { addedAt = Date.now(), modifiedAt = null, createdAt = null, uploadedBy = null, maxBytes = null } = {}) {
  // Per-type size gate — the real, admin-adjustable upload limit lives HERE, not
  // at multer (whose global ceiling is only an absolute backstop, and which
  // folder/remote ingestion never passes through). `maxBytes` is the effective
  // limit the caller resolved once via plugins.mediaLimitLookup; null (a bare
  // test caller) skips the gate. An oversize file is deterministic in its bytes,
  // so mark it unprocessable → ingestion ledgers-and-forgets rather than rescans.
  if (maxBytes != null) {
    const { size } = await fs.promises.stat(tmpPath);
    if (size > maxBytes) {
      const err = new Error(`file is larger than the ${Math.round(maxBytes / (1024 * 1024))} MB limit for its type`);
      err.reason = err.message;
      err.unprocessable = true;
      throw err;
    }
  }
  // Pick the handler by extension (media handlers are core capabilities — always
  // present, never removable, so there's no disabled-type gate here).
  const handler = sources.forUpload(originalName);
  let file;
  try {
    file = await handler.ingest(tmpPath, originalName);
  } catch (err) {
    // A handler throw is a deterministic function of the file's bytes (bad
    // decode, page cap) — retrying can't change it. Mark it so folder
    // ingestion can ledger-and-forget instead of rescanning forever; the
    // upload route's catch reads err.reason as before and ignores this.
    err.unprocessable = true;
    throw err;
  }
  if (!file) return null;
  // Stamp the date timestamps onto the stored entry so file-field values
  // (server/media) are a self-contained projection of payload.files —
  // recomputable at extract/backfill without re-opening the file.
  file.addedAt = addedAt;
  file.modifiedAt = Number.isFinite(modifiedAt) && modifiedAt > 0 ? modifiedAt : null;
  file.createdAt = Number.isFinite(createdAt) && createdAt > 0 ? createdAt : null;
  // Deterministic file-metadata fields land now (no AI, no API), independent
  // of the AI mapping/auto-tag gate below.
  const fileFields = extractFileFields(file, board.mapping?.fields);
  // Stamp the board's mapping when it has AI fields — the item carries
  // its own copy so automatic replay (error retries) re-runs the mapping
  // it was built with; user-initiated reprocess/re-extract re-stamp from
  // the current board mapping.
  // Only trigger extraction when the board has AI-sourced fields or
  // AI-derived identity. Connector fields are populated at entity creation,
  // not by the extract leg.
  const hasMapping =
    board.mapping?.identity?.from === "ai" ||
    (Array.isArray(board.mapping?.fields) && board.mapping.fields.some((f) => f.from === "ai"));
  // Extraction defines the item (identity, fields), so a mapped board
  // always enters the extract leg; auto_tag gates only tagging. With
  // auto-tag off the item carries `park` — the extract leg finishes the
  // definition, then parks it in held instead of flowing into tagging
  // (markExtracted). Explicit runs (reprocess/re-extract/release) carry
  // no park and go all the way. Unmapped: auto-tag on → pending, off → held.
  const payload = {
    identity: file.name, files: [file], fields: fileFields,
    ...(hasMapping ? { mapping: board.mapping } : {}),
    ...(hasMapping && !board.auto_tag ? { park: true } : {}),
  };
  const status = hasMapping ? "pending_extract" : (board.auto_tag ? "pending" : "held");
  // Every upload is born a single-instance entity, provisionally keyed
  // by its stored filename; derived-identity extraction may later merge
  // the instance into an existing entity (and delete this shell).
  const entityId = await createEntity(dbc, board.id, { identity: file.name, uploadedBy });
  const itemId = await insertItem(dbc, board.id, payload, status, entityId);
  return { entityId, itemId, file, status };
}

export function mountIngest(app, { db, sources }) {
  // Disk-backed upload (bounded memory; we process one file at a time).
  const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: UPLOAD_HARD_CEILING, files: MAX_FILES },
  });

  app.post("/api/upload", requireAuth, upload.array("files", MAX_FILES), wrap(async (req, res) => {
    const boardId = req.query.board || (req.body && req.body.board_id) || null;
    const board = boardId ? await getBoard(db, boardId) : null;
    // Missing and inaccessible answer alike, so board ids can't be probed.
    // Multer has already spooled the files to tmp — clean up on refusal.
    if (!board || !(await canAccessBoard(db, board.id, req.user))) {
      for (const f of req.files || []) await fs.promises.unlink(f.path).catch(() => {});
      return res.status(400).json({ error: "valid board required" });
    }

    const now = Date.now();
    // Per-file original modified time, sent by the client (File.lastModified),
    // aligned to req.files order. Absent → null (the `modified` file field stays
    // empty; the web platform exposes no creation date either).
    const lastModifieds = [].concat((req.body && req.body.lastModified) || []);
    // Resolve the effective per-type size limits ONCE for the whole request
    // (manifest defaults ⊕ admin overrides), then gate each file by its type.
    const limitFor = await mediaLimitLookup(db);

    const uploaded = [];
    const rejected = [];
    let fileIdx = -1;
    for (const f of req.files || []) {
      fileIdx++;
      try {
        const lm = Number(lastModifieds[fileIdx]);
        const admitted = await admitFile(db, sources, board, f.path, f.originalname, {
          addedAt: now,
          modifiedAt: lm, // admitFile null-guards non-finite/zero
          createdAt: null, // unavailable for browser uploads
          uploadedBy: req.user.id,
          maxBytes: limitFor(f.originalname),
        });
        if (!admitted) {
          rejected.push({ name: f.originalname, reason: "unsupported file type" });
          continue;
        }
        const { entityId, itemId, file, status } = admitted;
        // Response rows mirror the /api/items entity shape (id = entity id).
        uploaded.push({
          id: entityId, name: file.name, status, tags: [],
          w: file.w, h: file.h, kind: file.kind, label: file.original_name,
          identity: file.name,
          uploadedBy: { id: req.user.id, name: req.user.name || null, email: req.user.email },
          instances: [{
            id: itemId, name: file.name, label: file.original_name,
            w: file.w, h: file.h, kind: file.kind,
            status, tags: [], undecided: false,
          }],
        });
      } catch (err) {
        console.error("upload error:", f.originalname, err.message);
        // err.reason marks a user-explainable refusal (e.g. PDF page cap)
        rejected.push({ name: f.originalname, reason: err.reason || "could not process file" });
      } finally {
        await fs.promises.unlink(f.path).catch(() => {});
      }
    }

    res.json({ uploaded, rejected });
  }));

  // Multer limit errors from the route above; anything else falls through
  // to the app's generic error handler.
  app.use((err, _req, res, next) => {
    if (err && err.code === "LIMIT_FILE_SIZE")
      return res.status(413).json({ error: `file too large (max ${Math.round(UPLOAD_HARD_CEILING / (1024 * 1024))} MB)` });
    if (err && err.code === "LIMIT_FILE_COUNT")
      return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
    next(err);
  });
}
