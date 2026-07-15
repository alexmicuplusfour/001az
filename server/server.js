import express from "express";
import fs from "node:fs";
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
  rescheduleEntityRefreshes,
  boardEntityIdentities,
  getBoardTokenTotal,
  setIngestNextRun,
  setIngestState,
  clearIngestDrain,
  ingestedKeys,
  ingestedAmong,
  setPluginState,
  getPluginRow,
  withPluginHealth,
  listSourceConnections,
  getSourceConnection,
  createSourceConnection,
  updateSourceConnection,
  deleteSourceConnection,
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
import { loadAll as loadPlugins } from "./plugin-loader.js";
import { rateLimit } from "./ratelimit.js";
import { createSources } from "./sources/index.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { addConnectorEntity } from "./connectors/add.js";
import { liveFields, faceCadence } from "./connectors/runtime.js";
import { mediaCatalog, getMediaField, extractFileFields } from "./media/index.js";
import { pluginCatalog, getPluginDef, pluginState, pluginInstalled } from "./plugins.js";
import { mountIngest } from "./ingest.js";
import { resolveIngestAdapter, validateIngest } from "./ingestion/index.js";
import { applyFilters, applySort } from "./ingestion/filter-engine.js";
import { getSourceBackend } from "./ingestion/sources/index.js";
import { invalidateSourceCache } from "./ingestion/files.js";

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
await loadPlugins(db); // register dynamically-installed plugins before routes serve
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
    // Presence flag + next-run stamp — the client keeps a slow delta poll
    // alive on ingest boards, and the toolbar chip counts down to the run.
    ingest_enabled: !!(board.ingest && board.ingest.enabled !== false),
    ingest_next_run_at: board.ingest && board.ingest.enabled !== false
      ? board.ingest_next_run_at ?? null
      : null,
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
    ingest: b.ingest || null,
    ingest_state: b.ingest_state || null,
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
  const { update, error, sweep } = await buildBoardContentUpdate(req.body, prev);
  if (error) return res.status(400).json({ error });
  if (Object.keys(update).length > 0) await updateBoard(db, prev.id, update);
  // A saved config supersedes any half-drained run of the old one — a stale
  // drain_left would hand the next run the dead config's budget as its limit.
  if (update.ingest !== undefined) await clearIngestDrain(db, prev.id);
  if (sweep) {
    const n = await queueUntagged(db, prev.id);
    if (n) console.log(`board ${prev.id}: auto-tagging on — swept ${n} untagged item(s) into the queue`);
  }
  invalidateBoardCache(prev.id);
  res.json({ ok: true });
}));

// --- automatic ingestion (config + preview; the worker sweep does the runs) ---

// Everything the ingestion modal needs in one fetch: the adapter descriptor
// (source schema, filter catalog, sorts, trigger modes), the saved config,
// and the sweep-owned run status.
app.get("/api/boards/:id/ingest", requireAuth, requireBoardManager, wrap(async (req, res) => {
  const adapter = resolveIngestAdapter(req.board);
  res.json({
    available: !!adapter,
    descriptor: adapter ? adapter.descriptor() : null,
    // File boards: the installed source backends (folder/ftp/s3) + their pickable
    // connections. Connector boards: null (their source is the connector itself).
    sources: adapter?.listSources ? await adapter.listSources(db) : null,
    config: req.board.ingest || null,
    state: req.board.ingest_state || null,
    root: !!process.env.INGEST_ROOT,
  });
}));

// Browse one directory level of a board's configured (or in-progress) source —
// the source-browse modal navigates the tree to pick a base folder. The source
// credentials are resolved server-side from the saved connection; the client
// sends only { type, connectionId } + a nav path.
app.post("/api/boards/:id/ingest/source/browse", requireAuth, requireBoardManager, wrap(async (req, res) => {
  const adapter = resolveIngestAdapter(req.board);
  if (!adapter?.browse) return res.status(400).json({ error: "browsing isn't available for this board" });
  const source = req.body?.source || {};
  const navPath = req.body?.path != null ? String(req.body.path) : (source.path ?? source.folder ?? "");
  try {
    res.json(await adapter.browse(db, source, navPath));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Subfolders under the ingestion root for the folder picker. Bounded walk
// (depth ≤3, 200 entries) — a picker, not a filesystem browser.
app.get("/api/ingest/folders", requireAuth, wrap(async (_req, res) => {
  const root = process.env.INGEST_ROOT;
  if (!root) return res.json({ root: false, folders: [] });
  const folders = [];
  async function walk(abs, rel, depth) {
    if (depth > 3 || folders.length >= 200) return;
    let entries;
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (folders.length >= 200) return;
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith(".")) continue;
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      folders.push(relChild);
      await walk(path.join(abs, e.name), relChild, depth + 1);
    }
  }
  await walk(root, "", 1);
  res.json({ root: true, folders });
}));

// Dry-run a candidate config (request body, never saved): enumerate → filter
// → sort with the shared engine. Default response is the count alone —
// count = everything matching the filters (capped: the walk stopped at the
// preview bound, render as "N+"); new = the subset not yet in the ledger,
// i.e. what a run would actually consider. body.sample = { offset, limit }
// opts into a page of matching rows (+ hasMore) for the results view — each
// page is a fresh stateless enumerate, same as connector browse paging. Page
// responses skip the full-ledger scan (and `new`) the count view needs;
// instead each row carries `ingested` from a PK probe on just its page keys,
// so the list can mark what a run would skip.
app.post("/api/boards/:id/ingest/preview", requireAuth, requireBoardManager, wrap(async (req, res) => {
  const adapter = resolveIngestAdapter(req.board);
  if (!adapter) return res.status(400).json({ error: "ingestion is not available for this board" });
  const body = req.body || {};
  const cfg = { ...body, enabled: true }; // preview ignores the toggle
  delete cfg.sample;
  const hasRoot = !!process.env.INGEST_ROOT;
  const err = validateIngest(cfg, adapter.descriptor(), { hasRoot });
  if (err) return res.status(400).json({ error: err });
  if (adapter.validateSource) {
    const srcErr = await adapter.validateSource(db, cfg.source || {}, { hasRoot });
    if (srcErr) return res.status(400).json({ error: srcErr });
  }
  let sample = null;
  if (body.sample != null) {
    const offset = Number(body.sample.offset ?? 0);
    const limit = Number(body.sample.limit ?? 50);
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200)
      return res.status(400).json({ error: "invalid sample window" });
    sample = { offset, limit };
  }
  const PREVIEW_CAP = 1000;
  let enumerated;
  try {
    enumerated = await adapter.enumerate(db, req.board, cfg, { limit: PREVIEW_CAP });
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const catalog = adapter.descriptor().filters;
  const matched = applySort(applyFilters(enumerated.candidates, cfg.filters, catalog), cfg.sort, catalog);
  if (sample) {
    const rows = matched.slice(sample.offset, sample.offset + sample.limit);
    const known = await ingestedAmong(db, req.board.id, rows.map((c) => c.key));
    return res.json({
      count: matched.length,
      capped: !!enumerated.truncated,
      sample: rows.map((c) => ({ ...c, ingested: known.has(c.key) })),
      hasMore: sample.offset + sample.limit < matched.length,
    });
  }
  const known = await ingestedKeys(db, req.board.id);
  res.json({
    count: matched.length,
    new: matched.filter((c) => !known.has(c.key)).length,
    capped: !!enumerated.truncated,
  });
}));

// "Run now": arm the timer for the next tick. Also the only way to fire a
// manual-trigger board.
app.post("/api/boards/:id/ingest/run", requireAuth, requireBoardManager, wrap(async (req, res) => {
  if (!req.board.ingest || req.board.ingest.enabled === false)
    return res.status(409).json({ error: "ingestion is not enabled on this board" });
  await setIngestNextRun(db, req.board.id, Date.now());
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
async function buildBoardContentUpdate(body = {}, prev) {
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

  // Automatic ingestion config: null clears it (and disarms the timer);
  // an object is validated against the board's adapter descriptor. Timer
  // bookkeeping mirrors the auto-tag block below — arm on off→on or trigger
  // shape change (immediate first run; the sweep computes the next from the
  // trigger), disarm on off/manual. Other config edits (filters, sort) keep
  // the already-armed timer.
  if (body.ingest !== undefined) {
    if (body.ingest === null) {
      update.ingest = null;
      update.ingestNextRunAt = null;
    } else {
      const adapter = resolveIngestAdapter(prev);
      const hasRoot = !!process.env.INGEST_ROOT;
      const ingErr = validateIngest(body.ingest, adapter ? adapter.descriptor() : null, { hasRoot });
      if (ingErr) return { error: ingErr };
      if (adapter?.validateSource) {
        const srcErr = await adapter.validateSource(db, body.ingest.source || {}, { hasRoot });
        if (srcErr) return { error: srcErr };
      }
      update.ingest = body.ingest;
      const wasArmed = !!(prev.ingest && prev.ingest.enabled !== false && prev.ingest.trigger?.mode !== "manual");
      const isArmed = body.ingest.enabled && body.ingest.trigger.mode !== "manual";
      const trigChanged = JSON.stringify(prev.ingest?.trigger ?? null) !== JSON.stringify(body.ingest.trigger);
      if (isArmed && (!wasArmed || trigChanged)) update.ingestNextRunAt = Date.now();
      else if (!isArmed) update.ingestNextRunAt = null;
    }
  }

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
  const { update, error, sweep } = await buildBoardContentUpdate(req.body, prev);
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

  // A mapping edit that switches the board's input (files ↔ connector, or one
  // connector for another) orphans any saved ingest config: it was written
  // against the old adapter's descriptor, and run against the new one it
  // ranges from admitting nothing (unknown filter fields fail closed) to
  // scanning the whole ingestion root (a feed config's empty source resolves
  // to INGEST_ROOT itself under the folder adapter) — on the old trigger
  // cadence. Clear config, timer and run state; the modal starts fresh under
  // the new input. The dedup ledger stays — deletions remain final.
  let inputSwitched = false;
  if (update.mapping !== undefined) {
    const prevInput = prev.mapping?.input?.connector ?? null;
    const nextInput = update.mapping?.input?.connector ?? null;
    if (prevInput !== nextInput && (prev.ingest || prev.ingest_next_run_at)) {
      inputSwitched = true;
      update.ingest = null;
      update.ingestNextRunAt = null;
    }
  }

  if (Object.keys(update).length > 0) await updateBoard(db, id, update);
  if (inputSwitched) await setIngestState(db, id, null);
  else if (update.ingest !== undefined) await clearIngestDrain(db, id);

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
    await withPluginHealth(db, `ai:${key.provider}`, () =>
      testKey({ provider: key.provider, apiKey: key.api_key, model }));
    res.json({ ok: true, provider: key.provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Provider catalog (labels, model lists + notes, defaults, capabilities). The
// admin UI renders its provider/model pickers from this instead of hardcoding
// them, so a new provider needs no client edit.
app.get("/api/admin/ai-providers", requireAdmin, wrap(async (_req, res) => {
  // The static catalog + each provider's install flag, so the two consumers
  // (board modal's per-board override, the Plugins page) can mark or skip
  // not-installed providers without a second fetch.
  const catalog = providerCatalog();
  for (const p of catalog) {
    p.installed = await pluginInstalled(db, `ai:${p.name}`);
  }
  res.json(catalog);
}));

// --- plugins (admin: the unified integrations catalog) ---
// One payload for the Plugins page: every plugin (def + state, secrets
// masked) plus the slot assignments — read from the same settings the
// legacy per-layer routes use, just composed.
app.get("/api/admin/plugins", requireAdmin, wrap(async (_req, res) => {
  const plugins = await pluginCatalog(db);
  const embedder = await resolveEmbedder(db);
  const domains = {};
  for (const c of listConnectors()) {
    const conn = getConnector(c.name);
    // setting = the stored star; effective = what resolution lands on (they
    // diverge when the starred provider isn't installed — the UI shows both).
    let effective = null;
    try { effective = (await conn.activeProvider(db)).name; } catch { /* no provider installed */ }
    domains[c.name] = { setting: (await getSetting(db, `${c.name}_provider`)) || null, effective };
  }
  res.json({
    plugins,
    slots: {
      tagger: {
        keyId: Number(await getSetting(db, "default_key_id")) || null,
        model: (await getSetting(db, "model")) || null,
        envKey: !!process.env.ANTHROPIC_API_KEY,
      },
      embedder: {
        enabled: (await getSetting(db, "embed_enabled")) === "1",
        provider: (await getSetting(db, "embed_provider")) || null,
        keyId: Number(await getSetting(db, "embed_key_id")) || null,
        model: (await getSetting(db, "embed_model")) || null,
        stats: embedder ? await embeddingStats(db, embedder.model) : { tagged: 0, embedded: 0, failed: 0 },
      },
      domains,
    },
  });
}));

// Star a connector domain's default provider. (Registered before the :id
// routes so a domain can never be shadowed by an id match.) Enabled = usable,
// default = preselected — starring is where the old make-active guards live
// now: the plugin must be on, and a keyed provider must have its key.
app.post("/api/admin/plugins/slots/:domain", requireAdmin, wrap(async (req, res) => {
  const conn = getConnector(req.params.domain);
  if (!conn) return res.status(404).json({ error: "unknown domain" });
  const providers = conn.providerList();
  const provider = req.body?.provider ? String(req.body.provider) : "";
  const desc = providers.find((p) => p.name === provider);
  if (!desc) return res.status(400).json({ error: `provider must be one of: ${providers.map((p) => p.name).join(", ")}` });
  const st = await pluginState(db, `${req.params.domain}:${provider}`);
  if (!st.installed) return res.status(400).json({ error: `${desc.label} is not installed — add it first` });
  if (desc.needsKey && !(await getSetting(db, `${req.params.domain}_key_${provider}`)))
    return res.status(400).json({ error: `${desc.label} needs an API key` });
  await setSetting(db, `${req.params.domain}_provider`, provider);
  console.log(`connector ${req.params.domain}: default provider=${provider}`);
  res.json({ ok: true });
}));

// Add/remove a plugin (install state) and/or write its schema-declared config.
// Validated against the plugin's own configSchema; everything checks out before
// anything is written, so a bad field can't half-apply. Secret fields never
// land in plugins.config — they write through to their real store.
app.patch("/api/admin/plugins/:id", requireAdmin, wrap(async (req, res) => {
  const def = getPluginDef(req.params.id);
  if (!def) return res.status(404).json({ error: "unknown plugin" });
  const { installed, config } = req.body || {};

  if (installed !== undefined) {
    if (typeof installed !== "boolean") return res.status(400).json({ error: "installed must be true or false" });
    if (def.core && !installed) return res.status(400).json({ error: `${def.label} is a core capability and can't be removed` });
  }

  let nextConfig;
  const secretWrites = [];
  if (config !== undefined) {
    if (!config || typeof config !== "object" || Array.isArray(config))
      return res.status(400).json({ error: "config must be an object" });
    const schema = new Map(def.configSchema.map((f) => [f.key, f]));
    nextConfig = { ...((await getPluginRow(db, def.id))?.config || {}) };
    for (const [k, v] of Object.entries(config)) {
      const f = schema.get(k);
      if (!f) return res.status(400).json({ error: `unknown config field: ${k}` });
      if (f.type === "secret") {
        // Secrets never land in plugins.config. Connector keys write through to
        // the `<domain>_key_<provider>` setting ("" or null clears, a string
        // sets). No other plugin kind has a secret sink today — reject loudly
        // rather than 200-with-silent-discard so a future secret field can't
        // vanish unnoticed.
        if (def.kind !== "connector")
          return res.status(400).json({ error: `${def.label} has no secret store for ${f.label}` });
        secretWrites.push([`${def.connector.domain}_key_${def.name}`, v == null ? null : String(v).trim() || null]);
        continue;
      }
      if (v === null) { delete nextConfig[k]; continue; } // back to the schema default
      if (f.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min))
          return res.status(400).json({ error: `${f.label} must be a number${f.min !== undefined ? ` of at least ${f.min}` : ""}` });
        nextConfig[k] = n;
      } else if (f.type === "toggle") {
        if (typeof v !== "boolean") return res.status(400).json({ error: `${f.label} must be true or false` });
        nextConfig[k] = v;
      } else {
        nextConfig[k] = String(v);
      }
    }
  }

  for (const [key, val] of secretWrites) await setSetting(db, key, val);
  if (installed !== undefined || nextConfig !== undefined)
    await setPluginState(db, def.id, { installed, config: nextConfig });
  console.log(`plugin ${def.id} updated by admin: installed=${installed ?? "(unchanged)"}${nextConfig ? " +config" : ""}${secretWrites.length ? " +key" : ""}`);
  res.json({ ok: true, state: await pluginState(db, def.id) });
}));

// Reachability test. Connector plugins test through the shared runtime (the
// typed key wins over the stored one, so the toast reflects the form). AI
// keys are tested individually via /api/admin/ai-keys/:id/test; media has
// nothing to call out to.
app.post("/api/admin/plugins/:id/test", requireAdmin, wrap(async (req, res) => {
  const def = getPluginDef(req.params.id);
  if (!def) return res.status(404).json({ error: "unknown plugin" });
  if (def.kind !== "connector") {
    return res.status(400).json({
      error: def.kind === "ai" ? "test AI keys individually — each key has its own Test"
        : def.kind === "source" ? "test source connections individually — each has its own Test"
        : "nothing to test for a media plugin",
    });
  }
  const conn = getConnector(def.connector.domain);
  try {
    const { provider } = await conn.testConnection(db, {
      provider: def.name,
      apiKey: req.body?.api_key !== undefined ? String(req.body.api_key).trim() : undefined,
    });
    res.json({ ok: true, provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// --- source connections (reusable remote-ingestion credentials) ---
// Admin-only; a board manager only references them (never sees a secret). The
// connection's field set is the backend's connectionSchema — validate/coerce/
// mask all read from it, so a new source needs no route edits.

// Mask secret fields on read (value → presence boolean); echo only non-secrets.
function maskConnection(c) {
  const schema = getSourceBackend(c.type)?.manifest.connectionSchema || [];
  const config = {};
  const hasSecret = {};
  for (const f of schema) {
    if (f.type === "secret") hasSecret[f.key] = c.config?.[f.key] != null && c.config[f.key] !== "";
    else if (c.config && f.key in c.config) config[f.key] = c.config[f.key];
  }
  return { id: c.id, type: c.type, label: c.label, config, hasSecret, boards_using: Number(c.boards_using) || 0, created_at: c.created_at };
}

// Validate an incoming config against the schema. `existing` lets a blank secret
// (or blank required-text) pass when a value is already stored (blank = keep).
function validateConnectionConfig(schema, incoming = {}, existing = {}) {
  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) return "config must be an object";
  const keys = new Set(schema.map((f) => f.key));
  for (const k of Object.keys(incoming)) if (!keys.has(k)) return `unknown field "${k}"`;
  const provided = (k) => Object.prototype.hasOwnProperty.call(incoming, k);
  const stored = (k) => existing[k] != null && existing[k] !== "";
  for (const f of schema) {
    const v = incoming[f.key];
    if (f.type === "number") {
      if (provided(f.key) && v !== "" && v != null) {
        const n = Number(v);
        if (!Number.isFinite(n) || (f.min !== undefined && n < f.min))
          return `${f.label} must be a number${f.min !== undefined ? ` of at least ${f.min}` : ""}`;
      }
    } else if (f.type === "secret" || f.type === "text") {
      // A text/secret field must be a string (or number) — reject objects/arrays/
      // booleans before coerce turns them into "[object Object]"/"true" garbage.
      if (provided(f.key) && v != null && typeof v !== "string" && typeof v !== "number")
        return `${f.label} must be text`;
      const willHave = (provided(f.key) && String(v ?? "").trim() !== "") || stored(f.key);
      if (f.required && !willHave) return `${f.label} is required`;
    }
  }
  return null;
}

// Build the full stored config: start from `existing` (for edits; {} for create),
// overlay the incoming values, keep a blank secret as the stored one, and fill
// schema defaults for untouched fields.
function coerceConnectionConfig(schema, incoming = {}, existing = {}) {
  const out = {};
  const provided = (k) => Object.prototype.hasOwnProperty.call(incoming, k);
  for (const f of schema) {
    const v = incoming[f.key];
    if (f.type === "secret") {
      if (provided(f.key) && v != null && String(v).trim() !== "") out[f.key] = String(v).trim();
      else if (existing[f.key] != null && existing[f.key] !== "") out[f.key] = existing[f.key]; // blank = keep
    } else if (f.type === "number") {
      if (provided(f.key) && v !== "" && v != null) out[f.key] = Number(v);
      else if (existing[f.key] !== undefined) out[f.key] = existing[f.key];
      else if (f.default !== undefined) out[f.key] = f.default;
    } else if (f.type === "toggle") {
      if (provided(f.key)) out[f.key] = !!v;
      else if (existing[f.key] !== undefined) out[f.key] = existing[f.key];
      else if (f.default !== undefined) out[f.key] = f.default;
    } else { // text
      if (provided(f.key)) out[f.key] = String(v).trim();
      else if (existing[f.key] !== undefined) out[f.key] = existing[f.key];
      else if (f.default !== undefined) out[f.key] = f.default;
    }
  }
  return out;
}

app.get("/api/admin/source-connections", requireAdmin, wrap(async (req, res) => {
  const type = req.query.type ? String(req.query.type) : null;
  const conns = await listSourceConnections(db, type);
  res.json(conns.map(maskConnection));
}));

app.post("/api/admin/source-connections", requireAdmin, wrap(async (req, res) => {
  const { type, label, config } = req.body || {};
  const mod = type ? getSourceBackend(String(type)) : null;
  if (!mod || !mod.manifest.needsConnection)
    return res.status(400).json({ error: "unknown or connection-less source type" });
  const lbl = (label ? String(label) : "").trim().slice(0, 80);
  if (!lbl) return res.status(400).json({ error: "label required" });
  const err = validateConnectionConfig(mod.manifest.connectionSchema, config || {}, {});
  if (err) return res.status(400).json({ error: err });
  const clean = coerceConnectionConfig(mod.manifest.connectionSchema, config || {}, {});
  const id = await createSourceConnection(db, mod.manifest.name, lbl, clean);
  console.log(`source connection added: "${lbl}" (${mod.manifest.name})`);
  res.json({ id, type: mod.manifest.name, label: lbl });
}));

app.patch("/api/admin/source-connections/:id", requireAdmin, wrap(async (req, res) => {
  const existing = await getSourceConnection(db, Number(req.params.id));
  if (!existing) return res.status(404).json({ error: "not found" });
  const schema = getSourceBackend(existing.type)?.manifest.connectionSchema || [];
  const { label, config } = req.body || {};
  const update = {};
  if (label !== undefined) {
    const lbl = String(label).trim().slice(0, 80);
    if (!lbl) return res.status(400).json({ error: "label required" });
    update.label = lbl;
  }
  if (config !== undefined) {
    const err = validateConnectionConfig(schema, config, existing.config || {});
    if (err) return res.status(400).json({ error: err });
    update.config = coerceConnectionConfig(schema, config, existing.config || {});
  }
  if (!(await updateSourceConnection(db, existing.id, update)))
    return res.status(400).json({ error: "nothing to update" });
  // A config edit changes what the source returns but not the cache key (same
  // id) — drop its cached listings so boards re-walk with the new settings.
  invalidateSourceCache(existing.id);
  res.json({ ok: true });
}));

app.delete("/api/admin/source-connections/:id", requireAdmin, wrap(async (req, res) => {
  if (!(await deleteSourceConnection(db, Number(req.params.id)))) return res.status(404).json({ error: "not found" });
  // Don't keep serving a removed connection's listing until the window lapses.
  invalidateSourceCache(req.params.id);
  console.log(`source connection #${req.params.id} deleted by admin`);
  res.json({ ok: true });
}));

// Reachability test. `{ id }` tests a stored connection (typed fields merge over
// it, so an edited form tests before Save); `{ type, config }` tests a not-yet-
// saved one. Blank secrets fall back to the stored value.
app.post("/api/admin/source-connections/test", requireAdmin, wrap(async (req, res) => {
  const { id, type, config } = req.body || {};
  let mod, merged;
  if (id != null) {
    const existing = await getSourceConnection(db, Number(id));
    if (!existing) return res.status(404).json({ error: "not found" });
    mod = getSourceBackend(existing.type);
    if (!mod) return res.status(400).json({ error: `unknown source type "${existing.type}"` });
    merged = coerceConnectionConfig(mod.manifest.connectionSchema, config || {}, existing.config || {});
  } else {
    mod = type ? getSourceBackend(String(type)) : null;
    if (!mod || !mod.manifest.needsConnection) return res.status(400).json({ error: "unknown source type" });
    const err = validateConnectionConfig(mod.manifest.connectionSchema, config || {}, {});
    if (err) return res.status(400).json({ error: err });
    merged = coerceConnectionConfig(mod.manifest.connectionSchema, config || {}, {});
  }
  try {
    await withPluginHealth(db, `source:${mod.manifest.name}`, () => mod.backend({ conn: merged }).test());
    res.json({ ok: true });
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
    await withPluginHealth(db, `ai:${embedder.provider}`, () =>
      embedTexts({ ...embedder, texts: ["ping"] }));
    res.json({ ok: true, provider: embedder.provider, model: embedder.model });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

app.post("/api/admin/ai-config/test", requireAdmin, wrap(async (_req, res) => {
  const ai = await resolveDefaultAi(db);
  if (!ai) return res.status(400).json({ error: "No default API key configured" });
  try {
    await withPluginHealth(db, `ai:${ai.provider}`, () => testKey(ai));
    res.json({ ok: true, model: ai.model, provider: ai.provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Connector admin config lives on the Plugins surface now:
// GET /api/admin/plugins (catalog + key presence), PATCH /api/admin/plugins/:id
// (keys write through to `${domain}_key_${provider}` settings),
// POST /api/admin/plugins/slots/:domain (default provider),
// POST /api/admin/plugins/:id/test (reachability).

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
    res.json(await addConnectorEntity(db, board, connector, connectorName, entityId));
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
      added.push(await addConnectorEntity(db, board, connector, connectorName, String(entityId)));
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
  const stopWorker = startWorker({ db, thumbsDir: THUMBS_DIR, galleryDir: GALLERY_DIR, sources });

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
