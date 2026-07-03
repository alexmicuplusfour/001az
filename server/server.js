import express from "express";
import multer from "multer";
import sharp from "sharp";
import Anthropic from "@anthropic-ai/sdk";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  openDb,
  seedIfEmpty,
  listImages,
  deleteImage,
  reprocessImage,
  cancelBoardQueue,
  seedAdmin,
  createUser,
  listUsers,
  deleteUser,
  mintPermanentInvite,
  consumeInvite,
  createSession,
  deleteSession,
  touchLogin,
  toggleFavorite,
  heartNames,
  listCrates,
  createCrate,
  deleteCrate,
  toggleCrateImage,
  createBoard,
  listBoards,
  getBoard,
  updateBoard,
  deleteBoard,
  migrateOrphanImages,
  getBoardMemberIds,
  setBoardMembers,
  canAccessBoard,
  migrateInitialBoardMembers,
  migrateCratesPerBoard,
  getSetting,
  setSetting,
  setThumbDimensions,
} from "./db.js";
import {
  attachUser,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";
import { startWorker, invalidateBoardCache } from "./worker.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.db");
const TAGS_JSON = process.env.TAGS_JSON || path.join(ROOT, "tags.json");
const STATIC_DIR = process.env.STATIC_DIR || ROOT; // local dev only; prod uses Caddy
const GALLERY_DIR = process.env.GALLERY_DIR || path.join(ROOT, "gallery");
const THUMBS_DIR = process.env.THUMBS_DIR || path.join(ROOT, "thumbnails");
const FACETS_JSON = process.env.FACETS_JSON || path.join(ROOT, "facets.json");
const BASE_URL = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "";

// Backstop limits only — the client pre-filters oversized files and chunks
// large drops (see UPLOAD_* in app.js; keep UPLOAD_MAX_BYTES in sync). If
// multer still trips one of these, the whole request 413s.
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file
const MAX_FILES = 200; // per request
const THUMB_WIDTH = 600;
const SVG_RASTER_WIDTH = 2000; // SVG uploads are rasterized to WebP at this width
const MAX_PIXELS = 40e6; // decode cap: a 40MP image is ~160 MB of raw pixels

// The droplet is small (1 vCPU / 458 MB, no swap — node got OOM-killed under
// a concurrent bulk upload). Keep libvips lean: no operation cache holding
// decoded images, single worker thread.
sharp.cache(false);
sharp.concurrency(1);

// All upload image processing goes through this gate: decode strictly one
// image at a time process-wide, no matter how many requests are in flight.
let processGate = Promise.resolve();
function serializeProcessing(fn) {
  const run = processGate.then(fn);
  processGate = run.then(
    () => {},
    () => {}
  );
  return run;
}
const ALLOWED = { jpeg: "jpg", png: "png", webp: "webp", avif: "avif", heif: "avif", gif: "gif" };

fs.mkdirSync(GALLERY_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// --- live log capture: mirror console output into a ring buffer + SSE clients ---
const LOG_MAX = 500;
const logBuffer = [];
const logClients = new Set();

function emitLog(level, args) {
  const text = args.map((a) => (typeof a === "string" ? a : inspect(a, { depth: 3 }))).join(" ");
  const line = `${new Date().toISOString()} ${level} ${text}`;
  logBuffer.push(line);
  if (logBuffer.length > LOG_MAX) logBuffer.shift();
  const frame = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of logClients) {
    try {
      res.write(frame);
    } catch {
      /* client gone; cleaned up on close */
    }
  }
}

for (const level of ["log", "warn", "error"]) {
  const orig = console[level].bind(console);
  console[level] = (...args) => {
    orig(...args);
    emitLog(level.toUpperCase(), args);
  };
}

const db = openDb(DB_PATH);
const seeded = seedIfEmpty(db, TAGS_JSON);
if (seeded) console.log(`Seeded ${seeded} images from ${TAGS_JSON}`);
seedAdmin(db, ADMIN_EMAIL);
migrateOrphanImages(db, FACETS_JSON);
migrateInitialBoardMembers(db);
migrateCratesPerBoard(db);

const insertImage = db.prepare(
  `INSERT INTO images (filename, original_name, status, tags, board_id, created_at, updated_at)
   VALUES (?, ?, 'pending', '[]', ?, ?, ?)`
);

// Disk-backed upload (bounded memory; we process one file at a time).
const upload = multer({
  dest: os.tmpdir(),
  limits: { fileSize: MAX_BYTES, files: MAX_FILES },
});

const app = express();
app.disable("x-powered-by");
app.use(express.json());
app.use(attachUser(db));

const inviteLink = (token) => `${BASE_URL}/auth/${token}`;

app.get("/api/health", (_req, res) => {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM images").get();
  res.json({ ok: true, images: c });
});

// --- auth ---
app.get("/api/me", (req, res) => {
  res.json(req.user ? { email: req.user.email, name: req.user.name, is_admin: !!req.user.is_admin } : null);
});

app.get("/auth/:token", (req, res) => {
  const userId = consumeInvite(db, req.params.token);
  if (!userId) return res.redirect("/?login=invalid");
  const sid = createSession(db, userId);
  touchLogin(db, userId);
  setSessionCookie(res, sid);
  console.log(`login: user #${userId}`);
  res.redirect("/");
});

app.post("/api/logout", (req, res) => {
  deleteSession(db, req.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- favorites (any logged-in user) ---
app.post("/api/images/:id/favorite", requireAuth, (req, res) => {
  const result = toggleFavorite(db, req.user.id, Number(req.params.id));
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
});

app.get("/api/images/:id/hearts", requireAuth, (req, res) => {
  res.json({ names: heartNames(db, Number(req.params.id)) });
});

// --- crates (any logged-in user) ---
app.get("/api/crates", requireAuth, (req, res) => {
  res.json(listCrates(db, req.user.id, req.query.board || ""));
});

app.post("/api/crates", requireAuth, (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const boardId = (req.body && req.body.board_id ? String(req.body.board_id) : "").trim();
  const crate = createCrate(db, req.user.id, boardId, name);
  if (!crate) return res.status(400).json({ error: "invalid name" });
  res.json({ crate });
});

app.delete("/api/crates/:id", requireAuth, (req, res) => {
  if (!deleteCrate(db, req.user.id, Number(req.params.id)))
    return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

app.post("/api/crates/:id/images/:imageId", requireAuth, (req, res) => {
  const result = toggleCrateImage(db, req.user.id, Number(req.params.id), Number(req.params.imageId));
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
});

// --- admin: manage colleagues ---
app.get("/api/admin/users", requireAdmin, (_req, res) => {
  res.json(listUsers(db));
});

app.post("/api/admin/users", requireAdmin, (req, res) => {
  const email = (req.body && req.body.email ? String(req.body.email) : "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid email" });
  const user = createUser(db, email, req.body.name ? String(req.body.name).trim() : null);
  const token = mintPermanentInvite(db, user.id);
  console.log(`invited ${user.email}`);
  res.json({ user: { id: user.id, email: user.email, name: user.name }, link: inviteLink(token) });
});

app.post("/api/admin/users/:id/link", requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const user = db.prepare("SELECT id FROM users WHERE id=?").get(id);
  if (!user) return res.status(404).json({ error: "not found" });
  res.json({ link: inviteLink(mintPermanentInvite(db, id)) });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  deleteUser(db, Number(req.params.id));
  res.json({ ok: true });
});

// --- boards ---
app.get("/api/boards", requireAuth, (req, res) => {
  const all = listBoards(db);
  const accessible = all.filter((b) => canAccessBoard(db, b.id, req.user));
  res.json(accessible.map((b) => ({ id: b.id, name: b.name })));
});

app.get("/api/boards/:id", requireAuth, (req, res) => {
  const board = getBoard(db, req.params.id);
  if (!board || !canAccessBoard(db, board.id, req.user)) return res.status(404).json({ error: "not found" });
  res.json({ id: board.id, name: board.name, facets: board.facets, context: board.context });
});

app.get("/api/admin/boards", requireAdmin, (_req, res) => {
  const boards = listBoards(db);
  const counts = db.prepare("SELECT board_id, COUNT(*) AS c FROM images GROUP BY board_id").all();
  const countMap = Object.fromEntries(counts.map((r) => [r.board_id, r.c]));
  const pending = db
    .prepare("SELECT board_id, COUNT(*) AS c FROM images WHERE status='pending' GROUP BY board_id")
    .all();
  const pendingMap = Object.fromEntries(pending.map((r) => [r.board_id, r.c]));
  res.json(
    boards.map((b) => ({
      ...b,
      image_count: countMap[b.id] || 0,
      pending_count: pendingMap[b.id] || 0,
      memberIds: getBoardMemberIds(db, b.id),
    }))
  );
});

app.post("/api/admin/boards", requireAdmin, (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  let facets = [];
  if (req.body && req.body.facets !== undefined) {
    if (!Array.isArray(req.body.facets)) return res.status(400).json({ error: "facets must be an array" });
    facets = req.body.facets;
  }
  const context = req.body && req.body.context ? String(req.body.context) : "";
  const id = createBoard(db, name, facets, context);
  console.log(`created board "${name}" ${id}`);
  res.json({ id, name, facets, context });
});

app.patch("/api/admin/boards/:id", requireAdmin, (req, res) => {
  const id = req.params.id;
  const update = {};
  if (req.body && req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body && req.body.facets !== undefined) {
    if (!Array.isArray(req.body.facets)) return res.status(400).json({ error: "facets must be an array" });
    update.facets = req.body.facets;
  }
  if (req.body && req.body.context !== undefined) update.context = String(req.body.context);
  if (Object.keys(update).length > 0) {
    if (!updateBoard(db, id, update)) return res.status(404).json({ error: "not found" });
  } else if (!getBoard(db, id)) {
    return res.status(404).json({ error: "not found" });
  }
  if (req.body && Array.isArray(req.body.memberIds)) {
    setBoardMembers(db, id, req.body.memberIds.map(Number).filter(Boolean));
  }
  invalidateBoardCache(id);
  res.json({ ok: true });
});

app.post("/api/admin/boards/:id/retag", requireAdmin, (req, res) => {
  const board = getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const info = db
    .prepare(
      "UPDATE images SET status='pending', attempts=0, error=NULL, updated_at=? WHERE board_id=? AND status != 'pending'"
    )
    .run(Date.now(), req.params.id);
  invalidateBoardCache(req.params.id);
  console.log(`retag queued: ${info.changes} image(s) in board ${req.params.id}`);
  res.json({ ok: true, queued: info.changes });
});

app.post("/api/admin/boards/:id/retag/cancel", requireAdmin, (req, res) => {
  const board = getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const { restored, cleared } = cancelBoardQueue(db, req.params.id);
  console.log(`retag cancelled: board ${req.params.id} — ${restored} restored, ${cleared} left untagged (undecided)`);
  res.json({ ok: true, cancelled: restored + cleared, restored, cleared });
});

app.delete("/api/admin/boards/:id", requireAdmin, (req, res) => {
  const filenames = deleteBoard(db, req.params.id);
  if (filenames === null) return res.status(404).json({ error: "not found" });
  for (const fn of filenames) {
    fs.rmSync(path.join(GALLERY_DIR, fn), { force: true });
    fs.rmSync(path.join(THUMBS_DIR, fn + ".webp"), { force: true });
  }
  invalidateBoardCache(req.params.id);
  console.log(`deleted board ${req.params.id} + ${filenames.length} images`);
  res.json({ ok: true, deleted: filenames.length });
});

// --- admin: AI tagger config ---
app.get("/api/admin/ai-config", requireAdmin, (req, res) => {
  const dbModel = getSetting(db, "model");
  const dbKey = getSetting(db, "api_key");
  const model = dbModel || process.env.MODEL || "claude-haiku-4-5";
  const keySource = dbKey ? "db" : process.env.ANTHROPIC_API_KEY ? "env" : "none";
  res.json({ model, keySource, dbModel });
});

app.post("/api/admin/ai-config", requireAdmin, (req, res) => {
  const { model, apiKey } = req.body || {};
  if (model !== undefined) setSetting(db, "model", model || null);
  if (apiKey !== undefined && apiKey !== "") setSetting(db, "api_key", apiKey);
  console.log(`ai-config updated by admin: model=${model ?? "(unchanged)"}`);
  res.json({ ok: true });
});

app.delete("/api/admin/ai-config/key", requireAdmin, (req, res) => {
  setSetting(db, "api_key", null);
  console.log("ai-config: DB API key cleared by admin");
  res.json({ ok: true });
});

app.post("/api/admin/ai-config/test", requireAdmin, async (req, res) => {
  const apiKey = getSetting(db, "api_key") || process.env.ANTHROPIC_API_KEY;
  const model = getSetting(db, "model") || process.env.MODEL || "claude-haiku-4-5";
  if (!apiKey) return res.status(400).json({ error: "No API key configured" });
  try {
    const client = new Anthropic({ apiKey });
    await client.messages.countTokens({
      model,
      messages: [{ role: "user", content: "hi" }],
    });
    res.json({ ok: true, model });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/images", requireAuth, (req, res) => {
  const boardId = req.query.board || null;
  if (!boardId || !canAccessBoard(db, boardId, req.user)) return res.json([]);
  res.json(listImages(db, req.user.id, boardId));
});

// Live server logs via Server-Sent Events.
app.get("/api/logs/stream", requireAdmin, (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  for (const line of logBuffer) res.write(`data: ${JSON.stringify(line)}\n\n`);
  logClients.add(res);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);
  req.on("close", () => {
    clearInterval(heartbeat);
    logClients.delete(res);
  });
});

app.post("/api/upload", requireAuth, upload.array("files", MAX_FILES), async (req, res) => {
  const boardId = req.query.board || (req.body && req.body.board_id) || null;
  if (!boardId || !db.prepare("SELECT 1 FROM boards WHERE id=?").get(boardId)) {
    return res.status(400).json({ error: "valid board required" });
  }

  const files = req.files || [];
  const uploaded = [];
  const rejected = [];

  for (const f of files) {
    try {
      await serializeProcessing(async () => {
        let buf = await fs.promises.readFile(f.path);
        let meta = await sharp(buf, { pages: 1, limitInputPixels: MAX_PIXELS }).metadata();
        if (meta.format === "svg") {
          // Rasterize SVGs to WebP: vectors can embed scripts, so the original
          // markup is never stored or served. Render at high density, then cap.
          const density = Math.min(2400, Math.max(72, (72 * SVG_RASTER_WIDTH) / (meta.width || SVG_RASTER_WIDTH)));
          buf = await sharp(buf, { density, limitInputPixels: MAX_PIXELS })
            .resize({ width: SVG_RASTER_WIDTH, withoutEnlargement: true })
            .webp({ quality: 90 })
            .toBuffer();
          meta = await sharp(buf).metadata();
        }
        const ext = ALLOWED[meta.format];
        if (!ext) {
          rejected.push({ name: f.originalname, reason: "unsupported image type" });
          return;
        }
        const id = crypto.randomBytes(8).toString("hex");
        const filename = `${id}.${ext}`;
        const thumbInfo = await sharp(buf, { pages: 1, limitInputPixels: MAX_PIXELS })
          .rotate()
          .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
          .webp({ quality: 72 })
          .toFile(path.join(THUMBS_DIR, filename + ".webp"));
        await fs.promises.writeFile(path.join(GALLERY_DIR, filename), buf);

        const now = Date.now();
        const info = insertImage.run(filename, f.originalname || filename, boardId, now, now);
        const rowId = Number(info.lastInsertRowid);
        setThumbDimensions(db, rowId, thumbInfo.width, thumbInfo.height);
        uploaded.push({ id: rowId, name: filename, status: "pending", tags: [], w: thumbInfo.width, h: thumbInfo.height });
      });
    } catch (err) {
      console.error("upload error:", f.originalname, err.message);
      rejected.push({ name: f.originalname, reason: "could not process image" });
    } finally {
      await fs.promises.unlink(f.path).catch(() => {});
    }
  }

  res.json({ uploaded, rejected });
});

app.patch("/api/images/:id/tags", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const tags = req.body && Array.isArray(req.body.tags) ? req.body.tags : null;
  if (!tags) return res.status(400).json({ error: "tags array required" });
  const image = db.prepare("SELECT board_id FROM images WHERE id=?").get(id);
  if (!image) return res.status(404).json({ error: "not found" });
  if (!canAccessBoard(db, image.board_id, req.user)) return res.status(403).json({ error: "forbidden" });
  const board = getBoard(db, image.board_id);
  const allowed = new Set();
  if (board) for (const f of board.facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const clean = tags.filter((t) => typeof t === "string" && allowed.has(t));
  // A human made the call, so any AI "undecided" flag is resolved.
  db.prepare("UPDATE images SET status='tagged', tags=?, undecided=0, updated_at=? WHERE id=?").run(JSON.stringify(clean), Date.now(), id);
  res.json({ ok: true, tags: clean });
});

app.delete("/api/images/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const filename = deleteImage(db, id);
  if (!filename) return res.status(404).json({ error: "not found" });
  fs.rmSync(path.join(GALLERY_DIR, filename), { force: true });
  fs.rmSync(path.join(THUMBS_DIR, filename + ".webp"), { force: true });
  console.log(`deleted #${id} ${filename}`);
  res.json({ ok: true });
});

app.post("/api/images/:id/reprocess", requireAuth, (req, res) => {
  const id = Number(req.params.id);
  if (!reprocessImage(db, id)) return res.status(404).json({ error: "not found" });
  console.log(`reprocess queued #${id}`);
  res.json({ ok: true, status: "pending" });
});

// Local-dev static serving so fetch('/api/...') is same-origin while testing.
// In production Caddy serves these and only proxies /api/* here.
app.use(express.static(STATIC_DIR, { extensions: ["html"], cacheControl: false }));

// Upload/size error handler.
app.use((err, _req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: "file too large (max 10 MB)" });
  if (err && err.code === "LIMIT_FILE_COUNT")
    return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
  if (err) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: "server error" });
});

app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}  (db: ${DB_PATH})`);
  startWorker({ db, thumbsDir: THUMBS_DIR });
  backfillThumbDimensions();
});

async function backfillThumbDimensions() {
  const rows = db.prepare("SELECT id, filename FROM images WHERE thumb_w IS NULL").all();
  if (!rows.length) return;
  console.log(`backfilling thumbnail dimensions for ${rows.length} image(s)...`);
  let done = 0;
  for (const row of rows) {
    try {
      const meta = await sharp(path.join(THUMBS_DIR, row.filename + ".webp")).metadata();
      if (meta.width && meta.height) {
        setThumbDimensions(db, row.id, meta.width, meta.height);
        done++;
      }
    } catch {}
  }
  console.log(`thumbnail dimension backfill complete: ${done}/${rows.length}`);
}
