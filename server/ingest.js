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

// Backstop limits only — the client pre-filters oversized files and chunks
// large drops (see UPLOAD_* in app.js; keep UPLOAD_MAX_BYTES in sync). If
// multer still trips one of these, the whole request 413s.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 200; // per request

// Express 4 doesn't forward rejected promises from async handlers.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function mountIngest(app, { db, sources }) {
  // Disk-backed upload (bounded memory; we process one file at a time).
  const upload = multer({
    dest: os.tmpdir(),
    limits: { fileSize: MAX_BYTES, files: MAX_FILES },
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

    const uploaded = [];
    const rejected = [];
    let fileIdx = -1;
    for (const f of req.files || []) {
      fileIdx++;
      try {
        const file = await sources.forUpload(f.originalname).ingest(f.path, f.originalname);
        if (!file) {
          rejected.push({ name: f.originalname, reason: "unsupported file type" });
          continue;
        }
        // Stamp the date timestamps onto the stored entry so file-field values
        // (server/media) are a self-contained projection of payload.files —
        // recomputable at extract/backfill without re-opening the file.
        const lm = Number(lastModifieds[fileIdx]);
        file.addedAt = now;
        file.modifiedAt = Number.isFinite(lm) && lm > 0 ? lm : null;
        file.createdAt = null; // unavailable for browser uploads
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
        const entityId = await createEntity(db, board.id, { identity: file.name, uploadedBy: req.user.id });
        const id = await insertItem(db, board.id, payload, status, entityId);
        // Response rows mirror the /api/items entity shape (id = entity id).
        uploaded.push({
          id: entityId, name: file.name, status, tags: [],
          w: file.w, h: file.h, kind: file.kind, label: file.original_name,
          identity: file.name,
          uploadedBy: { id: req.user.id, name: req.user.name || null, email: req.user.email },
          instances: [{
            id, name: file.name, label: file.original_name,
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
      return res.status(413).json({ error: "file too large (max 10 MB)" });
    if (err && err.code === "LIMIT_FILE_COUNT")
      return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
    next(err);
  });
}
