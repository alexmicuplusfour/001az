import express from "express";
import multer from "multer";
import sharp from "sharp";
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import {
  openDb,
  initDb,
  countImages,
  listImages,
  insertImage,
  deleteImage,
  reprocessImage,
  cancelBoardQueue,
  seedAdmin,
  createUser,
  listUsers,
  deleteUser,
  userExists,
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
  boardExists,
  boardImageStats,
  retagBoard,
  getBoardMemberIds,
  setBoardMembers,
  canAccessBoard,
  getImageBoard,
  setImageTags,
  getImageReasoning,
  getSetting,
  setSetting,
  listAiKeys,
  getAiKey,
  createAiKey,
  deleteAiKey,
  setThumbDimensions,
  listImagesMissingThumbDims,
} from "./db.js";
import {
  attachUser,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";
import { startWorker, invalidateBoardCache, invalidateAllBoardCaches, resolveDefaultAi } from "./worker.js";
import { testKey, PROVIDERS } from "./providers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://gallery:gallery@127.0.0.1:5433/gallery"; // local compose default
const STATIC_DIR = process.env.STATIC_DIR || ROOT; // local dev only; prod uses Caddy
const GALLERY_DIR = process.env.GALLERY_DIR || path.join(ROOT, "gallery");
const THUMBS_DIR = process.env.THUMBS_DIR || path.join(ROOT, "thumbnails");
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

const db = openDb(DATABASE_URL);
await initDb(db);
await seedAdmin(db, ADMIN_EMAIL);

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

// Express 4 doesn't forward rejected promises from async handlers; every
// async route goes through wrap() so a DB error becomes a 500, not a crash.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get("/api/health", wrap(async (_req, res) => {
  res.json({ ok: true, images: await countImages(db) });
}));

// --- auth ---
app.get("/api/me", (req, res) => {
  res.json(req.user ? { email: req.user.email, name: req.user.name, is_admin: !!req.user.is_admin } : null);
});

app.get("/auth/:token", wrap(async (req, res) => {
  const userId = await consumeInvite(db, req.params.token);
  if (!userId) return res.redirect("/?login=invalid");
  const sid = await createSession(db, userId);
  await touchLogin(db, userId);
  setSessionCookie(res, sid);
  console.log(`login: user #${userId}`);
  res.redirect("/");
}));

app.post("/api/logout", wrap(async (req, res) => {
  await deleteSession(db, req.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// --- favorites (any logged-in user) ---
app.post("/api/images/:id/favorite", requireAuth, wrap(async (req, res) => {
  const result = await toggleFavorite(db, req.user.id, Number(req.params.id));
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
}));

app.get("/api/images/:id/hearts", requireAuth, wrap(async (req, res) => {
  res.json({ names: await heartNames(db, Number(req.params.id)) });
}));

// --- crates (any logged-in user) ---
app.get("/api/crates", requireAuth, wrap(async (req, res) => {
  res.json(await listCrates(db, req.user.id, req.query.board || ""));
}));

app.post("/api/crates", requireAuth, wrap(async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const boardId = (req.body && req.body.board_id ? String(req.body.board_id) : "").trim();
  const crate = await createCrate(db, req.user.id, boardId, name);
  if (!crate) return res.status(400).json({ error: "invalid name" });
  res.json({ crate });
}));

app.delete("/api/crates/:id", requireAuth, wrap(async (req, res) => {
  if (!(await deleteCrate(db, req.user.id, Number(req.params.id))))
    return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

app.post("/api/crates/:id/images/:imageId", requireAuth, wrap(async (req, res) => {
  const result = await toggleCrateImage(db, req.user.id, Number(req.params.id), Number(req.params.imageId));
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
}));

// --- admin: manage collaborators ---
app.get("/api/admin/users", requireAdmin, wrap(async (_req, res) => {
  res.json(await listUsers(db));
}));

app.post("/api/admin/users", requireAdmin, wrap(async (req, res) => {
  const email = (req.body && req.body.email ? String(req.body.email) : "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid email" });
  const user = await createUser(db, email, req.body.name ? String(req.body.name).trim() : null);
  const token = await mintPermanentInvite(db, user.id);
  console.log(`invited ${user.email}`);
  res.json({ user: { id: user.id, email: user.email, name: user.name }, link: inviteLink(token) });
}));

app.post("/api/admin/users/:id/link", requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await userExists(db, id))) return res.status(404).json({ error: "not found" });
  res.json({ link: inviteLink(await mintPermanentInvite(db, id)) });
}));

app.delete("/api/admin/users/:id", requireAdmin, wrap(async (req, res) => {
  await deleteUser(db, Number(req.params.id));
  res.json({ ok: true });
}));

// --- boards ---
app.get("/api/boards", requireAuth, wrap(async (req, res) => {
  const all = await listBoards(db);
  const accessible = [];
  for (const b of all) if (await canAccessBoard(db, b.id, req.user)) accessible.push(b);
  res.json(accessible.map((b) => ({ id: b.id, name: b.name })));
}));

app.get("/api/boards/:id", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  res.json({
    id: board.id,
    name: board.name,
    facets: board.facets,
    context: board.context,
    ai_reasoning: board.ai_reasoning !== false,
  });
}));

app.get("/api/admin/boards", requireAdmin, wrap(async (_req, res) => {
  const boards = await listBoards(db);
  const stats = await boardImageStats(db);
  res.json(
    await Promise.all(
      boards.map(async (b) => ({
        ...b,
        image_count: stats[b.id]?.c || 0,
        pending_count: stats[b.id]?.p || 0,
        memberIds: await getBoardMemberIds(db, b.id),
      }))
    )
  );
}));

app.post("/api/admin/boards", requireAdmin, wrap(async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  let facets = [];
  if (req.body && req.body.facets !== undefined) {
    if (!Array.isArray(req.body.facets)) return res.status(400).json({ error: "facets must be an array" });
    facets = req.body.facets;
  }
  const context = req.body && req.body.context ? String(req.body.context) : "";
  const aiReasoning = !req.body || req.body.ai_reasoning !== false;
  let aiKeyId = null;
  if (req.body && req.body.ai_key_id != null) {
    aiKeyId = Number(req.body.ai_key_id);
    if (!(await getAiKey(db, aiKeyId))) return res.status(400).json({ error: "unknown ai_key_id" });
  }
  const aiModel = req.body && req.body.ai_model ? String(req.body.ai_model) : null;
  const id = await createBoard(db, name, facets, context, aiReasoning, aiKeyId, aiKeyId ? aiModel : null);
  console.log(`created board "${name}" ${id}`);
  res.json({ id, name, facets, context, ai_reasoning: aiReasoning });
}));

app.patch("/api/admin/boards/:id", requireAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  const update = {};
  if (req.body && req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body && req.body.facets !== undefined) {
    if (!Array.isArray(req.body.facets)) return res.status(400).json({ error: "facets must be an array" });
    update.facets = req.body.facets;
  }
  if (req.body && req.body.context !== undefined) update.context = String(req.body.context);
  if (req.body && req.body.ai_reasoning !== undefined) update.aiReasoning = !!req.body.ai_reasoning;
  if (req.body && req.body.ai_key_id !== undefined) {
    if (req.body.ai_key_id === null) {
      update.aiKeyId = null;
      update.aiModel = null; // model override is meaningless without a key
    } else {
      const keyId = Number(req.body.ai_key_id);
      if (!(await getAiKey(db, keyId))) return res.status(400).json({ error: "unknown ai_key_id" });
      update.aiKeyId = keyId;
    }
  }
  if (req.body && req.body.ai_model !== undefined && update.aiKeyId !== null) {
    update.aiModel = req.body.ai_model ? String(req.body.ai_model) : null;
  }
  if (Object.keys(update).length > 0) {
    if (!(await updateBoard(db, id, update))) return res.status(404).json({ error: "not found" });
  } else if (!(await getBoard(db, id))) {
    return res.status(404).json({ error: "not found" });
  }
  if (req.body && Array.isArray(req.body.memberIds)) {
    await setBoardMembers(db, id, req.body.memberIds.map(Number).filter(Boolean));
  }
  invalidateBoardCache(id);
  res.json({ ok: true });
}));

app.post("/api/admin/boards/:id/retag", requireAdmin, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const queued = await retagBoard(db, req.params.id);
  invalidateBoardCache(req.params.id);
  console.log(`retag queued: ${queued} image(s) in board ${req.params.id}`);
  res.json({ ok: true, queued });
}));

app.post("/api/admin/boards/:id/retag/cancel", requireAdmin, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const { restored, cleared } = await cancelBoardQueue(db, req.params.id);
  console.log(`retag cancelled: board ${req.params.id} — ${restored} restored, ${cleared} left untagged (undecided)`);
  res.json({ ok: true, cancelled: restored + cleared, restored, cleared });
}));

app.delete("/api/admin/boards/:id", requireAdmin, wrap(async (req, res) => {
  const filenames = await deleteBoard(db, req.params.id);
  if (filenames === null) return res.status(404).json({ error: "not found" });
  for (const fn of filenames) {
    fs.rmSync(path.join(GALLERY_DIR, fn), { force: true });
    fs.rmSync(path.join(THUMBS_DIR, fn + ".webp"), { force: true });
  }
  invalidateBoardCache(req.params.id);
  console.log(`deleted board ${req.params.id} + ${filenames.length} images`);
  res.json({ ok: true, deleted: filenames.length });
}));

// --- admin: AI tagger config (key registry + app default) ---
app.get("/api/admin/ai-keys", requireAdmin, wrap(async (_req, res) => {
  const keys = await listAiKeys(db);
  res.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      provider: k.provider,
      hint: "…" + String(k.api_key).slice(-4), // raw keys never leave the server
      boards_using: k.boards_using,
      created_at: k.created_at,
    }))
  );
}));

app.post("/api/admin/ai-keys", requireAdmin, wrap(async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim().slice(0, 64);
  const provider = req.body && req.body.provider ? String(req.body.provider) : "";
  const apiKey = (req.body && req.body.key ? String(req.body.key) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: "provider must be anthropic or openai" });
  if (!apiKey) return res.status(400).json({ error: "key required" });
  const id = await createAiKey(db, name, provider, apiKey);
  console.log(`ai-key added: "${name}" (${provider})`);
  res.json({ id, name, provider });
}));

app.delete("/api/admin/ai-keys/:id", requireAdmin, wrap(async (req, res) => {
  if (!(await deleteAiKey(db, Number(req.params.id)))) return res.status(404).json({ error: "not found" });
  // Boards that used the key fell back to default (FK SET NULL) — their
  // cached entries still carry the old key id.
  invalidateAllBoardCaches();
  console.log(`ai-key #${req.params.id} deleted by admin`);
  res.json({ ok: true });
}));

app.post("/api/admin/ai-keys/:id/test", requireAdmin, wrap(async (req, res) => {
  const key = await getAiKey(db, Number(req.params.id));
  if (!key) return res.status(404).json({ error: "not found" });
  const model = req.body && req.body.model ? String(req.body.model) : null;
  try {
    await testKey({ provider: key.provider, apiKey: key.api_key, model });
    res.json({ ok: true, provider: key.provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.get("/api/admin/ai-config", requireAdmin, wrap(async (_req, res) => {
  const defaultKeyId = Number(await getSetting(db, "default_key_id")) || null;
  const model = (await getSetting(db, "model")) || process.env.MODEL || "claude-haiku-4-5";
  res.json({ defaultKeyId, model, envKey: !!process.env.ANTHROPIC_API_KEY });
}));

app.post("/api/admin/ai-config", requireAdmin, wrap(async (req, res) => {
  const { model, defaultKeyId } = req.body || {};
  if (defaultKeyId !== undefined) {
    if (defaultKeyId === null) {
      await setSetting(db, "default_key_id", null);
    } else {
      const key = await getAiKey(db, Number(defaultKeyId));
      if (!key) return res.status(400).json({ error: "unknown key" });
      await setSetting(db, "default_key_id", String(key.id));
    }
  }
  if (model !== undefined) await setSetting(db, "model", model || null);
  console.log(`ai-config updated by admin: defaultKeyId=${defaultKeyId ?? "(unchanged)"} model=${model ?? "(unchanged)"}`);
  res.json({ ok: true });
}));

app.post("/api/admin/ai-config/test", requireAdmin, wrap(async (_req, res) => {
  const ai = await resolveDefaultAi(db);
  if (!ai) return res.status(400).json({ error: "No default API key configured" });
  try {
    await testKey(ai);
    res.json({ ok: true, model: ai.model, provider: ai.provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.get("/api/images", requireAuth, wrap(async (req, res) => {
  const boardId = req.query.board || null;
  if (!boardId || !(await canAccessBoard(db, boardId, req.user))) return res.json([]);
  res.json(await listImages(db, req.user.id, boardId));
}));

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

app.post("/api/upload", requireAuth, upload.array("files", MAX_FILES), wrap(async (req, res) => {
  const boardId = req.query.board || (req.body && req.body.board_id) || null;
  if (!boardId || !(await boardExists(db, boardId))) {
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

        const rowId = await insertImage(db, filename, f.originalname || filename, boardId);
        await setThumbDimensions(db, rowId, thumbInfo.width, thumbInfo.height);
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
}));

// The AI's per-facet justification for an image's tags. Kept out of the
// /api/images list payload — fetched lazily when the lightbox panel opens.
app.get("/api/images/:id/reasoning", requireAuth, wrap(async (req, res) => {
  const row = await getImageReasoning(db, Number(req.params.id));
  if (!row) return res.status(404).json({ error: "not found" });
  if (!(await canAccessBoard(db, row.board_id, req.user))) return res.status(403).json({ error: "forbidden" });
  res.json({ reasoning: row.tag_reasoning || {} });
}));

app.patch("/api/images/:id/tags", requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const tags = req.body && Array.isArray(req.body.tags) ? req.body.tags : null;
  if (!tags) return res.status(400).json({ error: "tags array required" });
  const image = await getImageBoard(db, id);
  if (!image) return res.status(404).json({ error: "not found" });
  if (!(await canAccessBoard(db, image.board_id, req.user))) return res.status(403).json({ error: "forbidden" });
  const board = await getBoard(db, image.board_id);
  const allowed = new Set();
  if (board) for (const f of board.facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const clean = tags.filter((t) => typeof t === "string" && allowed.has(t));
  await setImageTags(db, id, clean);
  res.json({ ok: true, tags: clean });
}));

app.delete("/api/images/:id", requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const filename = await deleteImage(db, id);
  if (!filename) return res.status(404).json({ error: "not found" });
  fs.rmSync(path.join(GALLERY_DIR, filename), { force: true });
  fs.rmSync(path.join(THUMBS_DIR, filename + ".webp"), { force: true });
  console.log(`deleted #${id} ${filename}`);
  res.json({ ok: true });
}));

app.post("/api/images/:id/reprocess", requireAuth, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await reprocessImage(db, id))) return res.status(404).json({ error: "not found" });
  console.log(`reprocess queued #${id}`);
  res.json({ ok: true, status: "pending" });
}));

// Uploaded originals + thumbnails live in GALLERY_DIR/THUMBS_DIR, which in the
// container sit outside STATIC_DIR — mount them explicitly. Filenames are
// random per upload and never reused, so long-lived caching is safe.
app.use("/gallery", express.static(GALLERY_DIR, { maxAge: "7d", immutable: true }));
app.use("/thumbnails", express.static(THUMBS_DIR, { maxAge: "7d", immutable: true }));

// Frontend assets (same-origin /api during host dev; in the container the app
// is the only file server and Caddy just proxies).
app.use(express.static(STATIC_DIR, { extensions: ["html"], cacheControl: false }));

// Upload/size error handler.
app.use((err, _req, res, _next) => {
  if (err && err.code === "LIMIT_FILE_SIZE")
    return res.status(413).json({ error: "file too large (max 10 MB)" });
  if (err && err.code === "LIMIT_FILE_COUNT")
    return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
  // Errors that carry a status (body-parser, multer field errors) keep it;
  // anything else is an unexpected failure (e.g. the DB) — log it, say 500.
  const status = err && (err.status || err.statusCode);
  if (status) return res.status(status).json({ error: err.message });
  console.error("unhandled route error:", err);
  res.status(500).json({ error: "server error" });
});

app.listen(PORT, HOST, () => {
  console.log(`API listening on http://${HOST}:${PORT}  (db: ${new URL(DATABASE_URL).host})`);
  startWorker({ db, thumbsDir: THUMBS_DIR });
  backfillThumbDimensions().catch((err) => console.error("thumb backfill error:", err.message));
});

async function backfillThumbDimensions() {
  const rows = await listImagesMissingThumbDims(db);
  if (!rows.length) return;
  console.log(`backfilling thumbnail dimensions for ${rows.length} image(s)...`);
  let done = 0;
  for (const row of rows) {
    try {
      const meta = await sharp(path.join(THUMBS_DIR, row.filename + ".webp")).metadata();
      if (meta.width && meta.height) {
        await setThumbDimensions(db, row.id, meta.width, meta.height);
        done++;
      }
    } catch {}
  }
  console.log(`thumbnail dimension backfill complete: ${done}/${rows.length}`);
}
