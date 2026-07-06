// The one upload door: files arrive here, a source handler (by file type)
// turns each into a stored file entry, and the item is created with the
// generic payload ({ identity, files, fields }). Raw identity = the stored
// filename. Images and documents (pdf/txt/md/csv) are accepted; new file
// types plug in as new source handlers, this route stays format-blind.
import multer from "multer";
import fs from "node:fs";
import os from "node:os";
import { getBoard, canAccessBoard, insertItem } from "./db.js";
import { requireAuth } from "./auth.js";

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

    const uploaded = [];
    const rejected = [];
    for (const f of req.files || []) {
      try {
        const file = await sources.forUpload(f.originalname).ingest(f.path, f.originalname);
        if (!file) {
          rejected.push({ name: f.originalname, reason: "unsupported file type" });
          continue;
        }
        // Uploads to a board with auto-tagging off wait as 'held'.
        const status = board.auto_tag ? "pending" : "held";
        const id = await insertItem(db, board.id, { identity: file.name, files: [file], fields: {} }, status);
        uploaded.push({
          id, name: file.name, status, tags: [],
          w: file.w, h: file.h, kind: file.kind, label: file.original_name,
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
