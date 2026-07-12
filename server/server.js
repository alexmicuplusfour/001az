import express from "express";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import {
  openDb,
  initDb,
  countItems,
  listItems,
  listEntityIds,
  deleteEntity,
  deleteInstance,
  deleteEntityIfEmpty,
  reprocessEntity,
  getEntityBoard,
  entityInstanceCount,
  createEntity,
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
  getBoardAdminIds,
  setBoardMembers,
  canAccessBoard,
  canManageBoard,
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
  listItemPayloads,
  boardItemPayloads,
  updateItemPayload,
  updateItemPayloads,
  reextractItem,
  retagItem,
  insertItem,
  setEntityRefreshAt,
  rescheduleEntityRefreshes,
  boardEntityIdentities,
  getBoardTokenTotal,
} from "./db.js";
import {
  attachUser,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
} from "./auth.js";
import { startWorker, invalidateBoardCache, invalidateAllBoardCaches, resolveDefaultAi, resolveEmbedder, nextAutoTagRun } from "./worker.js";
import { testKey, embedTexts, providerCatalog, PROVIDERS } from "./providers.js";
import { rateLimit } from "./ratelimit.js";
import { createSources } from "./sources/index.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { liveFields, nextRefreshAt, faceCadence } from "./connectors/runtime.js";
import { mediaCatalog, getMediaField, extractFileFields } from "./media/index.js";
import { mountIngest } from "./ingest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://gallery:gallery@127.0.0.1:5433/gallery"; // local compose default
const STATIC_DIR = process.env.STATIC_DIR || path.join(ROOT, "public"); // frontend assets; the app serves them in every env (Caddy just proxies)
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

// Source handlers (server/sources/): store originals + faces (thumbnails)
// and clean them up on delete. The upload route itself is core (ingest.js).
const sources = createSources({ galleryDir: GALLERY_DIR, thumbsDir: THUMBS_DIR });

const app = express();
app.disable("x-powered-by");
// Caddy terminates in front of us; trust one hop so req.ip is the client,
// not the proxy (rate limiting and request logs key on it).
app.set("trust proxy", 1);

// Security headers on every response. CSP notes: fonts come from Google Fonts;
// img needs data: (inline SVG chevron in admin.css) and blob: (upload
// placeholder object URLs); 'unsafe-inline' styles cover admin.html's style=""
// attrs and logs.html's <style> block. frame-ancestors is 'self', not 'none':
// the lightbox renders /gallery documents in a same-origin frame — external
// embedding stays blocked. HSTS is Caddy's job (TLS lives there).
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
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
    if (res.statusCode < 400 && !(p.startsWith("/api/") || p.startsWith("/auth/"))) return;
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

// Entity-scoped routes (/api/items/:id/*, where the id is a card = entity):
// resolve the entity's board and enforce board access. Missing and forbidden
// both answer 404 so ids can't be probed across boards. Attaches
// req.entityId / req.entityBoardId.
const requireEntityAccess = wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  const ent = Number.isInteger(id) && id > 0 ? await getEntityBoard(db, id) : null;
  if (!ent || !(await canAccessBoard(db, ent.board_id, req.user)))
    return res.status(404).json({ error: "not found" });
  req.entityId = id;
  req.entityBoardId = ent.board_id;
  next();
});

// Instance-scoped routes (/api/instances/:id/*): same contract against the
// items table. Attaches req.itemId / req.itemBoardId.
const requireItemAccess = wrap(async (req, res, next) => {
  const id = Number(req.params.id);
  const item = Number.isInteger(id) && id > 0 ? await getItemBoard(db, id) : null;
  if (!item || !(await canAccessBoard(db, item.board_id, req.user)))
    return res.status(404).json({ error: "not found" });
  req.itemId = id;
  req.itemBoardId = item.board_id;
  next();
});

// Board-manager routes (/api/boards/:id content edits): the current user must be
// a global admin or this board's board-admin. Missing board → 404, forbidden →
// 403. Attaches req.board so the handler needn't refetch.
const requireBoardManager = wrap(async (req, res, next) => {
  const board = await getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  if (!(await canManageBoard(db, board.id, req.user)))
    return res.status(403).json({ error: "forbidden" });
  req.board = board;
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

// --- favorites (members of the entity's board; hearts are entity-level) ---
app.post("/api/items/:id/favorite", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  const result = await toggleFavorite(db, req.user.id, req.entityId);
  if (!result) return res.status(404).json({ error: "not found" });
  res.json(result);
}));

app.get("/api/items/:id/hearts", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  res.json({ names: await heartNames(db, req.entityId) });
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
  const [canManage, tokenTotal, embeddingOk] = await Promise.all([
    canManageBoard(db, board.id, req.user),
    getBoardTokenTotal(db, board.id),
    resolveEmbedder(db).then(Boolean),
  ]);
  res.json({
    id: board.id,
    name: board.name,
    facets: board.facets,
    context: board.context,
    ai_reasoning: board.ai_reasoning !== false,
    mapping: board.mapping || null,
    search: embeddingOk,
    manage: canManage,
    token_total: tokenTotal,
  });
}));

// Just the token total — polled by the live token chip while tagging runs, so
// the count ticks up without re-fetching the whole board payload.
app.get("/api/boards/:id/tokens", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  res.json({ token_total: await getBoardTokenTotal(db, board.id) });
}));

// Board-manager content editing — the gallery's "edit board" modal. A global
// admin or this board's board-admin (requireBoardManager). Content only for
// board-admins; global admins also receive the AI override used by this modal.
app.get("/api/boards/:id/settings", requireAuth, requireBoardManager, wrap(async (req, res) => {
  const b = req.board;
  res.json({
    id: b.id,
    name: b.name,
    facets: b.facets,
    context: b.context,
    ai_reasoning: b.ai_reasoning !== false,
    ai_research: b.ai_research === true,
    auto_tag: b.auto_tag !== false,
    auto_tag_periodic: !!b.auto_tag_periodic,
    auto_tag_every_min: b.auto_tag_every_min || 1440,
    auto_tag_skip_weekends: !!b.auto_tag_skip_weekends,
    retag_on_refresh: !!b.retag_on_refresh,
    ...(req.user.is_admin ? {
      ai_key_id: b.ai_key_id ?? null,
      ai_model: b.ai_model ?? null,
      extract_key_id: b.extract_key_id ?? null,
      extract_model: b.extract_model ?? null,
    } : {}),
  });
}));

app.patch("/api/boards/:id", requireAuth, requireBoardManager, wrap(async (req, res) => {
  const prev = req.board;
  const { update, error, sweep } = buildBoardContentUpdate(req.body, prev);
  if (error) return res.status(400).json({ error });
  if (Object.keys(update).length > 0) await updateBoard(db, prev.id, update);
  if (sweep) {
    const n = await queueUntagged(db, prev.id);
    if (n) console.log(`board ${prev.id}: auto-tagging on — swept ${n} untagged item(s) into the queue`);
  }
  invalidateBoardCache(prev.id);
  res.json({ ok: true });
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
        adminIds: await getBoardAdminIds(db, b.id),
      }))
    )
  );
}));

// The content-editable board fields shared by the admin PATCH and the
// board-manager PATCH: name, context, facets, the reasoning/research toggles,
// and the auto-tag schedule (with the timer bookkeeping). Returns
// { update, error, sweep } — error is a string when the body is invalid, sweep
// is true when auto-tagging transitions off→on (caller queues untagged items).
function buildBoardContentUpdate(body = {}, prev) {
  body = body || {};
  const update = {};
  if (body.name !== undefined) update.name = String(body.name).trim();
  if (body.facets !== undefined) {
    if (!Array.isArray(body.facets)) return { error: "facets must be an array" };
    update.facets = body.facets;
  }
  if (body.context !== undefined) update.context = String(body.context);
  if (body.ai_reasoning !== undefined) update.aiReasoning = !!body.ai_reasoning;
  if (body.ai_research !== undefined) update.aiResearch = !!body.ai_research;
  if (body.auto_tag !== undefined) update.autoTag = !!body.auto_tag;
  if (body.auto_tag_periodic !== undefined) update.autoTagPeriodic = !!body.auto_tag_periodic;
  if (body.auto_tag_every_min !== undefined) {
    const m = parseEveryMin(body.auto_tag_every_min);
    if (m === null) return { error: "invalid auto_tag_every_min" };
    update.autoTagEveryMin = m;
  }
  if (body.auto_tag_skip_weekends !== undefined) update.autoTagSkipWeekends = !!body.auto_tag_skip_weekends;
  if (body.retag_on_refresh !== undefined) update.retagOnRefresh = !!body.retag_on_refresh;

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

  return { update, error: null, sweep: eff.autoTag && !prev.auto_tag };
}

// Clamp a requested auto-tag interval to something sane; null when unparsable.
function parseEveryMin(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(n, 15), 60 * 24 * 28); // 15 min .. 4 weeks
}

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
  const id = await createBoard(db, name, facets, context, aiReasoning, aiKeyId, aiKeyId ? aiModel : null, autoTag, aiResearch);
  console.log(`created board "${name}" ${id}`);
  res.json({ id, name, facets, context, ai_reasoning: aiReasoning, ai_research: aiResearch });
}));

const MAPPING_KINDS = new Set(["text", "number", "url", "date"]);
// Returns an error string when mapping is invalid, null when valid.
function validateMapping(mapping) {
  // Optional input slot: "files" | { connector: name }
  if (mapping.input !== undefined && mapping.input !== "files") {
    if (!mapping.input || typeof mapping.input !== "object" || typeof mapping.input.connector !== "string")
      return `mapping.input must be "files" or { connector: name }`;
    if (!getConnector(mapping.input.connector))
      return `unknown connector: "${mapping.input.connector}"`;
  }
  // Optional identity slot.
  if (mapping.identity !== undefined) {
    const id = mapping.identity;
    if (!id || typeof id !== "object") return "mapping.identity must be an object";
    if (id.from !== "raw" && id.from !== "ai" && id.from !== "connector")
      return `mapping.identity.from must be "raw", "ai", or "connector"`;
    if (id.from === "ai" && (!id.hint || typeof id.hint !== "string" || !id.hint.trim()))
      return `mapping.identity.hint is required when from is "ai"`;
    if (id.hint !== undefined && (typeof id.hint !== "string" || id.hint.length > 500))
      return `mapping.identity.hint must be a string ≤500 chars`;
  }
  if (!Array.isArray(mapping.fields)) return "mapping.fields must be an array";
  // The cap is on AI fields only — they generate the extraction schema. Connector
  // and file fields are deterministic (bounded by their catalogs) and excluded
  // from the record_fields tool, so they don't count against it.
  if (mapping.fields.filter((f) => f.from === "ai").length > 12)
    return "mapping may have at most 12 AI fields";
  const seen = new Set();
  for (const f of mapping.fields) {
    if (!f.key || typeof f.key !== "string" || !/^[a-z][a-z0-9_]*$/.test(f.key))
      return `invalid field key: ${JSON.stringify(f.key)}`;
    if (seen.has(f.key)) return `duplicate field key: ${f.key}`;
    // "identity" is the identity slot's key in the record_fields schema — a
    // field with the same name would silently overwrite it there.
    if (f.key === "identity") return `field key "identity" is reserved for the identity slot`;
    seen.add(f.key);
    if (!MAPPING_KINDS.has(f.kind)) return `invalid kind "${f.kind}" for field "${f.key}"`;
    if (f.from !== "ai" && f.from !== "connector" && f.from !== "file")
      return `unsupported source "${f.from}" for field "${f.key}"`;
    if (f.from === "ai" && f.hint !== undefined && (typeof f.hint !== "string" || f.hint.length > 500))
      return `hint for field "${f.key}" must be a string ≤500 chars`;
    if (f.from === "connector" && (!f.fn || typeof f.fn !== "string"))
      return `connector field "${f.key}" requires a fn string`;
    // File fields (from:"file"): a deterministic media-metadata projection.
    // Only on file boards (no connector input), fn must be a known media field,
    // and its kind must match the catalog descriptor.
    if (f.from === "file") {
      if (mapping.input && mapping.input !== "files")
        return `file field "${f.key}" is only valid on a files board`;
      const desc = f.fn ? getMediaField(f.fn) : null;
      if (!desc) return `unknown file field fn "${f.fn}" for "${f.key}"`;
      if (f.kind !== desc.kind) return `file field "${f.key}" must have kind "${desc.kind}"`;
    }
    // Per-field liveness (slice 5c): connector fields only; `every` is minutes.
    if (f.live !== undefined) {
      if (typeof f.live !== "boolean") return `"live" for field "${f.key}" must be a boolean`;
      if (f.live && f.from !== "connector") return `only connector fields can be live ("${f.key}")`;
      if (f.live && (!Number.isInteger(f.every) || f.every < 1 || f.every > 43200))
        return `live field "${f.key}" needs an integer "every" in minutes (1–43200)`;
    }
  }
  // Optional face slot (slice 5d): the entity's card visual.
  if (mapping.face !== undefined) {
    const fc = mapping.face;
    if (!fc || typeof fc !== "object") return "mapping.face must be an object";
    if (fc.from !== "raw" && fc.from !== "connector") return `mapping.face.from must be "raw" or "connector"`;
    if (fc.from === "connector") {
      const conn = getConnector(mapping.input?.connector);
      if (!conn) return "a connector face requires a connector input";
      const producer = (conn.manifest.faces || []).find((p) => p.name === fc.producer);
      if (!producer) return `unknown face producer "${fc.producer}"`;
      if (fc.period !== undefined && !producer.periods.includes(fc.period))
        return `invalid period "${fc.period}" for face "${fc.producer}"`;
      if (fc.live !== undefined) {
        if (typeof fc.live !== "boolean") return `face "live" must be a boolean`;
        if (fc.live && (!Number.isInteger(fc.every) || fc.every < 1 || fc.every > 43200))
          return `live face needs an integer "every" in minutes (1–43200)`;
      }
    }
  }
  return null;
}

// Re-project file-metadata fields (server/media) over a board's existing
// instances after its file-field set changes: strip the previously-projected
// file fields, add the current ones, leave AI fields alone. Pure projection of
// each stored payload entry — no file is re-opened. Writes only on a real change.
async function backfillFileFields(boardId, mapping) {
  const mappingFields = (mapping && mapping.fields) || [];
  const wantsFileFields = mappingFields.some((f) => f.from === "file");
  const items = await boardItemPayloads(db, boardId);

  // Legacy entries (uploaded before file fields) carry no size/meta; re-derive it
  // once from the stored file (header-only reads) so their file fields aren't all
  // null. The reads are independent, so run them concurrently rather than one at a
  // time — this is the bulk of the wait on a board's first file-field save.
  const needsEnrich = items.map((it) => {
    const entry = it.payload?.files?.[0];
    return wantsFileFields && !!entry && entry.meta === undefined;
  });
  const metas = await Promise.all(items.map((it, i) =>
    needsEnrich[i] ? sources.metaFor(it.payload.files[0]) : null
  ));

  const patches = []; // [{ id, patch }] — flushed in a single bulk write below.
  items.forEach((it, i) => {
    let entry = it.payload?.files?.[0];
    if (!entry) return; // fileless (connector tag vehicle) — nothing to project
    // The enriched entry is persisted, so the header read is paid once. `added`
    // falls back to the item's created_at (modified/created were never captured).
    let enrichedEntry = false;
    if (needsEnrich[i]) {
      const m = metas[i];
      entry = { ...entry, size: m?.size ?? null, meta: m?.meta || {}, addedAt: entry.addedAt ?? it.created_at ?? null };
      enrichedEntry = true;
    }
    const existing = it.payload?.fields || {};
    const kept = {};
    for (const [k, v] of Object.entries(existing)) if (v?.src !== "file") kept[k] = v;
    const merged = { ...kept, ...extractFileFields(entry, mappingFields) };
    if (enrichedEntry) {
      const files = [...it.payload.files];
      files[0] = entry;
      patches.push({ id: it.id, patch: { files, fields: merged } });
    } else if (JSON.stringify(merged) !== JSON.stringify(existing)) {
      patches.push({ id: it.id, patch: { fields: merged } });
    }
  });

  // One bulk write instead of a round-trip per changed item.
  await updateItemPayloads(db, patches);
}

app.patch("/api/admin/boards/:id", requireAdmin, wrap(async (req, res) => {
  const id = req.params.id;
  const prev = await getBoard(db, id);
  if (!prev) return res.status(404).json({ error: "not found" });
  const { update, error, sweep } = buildBoardContentUpdate(req.body, prev);
  if (error) return res.status(400).json({ error });

  // Admin-only fields, layered on top of the shared content set.
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
  if (req.body && req.body.extract_key_id !== undefined) {
    if (req.body.extract_key_id === null) {
      update.extractKeyId = null;
      update.extractModel = null;
    } else {
      const keyId = Number(req.body.extract_key_id);
      if (!(await getAiKey(db, keyId))) return res.status(400).json({ error: "unknown extract_key_id" });
      update.extractKeyId = keyId;
    }
  }
  if (req.body && req.body.extract_model !== undefined && update.extractKeyId !== null) {
    update.extractModel = req.body.extract_model ? String(req.body.extract_model) : null;
  }
  if (req.body && req.body.mapping !== undefined) {
    if (req.body.mapping === null) {
      update.mapping = null;
    } else if (typeof req.body.mapping !== "object") {
      return res.status(400).json({ error: "mapping must be an object or null" });
    } else {
      const err = validateMapping(req.body.mapping);
      if (err) return res.status(400).json({ error: err });
      update.mapping = req.body.mapping;
    }
  }

  if (Object.keys(update).length > 0) await updateBoard(db, id, update);

  // A mapping change can turn fields live/idle or move their cadence — recompute
  // every entity's next refresh (empty live set clears their schedules).
  if (update.mapping !== undefined) {
    await rescheduleEntityRefreshes(db, id, liveFields(update.mapping), faceCadence(update.mapping));
    // File-field set changed → re-project deterministic metadata for existing
    // instances (add/remove file fields in place; AI fields untouched). Only for
    // file boards; connector items have no file entry so they'd no-op anyway.
    const m = update.mapping;
    if (m === null || !m.input || m.input === "files") await backfillFileFields(id, m);
  }

  // The moment auto-tagging comes back on, sweep the board: queue everything
  // untagged — held uploads, AI-undecided, failed. Turning it off queues
  // nothing — uploads pile up as 'held', untagged, until tagging returns.
  if (sweep) {
    const n = await queueUntagged(db, id);
    if (n) console.log(`board ${id}: auto-tagging on — swept ${n} untagged item(s) into the queue`);
  }

  if (req.body && Array.isArray(req.body.memberIds)) {
    const adminIds = Array.isArray(req.body.adminIds) ? req.body.adminIds.map(Number).filter(Boolean) : [];
    await setBoardMembers(db, id, req.body.memberIds.map(Number).filter(Boolean), adminIds);
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
  const payloads = await deleteBoard(db, req.params.id);
  if (payloads === null) return res.status(404).json({ error: "not found" });
  for (const payload of payloads) sources.cleanup(payload?.files);
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
  if (!(provider in PROVIDERS)) return res.status(400).json({ error: `provider must be one of: ${Object.keys(PROVIDERS).join(", ")}` });
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

// Provider catalog (labels, model lists + notes, defaults, capabilities). The
// admin UI renders its provider/model pickers from this instead of hardcoding
// them, so a new provider needs no client edit.
app.get("/api/admin/ai-providers", requireAdmin, wrap(async (_req, res) => {
  res.json(providerCatalog());
}));

app.get("/api/admin/ai-config", requireAdmin, wrap(async (_req, res) => {
  const defaultKeyId = Number(await getSetting(db, "default_key_id")) || null;
  const model = (await getSetting(db, "model")) || process.env.MODEL || "claude-haiku-4-5";
  const embedder = await resolveEmbedder(db);
  const embed = {
    enabled: (await getSetting(db, "embed_enabled")) === "1",
    provider: (await getSetting(db, "embed_provider")) || null,
    keyId: Number(await getSetting(db, "embed_key_id")) || null,
    model: (await getSetting(db, "embed_model")) || null,
    // Backfill progress against the model actually in effect (settings or
    // the provider default); zeros when not configured.
    stats: embedder ? await embeddingStats(db, embedder.model) : { tagged: 0, embedded: 0, failed: 0 },
  };
  res.json({ defaultKeyId, model, envKey: !!process.env.ANTHROPIC_API_KEY, embed });
}));

app.post("/api/admin/ai-config", requireAdmin, wrap(async (req, res) => {
  const { model, defaultKeyId, embedEnabled, embedKeyId, embedModel, embedProvider } = req.body || {};
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
  // Explicit provider selection: 'local' (keyless) or null (key-based).
  if (embedProvider !== undefined) {
    if (embedProvider === "local") {
      await setSetting(db, "embed_provider", "local");
      await setSetting(db, "embed_key_id", null);
      await setSetting(db, "embed_model", null);
    } else {
      await setSetting(db, "embed_provider", null);
    }
  }
  // Key-based path (skipped when embedProvider === 'local').
  if (embedKeyId !== undefined && embedProvider !== "local") {
    if (embedKeyId === null) {
      await setSetting(db, "embed_key_id", null);
    } else {
      const key = await getAiKey(db, Number(embedKeyId));
      if (!key) return res.status(400).json({ error: "unknown key" });
      if (!PROVIDERS[key.provider]?.embeds) {
        const names = Object.keys(PROVIDERS).filter((n) => PROVIDERS[n].embeds && !PROVIDERS[n].keyless).join(" or ");
        return res.status(400).json({ error: `embeddings need an ${names} key — ${key.provider} has no embeddings API` });
      }
      await setSetting(db, "embed_key_id", String(key.id));
    }
  }
  if (embedModel !== undefined) await setSetting(db, "embed_model", embedModel || null);
  if (embedEnabled !== undefined) {
    if (embedEnabled) {
      // Validate final state: local is always valid; key-based needs a good key.
      const ep = await getSetting(db, "embed_provider");
      if (ep !== "local") {
        const keyId = Number(await getSetting(db, "embed_key_id")) || 0;
        const key = keyId ? await getAiKey(db, keyId) : null;
        if (!key || !PROVIDERS[key.provider]?.embeds) {
          return res.status(400).json({ error: "pick Local, OpenAI, or Gemini before enabling semantic search" });
        }
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

// --- connector config (admin: which data provider backs each connector) ---
// Settings keys are per connector: `${name}_provider` and `${name}_api_key`.
// The connector's own activeProvider()/testConnection() read them, so these
// routes stay generic across connectors.
app.get("/api/admin/connectors", requireAdmin, wrap(async (_req, res) => {
  const out = [];
  for (const c of listConnectors()) {
    const conn = getConnector(c.name);
    // Key presence per provider (never the value) — keys live in their own
    // per-provider slot so switching backends doesn't overwrite them.
    const keys = {};
    for (const p of c.providers) keys[p.name] = !!(await getSetting(db, `${c.name}_key_${p.name}`));
    out.push({
      name: c.name,
      label: c.label,
      category: c.category,
      description: c.description,
      providers: c.providers,
      activeProvider: conn.activeProvider ? (await conn.activeProvider(db)).name : null,
      keys,
    });
  }
  res.json(out);
}));

app.post("/api/admin/connectors/:name", requireAdmin, wrap(async (req, res) => {
  const conn = getConnector(req.params.name);
  if (!conn) return res.status(404).json({ error: "unknown connector" });
  const providers = conn.manifest.providers || [];
  const provider = req.body?.provider ? String(req.body.provider) : "";
  const desc = providers.find((p) => p.name === provider);
  if (!desc) return res.status(400).json({ error: `provider must be one of: ${providers.map((p) => p.name).join(", ")}` });

  const keyName = `${req.params.name}_key_${provider}`;
  // api_key: a non-empty string sets it, an explicit "" clears it, undefined
  // leaves the stored key alone. Validate the final state before persisting.
  let nextKey; // undefined = leave as-is
  if (req.body?.api_key !== undefined) nextKey = String(req.body.api_key).trim() || null;
  const willHaveKey = nextKey !== undefined ? !!nextKey : !!(await getSetting(db, keyName));
  if (desc.needsKey && !willHaveKey) return res.status(400).json({ error: `${desc.label} needs an API key` });

  if (nextKey !== undefined) await setSetting(db, keyName, nextKey);
  await setSetting(db, `${req.params.name}_provider`, provider);
  console.log(`connector ${req.params.name}: provider=${provider} (key ${willHaveKey ? "set" : "none"})`);
  res.json({ ok: true, activeProvider: provider, hasKey: willHaveKey });
}));

app.post("/api/admin/connectors/:name/test", requireAdmin, wrap(async (req, res) => {
  const conn = getConnector(req.params.name);
  if (!conn) return res.status(404).json({ error: "unknown connector" });
  if (!conn.testConnection) return res.status(400).json({ error: "connector has no connection test" });
  try {
    // Test the provider the admin has selected, with the key they just typed
    // (falling back to that provider's stored key) — so the toast names what
    // they're actually configuring, not the currently-active provider.
    const { provider } = await conn.testConnection(db, {
      provider: req.body?.provider ? String(req.body.provider) : undefined,
      apiKey: req.body?.api_key !== undefined ? String(req.body.api_key).trim() : undefined,
    });
    res.json({ ok: true, provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Three shapes from one route: no params = the whole board as a bare array
// (legacy); ?limit/&after = one keyset page ({ items, nextCursor, now });
// ?since=<ms> = entities changed since then plus every current entity id, for
// merge/delete detection ({ items, ids, now }). `now` is captured BEFORE the
// query and handed back 2s early: it becomes the client's next since-cursor,
// and the margin (plus idempotent client reconcile) covers writes that
// stamped just before our read but committed after it.
app.get("/api/items", requireAuth, wrap(async (req, res) => {
  const boardId = req.query.board || null;
  if (!boardId || !(await canAccessBoard(db, boardId, req.user))) return res.json([]);
  const now = Date.now() - 2000;

  if (req.query.since != null) {
    if (!/^\d+$/.test(String(req.query.since))) return res.status(400).json({ error: "malformed since" });
    const { items } = await listItems(db, req.user.id, boardId, { since: Number(req.query.since) });
    return res.json({ items, ids: await listEntityIds(db, boardId), now });
  }

  if (req.query.limit != null || req.query.after != null) {
    const parsed = Number.parseInt(req.query.limit, 10);
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 500;
    let after = null;
    if (req.query.after != null) {
      const m = /^(\d+)_(\d+)$/.exec(String(req.query.after));
      if (!m) return res.status(400).json({ error: "malformed cursor" });
      after = { createdAt: Number(m[1]), id: Number(m[2]) };
    }
    const { items, nextCursor } = await listItems(db, req.user.id, boardId, { limit, after });
    return res.json({ items, nextCursor, now });
  }

  const { items } = await listItems(db, req.user.id, boardId);
  res.json(items);
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
  // Vectors are per instance; results speak in entity ids (what cards are),
  // so multiple matching instances collapse to their entity's best score.
  const best = new Map();
  for (const row of await boardEmbeddings(db, boardId, embedder.model)) {
    const v = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4);
    if (v.length !== qv.length) continue; // stale dims mid-model-change
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * qv[i];
    const eid = row.entity_id ?? row.id;
    if (!best.has(eid) || best.get(eid) < s) best.set(eid, s);
  }
  const scored = [...best].map(([id, score]) => ({ id, score }));
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

// The AI's per-facet justification for an instance's tags, plus its
// extracted fields. Kept out of the /api/items list payload — fetched lazily
// when the lightbox panel opens (and again per instance switch).
app.get("/api/instances/:id/reasoning", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const row = await getItemReasoning(db, req.itemId);
  res.json({
    reasoning: row?.tag_reasoning || {},
    fields: row?.payload?.fields || {},
  });
}));

// Tags are per instance — a human call about one piece of material.
app.patch("/api/instances/:id/tags", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const tags = req.body && Array.isArray(req.body.tags) ? req.body.tags : null;
  if (!tags) return res.status(400).json({ error: "tags array required" });
  const board = await getBoard(db, req.itemBoardId);
  const allowed = new Set();
  if (board) for (const f of board.facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const clean = tags.filter((t) => typeof t === "string" && allowed.has(t));
  await setItemTags(db, req.itemId, clean);
  res.json({ ok: true, tags: clean });
}));

// Delete the whole entity: instances cascade, all their files are cleaned.
app.delete("/api/items/:id", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  const result = await deleteEntity(db, req.entityId);
  if (!result) return res.status(404).json({ error: "not found" });
  sources.cleanup(result.files);
  console.log(`deleted entity #${req.entityId}`);
  res.json({ ok: true });
}));

// Card-level reprocess: re-run the whole pipeline for every instance. Mapped
// instances restart at extraction (re-derive identity + fields, then re-tag);
// the rest restart at tagging.
app.post("/api/items/:id/reprocess", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  if (!(await reprocessEntity(db, req.entityId))) return res.status(404).json({ error: "not found" });
  console.log(`reprocess queued entity #${req.entityId}`);
  res.json({ ok: true });
}));

// Re-run extraction for one instance that has a stamped mapping (409 without
// one). Identity re-derivation may re-parent the instance — merge or split.
app.post("/api/instances/:id/reextract", requireAuth, requireItemAccess, wrap(async (req, res) => {
  if (!(await reextractItem(db, req.itemId))) return res.status(409).json({ error: "item has no stamped mapping" });
  console.log(`reextract queued instance #${req.itemId}`);
  res.json({ ok: true, status: "pending_extract" });
}));

// Re-tag one instance from its existing material and fields — the per-instance,
// tag-only counterpart to the card-level reprocess. Leaves identity/fields as-is.
app.post("/api/instances/:id/retag", requireAuth, requireItemAccess, wrap(async (req, res) => {
  if (!(await retagItem(db, req.itemId))) return res.status(404).json({ error: "not found" });
  console.log(`retag queued instance #${req.itemId}`);
  res.json({ ok: true, status: "pending" });
}));

// Remove one instance from its entity (file included). The last instance
// can't be removed this way — delete the entity instead. No re-queue needed:
// the remaining instances own their fields and tags already.
app.delete("/api/instances/:id", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const { rows: [item] } = await db.query("SELECT entity_id FROM items WHERE id=$1", [req.itemId]);
  if (!item) return res.status(404).json({ error: "not found" });
  if (item.entity_id && (await entityInstanceCount(db, item.entity_id)) <= 1)
    return res.status(409).json({ error: "cannot remove the only instance — delete the item instead" });

  const removed = await deleteInstance(db, req.itemId);
  if (!removed) return res.status(404).json({ error: "not found" });
  // Race heal: two concurrent deletes of the last two instances both pass the
  // count guard above — if that emptied the entity, drop it rather than leave
  // a ghost card (the atomic emptiness check makes this a no-op otherwise).
  if (removed.entity_id) await deleteEntityIfEmpty(db, removed.entity_id);
  sources.cleanup(removed.payload?.files);
  console.log(`instance #${req.itemId} removed from entity #${removed.entity_id}`);
  res.json({ ok: true });
}));

// --- connector routes ---

app.get("/api/connectors", requireAuth, wrap(async (_req, res) => {
  // Enrich each connector with its active provider and per-face availability so
  // the mapping modal can warn when a configured face can't be rendered by the
  // current backend (e.g. a chart face while CoinMarketCap — no history — is active).
  const out = [];
  for (const c of listConnectors()) {
    const conn = getConnector(c.name);
    const activeProvider = conn.activeProvider ? (await conn.activeProvider(db)).name : null;
    out.push({ ...c, activeProvider, faces: conn.renderableFaces ? conn.renderableFaces(activeProvider) : c.faces });
  }
  res.json(out);
}));

// The file-metadata field catalog (server/media) for the mapping modal's "File
// fields" section — static descriptors, no db, like a connector manifest.
app.get("/api/file-fields", requireAuth, wrap(async (_req, res) => {
  res.json(mediaCatalog());
}));

app.get("/api/connectors/:name/search", requireAuth, wrap(async (req, res) => {
  const connector = getConnector(req.params.name);
  if (!connector) return res.status(404).json({ error: "unknown connector" });
  const q = String(req.query.q || "").trim();
  if (!q) return res.json([]);
  try {
    res.json(await connector.search(db, q));
  } catch (err) {
    console.error(`connector search error (${req.params.name}):`, err.message);
    res.status(502).json({ error: err.message });
  }
}));

// Create one connector entity + its file-less tag-vehicle instance and return
// the client row. Shared by the single add and the bulk add. Throws a tagged
// error on the two recoverable cases so callers can map them: `.duplicate` for a
// 23505 (identity already on the board), `.provider` for a fetch/provider error.
async function addConnectorEntity(board, connector, connectorName, entityId) {
  let entity;
  try {
    entity = await connector.fetchEntity(db, entityId);
  } catch (err) { err.provider = true; throw err; }

  // Bound fields live on the entity; one file-less instance is the tag
  // vehicle (tags/reasoning/queue state are per instance). A connector-face
  // board renders the chart first (face leg) so the tagger sees it — the face
  // is part of the item's definition, so it renders even with auto-tag off
  // (`park` makes the face leg park the item in held afterwards instead of
  // flowing into tagging). Face-less connector items are definition-complete
  // at birth: auto-tag off holds them as before.
  const wantsFace = board.mapping?.face?.from === "connector";
  const status = wantsFace ? "pending_face" : board.auto_tag ? "pending" : "held";
  let eid;
  try {
    eid = await createEntity(db, board.id, {
      identity: entity.identity,
      displayName: entity.display_name,
      symbol: entity.symbol || null,
      fields: entity.fields,
    });
  } catch (err) {
    if (err.code === "23505") { const e = new Error("entity already on this board"); e.duplicate = true; throw e; }
    throw err;
  }
  // Provider handle rides on the tag-vehicle instance (entities has no free-
  // form payload) for a future liveness re-fetch.
  const payload = {
    identity: entity.identity, files: [], fields: {}, mapping: board.mapping, source: entity.source,
    ...(wantsFace && !board.auto_tag ? { park: true } : {}),
  };
  const id = await insertItem(db, board.id, payload, status, eid);

  // Schedule the first liveness refresh when the mapping has live fields.
  const live = liveFields(board.mapping);
  if (live.length) await setEntityRefreshAt(db, eid, nextRefreshAt(entity.fields, live));

  console.log(`connector entity created: ${connectorName}/${entityId} → #${eid} (${entity.display_name})`);
  return {
    id: eid,
    name: entity.identity,
    identity: entity.identity,
    display_name: entity.display_name,
    symbol: entity.symbol || null,
    displayLabel: entity.display_name || entity.identity,
    status,
    tags: [],
    kind: "connector",
    w: null,
    h: null,
    label: null,
    fields: entity.fields,
    instances: [{
      id, name: entity.identity, label: null, w: null, h: null,
      kind: "connector", status, tags: [], undecided: false,
    }],
  };
}

// Create an entity from a connector — no file upload, fields come from the
// connector's fetchEntity call. Goes straight to pending (tagger runs over
// the bound fields). 409 when the identity already exists on this board.
app.post("/api/boards/:id/entities", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  const { connector: connectorName, id: entityId } = req.body || {};
  if (!connectorName || !entityId) return res.status(400).json({ error: "connector and id required" });
  const inputConnector = board.mapping?.input?.connector;
  if (inputConnector !== connectorName)
    return res.status(400).json({ error: `this board uses the "${inputConnector || "files"}" input, not "${connectorName}"` });
  const connector = getConnector(connectorName);
  if (!connector) return res.status(404).json({ error: "unknown connector" });

  try {
    res.json(await addConnectorEntity(board, connector, connectorName, entityId));
  } catch (err) {
    if (err.duplicate) return res.status(409).json({ error: err.message });
    if (err.provider) {
      console.error(`connector fetchEntity error (${connectorName}/${entityId}):`, err.message);
      return res.status(502).json({ error: err.message });
    }
    throw err;
  }
}));

// Bulk add from the browse modal — same per-entity path, tolerant per id:
// duplicates and provider errors land in `skipped` rather than failing the batch.
const BULK_ADD_MAX = 100;
app.post("/api/boards/:id/entities/bulk", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  const { connector: connectorName, ids } = req.body || {};
  if (!connectorName || !Array.isArray(ids) || !ids.length)
    return res.status(400).json({ error: "connector and a non-empty ids array required" });
  if (ids.length > BULK_ADD_MAX) return res.status(400).json({ error: `at most ${BULK_ADD_MAX} at a time` });
  const inputConnector = board.mapping?.input?.connector;
  if (inputConnector !== connectorName)
    return res.status(400).json({ error: `this board uses the "${inputConnector || "files"}" input, not "${connectorName}"` });
  const connector = getConnector(connectorName);
  if (!connector) return res.status(404).json({ error: "unknown connector" });

  const added = [], skipped = [];
  for (const entityId of ids) {
    try {
      added.push(await addConnectorEntity(board, connector, connectorName, String(entityId)));
    } catch (err) {
      if (err.duplicate) { skipped.push({ id: entityId, reason: "duplicate" }); continue; }
      console.error(`bulk add error (${connectorName}/${entityId}):`, err.message);
      skipped.push({ id: entityId, reason: err.message });
    }
  }
  res.json({ added, skipped });
}));

// Browse a connector board's catalog for the ingestion modal: a sorted,
// paginated page of rows carrying the domain's columns, each flagged on_board
// when its identity is already here. The connector is derived from the board's
// mapping (ACL + connector in one place). 502 on a provider error, like search.
const BROWSE_PAGE_MAX = 100;
app.get("/api/boards/:id/connector-list", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  const connectorName = board.mapping?.input?.connector;
  const connector = connectorName ? getConnector(connectorName) : null;
  if (!connector) return res.status(400).json({ error: "this board has no connector input" });
  const browse = connector.manifest.browse || {};

  const pageSize = Math.min(BROWSE_PAGE_MAX, Math.max(1, Number(req.query.pageSize) || browse.pageSize || 50));
  const opts = {
    sort: req.query.sort ? String(req.query.sort) : browse.defaultSort,
    order: req.query.order === "asc" ? "asc" : "desc",
    page: Math.max(1, Number(req.query.page) || 1),
    pageSize,
    query: req.query.q ? String(req.query.q) : "",
  };
  let rows;
  try {
    rows = await connector.list(db, opts);
  } catch (err) {
    console.error(`connector list error (${connectorName}):`, err.message);
    return res.status(502).json({ error: err.message });
  }
  // on_board mirrors runtime.fetchEntity's identity derivation (lowercase symbol,
  // falling back to the provider id).
  const onBoard = await boardEntityIdentities(db, board.id);
  const marked = rows.map((r) => ({ ...r, on_board: onBoard.has((r.symbol || "").toLowerCase() || r.id) }));
  res.json({ rows: marked, page: opts.page, hasMore: rows.length >= pageSize });
}));

// Ingestion + item-file statics, mounted before the frontend catch-all.
// Filenames are random per upload and never reused, so long-lived caching is
// safe. Login required: without it the bytes are world-readable to anyone
// holding a URL; within a session the 64-bit random filenames are the
// per-board barrier — they only surface through the board-ACL'd /api/items.
mountIngest(app, { db, sources });
app.use("/gallery", requireAuth, express.static(GALLERY_DIR, {
  maxAge: "7d",
  immutable: true,
  // md/csv would otherwise download; the lightbox renders originals inline
  // in a frame, so serve all text-ish docs as plain text.
  setHeaders: (res, p) => {
    if (/\.(md|csv)$/i.test(p)) res.setHeader("Content-Type", "text/plain; charset=utf-8");
  },
}));
app.use("/thumbnails", requireAuth, express.static(THUMBS_DIR, { maxAge: "7d", immutable: true }));

// Legacy: items uploaded before thumb dimensions were stored.
sources.backfillDims(await listItemPayloads(db), (id, patch) => updateItemPayload(db, id, patch))
  .catch((err) => console.log("thumb backfill error:", err.message));

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
  const stopWorker = startWorker({ db, thumbsDir: THUMBS_DIR, galleryDir: GALLERY_DIR });

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
    await sources.close?.();
    await db.end();
    process.exit(0);
  }
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

export { app, db };
