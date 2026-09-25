// Test harness: each call to startServer() spins up a throwaway Postgres
// database, imports the app against it (schema + admin seed run at import),
// and listens on an ephemeral port. Nothing here touches the real dev DB.
//
// Requires a reachable Postgres whose role can CREATE DATABASE. Locally that's
// the compose db on 127.0.0.1:5433; CI points TEST_ADMIN_URL at its service.
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import zlib from "node:zlib";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  createUser,
  getUserByEmail,
  mcpTokenFor,
  createSession,
  createBoard,
  setBoardMembers,
  createEntity,
  insertItem,
  setMcpToken,
  setPluginState,
  usageRows,
} from "../server/db.js";
// The health cache is ONE instance per process: server.js is imported with a
// ?bust= query, but query strings don't propagate to its bare imports, so
// sidecar-catalog.js (like worker.js and db.js) resolves once and is shared by
// every bust and every static test import. Clearing here clears the app's.
import { clearSidecarHealth, seedSidecarHealth, sweepSidecars } from "../server/sidecar-catalog.js";
import { TarWriter } from "../server/tarfile.js";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

// base -> how to look up that server's admin token. A LOOKUP, not the string:
// the database owns this value, and anything that changes it there (a rotate
// through the API, a clear in the UI, another file's setMcpToken) would leave a
// cached copy stale with no signal. Tests were hand-syncing it back, which is
// the same fact living in two places.
const MCP_TOKENS = new Map();

const ADMIN_URL = process.env.TEST_ADMIN_URL || "postgres://gallery:gallery@127.0.0.1:5433/postgres";
const TEMPLATE_DB = process.env.TEST_TEMPLATE_DB || "gallery_test_template";
export const ADMIN_EMAIL = "admin@test.local";

// The three sidecars default to compose hostnames, which don't resolve outside
// that network — so the admin plugins page's health probes burned their full 2 s
// AbortSignal timeout, twice, in every file that loaded the route. A closed local
// port takes the same unreachable-sidecar branch and is refused instantly.
//
// Set at module scope, NOT inside startServer(): worker.js reads the extractor
// URL into a const when it loads, and a test file that imports it statically
// loads it long before any before() hook runs. Every such file imports this
// helper first, so this assignment lands ahead of it. (The two sidecar-backed
// providers read theirs lazily off their descriptors, so those are safe either
// way.) Tests that exercise sidecar behaviour stub the wire themselves.
//
// Named, because sidecarsUp() below restores it.
const DEAD_SIDECAR = "http://127.0.0.1:1";
process.env.TRANSCRIBER_URL = DEAD_SIDECAR;
process.env.OBJECT_DETECTOR_URL = DEAD_SIDECAR;
process.env.EXTRACTOR_URL = DEAD_SIDECAR;

// `frontend: true` serves the REAL public/ instead of the empty temp dir — the
// browser tests (test/browser/) need the actual page; every API test is faster
// without it.
//
// `staticDir` overrides where those assets come from, which is how the browser
// tests can run against BUILT output (scripts/build-frontend.mjs -> public/dist)
// as well as source. It has to be a parameter rather than a pre-set STATIC_DIR:
// this function assigns that env var, so an outer value would be overwritten.
export async function startServer({ frontend = false, staticDir = null } = {}) {
  const name = "gallery_test_" + crypto.randomBytes(6).toString("hex");
  // max 2: files run in parallel, and every worker holds one of these alongside
  // the app's own pool. The admin pool only creates and drops a database, so two
  // clients is ample and keeps the whole suite well inside max_connections.
  const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
  admin.on("error", () => {}); // same idle-client race close() guards on `db`, below
  // Clone the pre-migrated template (scripts/build-test-template.mjs) instead of
  // replaying every migration here — ~90 ms rather than ~460 ms per file. The
  // app still runs the ledger at import; against a clone it finds everything
  // applied and no-ops. 3D000 = the template isn't there (running a file directly
  // without `npm test`), so fall back to a bare database and let that same
  // import-time run build the schema the slow way. Correct either way.
  try {
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
  } catch (e) {
    if (e.code !== "3D000") throw e;
    await admin.query(`CREATE DATABASE ${name}`);
  }
  const dbUrl = ADMIN_URL.replace(/\/[^/]+$/, "/" + name);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-test-"));
  const galleryDir = path.join(tmp, "gallery");
  const thumbsDir = path.join(tmp, "thumbnails");
  const backupsDir = path.join(tmp, "backups");
  const pluginsDir = path.join(tmp, "plugins");

  // The app reads all of these at import; set them before importing.
  process.env.DATABASE_URL = dbUrl;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.COOKIE_SECURE = "0";
  process.env.GALLERY_DIR = galleryDir;
  process.env.THUMBS_DIR = thumbsDir;
  process.env.BACKUPS_DIR = backupsDir;
  process.env.PLUGINS_DIR = pluginsDir;
  process.env.STATIC_DIR = staticDir || (frontend ? PUBLIC_DIR : tmp); // no real frontend needed for API tests
  process.env.CONNECTOR_RPM = "1000000"; // don't rate-limit stubbed provider calls in tests
  process.env.CONNECTOR_BURST = "1000000";
  process.env.AI_RPM = "1000000"; // same for the AI wire's per-key pacing
  process.env.AI_BURST = "1000000";
  process.env.INGEST_FEED_CACHE_MS = "0"; // enumerate fresh each call unless a test opts in

  // Query string cache-busts the import so repeated starts in one process each
  // get a fresh module bound to their own DATABASE_URL.
  const mod = await import("../server/server.js?bust=" + name);
  const { app, db } = mod;
  // entities.id and items.id are separate sequences that advance nearly in
  // lockstep, so a lookup against the wrong table usually finds a same-numbered
  // row and passes by coincidence (the crate-route bug hid this way for a long
  // time). Desync them so any wrong-table id use fails loudly in every test.
  await db.query("ALTER TABLE entities ALTER COLUMN id RESTART WITH 500001");
  // DROP DATABASE ... WITH (FORCE) in close() can race db.end() and terminate
  // an idle pool client; pg emits that as a pool 'error' event, which is an
  // uncaughtException when unhandled (a rare CI flake). Queries in flight
  // still reject normally where awaited — this only swallows the idle case.
  db.on("error", () => {});

  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // Every MCP call needs a bearer now (planning/mcp-members-plan.md §10.6):
  // the tokenless loopback path is gone. Mint one for the seeded admin and let
  // `mcp()` send it by default, so that change lives here and not at the ~78
  // call sites that never cared about tokens.
  //
  // Keyed by `base`, not a module variable — test files run concurrently, each
  // with its own server, and two of them sharing one token is the bug this
  // shape avoids.
  // seedAdmin runs at import against the ADMIN_EMAIL set above, so this row is
  // always there — no guard, because a missing one would silently leave every
  // MCP call in the file unauthenticated and 401ing for no visible reason.
  const adminUser = await getUserByEmail(db, ADMIN_EMAIL);
  await setMcpToken(db, adminUser.id, `test-mcp-${name}`);
  MCP_TOKENS.set(base, () => mcpTokenFor(db, adminUser.id));

  async function close() {
    MCP_TOKENS.delete(base);
    await new Promise((r) => server.close(r));
    await db.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { base, db, galleryDir, thumbsDir, backupsDir, pluginsDir, close };
}

// Historical migrations (0005 hoist, 0007 re-key, 0024 alert baseline) predate
// the entity_ids restructure (migration 0025) and join items through the old
// scalar `entity_id` column, which 0025 drops. To replay one against the HEAD
// schema, resurrect that column from entity_ids[0] for the duration of the call,
// then fold changes back into entity_ids and drop it again. Assumes the rows in
// play are single-membership (true for the historical data these migrations
// touch) — the fold-back collapses to entity_ids[0], so don't wrap work that
// created multi-membership rows.
export async function withLegacyEntityId(db, fn) {
  await db.query("ALTER TABLE items ADD COLUMN IF NOT EXISTS entity_id BIGINT");
  await db.query("UPDATE items SET entity_id = entity_ids[1]");
  try {
    return await fn();
  } finally {
    await db.query(
      "UPDATE items SET entity_ids = CASE WHEN entity_id IS NULL THEN '{}'::bigint[] ELSE ARRAY[entity_id] END"
    );
    await db.query("ALTER TABLE items DROP COLUMN IF EXISTS entity_id");
  }
}

// --- seeding (operates on the app's own pool) ---

const FACETS = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];

export async function adminSession(db) {
  const u = await getUserByEmail(db, ADMIN_EMAIL); // seeded at import
  return { id: u.id, sid: await createSession(db, u.id), email: ADMIN_EMAIL };
}

export async function seedUser(db, email) {
  const u = await createUser(db, email, null);
  return { id: u.id, sid: await createSession(db, u.id), email };
}

// Connector providers are "available, not installed" by default (the plugin
// install model), so activeProvider throws until one is added. A test that
// exercises a connector adds it first, exactly like a user would.
export async function installConnectors(db, ...ids) {
  for (const id of ids) await setPluginState(db, id, { installed: true });
}

// The routed-status report's answer for one card: every re-queue route (and
// the tag-edit PATCH) replies `{ entities: [{id, status, instances}] }`.
export const routedStatus = (r, entityId) =>
  r.json.entities.find((e) => e.id === entityId)?.status;

export async function seedBoard(db, name, memberIds = []) {
  const id = await createBoard(db, name, FACETS, "", true, null, null, { enabled: true });
  if (memberIds.length) await setBoardMembers(db, id, memberIds);
  return id;
}

// One entity + one instance, the shape every upload takes. `id` is the
// entity id (what cards, hearts, crates and the entity routes speak);
// `instanceId` is the items row (tags, reasoning, queue state).
export async function seedItem(db, boardId, filename = crypto.randomBytes(6).toString("hex") + ".png") {
  const id = await createEntity(db, boardId, { identity: filename });
  const instanceId = await insertItem(
    db,
    boardId,
    { identity: filename, files: [{ name: filename, original_name: filename, w: 10, h: 10 }], fields: {} },
    "tagged",
    id
  );
  return { id, instanceId, filename };
}

// One entity + one instance in a chosen pipeline state — the seeder for queue
// tests, where the point is which STATUS a row sits in rather than its files.
// `payload` merges over the empty-file shape; `tags` is stamped after the
// insert because insertItem doesn't own it.
let seedSeq = 0;
export async function seedInstance(db, boardId, status, { tags = null, payload = {} } = {}) {
  const identity = `seed${++seedSeq}`;
  const eid = await createEntity(db, boardId, { identity });
  const id = await insertItem(db, boardId, { identity, files: [], fields: {}, ...payload }, status, eid);
  if (tags) await db.query("UPDATE items SET tags=$1 WHERE id=$2", [JSON.stringify(tags), id]);
  return { eid, id };
}

// --- request helper ---

export async function req(base, method, pathname, { sid, body } = {}) {
  const headers = {};
  if (sid) headers.Cookie = `sid=${sid}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(base + pathname, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (static files, redirects) */
  }
  return { status: res.status, json, text };
}

// A gzipped tar built in memory, one [name, content] per file — the archive
// shapes GitHub and npm serve, without a network.
export async function tgzOf(files) {
  const out = new PassThrough();
  const chunks = [];
  out.on("data", (c) => chunks.push(c));
  const tw = new TarWriter(out);
  for (const [name, content] of files) await tw.file(name, Buffer.byteLength(content), Buffer.from(content));
  await tw.end();
  return zlib.gzipSync(Buffer.concat(chunks));
}

// An integrity string as npm's registry publishes one: `<algorithm>-<base64>`.
export const sri = (buf, algo = "sha512") => `${algo}-${crypto.createHash(algo).update(buf).digest("base64")}`;

// npm's answers for one published version, by URL: the packument — its
// `dist` the tarball's integrity hash, or whatever `dist` a test hands it —
// and the tarball.
export function npmAnswers(name, version, tgz, dist = { integrity: sri(tgz) }) {
  const tarball = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`;
  return {
    [`https://registry.npmjs.org/${name}`]: JSON.stringify({ versions: { [version]: { dist: { tarball, ...dist } } } }),
    [tarball]: tgz,
  };
}

// A fetch stub answering URL → body and recording what it was asked; any
// other URL throws, so a stray request fails the test.
export function answering(answers) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    const body = answers[String(url)];
    if (!body) throw new Error(`unexpected fetch: ${url}`);
    return new Response(body);
  };
  return { fetch, calls };
}

// --- local HTTP stand-ins ---

// Swap globalThis.fetch for one call and restore on the way out, pass or
// throw — the wire tests' seam (jsonBox below is the other: a real HTTP
// server for code that needs a URL). Promoted here when research.test.js
// became its second copy-holder alongside compat.test.js.
export async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// A fetch stub recording each parsed request body, answering by a per-call
// rule (call number + body in, Response out) — the refusal-negotiation
// tests' seam, promoted alongside withFetch for the same reason.
export const recorder = (reply) => {
  const bodies = [];
  const fetch = async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return reply(bodies.length, bodies[bodies.length - 1]);
  };
  return { fetch, bodies };
};

// A throwaway JSON server: records every request URL on `hits`, serves
// `payload` (mutable, so a test can change the answer without a second box)
// with `status` (also mutable — flip a box from erroring to healthy in place).
// The seam behind every "the app fetched something" test: an upstream listing,
// a price map, a sidecar. Close it in `after`.
export function jsonBox(payload, { status = 200, delay = 0 } = {}) {
  const box = http.createServer((rq, rs) => {
    box.hits.push(rq.url);
    setTimeout(() => {
      rs.writeHead(box.status, { "Content-Type": "application/json" });
      rs.end(JSON.stringify(typeof box.payload === "function" ? box.payload() : box.payload));
    }, delay);
  });
  Object.assign(box, { payload, status, hits: [] });
  box.url = (path = "") => `http://127.0.0.1:${box.address().port}${path}`;
  return new Promise((resolve) => box.listen(0, "127.0.0.1", () => resolve(box)));
}

// A host that ACCEPTS and never answers — which is what a compose hostname
// whose service was excluded from the stack actually does, and the one kind of
// absence the dead-port default above cannot imitate: a closed port is REFUSED
// instantly, so it costs nothing and hides every latency bug behind itself.
// That is why 1,523 tests never noticed the /health budget being paid on the
// request path (sidecar-presence-latency-plan.md, Why now).
//
// Returns `close()`, which also restores the dead-port defaults. Sockets are
// left hanging deliberately — unref'd so a forgotten one cannot hold the
// process open, and destroyed on close.
export async function hangingSidecars() {
  const sockets = [];
  const box = net.createServer((s) => { sockets.push(s); });
  box.unref();
  await new Promise((r) => box.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${box.address().port}`;
  process.env.TRANSCRIBER_URL = url;
  process.env.OBJECT_DETECTOR_URL = url;
  return {
    url,
    close: async () => {
      process.env.TRANSCRIBER_URL = DEAD_SIDECAR;
      process.env.OBJECT_DETECTOR_URL = DEAD_SIDECAR;
      clearSidecarHealth();
      for (const s of sockets) s.destroy();
      await new Promise((r) => box.close(r));
    },
  };
}

// What a healthy host's sidecars report on /health, keyed by provider name —
// ONE statement of it, so the two fixtures below can't drift into describing
// different machines.
const SIDECAR_HEALTH = {
  whisper: { model: "base" },
  localDetector: { model: "iSEE-Laboratory/llmdet_tiny" },
};

// Stand the sidecar-backed engines up for a file: one jsonBox per engine
// answering /health (a box answers every path with its payload — harmless,
// because suites that drive the engine protocols stub globalThis.fetch, which
// intercepts box URLs too). The descriptors read their URLs lazily, so
// reassigning env here works after import; the health cache is cleared so the
// dead-port defaults don't linger.
//
// The boxes come back mutable (jsonBox's own contract), so a test that wants
// an engine to go down mid-file flips `status`/`payload` and clears the cache
// — no second fixture, and no option here, for absence.
//
// Behavior today: the capabilities feed overlays what /health reports, so a
// floor's `running.model` reads the box's model instead of null. Presence
// (sidecar-presence-plan.md) reads the same probe, so files wired through this
// keep their floor-served assertions unchanged when resolution starts gating.
export async function sidecarsUp() {
  const [whisper, detector] = await Promise.all([
    jsonBox(SIDECAR_HEALTH.whisper), jsonBox(SIDECAR_HEALTH.localDetector),
  ]);
  process.env.TRANSCRIBER_URL = whisper.url();
  process.env.OBJECT_DETECTOR_URL = detector.url();
  // A SWEEP, not a clear. Nothing probes lazily any more
  // (sidecar-presence-latency-plan.md): the health map is filled by the watch
  // loop, which a test never starts, so clearing it would leave both engines
  // reading absent no matter what these boxes answer. One sweep here is the
  // fixture stating "and now the app has seen them".
  await sweepSidecars();
  return {
    whisper, detector,
    close: async () => {
      process.env.TRANSCRIBER_URL = DEAD_SIDECAR;
      process.env.OBJECT_DETECTOR_URL = DEAD_SIDECAR;
      clearSidecarHealth(); // empty reads absent — no sweep needed to say "gone"
      await Promise.all([whisper, detector].map((b) => new Promise((r) => b.close(r))));
    },
  };
}

// Same claim as sidecarsUp — both engines are up and report the canonical
// bodies — stated straight into the health cache instead of over HTTP. For
// unit tests that resolve a floor engine and then drive its protocol through
// their own fetch stub: presence-gated resolution (sidecar-presence-plan.md)
// reads the seeded answer, so no /health probe lands in that stub's call
// ledger and the assertions on it stay exactly as written. A test wanting
// absence is the inverse: clearSidecarHealth() against the dead-port defaults.
export function primeSidecars() {
  clearSidecarHealth();
  for (const [provider, body] of Object.entries(SIDECAR_HEALTH)) seedSidecarHealth(provider, body);
}

// --- usage meter ---

// What a board spent, optionally narrowed to one capability. Rides usageRows —
// the reader the app itself uses — rather than a second hand-written aggregate
// over the same table: db.js says above boardUsageSummary that calling it "is
// what keeps a Stage 5 unit (or a renamed cost column) from having to land
// twice", and this helper was the last reader still spelling the SELECT out.
// It had already paid for that twice (5b added an `audio` column, 5c an
// `images` one).
//
// `units` is the whole map, so a NEW unit needs no edit here. The named
// aliases stay because an assertion reads better as `m.calls` than
// `m.units.requests?.quantity`, and 11 call sites already use them.
//
// `provider` narrows to one backend — the app scope accumulates every spender
// in a test file, so a test asserting what ONE provider burned has to say so.
// It rides the grouping the reader already does rather than a second query.
export async function meterTotals(db, boardId, capability = null, provider = null) {
  const all = await usageRows(db, { board: boardId, capability, group: ["provider", "model"] });
  const rows = provider == null ? all : all.filter((r) => r.provider === provider);
  const units = {};
  for (const r of rows)
    for (const [unit, u] of Object.entries(r.units)) units[unit] = (units[unit] || 0) + u.quantity;
  const q = (unit) => units[unit] || 0;
  return {
    calls: q("requests"), input: q("input_tokens"), output: q("output_tokens"),
    cache_read: q("cache_read_tokens"), searches: q("web_searches"),
    audio: q("audio_seconds"), images: q("images"),
    // usageRows orders by the grouped columns, so the first row is the
    // lowest (provider, model) PAIR — where the old MIN()/MIN() could pick a
    // provider and a model that never appeared together.
    provider: rows[0]?.provider ?? null, model: rows[0]?.model ?? null,
    units,
  };
}

// Wait for a condition the worker settles asynchronously. Nine test files had
// hand-rolled this exact loop; new tests import it from here instead.
export async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 60));
  }
}

// --- MCP ---------------------------------------------------------------------

// One JSON-RPC call to /mcp. `req` above speaks cookies, which is exactly what
// MCP does not: a client carries a bearer token and the protocol version in
// headers. `xff` moves which per-IP rate bucket a call lands in, which is the
// only thing that header still decides here.

// Whatever this server's admin holds RIGHT NOW. Read through rather than
// remembered, so a test that rotates or clears the token does not have to tell
// the harness about it.
export const mcpToken = async (base) => (await MCP_TOKENS.get(base)?.())?.token ?? null;

export async function mcp(base, body, { token, origin, version, xff, method = "POST" } = {}) {
  const headers = { Accept: "application/json, text/event-stream" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (version !== null) headers["MCP-Protocol-Version"] = version || "2025-06-18";
  // UNDEFINED means "whatever this server's admin holds" — the normal case, and
  // what keeps every tool test from having to know a token exists. `null` still
  // means send no header, which is how the gate's own tests ask to be refused.
  const bearer = token === undefined ? await mcpToken(base) : token;
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (origin) headers.Origin = origin;
  if (xff) headers["X-Forwarded-For"] = xff;
  const res = await fetch(base + "/mcp", {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 202 has no body; 405 may be JSON */ }
  return { status: res.status, json, text };
}

// `tools/call` and hand back the tool RESULT, which is where a tool's own
// errors live (isError) — protocol errors stay on the envelope.
export async function callTool(base, name, args = {}, opts = {}) {
  const r = await mcp(base, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, opts);
  return { ...r, result: r.json?.result, error: r.json?.error };
}

// Every text block of a tool result, joined — what the model would read.
export const toolText = (result) =>
  (result?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
export const toolImages = (result) => (result?.content || []).filter((c) => c.type === "image");
