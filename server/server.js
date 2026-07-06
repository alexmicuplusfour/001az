import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import {
  openDb,
  initDb,
  countItems,
  listItems,
  deleteItem,
  reprocessItem,
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
  setCratePublic,
  toggleCrateItem,
  listFilterConfigs,
  saveFilterConfig,
  deleteFilterConfig,
  createBoard,
  listBoards,
  getBoard,
  updateBoard,
  deleteBoard,
  boardExists,
  boardItemStats,
  boardAiUsage,
  retagBoard,
  releaseHeld,
  queueUntagged,
  getBoardMemberIds,
  setBoardMembers,
  canAccessBoard,
  getItemBoard,
  setItemTags,
  getItemReasoning,
  getSetting,
  setSetting,
  listAiKeys,
  getAiKey,
  createAiKey,
  deleteAiKey,
  embeddingStats,
  boardEmbeddings,
} from "./db.js";
import {
  attachUser,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";
import { startWorker, invalidateBoardCache, invalidateAllBoardCaches, resolveDefaultAi, resolveEmbedder, nextAutoTagRun } from "./worker.js";
import { testKey, embedTexts, PROVIDERS, EMBED_PROVIDERS, PROVIDER_DEFAULT_EMBED_MODEL } from "./providers.js";
import { rateLimit } from "./ratelimit.js";
import { createRegistry } from "./types/index.js";
import imageType from "./types/image.js";

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

// Board types (see server/types/): core stays type-blind, adapters own
// ingestion, model input, and item-payload cleanup.
const registry = createRegistry({ db });
registry.register(imageType({ galleryDir: GALLERY_DIR, thumbsDir: THUMBS_DIR }));

const app = express();
app.disable("x-powered-by");
// Caddy terminates in front of us; trust one hop so req.ip is the client,
// not the proxy (rate limiting and request logs key on it).
app.set("trust proxy", 1);

// Security headers on every response. CSP notes: fonts come from Google Fonts;
// img needs data: (inline SVG chevron in admin.css) and blob: (upload
// placeholder object URLs); 'unsafe-inline' styles cover admin.html's style=""
// attrs and logs.html's <style> block. HSTS is Caddy's job (TLS lives there).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");
app.use((_req, res, next) => {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  next();
});

app.use(express.json());
app.use(attachUser(db));

// One access-log line per request, through console.log so it also reaches the
// live SSE viewer. Skips the long-lived log stream and static-asset noise
// (thumbnails etc.) unless they error.
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const p = req.path;
    if (p === "/api/logs/stream") return;
    if (res.statusCode < 400 && !(p.startsWith("/api") || p.startsWith("/auth"))) return;
    console.log(`${req.method} ${res.statusCode} ${Date.now() - start}ms ${p}`);
  });
  next();
});

// Throttle the unauthenticated login endpoint. Uploads are deliberately not
// rate-limited: bulk drops (1000+ images) arrive as many chunked requests
// from one IP, and auth plus per-request file limits already bound abuse.
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

const inviteLink = (token) => `${BASE_URL}/auth/${token}`;

// Express 4 doesn't forward rejected promises from async handlers; every
// async route goes through wrap() so a DB error becomes a 500, not a crash.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Item-scoped routes (/api/items/:id/*): resolve the item's board and enforce
// board access. Missing and forbidden both answer 404 so item ids can't be
// probed across boards. Attaches req.itemId / req.itemBoardId.
const requireItemAccess = wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  const item = Number.isInteger(id) && id > 0 ? await getItemBoard(db, id) : null;
  if (!item || !(await canAccessBoard(db, item.board_id, req.user)))
    return res.status(404).json({ error: "not found" });
  req.itemId = id;
  req.itemBoardId = item.board_id;
  next();
});

app.get("/api/health", wrap(async (_req, res) => {
  res.json({ ok: true, items: await countItems(db) });
}));

// --- auth ---
app.get("/api/me", (req, res) => {
  res.json(req.user ? { email: req.user.email, name: req.user.name, is_admin: !!req.user.is_admin } : null);
});

app.get("/auth/:token", authLimiter, wrap(async (req, res) => {
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

// --- favorites (members of the item's board) ---
app.post("/api/items/:id/favorite", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const result = await toggleFavorite(db, req.user.id, req.itemId);
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
}));

app.get("/api/items/:id/hearts", requireAuth, requireItemAccess, wrap(async (req, res) => {
  res.json({ names: await heartNames(db, req.itemId) });
}));

// --- crates (any logged-in user) ---
app.get("/api/crates", requireAuth, wrap(async (req, res) => {
  const boardId = (req.query.board || "").trim();
  if (!boardId || !(await boardExists(db, boardId)) || !(await canAccessBoard(db, boardId, req.user)))
    return res.status(404).json({ error: "board not found" });
  res.json(await listCrates(db, req.user.id, boardId));
}));

app.post("/api/crates", requireAuth, wrap(async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const boardId = (req.body && req.body.board_id ? String(req.body.board_id) : "").trim();
  // Existence first: canAccessBoard short-circuits true for admins, and a
  // missing board would otherwise surface as an FK error (500).
  if (!boardId || !(await boardExists(db, boardId)) || !(await canAccessBoard(db, boardId, req.user)))
    return res.status(404).json({ error: "board not found" });
  const crate = await createCrate(db, req.user.id, boardId, name);
  if (!crate) return res.status(400).json({ error: "invalid name" });
  res.json({ crate });
}));

app.delete("/api/crates/:id", requireAuth, wrap(async (req, res) => {
  if (!(await deleteCrate(db, req.user.id, Number(req.params.id))))
    return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

app.patch("/api/crates/:id", requireAuth, wrap(async (req, res) => {
  const crateId = Number(req.params.id);
  if (!Number.isInteger(crateId) || crateId <= 0) return res.status(404).json({ error: "not found" });
  if (typeof req.body?.public !== "boolean") return res.status(400).json({ error: "public required" });
  const crate = await setCratePublic(db, req.user.id, crateId, req.body.public);
  if (!crate) return res.status(404).json({ error: "not found" });
  res.json({ crate });
}));

app.post("/api/crates/:id/items/:itemId", requireAuth, wrap(async (req, res) => {
  const itemId = Number(req.params.itemId);
  const item = Number.isInteger(itemId) && itemId > 0 ? await getItemBoard(db, itemId) : null;
  if (!item || !(await canAccessBoard(db, item.board_id, req.user)))
    return res.status(404).json({ error: "not found" });
  const result = await toggleCrateItem(db, req.user.id, Number(req.params.id), itemId);
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
}));

// --- saved filter configs (any logged-in user) ---
app.get("/api/filter-configs", requireAuth, wrap(async (req, res) => {
  res.json(await listFilterConfigs(db, req.user.id, req.query.board || ""));
}));

app.post("/api/filter-configs", requireAuth, wrap(async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const boardId = (req.body && req.body.board_id ? String(req.body.board_id) : "").trim();
  if (!boardId || !(await boardExists(db, boardId)) || !(await canAccessBoard(db, boardId, req.user)))
    return res.status(404).json({ error: "board not found" });
  // config: { facetKey: [values] } — keep only that shape.
  const raw = req.body && typeof req.body.config === "object" && req.body.config ? req.body.config : {};
  const config = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!Array.isArray(v)) continue;
    const values = v.filter((x) => typeof x === "string").slice(0, 100);
    if (values.length) config[String(k).slice(0, 100)] = values;
  }
  if (!Object.keys(config).length) return res.status(400).json({ error: "empty config" });
  const saved = await saveFilterConfig(db, req.user.id, boardId, name, config);
  if (!saved) return res.status(400).json({ error: "invalid name" });
  res.json({ config: saved });
}));

app.delete("/api/filter-configs/:id", requireAuth, wrap(async (req, res) => {
  if (!(await deleteFilterConfig(db, req.user.id, Number(req.params.id))))
    return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

// --- admin: manage members ---
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
    type: board.type,
    facets: board.facets,
    context: board.context,
    ai_reasoning: board.ai_reasoning !== false,
    // tells the client whether to show the semantic search box
    search: !!(await resolveEmbedder(db)),
  });
}));

app.get("/api/admin/boards", requireAdmin, wrap(async (_req, res) => {
  const boards = await listBoards(db);
  const stats = await boardItemStats(db);
  const usage = await boardAiUsage(db);
  res.json(
    await Promise.all(
      boards.map(async (b) => ({
        ...b,
        item_count: stats[b.id]?.c || 0,
        pending_count: stats[b.id]?.p || 0,
        held_count: stats[b.id]?.h || 0,
        ai_usage: usage[b.id] || null,
        memberIds: await getBoardMemberIds(db, b.id),
      }))
    )
  );
}));

// Clamp a requested auto-tag interval to something sane; null when unparsable.
function parseEveryMin(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(n, 15), 60 * 24 * 28); // 15 min .. 4 weeks
}

// Registered board types + their suggested starter facets, for the create UI.
app.get("/api/admin/board-types", requireAdmin, (_req, res) => {
  res.json(registry.list());
});

app.post("/api/admin/boards", requireAdmin, wrap(async (req, res) => {
  const name = (req.body && req.body.name ? String(req.body.name) : "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  const type = req.body && req.body.type ? String(req.body.type) : "image";
  if (!registry.get(type)) return res.status(400).json({ error: `unknown board type "${type}"` });
  let facets = [];
  if (req.body && req.body.facets !== undefined) {
    if (!Array.isArray(req.body.facets)) return res.status(400).json({ error: "facets must be an array" });
    facets = req.body.facets;
  }
  const context = req.body && req.body.context ? String(req.body.context) : "";
  const aiReasoning = !req.body || req.body.ai_reasoning !== false;
  // off by default: research bills per web search, on top of tokens
  const aiResearch = !!(req.body && req.body.ai_research);
  let aiKeyId = null;
  if (req.body && req.body.ai_key_id != null) {
    aiKeyId = Number(req.body.ai_key_id);
    if (!(await getAiKey(db, aiKeyId))) return res.status(400).json({ error: "unknown ai_key_id" });
  }
  const aiModel = req.body && req.body.ai_model ? String(req.body.ai_model) : null;
  const autoTag = {
    enabled: !req.body || req.body.auto_tag !== false,
    periodic: !!(req.body && req.body.auto_tag_periodic),
    everyMin: (req.body && parseEveryMin(req.body.auto_tag_every_min)) || 1440,
    skipWeekends: !!(req.body && req.body.auto_tag_skip_weekends),
  };
  autoTag.nextRunAt = autoTag.enabled && autoTag.periodic
    ? nextAutoTagRun(Date.now(), autoTag.everyMin, autoTag.skipWeekends)
    : null;
  const id = await createBoard(db, name, facets, context, aiReasoning, aiKeyId, aiKeyId ? aiModel : null, autoTag, type, aiResearch);
  console.log(`created board "${name}" ${id} (${type})`);
  res.json({ id, name, type, facets, context, ai_reasoning: aiReasoning, ai_research: aiResearch });
}));

app.patch("/api/admin/boards/:id", requireAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  const prev = await getBoard(db, id);
  if (!prev) return res.status(404).json({ error: "not found" });
  const update = {};
  if (req.body && req.body.name !== undefined) update.name = String(req.body.name).trim();
  if (req.body && req.body.facets !== undefined) {
    if (!Array.isArray(req.body.facets)) return res.status(400).json({ error: "facets must be an array" });
    update.facets = req.body.facets;
  }
  if (req.body && req.body.context !== undefined) update.context = String(req.body.context);
  if (req.body && req.body.ai_reasoning !== undefined) update.aiReasoning = !!req.body.ai_reasoning;
  if (req.body && req.body.ai_research !== undefined) update.aiResearch = !!req.body.ai_research;
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
  if (req.body && req.body.auto_tag !== undefined) update.autoTag = !!req.body.auto_tag;
  if (req.body && req.body.auto_tag_periodic !== undefined) update.autoTagPeriodic = !!req.body.auto_tag_periodic;
  if (req.body && req.body.auto_tag_every_min !== undefined) {
    const m = parseEveryMin(req.body.auto_tag_every_min);
    if (m === null) return res.status(400).json({ error: "invalid auto_tag_every_min" });
    update.autoTagEveryMin = m;
  }
  if (req.body && req.body.auto_tag_skip_weekends !== undefined) update.autoTagSkipWeekends = !!req.body.auto_tag_skip_weekends;

  // Schedule bookkeeping: (re)arm the timer when the schedule turns on or
  // changes shape, disarm it when it turns off.
  const eff = {
    autoTag: update.autoTag ?? prev.auto_tag,
    periodic: update.autoTagPeriodic ?? prev.auto_tag_periodic,
    everyMin: update.autoTagEveryMin ?? prev.auto_tag_every_min,
    skipWeekends: update.autoTagSkipWeekends ?? prev.auto_tag_skip_weekends,
  };
  const wasScheduled = prev.auto_tag && prev.auto_tag_periodic;
  const isScheduled = eff.autoTag && eff.periodic;
  const shapeChanged = eff.everyMin !== prev.auto_tag_every_min || eff.skipWeekends !== prev.auto_tag_skip_weekends;
  if (isScheduled && (!wasScheduled || shapeChanged)) {
    update.autoTagNextRunAt = nextAutoTagRun(Date.now(), eff.everyMin, eff.skipWeekends);
  } else if (!isScheduled && prev.auto_tag_next_run_at !== null) {
    update.autoTagNextRunAt = null;
  }

  if (Object.keys(update).length > 0) await updateBoard(db, id, update);

  // The moment auto-tagging comes back on, sweep the board: queue everything
  // untagged — held uploads, AI-undecided, failed. Turning it off queues
  // nothing — uploads pile up as 'held', untagged, until tagging returns.
  if (eff.autoTag && !prev.auto_tag) {
    const n = await queueUntagged(db, id);
    if (n) console.log(`board ${id}: auto-tagging on — swept ${n} untagged item(s) into the queue`);
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
  console.log(`retag queued: ${queued} item(s) in board ${req.params.id}`);
  res.json({ ok: true, queued });
}));

// "Tag now" for a scheduled board: release held items without waiting for
// (or moving) the next scheduled run.
app.post("/api/admin/boards/:id/tag-held", requireAdmin, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const released = await releaseHeld(db, req.params.id);
  console.log(`tag-held: released ${released} held item(s) in board ${req.params.id}`);
  res.json({ ok: true, released });
}));

app.post("/api/admin/boards/:id/retag/cancel", requireAdmin, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const { restored, cleared } = await cancelBoardQueue(db, req.params.id);
  console.log(`retag cancelled: board ${req.params.id} — ${restored} restored, ${cleared} left untagged (undecided)`);
  res.json({ ok: true, cancelled: restored + cleared, restored, cleared });
}));

app.delete("/api/admin/boards/:id", requireAdmin, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id); // type needed after the rows are gone
  const payloads = await deleteBoard(db, req.params.id);
  if (payloads === null) return res.status(404).json({ error: "not found" });
  const adapter = registry.get(board?.type || "image");
  for (const payload of payloads) await adapter?.onDelete?.({ payload });
  invalidateBoardCache(req.params.id);
  console.log(`deleted board ${req.params.id} + ${payloads.length} items`);
  res.json({ ok: true, deleted: payloads.length });
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
  if (!PROVIDERS.includes(provider)) return res.status(400).json({ error: `provider must be one of: ${PROVIDERS.join(", ")}` });
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
  const embedder = await resolveEmbedder(db);
  const embed = {
    enabled: (await getSetting(db, "embed_enabled")) === "1",
    keyId: Number(await getSetting(db, "embed_key_id")) || null,
    model: (await getSetting(db, "embed_model")) || null,
    // Backfill progress against the model actually in effect (settings or
    // the provider default); zeros when not configured.
    stats: embedder ? await embeddingStats(db, embedder.model) : { tagged: 0, embedded: 0 },
  };
  res.json({ defaultKeyId, model, envKey: !!process.env.ANTHROPIC_API_KEY, embed });
}));

app.post("/api/admin/ai-config", requireAdmin, wrap(async (req, res) => {
  const { model, defaultKeyId, embedEnabled, embedKeyId, embedModel } = req.body || {};
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
  if (embedKeyId !== undefined) {
    if (embedKeyId === null) {
      await setSetting(db, "embed_key_id", null);
    } else {
      const key = await getAiKey(db, Number(embedKeyId));
      if (!key) return res.status(400).json({ error: "unknown key" });
      if (!EMBED_PROVIDERS.includes(key.provider)) {
        return res.status(400).json({ error: `embeddings need an ${EMBED_PROVIDERS.join(" or ")} key — ${key.provider} has no embeddings API` });
      }
      await setSetting(db, "embed_key_id", String(key.id));
    }
  }
  if (embedModel !== undefined) await setSetting(db, "embed_model", embedModel || null);
  if (embedEnabled !== undefined) {
    // embedKeyId was applied above, so this validates the final state.
    if (embedEnabled) {
      const keyId = Number(await getSetting(db, "embed_key_id")) || 0;
      const key = keyId ? await getAiKey(db, keyId) : null;
      if (!key || !EMBED_PROVIDERS.includes(key.provider)) {
        return res.status(400).json({ error: "pick an OpenAI or Gemini key before enabling semantic search" });
      }
    }
    await setSetting(db, "embed_enabled", embedEnabled ? "1" : null);
  }
  console.log(`ai-config updated by admin: defaultKeyId=${defaultKeyId ?? "(unchanged)"} model=${model ?? "(unchanged)"} embed=${embedEnabled ?? "(unchanged)"}`);
  res.json({ ok: true });
}));

// One tiny embedding call to prove the semantic-search config works end to end.
app.post("/api/admin/ai-config/embed-test", requireAdmin, wrap(async (_req, res) => {
  const embedder = await resolveEmbedder(db);
  if (!embedder) return res.status(400).json({ error: "semantic search is not enabled/configured" });
  try {
    await embedTexts({ ...embedder, texts: ["ping"] });
    res.json({ ok: true, provider: embedder.provider, model: embedder.model });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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

app.get("/api/items", requireAuth, wrap(async (req, res) => {
  const boardId = req.query.board || null;
  if (!boardId || !(await canAccessBoard(db, boardId, req.user))) return res.json([]);
  res.json(await listItems(db, req.user.id, boardId));
}));

// Semantic search: embed the query, dot-product against the board's stored
// vectors (all unit length, so dot = cosine), return ranked ids. The corpus
// is small enough to scan per request; the limiter is there because every
// call is one paid embedding request.
app.get("/api/search", requireAuth, rateLimit({ windowMs: 60 * 1000, max: 30 }), wrap(async (req, res) => {
  const boardId = req.query.board || "";
  if (!boardId || !(await canAccessBoard(db, boardId, req.user))) return res.status(404).json({ error: "not found" });
  const embedder = await resolveEmbedder(db);
  if (!embedder) return res.status(404).json({ error: "semantic search is not enabled" });
  const q = String(req.query.q || "").trim().slice(0, 500);
  if (!q) return res.json({ results: [] });
  const { vectors: [qv] } = await embedTexts({ ...embedder, texts: [q] });
  const scored = [];
  for (const row of await boardEmbeddings(db, boardId, embedder.model)) {
    const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    if (v.length !== qv.length) continue; // stale dims mid-model-change
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * qv[i];
    scored.push({ id: row.id, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  // Relative cutoff: keep everything within 0.15 of the best hit — absolute
  // cosine thresholds vary too much between models to hardcode one.
  const top = scored.length ? scored[0].score : 0;
  res.json({ results: scored.filter((x) => x.score >= top - 0.15).slice(0, 60) });
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

// The AI's per-facet justification for an item's tags. Kept out of the
// /api/items list payload — fetched lazily when the lightbox panel opens.
app.get("/api/items/:id/reasoning", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const row = await getItemReasoning(db, req.itemId);
  res.json({ reasoning: row?.tag_reasoning || {} });
}));

app.patch("/api/items/:id/tags", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const tags = req.body && Array.isArray(req.body.tags) ? req.body.tags : null;
  if (!tags) return res.status(400).json({ error: "tags array required" });
  const board = await getBoard(db, req.itemBoardId);
  const allowed = new Set();
  if (board) for (const f of board.facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const clean = tags.filter((t) => typeof t === "string" && allowed.has(t));
  await setItemTags(db, req.itemId, clean);
  res.json({ ok: true, tags: clean });
}));

app.delete("/api/items/:id", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const row = await deleteItem(db, req.itemId);
  if (!row) return res.status(404).json({ error: "not found" });
  const type = (await getBoard(db, row.board_id))?.type || "image";
  await registry.get(type)?.onDelete?.({ id: req.itemId, payload: row.payload });
  console.log(`deleted #${req.itemId} ${row.payload?.filename || ""}`.trim());
  res.json({ ok: true });
}));

app.post("/api/items/:id/reprocess", requireAuth, requireItemAccess, wrap(async (req, res) => {
  if (!(await reprocessItem(db, req.itemId))) return res.status(404).json({ error: "not found" });
  console.log(`reprocess queued #${req.itemId}`);
  res.json({ ok: true, status: "pending" });
}));

// Board-type routes: ingestion (/api/upload for images) + type-owned statics
// (/gallery, /thumbnails). Mounted before the frontend catch-all.
registry.mountAll(app);

// Frontend assets (same-origin /api during host dev; in the container the app
// is the only file server and Caddy just proxies).
app.use(express.static(STATIC_DIR, { extensions: ["html"], cacheControl: false }));

app.use((err, _req, res, _next) => {
  // Errors that carry a status (body-parser, multer field errors) keep it;
  // anything else is an unexpected failure (e.g. the DB) — log it, say 500.
  const status = err && (err.status || err.statusCode);
  if (status) return res.status(status).json({ error: err.message });
  console.error("unhandled route error:", err);
  res.status(500).json({ error: "server error" });
});

// Run as a server only when executed directly (node server/server.js). Under
// test the module is imported for its `app`/`db` exports: schema + admin seed
// run at import (against the test DATABASE_URL), but nothing listens and the
// tagging worker stays off.
const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  const server = app.listen(PORT, HOST, () => {
    console.log(`API listening on http://${HOST}:${PORT}  (db: ${new URL(DATABASE_URL).host})`);
  });
  const stopWorker = startWorker({ db, registry });

  // Graceful shutdown. In the container node is PID 1, which ignores signals
  // it has no handler for — without this, every `docker stop` waits out the
  // grace period and SIGKILLs mid-tag. Order: stop claiming work, close the
  // listener (SSE streams would hold it open forever, so end those and drop
  // lingering keep-alives), let an in-flight tag finish (bounded), then end
  // the pool.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal}: shutting down`);
    const drained = stopWorker();
    server.close();
    for (const res of logClients) res.end();
    server.closeAllConnections();
    await Promise.race([drained, new Promise((r) => setTimeout(r, 5000).unref())]);
    await db.end();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app, db, registry };
