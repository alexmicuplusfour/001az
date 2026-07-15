// Ingestion sources: the `source` plugin kind, the saved source_connections
// store (CRUD + secret masking + blank-keeps), the plugin catalog's
// connectionCount, and the FTP backend + shared file adapter driven end-to-end
// against an in-process ftp-srv. S3's backend logic is unit-tested through a
// fake in ingest-files.test.js; a live MinIO run is gated (see the plan).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { FtpSrv } from "ftp-srv";
import { startServer, adminSession, seedUser, seedBoard, req } from "./helpers.js";
import { backend as ftpBackend } from "../server/ingestion/sources/ftp.js";
import * as files from "../server/ingestion/files.js";
import {
  getBoard, updateBoard, ingestedKeys, setPluginState, recordIngest,
  createSourceConnection, getSourceConnection, getPluginRow,
} from "../server/db.js";
import { createSources } from "../server/sources/index.js";

let srv, db, sources;
let ftpServer, ftpRoot, ftpConn;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

before(async () => {
  srv = await startServer();
  db = srv.db;
  sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });

  // A throwaway FTP server rooted at a seeded tree.
  ftpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-root-"));
  fs.writeFileSync(path.join(ftpRoot, "a.txt"), "hello ftp");
  fs.writeFileSync(path.join(ftpRoot, "note.exe"), "not ingestible");
  fs.mkdirSync(path.join(ftpRoot, "sub"));
  fs.writeFileSync(path.join(ftpRoot, "sub", "b.md"), "nested markdown");

  // A no-op logger: ftp-srv otherwise chatters passive-socket teardown warnings
  // (benign — the transfer already completed when our client closed).
  const silentLog = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return silentLog; } };
  const port = await freePort();
  ftpServer = new FtpSrv({ url: `ftp://127.0.0.1:${port}`, anonymous: true, pasv_url: "127.0.0.1", log: silentLog });
  ftpServer.on("login", (_data, resolve) => resolve({ root: ftpRoot }));
  await ftpServer.listen();
  ftpConn = { host: "127.0.0.1", port, user: "anonymous", password: "", secure: false };

  // Give folder-source validation a root to jail against (reuse the ftp tree).
  process.env.INGEST_ROOT = ftpRoot;
});

after(async () => {
  delete process.env.INGEST_ROOT;
  sources.close?.();
  await ftpServer?.close();
  fs.rmSync(ftpRoot, { recursive: true, force: true });
  await srv.close();
});

// --- source_connections routes: CRUD, masking, blank-keeps, auth ---

test("source connection: create → masked list → blank-keeps edit → delete", async () => {
  const admin = await adminSession(db);

  const created = await req(srv.base, "POST", "/api/admin/source-connections", {
    sid: admin.sid,
    body: { type: "ftp", label: "Client FTP", config: { host: "ftp.example.com", user: "bob", password: "hunter2" } },
  });
  assert.equal(created.status, 200);
  const id = created.json.id;

  // List masks the secret (presence only), echoes non-secrets.
  const listed = await req(srv.base, "GET", "/api/admin/source-connections", { sid: admin.sid });
  assert.equal(listed.status, 200);
  const row = listed.json.find((c) => c.id === id);
  assert.equal(row.label, "Client FTP");
  assert.equal(row.config.host, "ftp.example.com");
  assert.equal(row.config.user, "bob");
  assert.equal(row.config.password, undefined, "secret never echoed");
  assert.equal(row.hasSecret.password, true);
  assert.equal(row.config.port, 21, "schema default filled");

  // Blank password + a new label: password is KEPT, label changes.
  const patched = await req(srv.base, "PATCH", `/api/admin/source-connections/${id}`, {
    sid: admin.sid,
    body: { label: "Renamed", config: { host: "ftp.example.com", user: "bob", password: "" } },
  });
  assert.equal(patched.status, 200);
  const stored = await getSourceConnection(db, id);
  assert.equal(stored.label, "Renamed");
  assert.equal(stored.config.password, "hunter2", "blank secret keeps the stored value");

  const del = await req(srv.base, "DELETE", `/api/admin/source-connections/${id}`, { sid: admin.sid });
  assert.equal(del.status, 200);
  assert.equal((await getSourceConnection(db, id)), null);
});

test("source connection: validation + admin-only", async () => {
  const admin = await adminSession(db);
  const member = await seedUser(db, "srcmember@test.local");

  // Unknown / connection-less type rejected.
  assert.equal((await req(srv.base, "POST", "/api/admin/source-connections",
    { sid: admin.sid, body: { type: "folder", label: "x" } })).status, 400);
  assert.equal((await req(srv.base, "POST", "/api/admin/source-connections",
    { sid: admin.sid, body: { type: "nope", label: "x" } })).status, 400);

  // Missing required field (host) rejected.
  const badHost = await req(srv.base, "POST", "/api/admin/source-connections",
    { sid: admin.sid, body: { type: "ftp", label: "x", config: { user: "bob" } } });
  assert.equal(badHost.status, 400);
  assert.match(badHost.json.error, /Host is required/);

  // Non-admin can't touch the credential store.
  assert.equal((await req(srv.base, "GET", "/api/admin/source-connections", { sid: member.sid })).status, 403);
  assert.equal((await req(srv.base, "POST", "/api/admin/source-connections",
    { sid: member.sid, body: { type: "ftp", label: "x", config: { host: "h" } } })).status, 403);
});

test("ftp connection: the allowSelfSigned toggle round-trips (not rejected as an unknown field)", async () => {
  const admin = await adminSession(db);

  // The FTPS self-signed opt-out is a real schema field — the config validator
  // must accept it, and coerce must store it (regression: it used to be read by
  // the backend but absent from connectionSchema, so the unknown-field check
  // rejected it and self-signed FTPS was unconfigurable).
  const created = await req(srv.base, "POST", "/api/admin/source-connections", {
    sid: admin.sid,
    body: { type: "ftp", label: "Self-signed FTPS", config: { host: "ftps.example.com", secure: true, allowSelfSigned: true } },
  });
  assert.equal(created.status, 200);
  const stored = await getSourceConnection(db, created.json.id);
  assert.equal(stored.config.allowSelfSigned, true, "toggle persisted");
  assert.equal(stored.config.secure, true);

  // Default (omitted) → verify (false).
  const dflt = await req(srv.base, "POST", "/api/admin/source-connections", {
    sid: admin.sid,
    body: { type: "ftp", label: "Verifying FTPS", config: { host: "ftps2.example.com", secure: true } },
  });
  assert.equal((await getSourceConnection(db, dflt.json.id)).config.allowSelfSigned, false, "defaults to verify");

  await req(srv.base, "DELETE", `/api/admin/source-connections/${created.json.id}`, { sid: admin.sid });
  await req(srv.base, "DELETE", `/api/admin/source-connections/${dflt.json.id}`, { sid: admin.sid });
});

test("catalog: source plugins present; folder core-installed, ftp/s3 available + connectionCount", async () => {
  const admin = await adminSession(db);
  const c1 = await createSourceConnection(db, "ftp", "one", { host: "h1" });
  const c2 = await createSourceConnection(db, "ftp", "two", { host: "h2" });

  const cat = await req(srv.base, "GET", "/api/admin/plugins", { sid: admin.sid });
  const bySrc = Object.fromEntries(cat.json.plugins.filter((p) => p.kind === "source").map((p) => [p.id, p]));

  assert.ok(bySrc["source:folder"].core);
  assert.equal(bySrc["source:folder"].state.installed, true, "folder core → installed");
  assert.equal(bySrc["source:ftp"].state.installed, false, "ftp available until added");
  assert.equal(bySrc["source:s3"].state.installed, false);
  assert.equal(bySrc["source:ftp"].state.connectionCount, 2);
  assert.ok(bySrc["source:ftp"].connectionSchema.some((f) => f.key === "password" && f.type === "secret"));

  await req(srv.base, "DELETE", `/api/admin/source-connections/${c1}`, { sid: admin.sid });
  await req(srv.base, "DELETE", `/api/admin/source-connections/${c2}`, { sid: admin.sid });
});

// --- FTP backend directly against ftp-srv ---

test("ftp backend: recursive list honors accept, fetch downloads, test connects", async () => {
  const be = ftpBackend({ conn: ftpConn });
  const accept = (name) => /\.(txt|md)$/i.test(name);

  const { entries } = await be.list({ path: "", recursive: true, accept });
  const files_ = entries.filter((e) => e.type === "file").map((e) => e.key).sort();
  assert.deepEqual(files_, ["a.txt", "sub/b.md"], "walks subdirs, skips .exe");
  const a = entries.find((e) => e.key === "a.txt");
  assert.equal(a.size, "hello ftp".length);
  assert.equal(a.type, "file");

  // One level with dirs, for the browse modal.
  const level = await be.list({ path: "", recursive: false, includeDirs: true });
  assert.ok(level.entries.some((e) => e.name === "sub" && e.type === "dir"));

  const tmp = path.join(os.tmpdir(), "ftp-fetch-" + Math.random().toString(16).slice(2));
  await be.fetch("a.txt", tmp);
  assert.equal(fs.readFileSync(tmp, "utf8"), "hello ftp");
  fs.rmSync(tmp, { force: true });

  assert.deepEqual(await be.test(), { ok: true });
});

// --- file adapter over an FTP connection, end to end ---

test("file adapter over ftp: enumerate → admit → ledger", async () => {
  // Install the ftp source and save a connection pointing at the test server.
  await setPluginState(db, "source:ftp", { installed: true });
  const connId = await createSourceConnection(db, "ftp", "test-server", ftpConn);

  const boardId = await seedBoard(db, "ftp-board");
  await updateBoard(db, boardId, {
    ingest: { enabled: true, source: { type: "ftp", connectionId: connId, path: "", recursive: true }, trigger: { mode: "manual" } },
  });
  const board = await getBoard(db, boardId);

  const { candidates } = await files.enumerate(db, board, board.ingest);
  const keys = candidates.map((c) => c.key).sort();
  assert.deepEqual(keys, ["a.txt", "sub/b.md"], "FTP files enumerated as candidates");

  const cand = candidates.find((c) => c.key === "a.txt");
  const r = await files.admit(db, board, cand, { sources });
  assert.ok(r.itemId && r.entityId);
  const { rows: [item] } = await db.query("SELECT status, payload FROM items WHERE id=$1", [r.itemId]);
  assert.equal(item.status, "pending");
  assert.equal(item.payload.files[0].original_name, "a.txt");

  const known = await ingestedKeys(db, boardId);
  assert.ok(known.has("a.txt"), "admit ledgered the FTP key");
});

test("file adapter: an uninstalled source is a readable refusal", async () => {
  await setPluginState(db, "source:ftp", { installed: false });
  const boardId = await seedBoard(db, "ftp-off");
  const connId = await createSourceConnection(db, "ftp", "off", ftpConn);
  await updateBoard(db, boardId, {
    ingest: { enabled: true, source: { type: "ftp", connectionId: connId, path: "" }, trigger: { mode: "manual" } },
  });
  const board = await getBoard(db, boardId);
  await assert.rejects(files.enumerate(db, board, board.ingest), /isn't installed/);
  await setPluginState(db, "source:ftp", { installed: true }); // restore for other tests
});

test("source health: a failing remote sweep reddens the plugin dot; a good run heals it", async () => {
  await setPluginState(db, "source:ftp", { installed: true });
  // The listing is the reachability probe — a scheduled sweep against a dead
  // source must land on the plugin's health ledger (gear-modal dot), not just
  // the board's last_error, and must heal once the source comes back.
  const prev = process.env.INGEST_FEED_CACHE_MS;
  process.env.INGEST_FEED_CACHE_MS = "0"; // don't let a cache hit skip the probe
  const deadPort = await freePort(); // freePort closes its listener → connection refused
  const deadId = await createSourceConnection(db, "ftp", "dead", { host: "127.0.0.1", port: deadPort });
  const liveId = await createSourceConnection(db, "ftp", "live", ftpConn);
  try {
    // Down → a structured failure is recorded on source:ftp.
    await assert.rejects(files.enumerate(db, {}, { source: { type: "ftp", connectionId: deadId, path: "" } }));
    const failed = await getPluginRow(db, "source:ftp");
    assert.ok(failed.fail_count > 0, "failure bumped the health streak");
    assert.ok(failed.last_error, "structured last_error stored");

    // Back up → the next successful listing heals the streak.
    await files.enumerate(db, {}, { source: { type: "ftp", connectionId: liveId, path: "" } });
    const healed = await getPluginRow(db, "source:ftp");
    assert.equal(healed.fail_count, 0, "success reset the streak");
    assert.equal(healed.last_error, null, "and cleared the error");
  } finally {
    if (prev === undefined) delete process.env.INGEST_FEED_CACHE_MS;
    else process.env.INGEST_FEED_CACHE_MS = prev;
    await req(srv.base, "DELETE", `/api/admin/source-connections/${deadId}`, { sid: (await adminSession(db)).sid });
    await req(srv.base, "DELETE", `/api/admin/source-connections/${liveId}`, { sid: (await adminSession(db)).sid });
  }
});

// --- board routes: GET /ingest sources, source/browse, save-time validation ---

test("GET /ingest lists installed sources + connections; browse navigates the tree", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "source:ftp", { installed: true });
  const connId = await createSourceConnection(db, "ftp", "browse-server", ftpConn);
  const boardId = await seedBoard(db, "browse-board");

  const info = await req(srv.base, "GET", `/api/boards/${boardId}/ingest`, { sid: admin.sid });
  assert.equal(info.status, 200);
  const srcs = Object.fromEntries(info.json.sources.map((s) => [s.type, s]));
  assert.ok(srcs.folder, "folder source always listed");
  assert.ok(srcs.ftp?.connections.some((c) => c.id === connId && c.label === "browse-server"));
  // The descriptor is the SHARED catalog only — the per-source field schema
  // lives on each source (folder's `folder`, ftp's `path`), never folded into
  // one folder-shaped descriptor.source.
  assert.deepEqual(info.json.descriptor.source, [], "descriptor carries no single source schema");
  assert.ok(srcs.folder.sourceSchema.some((f) => f.key === "folder"));
  assert.ok(srcs.ftp.sourceSchema.some((f) => f.key === "path"));
  // Connections carry no secret material to the (manager) client.
  for (const c of srcs.ftp.connections) assert.deepEqual(Object.keys(c).sort(), ["id", "label"]);
  // Every source offers every trigger mode, including continuous — a remote
  // source may watch (the modal defaults it away, but doesn't forbid it).
  assert.ok(srcs.folder.triggerModes.includes("continuous"), "folder offers continuous");
  assert.ok(srcs.ftp.triggerModes.includes("continuous"), "remote may also watch continuously");

  const root = await req(srv.base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "ftp", connectionId: connId }, path: "" },
  });
  assert.equal(root.status, 200);
  assert.equal(root.json.parent, null, "root has no parent");
  assert.ok(root.json.entries.some((e) => e.name === "sub" && e.type === "dir"));

  const deep = await req(srv.base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "ftp", connectionId: connId }, path: "sub" },
  });
  assert.equal(deep.json.parent, "", "sub's parent is the root");
  assert.ok(deep.json.entries.some((e) => e.name === "b.md" && e.type === "file"));
});

test("saving an ftp source validates the connection reference", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "source:ftp", { installed: true });
  const boardId = await seedBoard(db, "save-ftp");
  const base = { enabled: true, filters: [], sort: { by: "modified", order: "desc" }, trigger: { mode: "manual" } };

  const bad = await req(srv.base, "PATCH", `/api/boards/${boardId}`, {
    sid: admin.sid, body: { ingest: { ...base, source: { type: "ftp", connectionId: 999999, path: "" } } },
  });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /connection/);

  const connId = await createSourceConnection(db, "ftp", "save-conn", ftpConn);
  const ok = await req(srv.base, "PATCH", `/api/boards/${boardId}`, {
    sid: admin.sid, body: { ingest: { ...base, source: { type: "ftp", connectionId: connId, path: "" } } },
  });
  assert.equal(ok.status, 200);
});

test("save + browse refuse a connection whose type doesn't match the source", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "source:ftp", { installed: true });
  const s3conn = await createSourceConnection(db, "s3", "a bucket", { bucket: "b", accessKeyId: "k", secretAccessKey: "s" });
  const boardId = await seedBoard(db, "type-mismatch");
  const base = { enabled: true, filters: [], sort: { by: "modified", order: "desc" }, trigger: { mode: "manual" } };

  const save = await req(srv.base, "PATCH", `/api/boards/${boardId}`, {
    sid: admin.sid, body: { ingest: { ...base, source: { type: "ftp", connectionId: s3conn, path: "" } } },
  });
  assert.equal(save.status, 400);
  assert.match(save.json.error, /different source/);

  // The browse route resolves through the same chokepoint — mismatch refused there too.
  const browse = await req(srv.base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "ftp", connectionId: s3conn }, path: "" },
  });
  assert.equal(browse.status, 400);
  assert.match(browse.json.error, /not ftp|different/);
});

test("save refuses a folder that escapes the ingest root, and an uninstalled source", async () => {
  const admin = await adminSession(db);
  const base = { enabled: true, filters: [], sort: { by: "modified", order: "desc" }, trigger: { mode: "manual" } };

  const escapeBoard = await seedBoard(db, "escape");
  const escape = await req(srv.base, "PATCH", `/api/boards/${escapeBoard}`, {
    sid: admin.sid, body: { ingest: { ...base, source: { type: "folder", folder: "../secret" } } },
  });
  assert.equal(escape.status, 400);
  assert.match(escape.json.error, /escapes/);

  // S3 is available-not-installed by default → saving an s3 source is refused.
  await setPluginState(db, "source:s3", { installed: false });
  const s3conn = await createSourceConnection(db, "s3", "b", { bucket: "b", accessKeyId: "k", secretAccessKey: "s" });
  const s3Board = await seedBoard(db, "s3-uninstalled");
  const uninstalled = await req(srv.base, "PATCH", `/api/boards/${s3Board}`, {
    sid: admin.sid, body: { ingest: { ...base, source: { type: "s3", connectionId: s3conn, path: "" } } },
  });
  assert.equal(uninstalled.status, 400);
  assert.match(uninstalled.json.error, /isn't installed/);
});

test("browsing a removed connection is a readable refusal", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "source:ftp", { installed: true });
  const boardId = await seedBoard(db, "browse-gone");
  const r = await req(srv.base, "POST", `/api/boards/${boardId}/ingest/source/browse`, {
    sid: admin.sid, body: { source: { type: "ftp", connectionId: 999999 }, path: "" },
  });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /removed|pick another/);
});

// --- remote enumeration: full-listing cache (no reach cap that would clog) ---

test("remote source: files added after the first batch is ingested are still seen", async () => {
  await setPluginState(db, "source:ftp", { installed: true });
  const dir = path.join(ftpRoot, "grow");
  fs.mkdirSync(dir);
  for (const n of ["a.txt", "b.txt", "c.txt"]) fs.writeFileSync(path.join(dir, n), "x");
  const connId = await createSourceConnection(db, "ftp", "grow-conn", ftpConn);
  const boardId = await seedBoard(db, "grow-board");
  await updateBoard(db, boardId, {
    ingest: { enabled: true, source: { type: "ftp", connectionId: connId, path: "grow", recursive: true }, trigger: { mode: "manual" } },
  });
  const board = await getBoard(db, boardId);

  const first = await files.enumerate(db, board, board.ingest);
  assert.deepEqual(first.candidates.map((c) => c.key).sort(), ["grow/a.txt", "grow/b.txt", "grow/c.txt"]);
  for (const c of first.candidates) await recordIngest(db, boardId, c.key, Date.now()); // ledger the batch

  // Add more, re-enumerate: the new files are walked (not hidden behind the
  // ingested batch) and read as fresh vs the ledger. (Cache is off in tests.)
  for (const n of ["d.txt", "e.txt"]) fs.writeFileSync(path.join(dir, n), "x");
  const second = await files.enumerate(db, board, board.ingest);
  assert.deepEqual(second.candidates.map((c) => c.key).sort(),
    ["grow/a.txt", "grow/b.txt", "grow/c.txt", "grow/d.txt", "grow/e.txt"]);
  const known = await ingestedKeys(db, boardId);
  assert.deepEqual(second.candidates.filter((c) => !known.has(c.key)).map((c) => c.key).sort(),
    ["grow/d.txt", "grow/e.txt"], "the new files are fresh and would ingest");
});

test("remote enumeration is briefly cached (reused within TTL, re-walked on a key change)", async () => {
  await setPluginState(db, "source:ftp", { installed: true });
  const dir = path.join(ftpRoot, "cache");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "one.txt"), "x");
  const connId = await createSourceConnection(db, "ftp", "cache-conn", ftpConn);
  const boardId = await seedBoard(db, "cache-board");
  await updateBoard(db, boardId, {
    ingest: { enabled: true, source: { type: "ftp", connectionId: connId, path: "cache", recursive: true }, trigger: { mode: "manual" } },
  });
  const board = await getBoard(db, boardId);

  process.env.INGEST_FEED_CACHE_MS = "60000"; // enable the cache just for this test
  try {
    assert.equal((await files.enumerate(db, board, board.ingest)).candidates.length, 1);
    fs.writeFileSync(path.join(dir, "two.txt"), "x"); // added while the window is warm
    assert.equal((await files.enumerate(db, board, board.ingest)).candidates.length, 1, "served from cache");
    // A different cache key (recursive flag) forces a fresh walk → sees both.
    const other = { ...board.ingest, source: { ...board.ingest.source, recursive: false } };
    assert.equal((await files.enumerate(db, board, other)).candidates.length, 2, "key change → fresh walk");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = "0"; // restore the test default (cache off)
  }
});

test("remote enumeration cache evicts lapsed windows (no unbounded growth)", async () => {
  await setPluginState(db, "source:ftp", { installed: true });
  const connId = await createSourceConnection(db, "ftp", "evict-conn", ftpConn);
  const board = { ingest: { source: { type: "ftp", connectionId: connId, path: "", recursive: true } } };

  process.env.INGEST_FEED_CACHE_MS = "40"; // a tiny window so it lapses within the test
  try {
    await files.enumerate(db, board, board.ingest); // writes key A (recursive:true)
    await new Promise((r) => setTimeout(r, 60));     // let every prior window (incl. A) lapse
    // A write under a fresh key prunes the lapsed entries instead of piling on:
    // whatever the cache held before, it now holds only this one live window.
    await files.enumerate(db, board, { source: { ...board.ingest.source, recursive: false } });
    assert.equal(files._windowCacheSize(), 1, "stale windows evicted, not accumulated");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = "0";
  }
});

test("editing a connection drops its cached listing (config isn't in the cache key)", async () => {
  const admin = await adminSession(db);
  await setPluginState(db, "source:ftp", { installed: true });
  const connId = await createSourceConnection(db, "ftp", "edit-conn", ftpConn);
  const board = { ingest: { source: { type: "ftp", connectionId: connId, path: "", recursive: true } } };

  process.env.INGEST_FEED_CACHE_MS = "60000"; // warm window so the edit has something to drop
  try {
    await files.enumerate(db, board, board.ingest); // caches this connection's listing
    const before = files._windowCacheSize();
    // A config edit keeps the same id (same cache key) — the route must drop the
    // window so the board re-walks with the new settings, not up to 60s stale.
    const patched = await req(srv.base, "PATCH", `/api/admin/source-connections/${connId}`, {
      sid: admin.sid, body: { config: { host: ftpConn.host, port: ftpConn.port, user: ftpConn.user } },
    });
    assert.equal(patched.status, 200);
    assert.equal(files._windowCacheSize(), before - 1, "the connection's cached window was dropped");
  } finally {
    process.env.INGEST_FEED_CACHE_MS = "0";
  }
});
