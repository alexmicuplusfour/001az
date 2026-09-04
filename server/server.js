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
  retagEntity,
  retagEntityFacets,
  reextractEntity,
  entityHasTranscriptStamp,
  retranscribeItem,
  retranscribeEntity,
  refreshEntityData,
  routedEntities,
  getEntityBoard,
  entityInstanceCount,
  cancelBoardQueue,
  seedAdmin,
  createUser,
  listUsers,
  deleteUser,
  userExists,
  getUserById,
  getUserByEmail,
  setPassword,
  anyPasswordSet,
  setUserName,
  setBoardOrder,
  mintInvite,
  consumeInvite,
  deleteUnredeemedInvites,
  createSession,
  deleteSession,
  deleteOtherSessions,
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
  listAlerts,
  boardAlertUnseen,
  getAlertOwned,
  createAlert,
  updateAlert,
  deleteAlert,
  listAlertFirings,
  getAlertFiring,
  firingMatches,
  markAlertFiringsSeen,
  createBoard,
  NEW_BOARD_DEFAULTS,
  listBoards,
  getBoard,
  getEntity,
  entityVehiclePayload,
  updateBoard,
  withTx,
  BOARD_PIN_COLS,
  BOARD_CONFIG_COLS,
  deleteBoard,
  boardExists,
  boardItemStats,
  boardEntityCounts,
  boardPreviewFaces,
  boardHasItems,
  retagBoard,
  retagBoardFacets,
  supersedeFacetDiagnostics,
  releaseHeld,
  queueUntagged,
  getBoardMemberIds,
  getBoardAdminIds,
  setBoardMembers,
  setUserBoards,
  existingBoardIds,
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
  updateAiKey,
  deleteAiKey,
  boardEmbeddings,
  listItemPayloads,
  boardItemPayloads,
  updateItemPayload,
  updateItemPayloads,
  reextractItem,
  retagItem,
  retagItemFacets,
  rescheduleEntityRefreshes,
  floorOverdueRefreshes,
  addJobLog,
  jobLogWrite,
  boardEntityIdentities,
  boardUsageSummary,
  usageRows,
  USAGE_DIMS,
  boardFileBytes,
  day,
  APP_SCOPE,
  modelPriceFreshness,
  listJobLog,
  listRunningJobs,
  latestJobFailureAt,
  boardLatestFailures,
  clearJobLog,
  listRefreshHistory,
  boardHasRefreshHistory,
  boardNextRefreshAt,
  setIngestNextRun,
  setIngestState,
  demoteFacetDiagnostics,
  clearIngestSuperseded,
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
import { startWorker, invalidateBoardCache, invalidateAllBoardCaches, resolveEmbedder, resolveTranscriber, engineStamp, nextAutoTagRun, normaliseIdentity } from "./worker.js";
import { sidecarCatalogs, applySidecarCatalogs } from "./sidecar-catalog.js";
import { evaluateItemAlerts, sendAlertWebhook, nextDailyAt, seedAlertBaseline, sameCondition } from "./alerts.js";
import { facetRollup, editedFacets, GATES, storedFindingAt } from "./facet-diagnosis.js";
import { testKey, embedTexts, providerCatalog, cachedProviderModels, invalidateModelListCache, PROVIDERS } from "./providers.js";
import { refreshRateTable, setModelPrice, wantedModels, priceState } from "./pricing.js";
import { meterAiCall, priceUnpricedHistory } from "./metering.js";
import { validRate, unitList, unitVocabulary } from "./units.js";
import { learnPrices } from "./price-learner.js";
import { MODEL_CAPABILITIES, kindList, capabilityLabel } from "./capabilities.js";
import { bindCapability, setCapabilityConfig, assertValidCapabilityConfig, boardBindingPatch, boardConfigPatch } from "./capability-bind.js";
import { capabilityStatus } from "./capability-status.js";
import { boardConfigCatalog } from "./capability-resolve.js";
import { probeCapability } from "./capability-probe.js";
import { loadAll as loadPlugins, installFromUrl, uninstall, pluginsDir } from "./plugin-loader.js";
import { rateLimit } from "./ratelimit.js";
import { hashPassword, verifyPassword, dummyVerify, MIN_PASSWORD_LEN } from "./password.js";
import { createSources } from "./sources/index.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { addConnectorEntity, enqueueConnectorEntity } from "./connectors/add.js";
import { liveFields, faceSchedule, domainState } from "./connectors/runtime.js";
import { mediaCatalog, getMediaField, extractFileFields } from "./media/index.js";
import { FIELD_SOURCE, FIELD_SOURCE_DEFS } from "./field-sources.js";
import { pluginCatalog, pluginDefs, getPluginDef, pluginState, pluginInstalled, mediaLimits } from "./plugins.js";
import { mountIngest } from "./ingest.js";
import { mountBackups, restoreGate } from "./backup-routes.js";
import { measureStorage, writeSample, readSeries, sampleStorageDue, STORE_DEFS } from "./storage.js";
import { resolveIngestAdapter, validateIngest, ingestMode, ingestStatus, ENUM_CAP } from "./ingestion/index.js";
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
const BACKUPS_DIR = process.env.BACKUPS_DIR || path.join(ROOT, "backups");
// The storage gauge's stores (storage-plan.md) — ONE object, read by both the
// admin route's live measure and the worker's daily sample, so the two callers
// of measureStorage cannot drift on what the stores are. NPM_CACHE_DIR, never
// npm_config_cache: npm injects the latter under `npm run`, pointing at the
// developer's personal cache — unset means the store isn't measured.
const STORAGE_DIRS = {
  galleryDir: GALLERY_DIR, thumbsDir: THUMBS_DIR, backupsDir: BACKUPS_DIR,
  pluginsDir: pluginsDir(), npmCacheDir: process.env.NPM_CACHE_DIR || null,
};
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
// Build the in-memory rate table (pricing.js) so meter writes can stamp costs.
// Process-wide state, like the three above — not the worker's, even though the
// worker is its busiest reader: the rate table is a singleton, this process
// also serves the admin price routes, and hanging it off startWorker would
// mean a worker restart pointlessly rebuilt prices. AFTER loadPlugins, so a
// plugin provider's declared rates are in the registry to be read.
await refreshRateTable(db);
await seedAdmin(db, ADMIN_EMAIL);

// --- first-run setup -------------------------------------------------------
// When NO account has a password — a fresh install, or a restore of an
// archive with no passworded accounts — nobody can sign in, and the old
// answer (docker exec + mintlink.js) is the wrong ceremony for that moment.
// Instead the login page offers first-run setup: enter an email and password,
// and that account IS the admin — no env preconfiguration (ADMIN_EMAIL stays
// as optional automation). Single-tenant and self-hosted: whoever reaches a
// fresh instance first owns it, the same story as any freshly installed web
// app — the door exists only while zero passwords exist, and closes for good.
if (!(await anyPasswordSet(db))) {
  console.log("first-run setup: no account has a password yet — open the app to create the admin account");
}

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

// Live handles the backup routes need but that only exist later (the worker
// starts in the isMain block below); mutated there, read by reference.
const runtime = { stopWorker: null, restartWorker: null, exitAfter: false, restore: { active: false, sid: null } };
// Ahead of attachUser: during a restore the session tables are mid-rebuild,
// so this must answer without touching the DB.
app.use(restoreGate(runtime));

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
  res.json(req.user ? {
    email: req.user.email,
    name: req.user.name,
    is_admin: !!req.user.is_admin,
    needs_password: !req.user.password_hash,
    // The server's clock identity. Daily stamps (alert digests, the
    // ingestion daily trigger) are computed in server-local time
    // (nextDailyAt/nextIngestRunAt), and a Docker host is usually UTC while
    // the person is not — the client shows the delta instead of letting
    // "09:00" silently mean some other hour.
    server_tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    server_tz_offset_min: -new Date().getTimezoneOffset(),
  } : null);
});

// Second login window keyed by the submitted email (whether or not it exists —
// keying only real accounts would leak which emails are registered). The per-IP
// authLimiter alone lets an attacker with many IPs take 30 guesses per IP per
// window at ONE account; this caps the account itself no matter the source.
const loginEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) =>
    typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 200) : "",
});

app.post("/api/login", authLimiter, loginEmailLimiter, wrap(async (req, res) => {
  const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  const user = email && password ? await getUserByEmail(db, email) : null;
  // Unknown email and passwordless account burn the same scrypt as a wrong
  // password, so the generic 401 can't be timed into an email oracle.
  const ok = user?.password_hash
    ? await verifyPassword(password, user.password_hash)
    : await dummyVerify(password);
  if (!ok) {
    // Feeds the live log viewer and docker logs (fail2ban-able). Email is
    // attacker-controlled: strip to printable ASCII and cap it, so a crafted
    // "email" can't forge log lines or smuggle a bogus `from <ip>` past a
    // fail2ban regex.
    const safeEmail = email.toLowerCase().replace(/[^\x20-\x7e]/g, "").slice(0, 100);
    console.log(`login rejected: ${safeEmail || "(no email)"} from ${req.ip}`);
    return res.status(401).json({ error: "invalid credentials" });
  }
  if (req.sid) await deleteSession(db, req.sid); // rotate: never keep a pre-login session
  const sid = await createSession(db, user.id);
  await touchLogin(db, user.id);
  setSessionCookie(res, sid);
  console.log(`login: user #${user.id}`);
  res.json({ ok: true });
}));

// Change (or first-time set, when no hash exists yet — the invite flow lands
// there) the password. Rate-limited too: a stolen session shouldn't get free
// guesses at the current password.
app.post("/api/account/password", authLimiter, requireAuth, wrap(async (req, res) => {
  const current = typeof req.body?.current === "string" ? req.body.current : "";
  const next = typeof req.body?.password === "string" ? req.body.password : "";
  if (next.length < MIN_PASSWORD_LEN)
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  if (req.user.password_hash && !(await verifyPassword(current, req.user.password_hash)))
    return res.status(403).json({ error: "current password is incorrect" });
  await setPassword(db, req.user.id, await hashPassword(next));
  await deleteOtherSessions(db, req.user.id, req.sid);
  // An unredeemed invite link is a live login too — a password change must
  // revoke it along with the other sessions.
  await deleteUnredeemedInvites(db, req.user.id);
  console.log(`password ${req.user.password_hash ? "changed" : "set"}: user #${req.user.id}`);
  res.json({ ok: true });
}));

// The reader's board arrangement, shape-checked but deliberately NOT checked
// against the boards table (planning/board-arrangement-plan.md). These ids are
// only ever compared against the boards a reader can already see, so one naming
// a board that is gone — or was never theirs — ranks nothing and discloses
// nothing; validating them would buy an authorization property this list does
// not carry, at the price of a query on every drag. What IS enforced is that
// the column cannot be used as storage: strings only, deduped, bounded.
//
// Returns null for a body that isn't an order at all, which the route turns
// into a 400. An empty array is valid and means "forget my arrangement".
const MAX_BOARD_ORDER = 500;
const BOARD_ID_MAX = 64; // a uuid is 36; the slack is for whatever ids become
function cleanBoardOrder(value) {
  if (!Array.isArray(value) || value.length > MAX_BOARD_ORDER) return null;
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !id || id.length > BOARD_ID_MAX) return null;
    seen.add(id);
  }
  return [...seen];
}

// Account settings: the display name (empty clears it) and the board
// arrangement. One route for both because they are the same kind of thing —
// state belonging to the reader rather than to any board — and each field is
// written only when it is SENT, so the profile page (name alone) and the boards
// index (order alone) can never clobber the other's.
app.patch("/api/account", requireAuth, wrap(async (req, res) => {
  const { name, board_order: boardOrder } = req.body ?? {};
  // Everything is judged before anything is written — the rule the plugins
  // route states as "a bad field can't half-apply". These are two statements
  // rather than one, so a rejected order must not leave a renamed account.
  if (name === undefined && boardOrder === undefined)
    return res.status(400).json({ error: "nothing to update" });
  if (name !== undefined && typeof name !== "string")
    return res.status(400).json({ error: "name must be text" });
  let order = null;
  if (boardOrder !== undefined) {
    order = cleanBoardOrder(boardOrder);
    if (!order) return res.status(400).json({ error: "board_order must be a list of board ids" });
  }

  const out = { ok: true };
  if (name !== undefined) {
    out.name = name.trim().slice(0, 80) || null;
    await setUserName(db, req.user.id, out.name);
  }
  if (order) {
    out.board_order = order;
    await setBoardOrder(db, req.user.id, order);
  }
  res.json(out);
}));

app.get("/auth/:token", authLimiter, wrap(async (req, res) => {
  const userId = await consumeInvite(db, req.params.token);
  if (!userId) return res.redirect("/login.html?error=invalid");
  if (req.sid) await deleteSession(db, req.sid); // rotate: never keep a pre-login session
  const sid = await createSession(db, userId);
  await touchLogin(db, userId);
  setSessionCookie(res, sid);
  console.log(`login: user #${userId}`);
  const user = await getUserById(db, userId);
  // No password yet → straight to the set-password screen.
  res.redirect(user?.password_hash ? "/" : "/login.html");
}));

app.post("/api/logout", wrap(async (req, res) => {
  await deleteSession(db, req.sid);
  clearSessionCookie(res);
  res.json({ ok: true });
}));

// --- first-run setup (see the boot log block) ---
// Available exactly while NO account has a password. Re-checked against the
// DB on every call: the moment any password exists (someone onboarded via
// invite before the fresh instance was claimed), the door is closed for good.
const setupAvailable = async () => !(await anyPasswordSet(db));

app.get("/api/setup", wrap(async (_req, res) => {
  res.json({ setup: await setupAvailable() });
}));

app.post("/api/setup", authLimiter, wrap(async (req, res) => {
  if (!(await setupAvailable())) return res.status(403).json({ error: "setup is not available" });
  const email = (typeof req.body?.email === "string" ? req.body.email : "").trim();
  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid email" });
  if (password.length < MIN_PASSWORD_LEN)
    return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LEN} characters` });
  // Creates the account, or promotes it if the email already exists (a
  // restored instance's passwordless users, or the ADMIN_EMAIL seed).
  await seedAdmin(db, email);
  const user = await getUserByEmail(db, email);
  await setPassword(db, user.id, await hashPassword(password));
  if (req.sid) await deleteSession(db, req.sid); // rotate: never keep a pre-login session
  const sid = await createSession(db, user.id);
  await touchLogin(db, user.id);
  // The claim is a first password set — like /api/account/password it must
  // end every other way into this account: sessions someone opened off a
  // leaked invite link, and any unredeemed link itself.
  await deleteOtherSessions(db, user.id, sid);
  await deleteUnredeemedInvites(db, user.id);
  setSessionCookie(res, sid);
  console.log(`first-run setup complete: ${user.email} (#${user.id}) claimed the admin account from ${req.ip}`);
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
  // :itemId is an entity id (crates hold cards) — resolve it against entities,
  // not items; the two id sequences overlap, so the wrong table can coincide.
  const itemId = Number(req.params.itemId);
  const ent = Number.isInteger(itemId) && itemId > 0 ? await getEntityBoard(db, itemId) : null;
  if (!ent || !(await canAccessBoard(db, ent.board_id, req.user)))
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

// --- alerts (watched facet conditions — per-user like filter configs; the
// matcher/sweep live in alerts.js, detection hooks wherever condition data
// lands: the tag landings, the extract stamp, upload admission) ---

const ALERT_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
// :id is a bigint — junk ("abc", 0, 1.5) must read as "not found", not reach
// Postgres and 500 on the cast (the requireItemAccess guard, family-wide).
const alertIdParam = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id > 0 ? id : null;
};
const alertMin = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
const alertHHMM = (min) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

// What the client sees: the secret never echoes (has_secret drives the "keep /
// replace / clear" edit affordance), daily_at travels as "HH:MM".
const alertJson = (a) => ({
  id: a.id, name: a.name, condition: a.condition, delivery: a.delivery,
  daily_at: a.daily_at_min != null ? alertHHMM(a.daily_at_min) : null,
  webhook_url: a.webhook_url, has_secret: !!a.has_secret, enabled: a.enabled,
  ...(a.unseen != null ? { unseen: a.unseen } : {}),
});

// Validate + normalise an alert body over an existing row (POST: empty base).
// Returns { error } or the full field set updateAlert/createAlert writes.
// Secret semantics: absent = keep, "" = clear, value = set — has_secret is
// all the client ever sees, so "absent" must not mean "clear".
function parseAlertBody(body, base) {
  const b = body || {};
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 64) : base.name;
  if (!name) return { error: "name required" };

  let condition = base.condition || {};
  if (b.condition !== undefined) {
    // { facetKey: [values] } — the filter-configs cleaning, ≥1 facet kept.
    const raw = typeof b.condition === "object" && b.condition && !Array.isArray(b.condition) ? b.condition : {};
    condition = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!Array.isArray(v)) continue;
      const values = v.filter((x) => typeof x === "string").slice(0, 100);
      if (values.length) condition[String(k).slice(0, 100)] = values;
    }
  }
  if (!Object.keys(condition).length) return { error: "empty condition" };

  const delivery = b.delivery !== undefined ? String(b.delivery) : (base.delivery || "immediate");
  if (!["immediate", "daily", "record"].includes(delivery)) return { error: "invalid delivery" };

  let dailyAtMin = base.daily_at_min ?? null;
  if (b.daily_at !== undefined) {
    if (b.daily_at === null || b.daily_at === "") dailyAtMin = null;
    else if (ALERT_TIME_RE.test(String(b.daily_at))) dailyAtMin = alertMin(String(b.daily_at));
    else return { error: "daily_at must be HH:MM" };
  }
  if (delivery === "daily" && dailyAtMin == null) return { error: "daily_at required for daily delivery" };

  let webhookUrl = base.webhook_url ?? null;
  if (b.webhook_url !== undefined) {
    const url = String(b.webhook_url || "").trim().slice(0, 2048);
    if (url && !/^https?:\/\//i.test(url)) return { error: "webhook_url must be http(s)" };
    webhookUrl = url || null;
  }

  let webhookSecret = base.webhook_secret ?? null;
  if (b.webhook_secret !== undefined)
    webhookSecret = String(b.webhook_secret || "").slice(0, 256) || null;

  const enabled = b.enabled !== undefined ? !!b.enabled : (base.enabled ?? true);

  // Daily delivery runs off its stamp, and the stamp moves only when the
  // SCHEDULE does (delivery mode or HH:MM — a changed time must re-arm to
  // its next occurrence). A rename, webhook tweak or pause/resume keeps it:
  // recomputing from "now" would silently push an overdue digest — worker
  // mid-outage, or the edit racing the due minute — to tomorrow. An overdue
  // stamp is the sweep's to resolve (fire what's pending, re-arm), not the
  // editor's.
  const scheduleChanged =
    delivery !== (base.delivery || "immediate") || dailyAtMin !== (base.daily_at_min ?? null);

  return {
    name, condition, delivery, daily_at_min: dailyAtMin,
    next_delivery_at: delivery !== "daily" ? null
      : (scheduleChanged || base.next_delivery_at == null) ? nextDailyAt(dailyAtMin) : base.next_delivery_at,
    webhook_url: webhookUrl, webhook_secret: webhookSecret, enabled,
  };
}

app.get("/api/alerts", requireAuth, wrap(async (req, res) => {
  res.json((await listAlerts(db, req.user.id, req.query.board || "")).map(alertJson));
}));

app.post("/api/alerts", requireAuth, wrap(async (req, res) => {
  const boardId = (req.body && req.body.board_id ? String(req.body.board_id) : "").trim();
  if (!boardId || !(await boardExists(db, boardId)) || !(await canAccessBoard(db, boardId, req.user)))
    return res.status(404).json({ error: "board not found" });
  const parsed = parseAlertBody(req.body, {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const id = await createAlert(db, req.user.id, boardId, parsed);
  if (id == null) return res.status(400).json({ error: "an alert with that name already exists" });
  // Baseline what already matches, so only entities entering the set from now
  // on count as new (a board retag re-lands every old entity's tags). If the
  // seed fails the alert must not survive unseeded — it would lie in wait and
  // mass-fire on the next retag; drop it and let the client retry.
  try {
    await seedAlertBaseline(db, id, boardId, parsed.condition);
  } catch (err) {
    await deleteAlert(db, req.user.id, id).catch(() => {});
    throw err;
  }
  res.json({ alert: alertJson({ id, ...parsed, has_secret: !!parsed.webhook_secret, unseen: 0 }) });
}));

app.patch("/api/alerts/:id", requireAuth, wrap(async (req, res) => {
  const id = alertIdParam(req);
  const alert = id ? await getAlertOwned(db, req.user.id, id) : null;
  if (!alert) return res.status(404).json({ error: "not found" });
  const parsed = parseAlertBody(req.body, alert);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const ok = await updateAlert(db, alert.id, parsed);
  if (ok == null) return res.status(400).json({ error: "an alert with that name already exists" });
  if (!ok) return res.status(404).json({ error: "not found" });
  // A changed condition covers new ground and abandons old: re-baseline what
  // it covers (or the first retag after a widening edit announces the
  // newly-covered backlog as new) and prune the unfired claims it left
  // behind (or a narrowed alert delivers the old condition's pending
  // backlog). Idempotent, so a failure here heals on the client's retry.
  if (!sameCondition(alert.condition, parsed.condition))
    await seedAlertBaseline(db, alert.id, alert.board_id, parsed.condition);
  res.json({ alert: alertJson({ id: alert.id, ...parsed, has_secret: !!parsed.webhook_secret }) });
}));

app.delete("/api/alerts/:id", requireAuth, wrap(async (req, res) => {
  const id = alertIdParam(req);
  if (!id || !(await deleteAlert(db, req.user.id, id)))
    return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
}));

app.get("/api/alerts/:id/firings", requireAuth, wrap(async (req, res) => {
  const id = alertIdParam(req);
  const alert = id ? await getAlertOwned(db, req.user.id, id) : null;
  if (!alert) return res.status(404).json({ error: "not found" });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  res.json(await listAlertFirings(db, alert.id, { after: req.query.after || null, limit }));
}));

// Opening the history modal is the acknowledgement — one call, not per-row.
app.post("/api/alerts/:id/seen", requireAuth, wrap(async (req, res) => {
  const id = alertIdParam(req);
  if (!id) return res.status(404).json({ error: "not found" });
  await markAlertFiringsSeen(db, req.user.id, id);
  res.json({ ok: true });
}));

// Fire a sample payload at the stored URL right now — debugging webhooks
// blind is miserable. Owner-only; the verdict comes straight back.
app.post("/api/alerts/:id/test", requireAuth, wrap(async (req, res) => {
  const id = alertIdParam(req);
  const alert = id ? await getAlertOwned(db, req.user.id, id) : null;
  if (!alert) return res.status(404).json({ error: "not found" });
  if (!alert.webhook_url) return res.status(400).json({ error: "no webhook url on this alert" });
  const result = await sendAlertWebhook(
    { id: null, alert_id: alert.id, name: alert.name, board_id: alert.board_id, condition: alert.condition,
      fired_at: Date.now(), entity_count: 1, webhook_url: alert.webhook_url, webhook_secret: alert.webhook_secret },
    [{ entity_id: 0, live_entity_id: 0, label: "Sample entity", item_id: 0, matched_at: Date.now() }],
    { test: true }
  );
  res.json(result);
}));

// The ?event= fetch: a firing plus its matched entity ids. Board ACCESS, not
// ownership — a webhook link pasted in a team channel opens for every member.
app.get("/api/alert-firings/:id", requireAuth, wrap(async (req, res) => {
  const id = alertIdParam(req);
  const firing = id ? await getAlertFiring(db, id) : null;
  if (!firing || !(await canAccessBoard(db, firing.board_id, req.user)))
    return res.status(404).json({ error: "not found" });
  const matches = await firingMatches(db, firing.id);
  res.json({
    firing: {
      id: firing.id, alert_id: firing.alert_id, name: firing.name, board_id: firing.board_id,
      fired_at: firing.fired_at, entity_count: firing.entity_count,
    },
    // Where the content lives now — a merged-away match follows its instance
    // to its current card; hard-deleted ones drop out (the chip's count
    // still states the original truth).
    entityIds: [...new Set(matches.map((m) => m.live_entity_id).filter((id) => id != null))],
  });
}));

// --- admin: manage members ---
app.get("/api/admin/users", requireAdmin, wrap(async (_req, res) => {
  res.json(await listUsers(db));
}));

app.post("/api/admin/users", requireAdmin, wrap(async (req, res) => {
  const email = (req.body && req.body.email ? String(req.body.email) : "").trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "invalid email" });
  const user = await createUser(db, email, req.body.name ? String(req.body.name).trim() : null);
  const token = await mintInvite(db, user.id);
  console.log(`invited ${user.email}`);
  res.json({ user: { id: user.id, email: user.email, name: user.name }, link: inviteLink(token) });
}));

app.post("/api/admin/users/:id/link", requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (!(await userExists(db, id))) return res.status(404).json({ error: "not found" });
  res.json({ link: inviteLink(await mintInvite(db, id)) });
}));

app.delete("/api/admin/users/:id", requireAdmin, wrap(async (req, res) => {
  await deleteUser(db, Number(req.params.id));
  res.json({ ok: true });
}));

// Board access for one member — the inverse of the Boards tab's access picker
// (PATCH /api/admin/boards/:id with memberIds/adminIds). Both write
// board_members; this one only ever rewrites THIS user's rows, so the two
// surfaces can't delete each other's people.
app.patch("/api/admin/users/:id/boards", requireAdmin, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const user = Number.isInteger(id) ? await getUserById(db, id) : null;
  if (!user) return res.status(404).json({ error: "not found" });
  // A global admin already reaches every board without a board_members row
  // (canAccessBoard short-circuits on is_admin). Writing rows for them would
  // put a weaker, revocable copy of that access in the table — one a later
  // save could take away while is_admin still says otherwise.
  if (user.is_admin) return res.status(409).json({ error: "global admins already reach every board" });
  const asIds = (v) => (Array.isArray(v) ? v : []).map(String);
  const wanted = asIds(req.body?.boardIds);
  const admins = asIds(req.body?.adminBoardIds);
  const known = await existingBoardIds(db, [...new Set([...wanted, ...admins])]);
  const live = (list) => list.filter((bid) => known.has(bid));
  await setUserBoards(db, user.id, live(wanted), live(admins));
  res.json({ ok: true });
}));

// --- boards ---

// Every board this user may see, in the READER's own arrangement (arrangeFor
// below) — which is the whole of that feature for the three routes that call
// this. A board listing that must NOT follow a reader, the admin ledger, goes
// to listBoards directly and says so there. The check goes through the
// shared per-board helper rather than one batched board_members read: a second
// authorization path is exactly the thing that drifts when the role rules move.
// It is only fanned out so the lookups overlap instead of serializing (a global
// admin short-circuits without querying at all).
//
// Extracted because three routes want it — /api/boards, /overview and /signals —
// and the polled one arriving made a third hand-written copy of the same four
// lines, which is where a policy starts to differ by accident.
async function accessibleBoards(user) {
  const all = await listBoards(db);
  const ok = await Promise.all(all.map((b) => canAccessBoard(db, b.id, user)));
  return arrangeFor(user, all.filter((_, i) => ok[i]));
}

// The reader's own arrangement (planning/board-arrangement-plan.md), applied to
// the boards they can see.
//
// Sorting HERE is what makes the feature free at every surface it covers: the
// switcher (/api/boards) and the index (/api/boards/overview) both come out of
// accessibleBoards, and both already render in received order, so neither
// client learns anything about ordering. /api/admin/boards reads listBoards
// directly and keeps created_at — that table is the instance's ledger, and a
// per-reader shelf order there would make two admins' screenshots disagree.
//
// Unranked boards sort last in the order they arrived, which Array#sort being
// stable gives us rather than a tiebreaker. That is also the entire lifecycle:
// a board created or shared since the last drag has no rank and lands at the
// end; an id whose board is gone matches nothing. Neither needs a write.
const UNRANKED = Number.MAX_SAFE_INTEGER;
function arrangeFor(user, boards) {
  const order = Array.isArray(user?.board_order) ? user.board_order : [];
  if (!order.length) return boards;
  const rank = new Map(order.map((id, i) => [id, i]));
  // In place is safe: `boards` is the fresh array filter() just produced, never
  // the listBoards rows themselves.
  return boards.sort((a, b) => (rank.get(a.id) ?? UNRANKED) - (rank.get(b.id) ?? UNRANKED));
}

app.get("/api/boards", requireAuth, wrap(async (req, res) => {
  res.json((await accessibleBoards(req.user)).map((b) => ({ id: b.id, name: b.name })));
}));

// The boards page (planning/boards-page-plan.md): every accessible board with
// its card facts — gallery-card count (entities, not item rows), capability
// flags, and a preview stack of newest thumbnails — one fetch for the whole
// page. Registered before /:id so the literal path isn't captured as an id.
// Ingest fields mirror the /:id guard: next-run only rides an enabled config.
app.get("/api/boards/overview", requireAuth, wrap(async (req, res) => {
  const boards = await accessibleBoards(req.user);
  const [counts, previews, manage] = await Promise.all([
    boardEntityCounts(db),
    boardPreviewFaces(db, boards.map((b) => b.id), 8),
    Promise.all(boards.map((b) => canManageBoard(db, b.id, req.user))),
  ]);
  res.json(boards.map((b, i) => {
    return {
      id: b.id,
      name: b.name,
      count: counts[b.id] || 0,
      // No has_taxonomy alongside this: unlike the connector name and the
      // next-run stamp, the count fully implies the flag, and two fields that
      // can disagree is a bug waiting to happen. The client tests > 0.
      facet_count: Array.isArray(b.facets) ? b.facets.length : 0,
      has_mapping: !!b.mapping,
      mapping_connector: b.mapping?.input?.connector || null,
      // These chips are an inventory of what a board HAS, so unlike the gallery
      // toolbar this one shows for every configured board — a paused or manual
      // feed is still a feed, and hiding it would read as "no ingestion here".
      // The mode is what lets the chip say which, instead of a bare icon that
      // used to promise a run the sweep was never going to arm.
      ...ingestStatus(b),
      manage: manage[i],
      preview: previews[b.id] || [],
    };
  }));
}));

// The boards index's attention dots (planning/boards-signals-plan.md): for every
// accessible board, the three stamps the gallery's header dots are built from,
// which the client holds against the SAME localStorage watermarks the gallery
// writes. That sharing is the whole design — acknowledge a board's job log in
// its gallery and this route's answer stops mattering for it, with no second
// ledger to keep in step.
//
// Its own route rather than fields on /overview, which is the /jobs/errors and
// /tokens precedent: this is re-read on a background tick, and the overview
// answers a page — entity counts and a LATERAL preview stack that nobody wants
// re-fetched, or re-rendered, once a minute.
//
// No `now`, deliberately, and it is the one field a reader of /jobs/errors would
// expect to find here. That route carries the server clock because markSeen
// FLOORS the watermark on it; the index never marks. It only compares, which is
// one stored number against one server stamp with no clock of the reader's in it
// anywhere. A `now` here would be a field with no reader.
//
// Registered before /:id so the literal path isn't captured as an id.
app.get("/api/boards/signals", requireAuth, wrap(async (req, res) => {
  const boards = await accessibleBoards(req.user);
  // The diagnostics gate has a cheap half and an expensive half, and the cheap
  // half is already in memory: vote mode and the stored findings both ride in on
  // the read above. Resolving it FIRST means canManageBoard is asked only where
  // its answer can still change the output — which on a typical instance is no
  // boards at all, since ai_votes defaults to 1. That matters here and not on
  // /overview, because this route runs on a tick: the discarded lookups would
  // have been one per board per minute per open tab, forever.
  //
  // Not a cache and not a second authorization path — the same helper, the same
  // rule, asked in fewer places.
  const finding = boards.map((b) => (Number(b.ai_votes) > 1 ? storedFindingAt(b) : null));
  const [failures, alertsUnseen, manage] = await Promise.all([
    boardLatestFailures(db, boards.map((b) => b.id)),
    // Skipped outright for a reader with no boards, who would otherwise pay for
    // an aggregate over their alerts to be told about nothing.
    boards.length ? boardAlertUnseen(db, req.user.id) : {},
    Promise.all(boards.map((b, i) => (finding[i] ? canManageBoard(db, b.id, req.user) : false))),
  ]);
  // One entry per accessible board, nulls included, rather than only the boards
  // with news: absence would then mean both "nothing here" and "not in this
  // response", and this feature has already paid for that conflation twice
  // (signals.js's `landed`, state.facetStats). An entry is an answer.
  res.json(boards.map((b, i) => ({
    board_id: b.id,
    failed_at: failures[b.id] ?? null,
    alerts_unseen: alertsUnseen[b.id] || 0,
    // Gated HERE and not on the client. /facet-stats is requireBoardManager, and
    // "there is a finding on this board" is the substance of what that gate
    // protects — emitting it to a plain member through the index would widen an
    // access boundary by way of a dot. canSeeDiagnostics' two operands, on the
    // side of the wire where they decide disclosure rather than whether a button
    // is drawn.
    diagnostic_at: manage[i] ? finding[i] : null,
  })));
}));

app.get("/api/boards/:id", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  const [canManage, usage, embeddingOk] = await Promise.all([
    canManageBoard(db, board.id, req.user),
    boardUsageSummary(db, board.id),
    resolveEmbedder(db).then(Boolean),
  ]);
  // Spend is management-visible (metering-plan.md, Decided). The summary is
  // one query for everyone; management decides only DISCLOSURE, which is why
  // it can run concurrently with the read rather than gating it.
  const cost = canManage ? usage.cost : null;
  res.json({
    id: board.id,
    name: board.name,
    facets: board.facets,
    context: board.context,
    ai_reasoning: board.ai_reasoning !== false,
    // Vote mode's pass count. The gallery needs it to gate anything that reads
    // per-facet confidence — a single-pass board has none at all (tag_confidence
    // {} means NOT MEASURED), so a control that surfaces it would be permanently
    // empty there. /settings has carried it since 0029; this payload is what the
    // gallery actually loads.
    ai_votes: board.ai_votes || 1,
    mapping: board.mapping || null,
    search: embeddingOk,
    manage: canManage,
    paused: board.paused === true,
    // The board's all-time spend, per unit and never summed across them
    // (metering-plan.md Stage 0 — input and output bill at different rates),
    // with the vocabulary beside it so the chip renders what it is handed.
    units: usage.units,
    unitDefs: unitList(Object.keys(usage.units)),
    ...(cost ? { cost } : {}),
    // What ingestion is doing + the next-run stamp: the toolbar chip counts
    // down to the run, and the client keeps a slow delta poll alive whenever a
    // run is actually coming. The mode is what separates the two no-next-run
    // cases — an on-demand board from a held schedule. The stamp is NOT blanked
    // for a held schedule: "Run now" on a paused or manual board arms it, and
    // that pending run is exactly what the chip should show.
    ...ingestStatus(board),
  });
}));

// Just the token buckets — polled by the live token chip while tagging runs,
// so the counts tick up without re-fetching the whole board payload.
app.get("/api/boards/:id/tokens", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  // This route is POLLED while tagging runs, so it stays one meter query:
  // the summary answers buckets and spend together, and the manager check
  // rides alongside rather than gating a second read.
  const [usage, manage] = await Promise.all([
    boardUsageSummary(db, board.id),
    canManageBoard(db, board.id, req.user),
  ]);
  const cost = manage ? usage.cost : null;
  res.json({ units: usage.units, unitDefs: unitList(Object.keys(usage.units)), ...(cost ? { cost } : {}) });
}));

// The board's job log (planning/job-log-plan.md): running sweep jobs (a
// transcription or ingest run in flight) plus settled history, newest first
// behind a keyset cursor. Deliberately member-visible like /tokens, errors
// included — the log is transparency, not management.
app.get("/api/boards/:id/jobs", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const pick = (j) => ({
    id: j.id, kind: j.kind, outcome: j.outcome, error: j.error, detail: j.detail,
    target: j.target, entity_id: j.entity_id, item_id: j.item_id,
    // A real display name wins; then the frozen target (the ORIGINAL
    // filename) — a provisional upload entity's identity is the stored hex
    // name, so it comes last, not ahead of the label people recognize.
    entity_display: j.entity_display || j.target || j.entity_identity,
    started_at: j.started_at, ended_at: j.ended_at,
  });
  // kind=refresh serves field_snapshots wearing the same row shape — refresh
  // ticks are deliberately not in job_log (volume); movement already is. The
  // has_refresh flag tells the client whether the Refresh pill has anything
  // behind it.
  const historyP = req.query.kind === "refresh"
    ? listRefreshHistory(db, board.id, { after: req.query.after || null, limit }).then(({ rows, nextCursor }) => ({
        jobs: rows.map((s) => ({
          id: s.id, kind: "refresh", outcome: "ok", error: null,
          detail: { fields: s.fields, provider: s.source },
          target: null, entity_id: s.entity_id, item_id: null,
          entity_display: s.entity_display || s.entity_identity,
          started_at: s.refreshed_at, ended_at: null,
        })),
        nextCursor,
      }))
    : listJobLog(db, board.id, {
        after: req.query.after || null,
        kind: req.query.kind || null,
        outcome: req.query.outcome || null,
        limit,
      }).then((page) => ({ jobs: page.jobs.map(pick), nextCursor: page.nextCursor }));
  const [running, history, hasRefresh, nextRefreshAt, failedAt] = await Promise.all([
    listRunningJobs(db, board.id),
    historyP,
    boardHasRefreshHistory(db, board.id),
    boardNextRefreshAt(db, board.id),
    // Board-wide and independent of the kind filter above — this is the chip's
    // dot, not part of the page. Served here as well as on its own route so the
    // reader with the modal OPEN acknowledges against what they are actually
    // looking at, rather than against a stamp the background tick last
    // refreshed up to twenty seconds ago. Same function either way, so the two
    // cannot disagree.
    latestJobFailureAt(db, board.id),
  ]);
  res.json({
    running: running.map(pick),
    jobs: history.jobs,
    nextCursor: history.nextCursor,
    has_refresh: hasRefresh,
    failed_at: failedAt,
    // The work-kind vocabulary (capabilities.js), pill order — the modal
    // renders labels from THIS, never a client-side list, so a new kind
    // arrives with its name (metering-plan.md, Mechanism 3's rule for units,
    // applied to work).
    kinds: kindList(),
    // Upcoming work — the modal's "scheduled" strip. Null = nothing of that
    // family is coming on this board. For ingestion the armed stamp is the
    // whole answer: it covers a live schedule AND a "Run now" queued against a
    // paused or manual board, which is work that is genuinely about to happen
    // and which an `enabled` test would have hidden from this strip.
    scheduled: {
      ingest_next_run_at: ingestStatus(board).ingest_next_run_at,
      retag_next_run_at: board.auto_tag !== false && board.auto_tag_periodic ? board.auto_tag_next_run_at ?? null : null,
      refresh_next_at: nextRefreshAt,
    },
    // The modal renders pause state it fetched, not state it hopes the board
    // payload had — this endpoint is its own 5s heartbeat, so a pause flipped
    // by another manager shows up here first.
    paused: board.paused === true,
    now: Date.now(),
  });
}));

// The jobs chip's attention dot: one stamp, the newest failure on this board,
// which the client holds against its own local watermark. Its own route rather
// than a field on the page above — the gallery re-reads this on the poll tick
// and a page costs four queries to answer, which is exactly why /tokens is its
// own route too. Member-visible on the same terms as the log it summarises.
app.get("/api/boards/:id/jobs/errors", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  // `now` travels with it: the client's watermark is compared against server
  // stamps, so it has to be floored on the server's clock, not the reader's
  // (public/seen-mark.js). Free here, and this is the read that happens often
  // enough to keep the offset honest.
  res.json({ failed_at: await latestJobFailureAt(db, board.id), now: Date.now() });
}));

// Clear the board's job history — the modal's red button. Manager-gated:
// READING the log is transparency for every member, but destroying it is
// management. Settled rows only; running rows are live work whose stamp is
// still coming, and refresh history (field_snapshots) is movement data, not
// this ledger — both survive.
app.delete("/api/boards/:id/jobs", requireAuth, requireBoardManager, wrap(async (req, res) => {
  res.json({ cleared: await clearJobLog(db, req.board.id) });
}));

// Soft cancel — "Cancel queued" (job-control-plan.md Stage 2), shared by the
// Jobs modal button below and the admin stop button's route. One board-run
// job-log row per cancel, whatever the counts came to — somebody asked, so
// "nothing was queued" is the answer — and the ledger never breaks the job:
// a log failure is a warn, the cancel itself already committed.
async function cancelQueued(boardId, { abort = false } = {}) {
  const t0 = Date.now();
  const counts = await cancelBoardQueue(db, boardId, { abort });
  await jobLogWrite(() => addJobLog(db, {
    boardId, kind: "cancel", outcome: "ok",
    detail: { mode: abort ? "abort" : "queued", ...counts },
    startedAt: t0, endedAt: Date.now(),
  }), `cancel row, board ${boardId}`);
  console.log(`cancel ${abort ? "ABORT" : "queued"}: board ${boardId} — ${counts.restored} restored, ${counts.parked} parked, ${counts.removed} removed, ${abort ? `${counts.discarding} discarding` : `${counts.finishing} left to finish`}`);
  return counts;
}

// Manager-gated like Clear above and for the same reason: reading the queue is
// for every member, emptying it is holding the board. `{ abort: true }` in the
// body is the hard verb (Stage 3) — same door, wider blast radius.
app.post("/api/boards/:id/jobs/cancel-queued", requireAuth, requireBoardManager, wrap(async (req, res) => {
  res.json({ ok: true, ...(await cancelQueued(req.board.id, { abort: req.body?.abort === true })) });
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
    ai_votes: b.ai_votes || 1,
    // The facet editor renders each facet's finding under the description being
    // edited, which is where the fix gets typed. Same rows as /facet-stats, so
    // the two surfaces cannot disagree about what a facet's state is.
    facet_gates: GATES,
    facet_stats: await facetRollup(db, b),
    auto_tag: b.auto_tag !== false,
    auto_tag_periodic: !!b.auto_tag_periodic,
    auto_tag_every_min: b.auto_tag_every_min || 1440,
    auto_tag_skip_weekends: !!b.auto_tag_skip_weekends,
    retag_on_refresh: !!b.retag_on_refresh,
    // The modal's Mapping pane: the mapping itself (already public via
    // GET /api/boards/:id) and whether the board has items — templates only
    // apply while it's empty.
    mapping: b.mapping || null,
    has_items: await boardHasItems(db, b.id),
    ingest: b.ingest || null,
    ingest_state: b.ingest_state || null,
    // Board-scoped capability KNOBS (tagging's image detail) + the vocabulary
    // their pickers need. Visible to any board manager: these are cost/quality
    // dials like ai_votes above, not credentials — and the manager save route
    // accepts them (buildBoardContentUpdate).
    ...Object.fromEntries(BOARD_CONFIG_COLS.map((col) => [col, b[col] ?? null])),
    capability_config: await boardConfigCatalog(db),
    // Every capability's board-PIN columns (registry-derived) — the strip's
    // pickers preselect off these. Admin-only: pins select credentials, and
    // key ids are nobody else's business.
    ...(req.user.is_admin
      ? Object.fromEntries(BOARD_PIN_COLS.map((col) => [col, b[col] ?? null]))
      : {}),
  });
}));

// Per-facet tagging consistency: how often the board's own tagger agreed with
// itself, facet by facet (planning/facet-diagnosis-plan.md §1). Answering "which
// of my facets is a coin flip" has needed hand-written SQL until now.
//
// requireBoardManager, matching the edit pencil rather than the jobs chip: the
// number is only actionable to someone who can edit the taxonomy it measures.
// `votes` rides along because 1 means the board measures nothing at all — {} is
// NOT MEASURED, never zero agreement — and a reader has to tell that from a
// board that measured and found no problem.
app.get("/api/boards/:id/facet-stats", requireAuth, requireBoardManager, wrap(async (req, res) => {
  res.json({
    votes: req.board.ai_votes || 1,
    // The thresholds the loop gates on ride out with the numbers they apply to.
    // The client decides which of the five states a facet is in, and a copy of
    // these in the browser would drift the first time either is retuned — with
    // a symptom (a facet stuck "awaiting re-measurement" while the loop happily
    // re-diagnoses it) that reads as a bug in neither half.
    gates: GATES,
    facets: await facetRollup(db, req.board),
  });
}));

// THE board save — both mounts (/api/boards/:id for any manager, the
// /api/admin/boards/:id alias the admin page has always called) run this one
// handler. Authority is layered off req.user, never off which URL the client
// picked: the content trunk (buildBoardContentUpdate) runs for everyone, the
// admin legs (capability pins, mapping, memberIds) only for a global admin.
// The two used to be separate routes whose validate → write → side-effect
// tails were hand-copied and had started to differ in order — the exact drift
// this merge exists to end.
//
// A non-admin body carrying admin-only fields has them IGNORED, not refused
// (board-manage.test.js pins this): the modal saves full-state, and a
// manager's hour of taxonomy edits must not 403 over a field their UI never
// rendered.
const saveBoardPatch = wrap(async (req, res) => {
  const prev = req.board;
  const isAdmin = !!req.user.is_admin;
  const { update, error, sweep, demote } = await buildBoardContentUpdate(req.body, prev);
  if (error) return res.status(400).json({ error });
  let inputSwitched = false;
  if (isAdmin) {
    const admin = await buildBoardAdminUpdate(req.body, prev, update);
    if (admin.error) return res.status(400).json({ error: admin.error });
    inputSwitched = admin.inputSwitched;
  }

  if (Object.keys(update).length > 0) await updateBoard(db, prev.id, update);
  // A redefined facet's finding quotes wording that no longer exists; its stats
  // are the only baseline for "was 60% unanimous, now 88%". Demote, don't drop.
  await demoteFacetDiagnostics(db, prev.id, demote);
  // A saved ingest config supersedes the old one's run verdicts — its
  // half-drained budget AND its last_error (the chips clear on save; the next
  // run judges the new config). An input SWITCH goes further: run state
  // written against the old adapter means nothing to the new one.
  if (inputSwitched) await setIngestState(db, prev.id, null);
  else if (update.ingest !== undefined) await clearIngestSuperseded(db, prev.id);
  // A mapping change can turn fields live/idle, move their cadence, or turn the
  // face on — recompute every entity's next refresh (an empty live set clears
  // their schedules; a newly-configured face marks unrendered entities due now,
  // which is what backfills charts onto cards that predate the face), and
  // re-project deterministic file metadata for existing instances (file boards
  // only; connector items have no file entry so they'd no-op anyway). Only
  // reachable when the admin leg accepted a mapping — update.mapping stays
  // undefined for managers.
  if (update.mapping !== undefined) {
    await rescheduleEntityRefreshes(db, prev.id, liveFields(update.mapping), faceSchedule(update.mapping));
    const m = update.mapping;
    if (m === null || !m.input) await backfillFileFields(prev.id, m);
  }
  // Unpausing floors the board's overdue refresh stamps to now: a days-paused
  // board otherwise owns the deep past of dueLiveEntities' soonest-first order
  // and monopolizes the refresh sweep for its whole drain (job-control-plan.md
  // Stage 1). Pausing needs no side-effect — the gates read the flag live.
  // It lives here, beside its sibling second-statement effects, because this
  // route is the ONLY unpause path; give `paused` a second writer (a bulk
  // "resume all", a restore) and this belongs in a setBoardPaused db helper.
  if (update.paused === false && prev.paused) await floorOverdueRefreshes(db, prev.id);
  // The moment auto-tagging comes back on, sweep the board: queue everything
  // untagged — held uploads, AI-undecided, failed. Turning it off queues
  // nothing — uploads pile up as 'held', untagged, until tagging returns.
  if (sweep) {
    const n = await queueUntagged(db, prev.id);
    if (n) console.log(`board ${prev.id}: auto-tagging on — swept ${n} untagged item(s) into the queue`);
  }
  if (isAdmin && req.body && Array.isArray(req.body.memberIds)) {
    const adminIds = Array.isArray(req.body.adminIds) ? req.body.adminIds.map(Number).filter(Boolean) : [];
    await setBoardMembers(db, prev.id, req.body.memberIds.map(Number).filter(Boolean), adminIds);
  }
  invalidateBoardCache(prev.id);
  // Hand back the ingestion trio this save landed on, so the modal can stamp it
  // straight into client state instead of re-deriving the mode in JS (a second
  // copy of ingestMode's rules) or paying a refetch to learn what we just wrote.
  // ingest_error: an ingest save just cleared last_error (superseded, above),
  // so no state = false is the truth there; a save that didn't touch ingest
  // carries the row's live state so the echo stays honest for every reader.
  res.json({
    ok: true,
    ...ingestStatus({
      ingest: update.ingest !== undefined ? update.ingest : prev.ingest,
      ingest_next_run_at: update.ingestNextRunAt !== undefined ? update.ingestNextRunAt : prev.ingest_next_run_at,
      ...(update.ingest === undefined ? { ingest_state: prev.ingest_state } : {}),
    }),
    // Echoed for the same reason as the trio above, and load-bearing for the
    // client's single stamping funnel: stampBoard resets `paused` from whatever
    // payload it is handed, so a save response that omitted it would read as
    // "unpaused" and silently resume the board on the client.
    paused: (update.paused ?? prev.paused) === true,
  });
});

app.patch("/api/boards/:id", requireAuth, requireBoardManager, saveBoardPatch);

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
    // The resolved root itself (null = folder ingestion unconfigured), so the
    // modal can show what a subpath actually means (/data/ingest/ +
    // "wardrobe") instead of a bare name whose real location only ever
    // surfaced by accident in raw fs error strings. This route is
    // manager-gated precisely because the config carries server paths, so the
    // root string sits behind the same fence.
    rootPath: process.env.INGEST_ROOT || null,
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
    // limit rides through raw — browse() owns the default and the clamp.
    res.json(await adapter.browse(db, source, navPath, { limit: req.body?.limit }));
  } catch (err) {
    // 404 = the path itself is missing — err.notFound, tagged by the backend
    // (the contract note in sources/folder.js's header) — and the modal falls
    // back a level and offers the relink. Anything else (dead server, bad
    // connection, escape) is a plain 400: falling back would fail at every
    // level too, some behind a 30s connect timeout each.
    res.status(err.notFound ? 404 : 400).json({ error: err.message });
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
  // trigger: false — preview answers "what matches", and the schedule has no
  // bearing on that; a half-typed "every N minutes" must not block it.
  const err = validateIngest(cfg, adapter.descriptor(), { hasRoot, trigger: false });
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
  // The preview window IS the run window — one bound, so the count can never
  // promise what a run won't see. Connector adapters carry their own
  // (windowCap: depth is free for a snapshot-served catalog, metered for a
  // paged one); the file adapter keeps the shared default.
  const windowCap = adapter.windowCap ? adapter.windowCap() : ENUM_CAP();
  let enumerated;
  try {
    enumerated = await adapter.enumerate(db, req.board, cfg, { limit: windowCap });
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
      // How deep this actually went. Shipped because the client has to NAME
      // it ("showing the first N scanned") and it was never a constant it
      // could hardcode — it's the safety backstop, or whatever an operator
      // set INGEST_FEED_CAP to.
      scanned: enumerated.candidates.length,
      sample: rows.map((c) => ({ ...c, ingested: known.has(c.key) })),
      hasMore: sample.offset + sample.limit < matched.length,
    });
  }
  const known = await ingestedKeys(db, req.board.id);
  res.json({
    count: matched.length,
    new: matched.filter((c) => !known.has(c.key)).length,
    capped: !!enumerated.truncated,
    scanned: enumerated.candidates.length,
  });
}));

// "Run now": arm the timer for the next tick. The only way to fire a manual
// board, and deliberately NOT gated on `enabled` — pausing a schedule stops the
// timer, it doesn't confiscate the button. The sweep disarms a paused board
// again after the run, so this buys exactly one run.
app.post("/api/boards/:id/ingest/run", requireAuth, requireBoardManager, wrap(async (req, res) => {
  if (!req.board.ingest)
    return res.status(409).json({ error: "ingestion is not configured on this board" });
  await setIngestNextRun(db, req.board.id, Date.now());
  res.json({ ok: true });
}));

app.get("/api/admin/boards", requireAdmin, wrap(async (_req, res) => {
  const boards = await listBoards(db);
  const stats = await boardItemStats(db);
  res.json({
    boards: await Promise.all(
      boards.map(async (b) => ({
        ...b,
        item_count: stats[b.id]?.c || 0,
        pending_count: stats[b.id]?.p || 0,
        held_count: stats[b.id]?.h || 0,
        memberIds: await getBoardMemberIds(db, b.id),
        adminIds: await getBoardAdminIds(db, b.id),
      }))
    ),
  });
}));

// --- usage (metering-plan.md, Mechanism 3 / Stage 4) ---
// The dimensioned reader behind the Usage tab (and any later consumer): group
// by any subset of the meter's dimensions over any day window. The response is
// SELF-DESCRIBING (the detail-chart precedent): units with their labels and
// format kinds, kind and capability names, board and provider labels — the
// client renders what it is handed and never invents a vocabulary of its own.
// A read with no window would scan (and ship) all of history — the meter keeps
// forever by default, and grouping collapses only the unit axis, so it bounds
// nothing. The window is a DEFAULT, not a law: `from=` reaches back as far as
// the caller likes, and the answer always echoes the window it used so the
// client states the period it is showing rather than assuming one.
const USAGE_DEFAULT_DAYS = 30;

async function usageResponse(query, { board }) {
  const group = String(query.group || "").split(",").map((s) => s.trim()).filter(Boolean);
  const bad = group.find((g) => !USAGE_DIMS[g]);
  // The app's own status channel (wrap → the error middleware), the same
  // Object.assign idiom capability-bind/probe use — so this helper returns the
  // thing it computes and no caller unpacks an HTTP envelope.
  if (bad) throw Object.assign(new Error(`unknown group dimension "${bad}"`), { status: 400 });
  const from = query.from || day(Date.now() - (USAGE_DEFAULT_DAYS - 1) * 86400000);
  const to = query.to || null;
  const rows = await usageRows(db, {
    from, to, group,
    // The board is the CALLER's to state — the scoped route passes its own and
    // the admin route passes the query's, so scope is never a defaulted
    // parameter a third route could forget into "every board".
    board,
    capability: query.capability || null,
  });
  // One shape and one degradation rule for every dimension's values: an id
  // with no name renders as itself, never dropped (an uninstalled plugin's
  // provider and a deleted board are the same story). The client loops over
  // `dims` instead of branching per dimension name.
  //
  // The '' sentinel is handled ONCE here, from what the axis declares
  // (USAGE_DIMS.emptyLabel), rather than by a per-dimension branch inside each
  // namer — the axis owns what its own emptiness means, and a Stage 5
  // dimension with a sentinel gets named by declaring it, not by remembering
  // to add a branch in this file.
  const boardNames = group.includes("board")
    ? new Map((await listBoards(db)).map((b) => [b.id, b.name]))
    : null;
  // Two registries answer to the `provider` axis, because two families of work
  // spend against it: AI providers and the connector runtime's data providers
  // (Stage 5d). pluginDefs() is already the composed catalog over both, and it
  // is memoized behind the resetDefs() the loader fires on every
  // register/unregister — so a plugin-registered provider names itself here
  // with no invalidation of ours. Narrowed to connector defs because the same
  // catalog also carries media and source defs, where `local` is a source name
  // AND an AI provider name; AI stays first regardless.
  //
  // A COLLISION IS NOT ONLY COSMETIC, and this comment said otherwise until the
  // 5d pass measured it: the stored provider id is the rate key too
  // (pricing.js `key(provider, model)`), and an on-device AI provider carries a
  // `*`/`*` zero rate that matches ANY model spelling. So a connector sharing
  // that name would have its quota stamped priced-at-zero — a "known free"
  // claim, not the honest unpriced blank. Nothing collides today and both
  // families are un-namespaced in the meter; fixing it properly means
  // namespacing the stored id (both families, or neither) plus a migration of
  // usage_meter.provider, which is a slice of its own.
  const connectorProviders = new Map(
    pluginDefs().filter((d) => d.kind === "connector").map((d) => [d.name, d.label]));
  const NAMERS = {
    board: (id) => boardNames?.get(id) ?? id,
    capability: capabilityLabel,
    provider: (id) => PROVIDERS[id]?.label ?? connectorProviders.get(id) ?? id,
    model: (id) => id,
    day: (id) => id,
  };
  const values = (dim) => {
    const name = NAMERS[dim], { emptyLabel } = USAGE_DIMS[dim];
    return Object.fromEntries([...new Set(rows.map((r) => r[dim]))]
      .map((id) => [id, id === APP_SCOPE && emptyLabel ? emptyLabel : name(id)]));
  };
  return {
    rows,
    from, to,
    // WHICH BREAKDOWNS EXIST (Mechanism 3), from the same table the group
    // param is validated against — plus the values present for the ones asked
    // for, each with its label.
    dims: Object.fromEntries(Object.entries(USAGE_DIMS).map(([id, d]) => [
      id,
      { label: d.label, ...(group.includes(id) ? { values: values(id) } : {}) },
    ])),
    units: unitList(rows.flatMap((r) => Object.keys(r.units))),
  };
}

app.get("/api/usage", requireAdmin, wrap(async (req, res) => {
  res.json(await usageResponse(req.query, { board: req.query.board || null }));
}));

// The board-scoped twin: same reader, the board pinned by the route. Manager-
// gated — spend is management-visible (metering-plan.md, Decided) — which
// requireBoardManager already says in the house voice (404 unknown, 403
// member).
app.get("/api/boards/:id/usage", requireAuth, requireBoardManager, wrap(async (req, res) => {
  // The board comes from the ROUTE, so a `?board=` in the query cannot widen
  // the scope — it is not consulted at all.
  res.json(await usageResponse(req.query, { board: req.board.id }));
}));

// --- storage (storage-plan.md, Stage 2) ---
// The gauge's read: the LEVEL, measured live — the walk is sub-second at this
// app's scale, and a stale answer to "how full is my server" would be a
// self-inflicted wound. The measurement is recorded under today before the
// series is read, so the trend the tab draws always includes the point it is
// standing on (the user looking IS a sample). `boards` is attribution of
// originals, `now` is disk truth; they don't add up and the tab says so —
// boardFileBytes carries the why.
app.get("/api/admin/storage", requireAdmin, wrap(async (_req, res) => {
  // The board attribution shares nothing with the walk, so it runs beside it
  // rather than behind it — awaited in the same expression, so a failing
  // measure rejects it here instead of surfacing as an unhandled rejection.
  // Only the series genuinely waits on the write.
  const [now, boards] = await Promise.all([measureStorage(db, STORAGE_DIRS), boardFileBytes(db)]);
  await writeSample(db, day(), now);
  // Wide enough for the tab's 30 bars and the days-until-full slope that will
  // read the same payload — not "everything ever", which has no ceiling.
  const series = await readSeries(db, day(Date.now() - 89 * 86400000));
  res.json({ now, series, boards, stores: STORE_DEFS });
}));

// --- model prices (metering-plan.md, Stage 3c) ---
// The rate map's admin surface. Routes only for now — their editor UI belongs
// to Stage 4's Usage tab (the plan records that routes lead their UI by one
// stage); until then this is curl-able and what the tab will bind to.

// The editor's read (Stage 4c): the RESOLVED rate map with per-unit
// provenance — what will actually be stamped and which rung said so — plus
// the fetch list, when each learner rung last heard from its source, and the
// unit vocabulary. `units` is the REGISTRY (∪ anything resolved outside it),
// not just what's present: an editor declares new facts, so its vocabulary
// can't be limited to the old ones.
app.get("/api/admin/prices", requireAdmin, wrap(async (_req, res) => {
  // Independent reads of the same table, so they run concurrently rather
  // than one behind the other — neither answer feeds the other.
  const [models, freshness] = await Promise.all([priceState(db), modelPriceFreshness(db)]);
  res.json({
    models,
    wanted: wantedModels(),
    freshness,
    units: unitVocabulary(models.flatMap((m) => Object.keys(m.units))),
  });
}));

// Type a price in. An admin row always wins, and an edit INSERTS a new
// effective row — never rewrites one, and never restamps history (the 3a
// rule). The rate rule is `validRate` (units.js), the same one the descriptor
// rung, both learners, and the write itself hold — the route's own job is
// only to turn a rejection into a 400 rather than a 500.
app.put("/api/admin/prices", requireAdmin, wrap(async (req, res) => {
  const { provider, model, unit, microsPerUnit } = req.body || {};
  for (const [k, v] of [["provider", provider], ["model", model], ["unit", unit]])
    if (!v || typeof v !== "string") return res.status(400).json({ error: `${k} is required` });
  if (!validRate(microsPerUnit))
    return res.status(400).json({ error: "microsPerUnit must be a non-negative finite number (0 = known-free)" });
  await setModelPrice(db, { provider, model, unit, microsPerUnit });
  res.json({ ok: true });
}));

// "Refresh prices now" — the learners' pass with the staleness gates skipped
// (they pace the background sweep; they don't refuse a person who asked).
// null from the learner means the pass itself broke, and the person who
// clicked deserves that difference from "nothing new".
app.post("/api/admin/prices/refresh", requireAdmin, wrap(async (_req, res) => {
  const learned = await learnPrices(db, { force: true });
  if (learned == null) return res.status(502).json({ error: "price refresh failed — see the server log" });
  res.json({ learned });
}));

// "Price past usage" — the plan's additive escape hatch, an admin's explicit
// act (metering.js priceUnpricedHistory). Stamps TODAY's rates onto the
// unpriced remainder only; priced history never moves. Idempotent by nature:
// a second click finds no remainder left that any rung can price.
app.post("/api/admin/prices/history", requireAdmin, wrap(async (_req, res) => {
  res.json(await priceUnpricedHistory(db));
}));

// The content-editable board fields shared by every board save surface —
// create and both PATCH mounts: name, context, facets, the toggles,
// `~` prefixes are reserved for system facets (~objects, ~uploaders — the
// client's filter router shadows them, and alert conditions/saved configs
// store them durably), so a user facet may not claim one. The only facet-key
// constraint enforced server-side; everything else about facets stays free.
function facetsReservedKeyError(facets) {
  const clash = facets.find((f) => typeof f?.key === "string" && f.key.startsWith("~"));
  return clash ? `facet key "${clash.key}" is reserved (~ prefixes belong to system facets)` : null;
}

// and the auto-tag schedule (with the timer bookkeeping). Returns
// { update, error, sweep, demote } — error is a string when the body is
// invalid, sweep is true when auto-tagging transitions off→on (caller queues
// untagged items), demote the facets whose definition moved.
async function buildBoardContentUpdate(body = {}, prev) {
  body = body || {};
  const update = {};
  // Facets whose DEFINITION moved, with the wording being replaced. Returned
  // beside `update` for the route to act on, exactly as `sweep` is: the write
  // itself is a second statement against a worker-owned column, not something
  // updateBoard can fold in.
  //
  // DIFFED, never fired on `body.facets !== undefined` — the board modal sends
  // `facets` on every save, so that test would demote every finding on the board
  // the first time someone renames it.
  let demote = [];
  if (body.name !== undefined) {
    update.name = String(body.name).trim();
    // The same rule create enforces — a board must keep a name. The modal
    // guards this client-side; the API refuses it for everyone else.
    if (!update.name) return { error: "name required" };
  }
  if (body.facets !== undefined) {
    if (!Array.isArray(body.facets)) return { error: "facets must be an array" };
    const reserved = facetsReservedKeyError(body.facets);
    if (reserved) return { error: reserved };
    update.facets = body.facets;
    demote = editedFacets(prev?.facets || [], body.facets);
  }
  // ?? "" so an explicit null clears the context instead of storing "null".
  if (body.context !== undefined) update.context = String(body.context ?? "");
  if (body.ai_reasoning !== undefined) update.aiReasoning = !!body.ai_reasoning;
  if (body.ai_research !== undefined) update.aiResearch = !!body.ai_research;
  if (body.ai_votes !== undefined) {
    const v = Number(body.ai_votes);
    // Odd only: an even count makes a genuine tie reachable on a single-value
    // facet, which the merge can only break arbitrarily.
    if (![1, 3, 5].includes(v)) return { error: "ai_votes must be 1, 3 or 5" };
    update.aiVotes = v;
  }
  // Research bills per web search ON TOP of tokens, so N passes multiply a cost
  // the token figures never show. Checked against the POST-update pair, so
  // enabling either one against a standing other is refused and not just the
  // simultaneous case.
  //
  // ONLY when the request actually touches one of the two: a board already
  // holding the pair (reachable by editing the column directly) must still be
  // renameable. Validating untouched state would make an unrelated edit fail
  // for a reason the user can't see in their own request — and tagging is
  // protected regardless, since getBoardPrompt forces a single pass under
  // research whatever the column says.
  if (body.ai_votes !== undefined || body.ai_research !== undefined) {
    const votesAfter = update.aiVotes ?? prev.ai_votes ?? 1;
    const researchAfter = update.aiResearch ?? prev.ai_research === true;
    if (votesAfter > 1 && researchAfter) {
      return { error: "agreement passes cannot be combined with web research — searches bill per pass" };
    }
  }
  if (body.auto_tag !== undefined) update.autoTag = !!body.auto_tag;
  if (body.auto_tag_periodic !== undefined) update.autoTagPeriodic = !!body.auto_tag_periodic;
  if (body.auto_tag_every_min !== undefined) {
    const m = parseEveryMin(body.auto_tag_every_min);
    if (m === null) return { error: "invalid auto_tag_every_min" };
    update.autoTagEveryMin = m;
  }
  if (body.auto_tag_skip_weekends !== undefined) update.autoTagSkipWeekends = !!body.auto_tag_skip_weekends;
  if (body.retag_on_refresh !== undefined) update.retagOnRefresh = !!body.retag_on_refresh;
  // Board pause (job-control-plan.md Stage 1): manager-level like the rest of
  // this trunk — the Jobs modal's Pause button PATCHes it. Just a flag here;
  // the worker's due/claim queries are where it bites, and the route handles
  // the one resume side-effect (the refresh floor) beside its sibling
  // second-statement effects (sweep, demote).
  if (body.paused !== undefined) update.paused = !!body.paused;
  // Board-scoped capability knobs (tagging's image detail) — here, not in the
  // admin-only pin patch, because a manager may set them. The validator throws
  // (it is shared with the capability bind route, whose contract is a thrown
  // 400); this function's contract is a RETURNED error, so convert rather than
  // leaning on the global handler — both PATCH routes already have the
  // `if (error) return 400` branch.
  let cfgCols;
  try {
    cfgCols = boardConfigPatch(body);
  } catch (e) {
    if (e.status === 400) return { error: e.message };
    throw e;
  }
  if (Object.keys(cfgCols).length) update.boardBindings = { ...update.boardBindings, ...cfgCols };

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
      // `enabled` is a pause on the SCHEDULE, so a manual board has nothing for
      // it to hold — stored false there it would be inert state that ambushes
      // the user later, when switching back to a schedule starts it held for a
      // pause nobody asked for. Normalize here rather than in the modal: it is
      // the config's invariant, not a rendering detail, and ingestMode already
      // reads manual as winning.
      update.ingest = body.ingest.trigger.mode === "manual"
        ? { ...body.ingest, enabled: true }
        : body.ingest;
      const wasArmed = !!(prev.ingest && prev.ingest.enabled !== false && prev.ingest.trigger?.mode !== "manual");
      const isArmed = ingestMode(update.ingest) === "scheduled";
      const trigChanged = JSON.stringify(prev.ingest?.trigger ?? null) !== JSON.stringify(body.ingest.trigger);
      // Disarm the SCHEDULE — but a board that was on no schedule either side
      // of this save can only hold a stamp because "Run now" put one there, and
      // nulling that would silently cancel the run we just told the user was
      // queued. The two buttons sit side by side in the modal, so "fire it,
      // then save the config" is an ordinary thing to do. (A stamp alone can't
      // tell the two apart: an armed schedule's first run also sits at `now`.
      // Being unarmed on both sides is what makes it hand-fired.)
      const handFired = !wasArmed && !isArmed && prev.ingest_next_run_at != null;
      if (isArmed && (!wasArmed || trigChanged)) update.ingestNextRunAt = Date.now();
      else if (!isArmed && !handFired) update.ingestNextRunAt = null;
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

  return { update, error: null, sweep: eff.autoTag && !prev.auto_tag, demote };
}

// The ADMIN half of a board save, layered over the content trunk by all three
// admin write surfaces (create, and both PATCH mounts when the caller is a
// global admin): capability pins (boardBindingPatch — the registry loop,
// stricter than the hand-copied blocks it replaced) and the mapping. Mutates
// `update` in place and returns { error, inputSwitched } — the trunk's
// returned-error contract, so every route branches exactly once.
async function buildBoardAdminUpdate(body = {}, prev, update) {
  try {
    const pins = await boardBindingPatch(db, body || {});
    // MERGE: the trunk may already have put config knobs here.
    if (Object.keys(pins).length) update.boardBindings = { ...update.boardBindings, ...pins };
  } catch (e) {
    if (e.status === 400) return { error: e.message };
    throw e;
  }
  if (body && body.mapping !== undefined) {
    if (body.mapping === null) {
      update.mapping = null;
    } else if (typeof body.mapping !== "object") {
      return { error: "mapping must be an object or null" };
    } else {
      const err = validateMapping(body.mapping);
      if (err) return { error: err };
      update.mapping = body.mapping;
    }
  }
  // A mapping edit that switches the board's input (files ↔ connector, or one
  // connector for another) orphans any saved ingest config: it was written
  // against the old adapter's descriptor, and run against the new one it
  // ranges from admitting nothing (unknown filter fields fail closed) to
  // scanning the whole ingestion root (a feed config's empty source resolves
  // to INGEST_ROOT itself under the folder adapter) — on the old trigger
  // cadence. Clear config and timer here; the route clears run state off the
  // flag. The dedup ledger stays — deletions remain final. Never fires on
  // create: its synthetic prev holds no ingest config or timer.
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
  return { error: null, inputSwitched };
}

// Clamp a requested auto-tag interval to something sane; null when unparsable.
function parseEveryMin(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(Math.max(n, 15), 60 * 24 * 28); // 15 min .. 4 weeks
}

app.post("/api/admin/boards", requireAdmin, wrap(async (req, res) => {
  const body = req.body || {};
  const name = String(body.name ?? "").trim();
  if (!name) return res.status(400).json({ error: "name required" });
  // Create runs the SAME trunk + admin legs the PATCH mounts run, against a
  // synthetic prev: the defaults a new board is born with. One validation
  // path, on purpose — create used to hand-copy the checks and had already
  // drifted (an unparsable auto_tag_every_min was a 400 on PATCH and a silent
  // 1440 here). Mapping + pins ride the create because the modal's Mapping
  // tab works on new boards too (templates only apply while a board is
  // empty); no reschedule/backfill side-effects — nothing exists yet.
  // body.mapping rides prev unvalidated so a create carrying mapping + ingest
  // together resolves the ingest adapter the mapping selects; the mapping
  // itself is validated in the admin leg before anything writes.
  const prev = {
    ...NEW_BOARD_DEFAULTS,
    mapping: body.mapping && typeof body.mapping === "object" ? body.mapping : null,
  };
  const { update, error } = await buildBoardContentUpdate(body, prev);
  if (error) return res.status(400).json({ error });
  const admin = await buildBoardAdminUpdate(body, prev, update);
  if (admin.error) return res.status(400).json({ error: admin.error });
  // Everything validated (a 400 above leaves nothing behind), so write: the
  // bare insert and the patch that shapes it, ONE transaction — a create can
  // no longer land a board and then lose its pins between two statements.
  const id = await withTx(db, async (tx) => {
    const bid = await createBoard(tx, name);
    await updateBoard(tx, bid, update);
    return bid;
  });
  console.log(`created board "${name}" ${id}`);
  res.json({
    id, name,
    facets: update.facets ?? [],
    context: update.context ?? "",
    ai_reasoning: update.aiReasoning ?? true,
    ai_research: update.aiResearch ?? false,
    ai_votes: update.aiVotes ?? 1,
    mapping: update.mapping ?? null,
  });
}));

// The kinds a scalar field can hold, for the sources that don't narrow it
// further with their own `kinds`. Detect fields carry NO kind — their output is
// located hits, not a scalar (field-sources.js `output`).
const MAPPING_KINDS = ["text", "number", "url", "date"];

// Shared by fields and the face slot: a `refresh: { every }` cadence in
// minutes. Returns an error string or null.
function validateRefresh(refresh, what) {
  if (!refresh || typeof refresh !== "object" || !Number.isInteger(refresh.every) ||
      refresh.every < 1 || refresh.every > 43200)
    return `${what} needs an integer refresh.every in minutes (1–43200)`;
  return null;
}

// Which sources may bind a slot, for the refusal message — derived from the
// defs so the message can't drift from the rule.
const slotSources = (slot) =>
  FIELD_SOURCE_DEFS.filter((d) => (d.slots || []).includes(slot))
    .map((d) => `"${d.id}"`).join(" or ");

// Returns an error string when mapping is invalid, null when valid. Field AND
// slot rules are read off FIELD_SOURCE_DEFS — which sources a slot takes
// (`slots`), on which board type (`filesOnly`/`connectorOnly`), instruction and
// refresh rules — so a new source is validated by its table row, not by another
// branch here. Only a source's own config vocabulary is checked by name below
// (extract's options list; the connector face's producer/period; the file
// face's prefer/pick).
function validateMapping(mapping) {
  // Optional input slot: absent = files. (The literal string "files" died with
  // `from:"raw"` — two spellings of the same absence; migration 0038 normalizes.)
  if (mapping.input !== undefined) {
    if (!mapping.input || typeof mapping.input !== "object" || typeof mapping.input.connector !== "string")
      return `mapping.input must be { connector: name } — omit it for a files board`;
    if (!getConnector(mapping.input.connector))
      return `unknown connector: "${mapping.input.connector}"`;
  }
  const filesBoard = !mapping.input;

  // Identity slot: null/absent = the filename (the slot's default, owned by
  // the renderer — no pseudo-source in the mapping).
  if (mapping.identity !== undefined && mapping.identity !== null) {
    const id = mapping.identity;
    if (typeof id !== "object") return "mapping.identity must be an object or null";
    const def = FIELD_SOURCE[id.source];
    if (!def || !(def.slots || []).includes("identity"))
      return `mapping.identity.source must be ${slotSources("identity")} (or the slot null)`;
    if (def.connectorOnly && filesBoard)
      return `a ${def.id} identity requires a connector input`;
    if (def.takesInstruction) {
      if (!id.instruction || typeof id.instruction !== "string" || !id.instruction.trim())
        return `mapping.identity.instruction is required for a ${def.id} identity`;
      if (id.instruction.length > 500) return `mapping.identity.instruction must be ≤500 chars`;
    }
    // Match-to-a-list mode: a declared options list constrains the AI's answer
    // to a closed set (vs open extraction). Config only — never seeds entities.
    if (id.options !== undefined) {
      if (!def.takesInstruction)
        return `mapping.identity.options needs an instruction-taking source`;
      if (!Array.isArray(id.options)) return `mapping.identity.options must be an array`;
      if (id.options.length > 200) return `mapping.identity may have at most 200 options`;
      const seenKeys = new Set();
      for (const c of id.options) {
        if (!c || typeof c !== "object" || typeof c.value !== "string" || !c.value.trim())
          return `each identity option needs a non-empty "value"`;
        if (c.hint !== undefined && (typeof c.hint !== "string" || c.hint.length > 500))
          return `identity option hint must be a string ≤500 chars`;
        const k = normaliseIdentity(c.value); // same key the runtime dedups on
        if (seenKeys.has(k)) return `duplicate identity option: "${c.value}"`;
        seenKeys.add(k);
      }
    }
  }

  if (!Array.isArray(mapping.fields)) return "mapping.fields must be an array";
  const seen = new Set();
  const perSource = {};
  for (const f of mapping.fields) {
    if (!f.key || typeof f.key !== "string" || !/^[a-z][a-z0-9_]*$/.test(f.key))
      return `invalid field key: ${JSON.stringify(f.key)}`;
    if (seen.has(f.key)) return `duplicate field key: ${f.key}`;
    // "identity" is the identity slot's key in the record_fields schema — a
    // field with the same name would silently overwrite it there.
    if (f.key === "identity") return `field key "identity" is reserved for the identity slot`;
    seen.add(f.key);

    const def = FIELD_SOURCE[f.source];
    if (!def) return `unsupported source "${f.source}" for field "${f.key}"`;
    perSource[def.id] = (perSource[def.id] || 0) + 1;

    // Kind: detect fields carry none (occurrences, not a scalar); everyone
    // else holds one of the scalar kinds, narrowed to the source's own list
    // where it declares one (def.kinds — what a user may pick for extract).
    if (def.output === "occurrences") {
      if (f.kind !== undefined) return `${def.id} field "${f.key}" carries no kind`;
    } else if (!(def.kinds || MAPPING_KINDS).includes(f.kind)) {
      return `invalid kind "${f.kind}" for field "${f.key}"`;
    }

    if (def.needsFn && (!f.fn || typeof f.fn !== "string"))
      return `${def.id} field "${f.key}" requires a fn string`;
    if (def.filesOnly && !filesBoard)
      return `file field "${f.key}" is only valid on a files board`;
    if (def.connectorOnly && filesBoard)
      return `${def.id} field "${f.key}" requires a connector input`;
    // Media-catalog fields: fn must exist and the kind is the catalog's.
    if (def.catalog === "media") {
      const desc = getMediaField(f.fn);
      if (!desc) return `unknown file field fn "${f.fn}" for "${f.key}"`;
      if (f.kind !== desc.kind) return `file field "${f.key}" must have kind "${desc.kind}"`;
    }
    if (f.instruction !== undefined) {
      if (!def.takesInstruction) return `${def.id} field "${f.key}" takes no instruction`;
      if (typeof f.instruction !== "string" || f.instruction.length > 500)
        return `instruction for field "${f.key}" must be a string ≤500 chars`;
    }
    if (f.refresh !== undefined) {
      if (!def.refreshable) return `${def.id} field "${f.key}" cannot refresh`;
      const err = validateRefresh(f.refresh, `field "${f.key}"`);
      if (err) return err;
    }
  }
  for (const def of FIELD_SOURCE_DEFS) {
    if (def.cap && (perSource[def.id] || 0) > def.cap)
      return `mapping may have at most ${def.cap} ${def.id} fields`;
  }

  // Face slot: null/absent = the renderer's default (file preview on a files
  // board, symbol tile on a connector board — see faces/select.js).
  if (mapping.face !== undefined && mapping.face !== null) {
    const fc = mapping.face;
    if (typeof fc !== "object") return "mapping.face must be an object or null";
    const def = FIELD_SOURCE[fc.source];
    if (!def || !(def.slots || []).includes("face"))
      return `mapping.face.source must be ${slotSources("face")} (or the slot null)`;
    if (def.filesOnly && !filesBoard) return "a file face is only valid on a files board";
    if (def.connectorOnly && filesBoard) return "a connector face requires a connector input";
    if (fc.refresh !== undefined) {
      if (!def.refreshable) return `a ${def.id} face has no "refresh"`;
      const err = validateRefresh(fc.refresh, "face");
      if (err) return err;
    }
    // Each source's own config vocabulary:
    if (fc.source === "connector") {
      // connectorOnly above guarantees the input exists and was resolved.
      const conn = getConnector(mapping.input.connector);
      const producer = (conn.manifest.faces || []).find((p) => p.name === fc.producer);
      if (!producer) return `unknown face producer "${fc.producer}"`;
      if (fc.period !== undefined && !producer.periods.includes(fc.period))
        return `invalid period "${fc.period}" for face "${fc.producer}"`;
    } else if (fc.source === "file") {
      // Selects which instance backs the card (server/faces/select.js).
      if (fc.prefer !== undefined && !["any", "image", "document", "audio"].includes(fc.prefer))
        return `invalid face prefer "${fc.prefer}"`;
      if (fc.pick !== undefined && !["first", "latest"].includes(fc.pick))
        return `invalid face pick "${fc.pick}"`;
      for (const k of ["producer", "period"])
        if (fc[k] !== undefined) return `a file face has no "${k}"`;
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
  const wantsFileFields = mappingFields.some((f) => f.source === "file");
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

// The admin-page alias of the board save — the SAME handler as PATCH
// /api/boards/:id (authority comes from req.user, not the path), behind
// requireAdmin so this route's contract stays what it always was: a
// board-admin gets a 403 here, not a quieter version of their own save.
// requireBoardManager after it only 404s a missing board and attaches
// req.board — a global admin always passes its role check.
app.patch("/api/admin/boards/:id", requireAdmin, requireBoardManager, saveBoardPatch);

// Facet scope for a retag: absent = the whole board, exactly as before. A typo
// silently retagging nothing is the worst outcome here, so unknown keys are a
// 400 rather than a filter. `fit` is refused because buildPrompt reserves that
// property for the whole-item verdict — a facet named `fit` never gets asked
// about, scoped or not (prompt.test.js pins this).
function readFacetScope(body, board) {
  if (body?.facets === undefined) return { scope: null };
  if (!Array.isArray(body.facets) || !body.facets.length) return { error: "facets must be a non-empty array" };
  const known = new Set((board.facets || []).map((f) => f.key));
  const keys = [...new Set(body.facets.map(String))];
  const bad = keys.filter((k) => !known.has(k) || k === "fit");
  if (bad.length) return { error: `unknown facet(s): ${bad.join(", ")}` };
  // Scoping to every facet IS an ordinary full pass — normalise so the two
  // paths cannot drift.
  return { scope: keys.length === known.size ? null : keys };
}

app.post("/api/admin/boards/:id/retag", requireAdmin, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  const { scope, error } = readFacetScope(req.body, board);
  if (error) return res.status(400).json({ error });
  const queued = scope ? await retagBoardFacets(db, req.params.id, scope) : await retagBoard(db, req.params.id);
  // The findings for whatever is being re-measured are superseded from this
  // moment, and this is the moment that knows it — one statement, here, rather
  // than a comparison the reader has to make on every modal open. Scoped
  // retag marks only its own facets; a full pass marks them all.
  if (queued) await supersedeFacetDiagnostics(db, req.params.id, scope);
  invalidateBoardCache(req.params.id);
  console.log(`retag queued: ${queued} item(s) in board ${req.params.id}${scope ? ` (facets: ${scope.join(", ")})` : ""}`);
  res.json({ ok: true, queued, ...(scope ? { facets: scope } : {}) });
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

// (The old admin-only POST /api/admin/boards/:id/retag/cancel is gone — its
// path named the retag leg while the operation grew to cancel every queue and
// delete queued adds, and canManageBoard passes every global admin, so the
// admin panel now calls the member-facing /jobs/cancel-queued route above.)

app.delete("/api/admin/boards/:id", requireAdmin, wrap(async (req, res) => {
  const payloads = await deleteBoard(db, req.params.id);
  if (payloads === null) return res.status(404).json({ error: "not found" });
  for (const payload of payloads) sources.cleanup(payload?.files);
  invalidateBoardCache(req.params.id);
  console.log(`deleted board ${req.params.id} + ${payloads.length} items`);
  res.json({ ok: true, deleted: payloads.length });
}));

// --- admin: AI tagger config (key registry) ---
// The "App default" answer the board modal used to fetch from /api/admin/ai-default
// now rides the capabilities feed (each entry's `running`) — one ladder, one label.

app.get("/api/admin/ai-keys", requireAdmin, wrap(async (_req, res) => {
  const keys = await listAiKeys(db);
  res.json(
    keys.map((k) => ({
      id: k.id,
      name: k.name,
      provider: k.provider,
      hint: k.api_key ? "…" + String(k.api_key).slice(-4) : "no key", // raw keys never leave the server; null = keyless connection
      base_url: k.base_url || null, // a URL, not a secret — the connection's identity for self-hosted providers
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
  // The row is the selection handle (boards and the default-tagger slot point
  // at it), so a keyless provider registers one too — just with no secret in
  // it (a token is still accepted, e.g. for a reverse proxy in front of the
  // box). On-device providers have no accounts at all — nothing to register.
  if (PROVIDERS[provider].onDevice)
    return res.status(400).json({ error: `${PROVIDERS[provider].label} runs on-device — it has no connections to register` });
  if (!apiKey && !PROVIDERS[provider].keyless) return res.status(400).json({ error: "key required" });
  // Per-connection server URL — only for providers that declare `needsBase`
  // (self-hosted); blank falls back to the descriptor's default base.
  let baseUrl = null;
  if (PROVIDERS[provider].needsBase && req.body?.base_url) {
    baseUrl = String(req.body.base_url).trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(baseUrl))
      return res.status(400).json({ error: "server URL must start with http:// or https://" });
  }
  // A needsBase provider that ships no default base has nowhere to fall back
  // to — a URL-less connection would fail confusingly at call time instead.
  if (PROVIDERS[provider].needsBase && !baseUrl && !PROVIDERS[provider].base)
    return res.status(400).json({ error: "server URL required — this provider has no default" });
  const id = await createAiKey(db, name, provider, apiKey || null, baseUrl);
  console.log(`ai-key added: "${name}" (${provider})`);
  res.json({ id, name, provider });
}));

// Edit a connection in place: rename, repoint (server URL), rotate the secret.
// Boards and the default slots keep working through the edit — the row id (the
// selection handle) never changes, and resolution reads the row fresh per call.
app.patch("/api/admin/ai-keys/:id", requireAdmin, wrap(async (req, res) => {
  const key = await getAiKey(db, Number(req.params.id));
  if (!key) return res.status(404).json({ error: "not found" });
  const patch = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim().slice(0, 64);
    if (!name) return res.status(400).json({ error: "name required" });
    patch.name = name;
  }
  // Rotation only — non-empty replaces, blank keeps. A keyed provider can
  // never be edited into keylessness (remove the row for that).
  if (req.body?.key) patch.apiKey = String(req.body.key).trim();
  if (req.body?.base_url !== undefined && PROVIDERS[key.provider]?.needsBase) {
    const baseUrl = String(req.body.base_url || "").trim().replace(/\/+$/, "");
    if (baseUrl && !/^https?:\/\//i.test(baseUrl))
      return res.status(400).json({ error: "server URL must start with http:// or https://" });
    if (!baseUrl && !PROVIDERS[key.provider].base)
      return res.status(400).json({ error: "server URL required — this provider has no default" });
    patch.baseUrl = baseUrl || null; // blank = back to the descriptor default
  }
  await updateAiKey(db, Number(req.params.id), patch);
  invalidateModelListCache(req.params.id); // rotated key / repointed server = a different catalog
  console.log(`ai-key #${req.params.id} updated by admin`);
  res.json({ ok: true });
}));

app.delete("/api/admin/ai-keys/:id", requireAdmin, wrap(async (req, res) => {
  if (!(await deleteAiKey(db, Number(req.params.id)))) return res.status(404).json({ error: "not found" });
  invalidateModelListCache(req.params.id);
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
      testKey({ provider: key.provider, apiKey: key.api_key, base: key.base_url || undefined, model }));
    res.json({ ok: true, provider: key.provider });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}));

// Live model catalog for one connection — asks the provider itself
// (wire.listModels) with the row's own key/server, so retired models drop out
// and new ones appear with no app update. ?kind=embed|transcribe carves the
// capability catalogs (descriptor filters — one upstream fetch serves all
// kinds). Cached per connection (the cache + its invalidation live in
// providers.js beside the lister); ?refresh=1 busts — the client sends it
// once per picker for "I just `ollama pull`ed". A bad key or an unreachable
// box serves the descriptor's curated fallback rather than a 4xx (failure
// semantics live in the engine; Test diagnoses).
app.get("/api/admin/ai-keys/:id/models", requireAdmin, wrap(async (req, res) => {
  // An unrecognized kind falls to tagging — which also covers the pre-capability
  // name for it ("tagging"), so a cached client page needs no alias.
  const kind = MODEL_CAPABILITIES.includes(req.query.kind) ? req.query.kind : "tag";
  const refresh = req.query.refresh === "1"; // strict: ?refresh=0 must not bust
  // "env" is the ANTHROPIC_API_KEY-backed default-tagger option — no ai_keys
  // row, but the server holds the key, so it lists like any connection.
  // Reserved cache id 0 (row ids start at 1); the env key changes only with a
  // restart, so the TTL is the only staleness possible and no mutation path
  // needs to invalidate it.
  if (req.params.id === "env") {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(404).json({ error: "not found" });
    return res.json(await cachedProviderModels(0, {
      provider: "anthropic", apiKey: process.env.ANTHROPIC_API_KEY, kind,
    }, { refresh }));
  }
  const key = await getAiKey(db, Number(req.params.id));
  if (!key) return res.status(404).json({ error: "not found" });
  res.json(await cachedProviderModels(req.params.id, {
    provider: key.provider, apiKey: key.api_key, base: key.base_url || undefined, kind,
  }, { refresh }));
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
  // …plus what the sidecar-backed engines actually serve. This feed is what
  // the board modal's per-board picker reads, so without the overlay a
  // sidecar's models are invisible exactly where they'd be chosen.
  // The entry's `provides` is the descriptor's own object by reference, so the
  // overlay writes a fresh one onto this row rather than into the registry.
  applySidecarCatalogs(await sidecarCatalogs(), (p) => catalog.find((e) => e.name === p));
  res.json(catalog);
}));

// --- plugins (admin: the unified integrations catalog) ---
// One payload for the Plugins page: every plugin (def + state, secrets
// masked) plus the slot assignments — read from the same settings the
// legacy per-layer routes use, just composed.
app.get("/api/admin/plugins", requireAdmin, wrap(async (_req, res) => {
  const plugins = await pluginCatalog(db);
  // A sidecar-backed engine's card shows the model the sidecar ITSELF reports
  // (its /health): the model is baked into the image at build, so the app never
  // names it and the card can't drift when the image is rebuilt against a
  // different one. An unreachable sidecar leaves the list empty and the card
  // notes the fallback. Written into `provides` only — the one capability shape
  // on the wire since 7b, so there is no second copy to read stale.
  // The catalogs and the overlay itself live in ./sidecar-catalog.js — the SAME
  // answer, applied the SAME way as the board picker's feed above, so a card
  // and a picker can never disagree about what an engine serves. All this
  // route contributes is where to find the holder: detached from the memoized
  // plugin def first, because `ai` is shared with it.
  applySidecarCatalogs(await sidecarCatalogs(), (provider) => {
    const entry = plugins.find((p) => p.id === `ai:${provider}`);
    return entry ? (entry.ai = { ...entry.ai }) : null;
  });
  // The legacy `slots` block died in 7c: every status read it carried — slot
  // defaults, domain stars, embed stats, the detect threshold — lives on
  // GET /api/admin/capabilities, so this payload stopped running three
  // resolvers, four binding walks, and a stats query per render to restate
  // what the feed already says.
  res.json({ plugins });
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
    if (def.core && !installed) return res.status(400).json({ error: `${def.label} is built in and can't be removed` });
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

// Install a plugin from a URL (github:owner/repo, npm:name, an https tarball, or
// a local path): fetch → npm install → validate → register → persist, live (no
// restart). Admin-only, and it runs code from the internet AS THE SERVER — no
// sandbox, by the ratified self-hosted trust model; the page names that risk
// before calling this. Long-running (npm install); returns the new card.
app.post("/api/admin/plugins/install", requireAdmin, wrap(async (req, res) => {
  const url = req.body?.url ? String(req.body.url).trim() : "";
  if (!url) return res.status(400).json({ error: "a plugin URL is required" });
  try {
    const id = await installFromUrl(db, url);
    const plugin = (await pluginCatalog(db)).find((p) => p.id === id) || null;
    res.json({ ok: true, plugin });
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
  }
}));

// Uninstall an EXTERNAL plugin: unregister + remove its code + drop its rows. A
// built-in id has no install record → 400 (built-ins use PATCH { installed:false }
// — availability, not removal).
app.delete("/api/admin/plugins/:id", requireAdmin, wrap(async (req, res) => {
  try {
    await uninstall(db, req.params.id);
    res.json({ ok: true });
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

// The capabilities status feed (capabilities-plan.md slice 3): every capability
// — AI, connector domain, always-on — with its state, what serves it, why it
// fell if it fell, who else could serve it, and what the outage costs. The
// capabilities page renders this verbatim; nothing here is authored per
// capability.
app.get("/api/admin/capabilities", requireAdmin, wrap(async (_req, res) => {
  res.json({ capabilities: await capabilityStatus(db) });
}));

// The capability-native peers. Same rules, addressed by capability id rather
// than by a per-capability body field — so a new capability is reachable here
// the moment it exists in CAPABILITY_DEFS.
app.post("/api/admin/capabilities/:id/bind", requireAdmin, wrap(async (req, res) => {
  try {
    const { provider, keyId, model, enabled, config } = req.body || {};
    // Config validated BEFORE the binding writes: the stores-nothing covenant
    // (capability-bind.js) must hold for a combined body — a valid binding
    // beside a bogus config stores neither half.
    if (config) assertValidCapabilityConfig(req.params.id, config);
    await bindCapability(db, req.params.id, { provider, keyId, model, enabled });
    if (config) await setCapabilityConfig(db, req.params.id, config);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.message });
  }
  res.json({ ok: true });
}));

app.post("/api/admin/capabilities/:id/probe", requireAdmin, wrap(async (req, res) => {
  try {
    res.json(await probeCapability(db, req.params.id));
  } catch (err) {
    res.status(err.status || 400).json({ error: err.message });
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
  const { vectors: [qv], usage } = await embedTexts({ ...embedder, texts: [q] });
  // The query embed is a paid call like any other, metered to the board being
  // searched — the search is that board's work (metering-plan.md Stage 5a).
  await meterAiCall(db, boardId, { capability: "embed", provider: embedder.provider, model: embedder.model }, usage);
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
    // Per-facet vote agreement, {} on a single-pass board. Empty means NOT
    // MEASURED — the client must render nothing rather than "0 agreed".
    confidence: row?.tag_confidence || {},
    fields: row?.payload?.fields || {},
  });
}));

// The audio transcript for the lightbox — produced out-of-band by the
// transcription loop. null while still transcribing (or not audio); "" for a
// clip with no discernible speech. `turns` is the structured half
// (structured-transcripts-plan.md): per-segment { start, end, text } for
// paragraphing + click-to-seek — null for items transcribed before it shipped
// or by an engine that gave none, and the client falls back to the flat text.
app.get("/api/instances/:id/transcript", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const row = await getItemReasoning(db, req.itemId);
  res.json({ transcript: row?.payload?.transcript ?? null, turns: row?.payload?.transcript_turns ?? null });
}));

// Tags are per instance — a human call about one piece of material.
app.patch("/api/instances/:id/tags", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const tags = req.body && Array.isArray(req.body.tags) ? req.body.tags : null;
  if (!tags) return res.status(400).json({ error: "tags array required" });
  const board = await getBoard(db, req.itemBoardId);
  const allowed = new Set();
  if (board) for (const f of board.facets) for (const v of f.values) allowed.add(`${f.key}/${v}`);
  const clean = tags.filter((t) => typeof t === "string" && allowed.has(t));
  const affected = await setItemTags(db, req.itemId, clean);
  // A human tagging an entity into a watched set is an arrival too.
  await evaluateItemAlerts(db, req.itemId); // never throws
  // A tag edit flips the instance to 'tagged' — report the affected cards on
  // the re-queue contract so the client's aggregates come from the server's
  // rule, not a hand-rolled one (Stage 4 ride-along). Unlike the re-queue
  // routes this does NOT 404 on a null: the save itself succeeded, and a row
  // that vanished under it just has no card left to report (routedEntities
  // answers [] for the empty seed).
  res.json({ ok: true, tags: clean, entities: await routedEntities(db, affected) });
}));

// Delete the whole entity: instances cascade, all their files are cleaned.
app.delete("/api/items/:id", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  const result = await deleteEntity(db, req.entityId);
  if (!result) return res.status(404).json({ error: "not found" });
  sources.cleanup(result.files);
  console.log(`deleted entity #${req.entityId}`);
  res.json({ ok: true });
}));

// Card-level reprocess: re-run the whole pipeline for every instance. Each
// instance restarts at the leg its payload calls for (fetch/face/extract/tag
// — reprocessEntity routes); the response is the routedEntities report —
// where every instance actually landed and each affected card's fresh
// aggregate (classify mode: re-routing this entity's instances can move
// OTHER cards that share them) — so the client mirrors the truth instead of
// guessing "pending".
app.post("/api/items/:id/reprocess", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  // Stage 3b: a kept transcript is only stale if the engine that would
  // transcribe TODAY is known and differs from its stamp. Resolution failure
  // or an incomplete identity (whisper learns its model per call) means
  // unknown — transcripts stay, nothing re-bills by accident. Asked only when
  // some instance actually carries a stamp: the staleness arm reads no other
  // row, and resolving walks the capability ladder, so every image, document
  // and connector card would pay for an answer it can't use.
  let engine = null;
  try {
    if (await entityHasTranscriptStamp(db, req.entityId)) {
      const t = await resolveTranscriber(db, await getBoard(db, req.entityBoardId));
      if (t?.id && t?.model) engine = engineStamp(t);
    }
  } catch {}
  const affected = await reprocessEntity(db, req.entityId, engine);
  if (!affected) return res.status(404).json({ error: "not found" });
  console.log(`reprocess queued entity #${req.entityId}`);
  res.json({ ok: true, entities: await routedEntities(db, affected) });
}));

// Card-level retag (Stage 3c): re-tag every instance from its existing
// material and fields — the tag-only slice of reprocess, for the split
// button's caret. Takes the same optional `facets` scope as the instance
// route; scoped passes only touch settled, decided instances (409 when none
// qualify).
app.post("/api/items/:id/retag", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  // The board is read only to validate a scope — readFacetScope ignores it
  // when the body carries no `facets`, which is every plain "Retag" click.
  const board = req.body?.facets === undefined ? null : await getBoard(db, req.entityBoardId);
  const { scope, error } = readFacetScope(req.body, board || { facets: [] });
  if (error) return res.status(400).json({ error });
  let affected;
  if (scope) {
    affected = await retagEntityFacets(db, req.entityId, scope);
    if (!affected) return res.status(409).json({ error: "no tagged, decided instance to re-tag on some facets" });
  } else {
    affected = await retagEntity(db, req.entityId);
    if (!affected) return res.status(404).json({ error: "not found" });
  }
  console.log(`retag queued entity #${req.entityId}${scope ? ` (facets: ${scope.join(", ")})` : ""}`);
  res.json({ ok: true, entities: await routedEntities(db, affected), ...(scope ? { facets: scope } : {}) });
}));

// Card-level re-extract (Stage 3c): every instance re-enters the extract leg.
// 409 when no instance has a stamped mapping and the board has no AI mapping
// to apply — nothing to extract anywhere on the card.
app.post("/api/items/:id/reextract", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  const affected = await reextractEntity(db, req.entityId);
  if (!affected) return res.status(409).json({ error: "nothing to extract on this item" });
  console.log(`reextract queued entity #${req.entityId}`);
  res.json({ ok: true, entities: await routedEntities(db, affected) });
}));

// Card-level re-transcribe (Stage 4): every audio instance forgets its
// transcript and re-enters the tag leg; the absence-keyed lane refills the
// text. 409 when the card has no audio. Re-bills transcription — the point.
app.post("/api/items/:id/retranscribe", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  const affected = await retranscribeEntity(db, req.entityId);
  if (!affected) return res.status(409).json({ error: "only audio can be re-transcribed" });
  console.log(`retranscribe queued entity #${req.entityId}`);
  res.json({ ok: true, entities: await routedEntities(db, affected) });
}));

// Refresh a connector card's data on demand (Stage 4): fetch → face → tag
// with the tags kept until the fresh pass lands — reprocess without the
// clear. 409 on anything that isn't a connector vehicle.
app.post("/api/items/:id/refresh", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  const affected = await refreshEntityData(db, req.entityId);
  if (!affected) return res.status(409).json({ error: "not a connector item" });
  console.log(`refresh queued entity #${req.entityId}`);
  res.json({ ok: true, entities: await routedEntities(db, affected) });
}));

// Re-run extraction for one instance that has a stamped mapping (409 without
// one). Identity re-derivation may re-parent the instance — merge or split.
app.post("/api/instances/:id/reextract", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const affected = await reextractItem(db, req.itemId);
  if (!affected) return res.status(409).json({ error: "item has no stamped mapping" });
  console.log(`reextract queued instance #${req.itemId}`);
  res.json({ ok: true, entities: await routedEntities(db, affected) });
}));

// Force a fresh transcription (Stage 3b) — the one artifact reprocess
// deliberately keeps. One verb: drop the transcript (turns, engine stamp and
// any parked error with it) and re-enter the tag leg; the absence-keyed
// transcription lane refills the text on its own, and the tag leg's
// awaiting-transcription wait does the sequencing. Audio-only (the verb's
// WHERE → 409). This re-bills transcription — which is exactly what the
// caller asked for.
app.post("/api/instances/:id/retranscribe", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const affected = await retranscribeItem(db, req.itemId);
  if (!affected) return res.status(409).json({ error: "only audio can be re-transcribed" });
  console.log(`retranscribe queued instance #${req.itemId}`);
  res.json({ ok: true, entities: await routedEntities(db, affected) });
}));

// Re-tag one instance from its existing material and fields — the per-instance,
// tag-only counterpart to the card-level reprocess. Leaves identity/fields as-is.
app.post("/api/instances/:id/retag", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const board = await getBoard(db, req.itemBoardId);
  if (!board) return res.status(404).json({ error: "not found" });
  const { scope, error } = readFacetScope(req.body, board);
  if (error) return res.status(400).json({ error });
  // A scoped retag needs something to preserve AND a verdict it can leave alone,
  // so it only takes settled, decided rows — a 409 rather than a 404 says "this
  // item, wrong state", not "no such item".
  let affected;
  if (scope) {
    affected = await retagItemFacets(db, req.itemId, scope);
    if (!affected) return res.status(409).json({ error: "only a tagged, decided item can be re-tagged on some facets" });
  } else {
    affected = await retagItem(db, req.itemId);
    if (!affected) return res.status(404).json({ error: "not found" });
  }
  console.log(`retag queued instance #${req.itemId}${scope ? ` (facets: ${scope.join(", ")})` : ""}`);
  res.json({ ok: true, entities: await routedEntities(db, affected), ...(scope ? { facets: scope } : {}) });
}));

// Remove one instance from its entity (file included). The last instance
// can't be removed this way — delete the entity instead. No re-queue needed:
// the remaining instances own their fields and tags already.
app.delete("/api/instances/:id", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const { rows: [item] } = await db.query("SELECT entity_ids FROM items WHERE id=$1", [req.itemId]);
  if (!item) return res.status(404).json({ error: "not found" });
  // Removing this instance must not ghost any entity it's the sole member of —
  // that last-instance case goes through entity delete instead.
  for (const eid of item.entity_ids || [])
    if ((await entityInstanceCount(db, eid)) <= 1)
      return res.status(409).json({ error: "cannot remove the only instance — delete the item instead" });

  const removed = await deleteInstance(db, req.itemId);
  if (!removed) return res.status(404).json({ error: "not found" });
  // Race heal: two concurrent deletes of the last two instances both pass the
  // count guard above — if that emptied an entity, drop it rather than leave a
  // ghost card (the atomic emptiness check makes this a no-op otherwise).
  for (const eid of removed.entity_ids || []) await deleteEntityIfEmpty(db, eid);
  sources.cleanup(removed.payload?.files);
  console.log(`instance #${req.itemId} removed from ent[${(removed.entity_ids || []).join(",")}]`);
  res.json({ ok: true });
}));

// --- connector routes ---

app.get("/api/connectors", requireAuth, wrap(async (req, res) => {
  // Enrich each connector with its active provider and per-face availability so
  // the mapping modal can warn when a configured face can't be rendered by the
  // current backend (e.g. a chart face while CoinMarketCap — no history — is active).
  const out = [];
  for (const c of listConnectors()) {
    const conn = getConnector(c.name);
    // standing(), not activeProvider(): the raw resolver THROWS when no provider
    // of that domain is installed — a normal state (a domain nobody added yet),
    // and one that must not take the whole catalog down with it, since this is
    // the fetch behind the template picker, the field catalog AND the face row,
    // for every connector. Unresolved → activeProvider null and the manifest's
    // faces UNannotated, so the modal shows no per-provider availability claim
    // it can't stand behind.
    const standing = await conn.standing(db);
    const activeProvider = standing.effective?.name || null;
    // Whether the domain can serve AT ALL, off the same ladder the capabilities
    // card reads (connectors/runtime domainState). The template picker lists
    // every connector — a board's mapping is a shape, not a live connection —
    // but a template it can't feed has to say so at the point of choosing,
    // rather than an hour later when the first add fails. Shipped rather than
    // derived client-side: which rungs can still serve (degraded can; blocked
    // can't) is the ladder's business, not a rule for callers to re-know.
    //
    // The REASON is admin-only, and the split is not fussiness. `available` is
    // a fact about the board — its data isn't flowing — and every member who
    // can see the board can see that much already. The reason is a fact about
    // the deployment: which provider is installed, whether it holds a key,
    // which one took over for a dead star. That lived behind /api/admin/* and
    // stays there; this route is requireAuth. The client is written to the
    // absence, not to a role flag, so the two can't drift.
    const { reason, available } = domainState(standing, c);
    out.push({
      ...c,
      activeProvider,
      available,
      ...(reason && req.user.is_admin ? { reason } : {}),
      faces: activeProvider && conn.renderableFaces ? conn.renderableFaces(activeProvider) : c.faces,
    });
  }
  res.json(out);
}));

// The file-metadata field catalog (server/media) for the mapping modal's "File
// fields" section — static descriptors, no db, like a connector manifest.
app.get("/api/file-fields", requireAuth, wrap(async (_req, res) => {
  res.json(mediaCatalog());
}));

// The accepted media types + their effective per-type upload limits (manifest
// defaults ⊕ admin overrides). The client's upload accept filter + size
// pre-filter read this, so the accepted set and its limits live in ONE place
// (the media manifests) instead of being duplicated in the client. Public
// capability metadata — the same info the file-input `accept` attr already
// exposes — so no auth gate.
app.get("/api/media-types", wrap(async (_req, res) => {
  res.json(await mediaLimits(db));
}));

// (No standalone /api/connectors/:name/search route: the browse modal's
// /connector-list is the one add surface, and its provider-side query path
// already folds real catalog search in. Provider `search` stays a contract
// method — the FMP list() bridge and the plugin-health tracking use it.)

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

// Bulk add from the browse modal — ENQUEUE, not fetch (add-feedback-plan
// Stage 2): each id becomes an entity + vehicle at 'pending_fetch' from the
// browse row's own data, in milliseconds, and the worker's fetch leg pulls
// the provider data afterwards. Duplicates still land in `skipped` (the
// identity derivation is the same one the fetch would produce, so the unique
// index fires here). Ids may be bare strings (legacy — identity falls back to
// the id and the fetch leg reconciles) or {id, symbol, name} rows (the
// modal's form). Each result echoes `connector_id` so the modal flips its
// exact rows instead of matching by symbol.
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

  // Resolved once for the whole batch — it stamps payload.source.provider so
  // charts and refresh prefetch have a name before the first fetch lands. A
  // domain with no provider still enqueues (null; the leg re-resolves).
  const providerName = await connector.activeProvider(db).then((p) => p.name).catch(() => null);

  const cap = (v, n) => (typeof v === "string" ? v.slice(0, n) : null);
  const added = [], skipped = [];
  for (const entry of ids) {
    const e = entry && typeof entry === "object" ? entry : { id: entry }; // bare string = legacy form
    const row = { id: e.id, symbol: cap(e.symbol, 40), name: cap(e.name, 200) };
    if (row.id == null || row.id === "") { skipped.push({ id: row.id, reason: "id required" }); continue; }
    try {
      const r = await enqueueConnectorEntity(db, board, connectorName, row, providerName);
      added.push({ ...r, connector_id: row.id });
    } catch (err) {
      if (err.duplicate) { skipped.push({ id: row.id, reason: "duplicate" }); continue; }
      console.error(`bulk enqueue error (${connectorName}/${row.id}):`, err.message);
      skipped.push({ id: row.id, reason: err.message });
    }
  }
  res.json({ added, skipped });
}));

// The lightbox detail view's live chart: one entity's price series from the
// active provider, shaped per the domain's chart vocabulary (manifest.chart).
// Range/kind are CLAMPED, never rejected — the client's stored pref may be
// another domain's — and the response's ranges/kinds are the deployment's
// PROVEN offer (the runtime's learned-availability model), which is exactly
// what the client renders as controls: a learned refusal reshapes the UI on
// the next fetch instead of stranding a button that errors forever.
//
// 404 = nothing can serve (not a connector board, provider without chart(),
// empty offer, unresolvable id) → the client keeps the static face. 502 =
// transient provider failure, message verbatim (the connector-list pattern).
// Empty-but-served series pass through as 200: absence of data is data, and
// teaches the learned model nothing. No route-level rate limiter: provider
// pacing + the providers' short-TTL caches are the guard, per connector-list.
app.get("/api/items/:id/chart", requireAuth, requireEntityAccess, wrap(async (req, res) => {
  // Independent reads, and this path runs on every lightbox open and every
  // range flip — one round-trip of latency, not three.
  const [board, entity, payload] = await Promise.all([
    getBoard(db, req.entityBoardId),
    getEntity(db, req.entityId),
    entityVehiclePayload(db, req.entityId),
  ]);
  const connectorName = board?.mapping?.input?.connector;
  const connector = connectorName ? getConnector(connectorName) : null;
  if (!connector) return res.status(404).json({ error: "not a connector item" });
  if (!entity) return res.status(404).json({ error: "not found" });

  let series;
  try {
    series = await connector.chartSeries(db, entity, payload?.source || null, {
      range: String(req.query.range || ""),
      kind: String(req.query.kind || ""),
    }, req.entityBoardId);
  } catch (err) {
    console.error(`chart series error (${connectorName}/#${req.entityId}):`, err.message);
    return res.status(502).json({ error: err.message });
  }
  if (!series) return res.status(404).json({ error: "no live chart for this item" });
  res.json({
    symbol: entity.symbol || null,
    name: entity.display_name || entity.symbol || entity.identity,
    ...series,
  });
}));

// The narrowing filters this board's browse modal can offer right now, with
// their vocabularies resolved — static ones from the manifest, provider-
// supplied ones (CoinGecko's ~857 categories, FMP's industries) from the
// active backend, both normalized to {value,label}.
//
// Its own route rather than a field on /api/connectors: that route is the
// template picker's and the mapping modal's, called on every open, and it
// must stay free of metered provider I/O. This one is the browse modal's, the
// single surface that needs the vocabulary, and a provider that can't supply
// one degrades to the static filters (or none) instead of an error.
app.get("/api/boards/:id/connector-filters", requireAuth, wrap(async (req, res) => {
  const board = await getBoard(db, req.params.id);
  if (!board || !(await canAccessBoard(db, board.id, req.user)))
    return res.status(404).json({ error: "not found" });
  const connectorName = board.mapping?.input?.connector;
  const connector = connectorName ? getConnector(connectorName) : null;
  if (!connector) return res.status(400).json({ error: "this board has no connector input" });
  res.json({ filters: await connector.browseFilters(db, board.id) });
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
  // Narrowing filters, whitelisted against the SAME resolved vocabulary the
  // filters route renders (connectors/runtime browseFilters): only declared
  // keys pass, and only real values — a free-text value would just silently
  // match nothing. Provider-supplied vocabularies (CoinGecko categories, FMP
  // industries) resolve from that one place, so the control and the guard
  // can't drift.
  //
  // Resolved only when the request actually carries a filter. Most browse
  // pages carry none, and resolving costs a provider lookup plus — on a cold
  // vocabulary — a metered fetch INSIDE this request, which is exactly the
  // I/O the sibling filters route exists to keep off the paging path.
  if ((browse.filters || []).some((f) => req.query[f.key] != null)) {
    for (const f of await connector.browseFilters(db, board.id)) {
      const v = req.query[f.key];
      if (v != null && f.options.some((o) => o.value === String(v))) opts[f.key] = String(v);
    }
  }
  let rows;
  try {
    rows = await connector.list(db, opts, board.id);
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
const backups = mountBackups(app, {
  db,
  backupsDir: BACKUPS_DIR,
  dirs: { galleryDir: GALLERY_DIR, thumbsDir: THUMBS_DIR, pluginsDir: pluginsDir() },
  runtime,
  adminEmail: ADMIN_EMAIL,
});
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
  const launchWorker = () => startWorker({
    db, thumbsDir: THUMBS_DIR, galleryDir: GALLERY_DIR, sources,
    autoBackup: backups.autoBackupSweep, // daily DB dump into BACKUPS_DIR (see backup.js)
    sampleStorage: () => sampleStorageDue(db, STORAGE_DIRS), // daily storage-level sample (storage-plan.md)
  });
  let stopWorker = launchWorker();
  runtime.stopWorker = () => stopWorker();
  // A restore quiesces the worker before touching the schema. Success exits the
  // process (exitAfter) and the supervisor reboots everything; a REFUSED or
  // failed restore leaves this process serving, so the worker must come back.
  runtime.restartWorker = () => { stopWorker = launchWorker(); };
  runtime.exitAfter = true;

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
