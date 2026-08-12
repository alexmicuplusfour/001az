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
  getUserById,
  getUserByEmail,
  setPassword,
  anyPasswordSet,
  setUserName,
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
  boardAiUsage,
  retagBoard,
  retagBoardFacets,
  supersedeFacetDiagnostics,
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
  boardEntityIdentities,
  getBoardTokenTotal,
  listJobLog,
  listRunningJobs,
  latestJobFailureAt,
  clearJobLog,
  listRefreshHistory,
  boardHasRefreshHistory,
  boardNextRefreshAt,
  setIngestNextRun,
  setIngestState,
  demoteFacetDiagnostics,
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
import { startWorker, invalidateBoardCache, invalidateAllBoardCaches, resolveEmbedder, transcriberSidecarModel, detectorSidecarModel, nextAutoTagRun, normaliseIdentity } from "./worker.js";
import { evaluateItemAlerts, sendAlertWebhook, nextDailyAt, seedAlertBaseline, sameCondition } from "./alerts.js";
import { facetRollup, editedFacets, GATES } from "./facet-diagnosis.js";
import { testKey, embedTexts, providerCatalog, cachedProviderModels, invalidateModelListCache, PROVIDERS } from "./providers.js";
import { MODEL_CAPABILITIES } from "./capabilities.js";
import { bindCapability, setCapabilityConfig, assertValidCapabilityConfig, boardBindingPatch, boardConfigPatch } from "./capability-bind.js";
import { capabilityStatus } from "./capability-status.js";
import { boardConfigCatalog } from "./capability-resolve.js";
import { probeCapability } from "./capability-probe.js";
import { loadAll as loadPlugins, installFromUrl, uninstall, pluginsDir } from "./plugin-loader.js";
import { rateLimit } from "./ratelimit.js";
import { hashPassword, verifyPassword, dummyVerify, MIN_PASSWORD_LEN } from "./password.js";
import { createSources } from "./sources/index.js";
import { getConnector, listConnectors } from "./connectors/index.js";
import { addConnectorEntity } from "./connectors/add.js";
import { liveFields, faceSchedule, domainState } from "./connectors/runtime.js";
import { mediaCatalog, getMediaField, extractFileFields } from "./media/index.js";
import { pluginCatalog, getPluginDef, pluginState, pluginInstalled, mediaLimits } from "./plugins.js";
import { mountIngest } from "./ingest.js";
import { mountBackups, restoreGate } from "./backup-routes.js";
import { resolveIngestAdapter, validateIngest, ENUM_CAP } from "./ingestion/index.js";
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

// Profile settings (currently just the display name). Empty clears it.
app.patch("/api/account", requireAuth, wrap(async (req, res) => {
  if (typeof req.body?.name !== "string") return res.status(400).json({ error: "name required" });
  const name = req.body.name.trim().slice(0, 80) || null;
  await setUserName(db, req.user.id, name);
  res.json({ ok: true, name });
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

// --- boards ---
app.get("/api/boards", requireAuth, wrap(async (req, res) => {
  const all = await listBoards(db);
  const accessible = [];
  for (const b of all) if (await canAccessBoard(db, b.id, req.user)) accessible.push(b);
  res.json(accessible.map((b) => ({ id: b.id, name: b.name })));
}));

// The boards page (planning/boards-page-plan.md): every accessible board with
// its card facts — gallery-card count (entities, not item rows), capability
// flags, and a preview stack of newest thumbnails — one fetch for the whole
// page. Registered before /:id so the literal path isn't captured as an id.
// Ingest fields mirror the /:id guard: next-run only rides an enabled config.
app.get("/api/boards/overview", requireAuth, wrap(async (req, res) => {
  const all = await listBoards(db);
  // Both checks go through the shared helpers rather than one batched
  // board_members read: a second authorization path is exactly the thing that
  // drifts. They're only fanned out so the per-board lookups overlap instead of
  // serializing (a global admin short-circuits without querying at all).
  const access = await Promise.all(all.map((b) => canAccessBoard(db, b.id, req.user)));
  const boards = all.filter((_, i) => access[i]);
  const [counts, previews, manage] = await Promise.all([
    boardEntityCounts(db),
    boardPreviewFaces(db, boards.map((b) => b.id), 8),
    Promise.all(boards.map((b) => canManageBoard(db, b.id, req.user))),
  ]);
  res.json(boards.map((b, i) => {
    const ingestOn = !!(b.ingest && b.ingest.enabled !== false);
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
      has_ingest: ingestOn,
      ingest_next_run_at: ingestOn ? b.ingest_next_run_at ?? null : null,
      manage: manage[i],
      preview: previews[b.id] || [],
    };
  }));
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
    // Vote mode's pass count. The gallery needs it to gate anything that reads
    // per-facet confidence — a single-pass board has none at all (tag_confidence
    // {} means NOT MEASURED), so a control that surfaces it would be permanently
    // empty there. /settings has carried it since 0029; this payload is what the
    // gallery actually loads.
    ai_votes: board.ai_votes || 1,
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
    // Upcoming automatic work — the modal's "scheduled" strip. Null = that
    // family isn't scheduled on this board.
    scheduled: {
      ingest_next_run_at: board.ingest && board.ingest.enabled !== false ? board.ingest_next_run_at ?? null : null,
      retag_next_run_at: board.auto_tag !== false && board.auto_tag_periodic ? board.auto_tag_next_run_at ?? null : null,
      refresh_next_at: nextRefreshAt,
    },
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
  // A saved ingest config supersedes any half-drained run of the old one — a
  // stale drain_left would hand the next run the dead config's budget as its
  // limit. An input SWITCH goes further: run state written against the old
  // adapter means nothing to the new one.
  if (inputSwitched) await setIngestState(db, prev.id, null);
  else if (update.ingest !== undefined) await clearIngestDrain(db, prev.id);
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
    if (m === null || !m.input || m.input === "files") await backfillFileFields(prev.id, m);
  }
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
  res.json({ ok: true });
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
  // The preview window IS the run window (ENUM_CAP, shared with the sweep's
  // enumerate) — one bound, so the count can never promise what a run won't see.
  let enumerated;
  try {
    enumerated = await adapter.enumerate(db, req.board, cfg, { limit: ENUM_CAP() });
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

const MAPPING_KINDS = new Set(["text", "number", "url", "date", "object"]);
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
    // Classify mode: a declared candidate list constrains the AI's answer to a
    // closed set (vs open extraction). Config only — never seeds entities.
    if (id.candidates !== undefined) {
      if (id.from !== "ai") return `mapping.identity.candidates requires from "ai"`;
      if (!Array.isArray(id.candidates)) return `mapping.identity.candidates must be an array`;
      if (id.candidates.length > 200) return `mapping.identity may have at most 200 candidates`;
      const seenKeys = new Set();
      for (const c of id.candidates) {
        if (!c || typeof c !== "object" || typeof c.value !== "string" || !c.value.trim())
          return `each identity candidate needs a non-empty "value"`;
        if (c.hint !== undefined && (typeof c.hint !== "string" || c.hint.length > 500))
          return `identity candidate hint must be a string ≤500 chars`;
        const k = normaliseIdentity(c.value); // same key the runtime dedups on
        if (seenKeys.has(k)) return `duplicate identity candidate: "${c.value}"`;
        seenKeys.add(k);
      }
    }
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
    if (fc.from !== "raw" && fc.from !== "connector" && fc.from !== "file")
      return `mapping.face.from must be "raw", "connector", or "file"`;
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
    // A file face selects which instance backs the card (server/faces/select.js).
    // Files boards only; a static file has nothing to refresh, so it carries no
    // producer/period/cadence.
    if (fc.from === "file") {
      if (mapping.input && mapping.input !== "files") return "a file face is only valid on a files board";
      if (fc.prefer !== undefined && !["any", "image", "document", "audio"].includes(fc.prefer))
        return `invalid face prefer "${fc.prefer}"`;
      if (fc.pick !== undefined && !["first", "latest"].includes(fc.pick))
        return `invalid face pick "${fc.pick}"`;
      for (const k of ["producer", "period", "live", "every"])
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
  // `askModel` is the probe, not its answer: no card, no /health call.
  const sidecarCatalog = async (id, cap, askModel, note) => {
    const entry = plugins.find((p) => p.id === id);
    if (!entry) return;
    const live = await askModel();
    const catalog = { default: live, models: live ? [{ id: live, note }] : [] };
    // don't mutate: `ai` is shared with the memoized plugin defs
    entry.ai = { ...entry.ai, provides: { ...entry.ai.provides, [cap]: catalog } };
  };
  await sidecarCatalog("ai:whisper", "transcribe", transcriberSidecarModel,
    "runs on-server · no API key · baked at deploy (WHISPER_MODEL)");
  await sidecarCatalog("ai:localDetector", "detect", detectorSidecarModel,
    "runs in the object-detector sidecar · no API key · baked at deploy (OBJECT_DETECTOR_MODEL)");
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
    // Per-facet vote agreement, {} on a single-pass board. Empty means NOT
    // MEASURED — the client must render nothing rather than "0 agreed".
    confidence: row?.tag_confidence || {},
    fields: row?.payload?.fields || {},
  });
}));

// The audio transcript for the lightbox — produced out-of-band by the
// transcription loop. null while still transcribing (or not audio); "" for a
// clip with no discernible speech.
app.get("/api/instances/:id/transcript", requireAuth, requireItemAccess, wrap(async (req, res) => {
  const row = await getItemReasoning(db, req.itemId);
  res.json({ transcript: row?.payload?.transcript ?? null });
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
  // A human tagging an entity into a watched set is an arrival too.
  await evaluateItemAlerts(db, req.itemId); // never throws
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
  const { rows: [item] } = await db.query("SELECT board_id FROM items WHERE id=$1", [req.itemId]);
  const board = item && (await getBoard(db, item.board_id));
  if (!board) return res.status(404).json({ error: "not found" });
  const { scope, error } = readFacetScope(req.body, board);
  if (error) return res.status(400).json({ error });
  // A scoped retag needs something to preserve AND a verdict it can leave alone,
  // so it only takes settled, decided rows — a 409 rather than a 404 says "this
  // item, wrong state", not "no such item".
  if (scope) {
    if (!(await retagItemFacets(db, req.itemId, scope))) {
      return res.status(409).json({ error: "only a tagged, decided item can be re-tagged on some facets" });
    }
  } else if (!(await retagItem(db, req.itemId))) {
    return res.status(404).json({ error: "not found" });
  }
  console.log(`retag queued instance #${req.itemId}${scope ? ` (facets: ${scope.join(", ")})` : ""}`);
  res.json({ ok: true, status: "pending", ...(scope ? { facets: scope } : {}) });
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
