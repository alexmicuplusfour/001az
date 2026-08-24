// The shared file-ingestion adapter. A file board pulls files from a SOURCE
// (local folder, ftp, s3, …); this adapter owns everything common to all of
// them — the filter/sort catalog, the candidate shape, and the admit path
// through the one upload door (admitFile) — and dispatches only the source-
// specific bits (list files, fetch one) to the backend named by
// `cfg.source.type`. Adding a source is a backend module in ./sources/, never
// a new adapter: the sweep, routes, engine, ledger and modal stay adapter-blind
// (see ./sources/folder.js for the backend contract; ./connector.js is the
// other adapter, for connector-catalog feeds).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { admitFile } from "../ingest.js";
import { withTx, recordIngest, getSourceConnection, listSourceConnections, withPluginHealth } from "../db.js";
// MEDIA-side helpers: which extensions a handler accepts, and the ext of a name.
import { acceptsName, extOf } from "../sources/index.js";
import { getSourceBackend, sourceModules } from "./sources/index.js";
import { SAFETY_CAP, cacheTtl, readWindow, writeWindow } from "./window-cache.js";
import { resolveJailed } from "./sources/folder.js";
import { pluginInstalled, mediaLimitLookup } from "../plugins.js";

// The file filter catalog + sorts, shared by every file source. `values` a
// backend fills (name/path/extension/file_size/modified/created) feed these.
// `preview: true` marks the compact subset the ingest preview shows; the rest
// stay filterable but off the preview table.
const FILE_FILTERS = [
  { fn: "name", kind: "text", label: "File name" },
  { fn: "extension", kind: "text", label: "Extension", preview: true },
  { fn: "path", kind: "text", label: "Relative path" },
  { fn: "file_size", kind: "number", label: "File size (bytes)", preview: true },
  { fn: "modified", kind: "date", label: "Modified", preview: true },
  { fn: "created", kind: "date", label: "Created" },
];
const FILE_SORTS = [
  { by: "modified", label: "Modified" },
  { by: "created", label: "Created" },
  { by: "name", label: "File name" },
  { by: "file_size", label: "File size" },
];
const FILE_TRIGGERS = ["manual", "continuous", "interval", "daily"];

// Remote enumeration is served from a briefly-cached FULL listing, not a hard
// reach cap. A capped window would "clog": once the first N files are ingested
// they still fill the window (the ledger dedups DOWNSTREAM, not during the
// walk), so files added afterwards would never be seen — breaking the whole
// point of watching a growing source. Instead the walk lists the source in full
// and caches the result for INGEST_FEED_CACHE_MS, so cost is bounded by
// FREQUENCY (one listing per cache window, reused by back-to-back drain ticks
// and preview pages) rather than by size, with no reach limit. Same mechanism
// as the connector feed, and now literally the same pieces — SAFETY_CAP, the
// TTL read, the prune, and reading/writing an entry all live in
// ./window-cache.js, because the connector adapter had copied two of the first
// three and was missing the prune, then grew a second timestamp on its private
// copy of the entry and left `at` meaning two different things. SAFETY_CAP is
// only an out-of-memory backstop for a pathological source (narrow the base
// path if you ever hit it). Candidate objects are read-only downstream
// (applyFilters/applySort copy), so serving a cached array by reference is
// safe. Entries are pruned on write once past their window (an expired entry
// is a guaranteed miss anyway), so the map holds only the actively-swept
// sources — a re-pointed or deleted board's stale key, and its full candidate
// array, doesn't linger for the worker's lifetime.
const windowCache = new Map();
// Test seam: the cache is module-private; tests assert it doesn't accumulate.
export const _windowCacheSize = () => windowCache.size;

// Drop every cached listing for a connection. The cache key carries the
// connection's ID but not its config, so editing a connection's host/bucket/
// prefix (same ID) would otherwise serve the OLD settings' listing until the
// window lapses. The connection routes call this on edit/remove so the next
// enumerate re-walks with the current config. `connectionId` is the key's 2nd
// `|`-segment; split (not substring) so a path containing "|<id>|" can't match.
export function invalidateSourceCache(connectionId) {
  const id = String(connectionId);
  for (const k of windowCache.keys()) if (k.split("|")[1] === id) windowCache.delete(k);
}

// Resolve the backend for a board's source config. Dispatches by `source.type`
// (absent → "folder", so existing file boards are unchanged), enforces the
// plugin install gate, and resolves the saved connection for remote sources.
// Every failure is a readable throw — the sweep records it as the board's
// last_error and the routes surface it, rather than crashing.
export async function resolveBackend(db, source = {}) {
  const type = source.type || "folder";
  const mod = getSourceBackend(type);
  if (!mod) throw new Error(`unknown ingestion source "${type}"`);
  if (db && !(await pluginInstalled(db, `source:${type}`)))
    throw new Error(`the ${mod.manifest.label} source isn't installed — add it on the Plugins page`);
  if (!mod.manifest.needsConnection) return mod.backend({ source });
  const conn = await getSourceConnection(db, source.connectionId);
  if (!conn) throw new Error("that source connection was removed — pick another for this board");
  // The connection must be for THIS source type — the single chokepoint that
  // keeps validateSource's invariant true at run/browse time too, so a caller
  // (e.g. the browse route) can't drive one backend with another's credentials.
  if (conn.type !== type) throw new Error(`that connection is a ${conn.type} connection, not ${type}`);
  // A malformed/hand-edited row (config not a JSON object) degrades to defaults
  // rather than throwing an opaque TypeError deep in the backend.
  const config = conn.config && typeof conn.config === "object" && !Array.isArray(conn.config) ? conn.config : {};
  return mod.backend({ source, conn: config });
}

// Per-board source config → the directory/prefix a backend should read.
const sourcePath = (source = {}) => source.folder ?? source.path ?? "";

// The descriptor the routes serve and the modal renders: the SHARED file
// catalog — filters, sorts and trigger modes are identical across every file
// source. The per-source FIELD schema is deliberately NOT here (it's inherently
// per-source): each backend's is carried by its listSources() entry
// (info.sources[].sourceSchema). `source: []` mirrors the connector adapter,
// whose universe likewise has nothing global to configure.
export function descriptor() {
  return {
    source: [],
    filters: FILE_FILTERS,
    sorts: FILE_SORTS,
    triggerModes: FILE_TRIGGERS,
  };
}

// List the source's files into candidates the shared engine filters/sorts on.
// `accept`/`maxBytes` are applied inside the backend walk so `limit` counts only
// admissible files (identical to the pre-split folder behaviour).
// Map backend file entries → the candidate shape the shared engine filters/sorts.
function toCandidates(entries) {
  return entries
    .filter((e) => e.type === "file")
    .map((e) => ({
      key: e.key,
      label: e.name,
      values: {
        name: e.name,
        path: e.path,
        extension: extOf(e.name),
        file_size: e.size,
        modified: e.modified,
        created: e.created,
      },
    }));
}

export async function enumerate(db, board, cfg, { limit = Infinity } = {}) {
  const type = cfg.source?.type || "folder";
  const srcPath = sourcePath(cfg.source);
  const recursive = cfg.source?.recursive !== false;
  const remote = !!getSourceBackend(type)?.manifest.needsConnection;
  // Per-type size gate for the walk: a file over ITS type's effective limit is
  // dropped during enumeration, so `limit` counts only admissible files and the
  // browse/preview reflects what will actually ingest (a 40 MB audio passes, a
  // 15 MB image doesn't). admitFile re-checks at admit time as the authority.
  const limitFor = await mediaLimitLookup(db);

  // Remote: serve a briefly-cached full listing (see the cache note above) so a
  // growing source is fully seen; the caller's `limit` is ignored — the ledger,
  // filters and per-run limit downstream do the bounding. Keyed by what changes
  // the listing (not the sort, which is applied downstream), so a count, its
  // result pages, and back-to-back drain ticks in one window all reuse it.
  if (remote) {
    const key = `${type}|${cfg.source?.connectionId ?? ""}|${srcPath}|${recursive}`;
    const ttl = cacheTtl();
    // No `hold`: a file drain re-lists on the clock like every other caller.
    // The connector adapter holds its window across a drain because re-walking
    // a METERED catalog per tick is the cost it can't pay; an S3 LIST fan-out
    // isn't that, and nobody has asked for the snapshot consistency a hold
    // would also buy here. One parameter away if that changes.
    const hit = readWindow(windowCache, key, { ttl });
    if (hit) return hit;
    const startedAt = Date.now();
    const be = await resolveBackend(db, cfg.source);
    // The remote listing is the source's reachability probe — the sweep's
    // equivalent of the admin Test button. Ledger its outcome on the source
    // plugin (heal on success, structured error on throw) so a source that's
    // down turns the gear-modal dot red with its last error and heals when it
    // recovers, mirroring connector feeds. Only the network call is wrapped;
    // resolveBackend's config errors (connection removed) aren't a source-health
    // signal, and a cache hit above rightly probes nothing. Per-file fetch
    // failures in admit stay board-level (retryable) — list is the coarse
    // "is this source working" signal, exactly what Test checks.
    const { entries, truncated } = await withPluginHealth(db, `source:${type}`, () =>
      be.list({ path: srcPath, recursive, limit: SAFETY_CAP, accept: acceptsName, maxBytesFor: limitFor }));
    return writeWindow(windowCache, key, ttl, { candidates: toCandidates(entries), truncated }, startedAt);
  }

  // Local folder: walk fresh each call (cheap, always current), honoring limit.
  const be = await resolveBackend(db, cfg.source);
  const { entries, truncated } = await be.list({ path: srcPath, recursive, limit, accept: acceptsName, maxBytesFor: limitFor });
  return { candidates: toCandidates(entries), truncated };
}

// Admit one candidate: fetch the source file to tmp (never consume the
// original), then birth the entity+item and the ledger row in one transaction,
// through the same admitFile the upload route uses. The gallery/thumbnail writes
// inside admitFile precede COMMIT, so a rollback cleans them up best-effort —
// the same latent orphan window the upload route has.
export async function admit(db, board, candidate, { sources } = {}) {
  const be = await resolveBackend(db, board.ingest?.source);
  const limitFor = await mediaLimitLookup(db); // effective per-type size gate
  const tmp = path.join(os.tmpdir(), `ingest-${crypto.randomBytes(8).toString("hex")}`);
  await be.fetch(candidate.key, tmp);
  let admitted = null;
  try {
    return await withTx(db, async (client) => {
      admitted = await admitFile(client, sources, board, tmp, candidate.label, {
        addedAt: Date.now(),
        modifiedAt: candidate.values.modified,
        createdAt: candidate.values.created, // file sources fill `created` (media/universal.js)
        maxBytes: limitFor(candidate.label),
      });
      if (!admitted) {
        const e = new Error("unsupported file type");
        e.skip = true; // ledger-and-forget: don't rescan it forever
        throw e;
      }
      await recordIngest(client, board.id, candidate.key, Date.now());
      return { entityId: admitted.entityId, itemId: admitted.itemId };
    });
  } catch (err) {
    if (admitted?.file) sources.cleanup([admitted.file]);
    // Content the handlers can't process (bad decode, unsupported bytes,
    // page-cap refusals) is deterministic — skip means the sweep ledgers it and
    // stops rescanning. Infra failures (db, disk, network) stay retryable.
    if (err.unprocessable) err.skip = true;
    throw err;
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}

// Validate a board's per-board source config. Keyed off the INCOMING source
// type (a board can switch sources), so this can't live in the static
// descriptor. Returns an error string, or null when valid. Every failure is a
// readable message the modal shows.
export async function validateSource(db, source = {}, { hasRoot = false } = {}) {
  if (typeof source !== "object" || Array.isArray(source)) return "ingest.source must be an object";
  const type = source.type || "folder";
  const mod = getSourceBackend(type);
  if (!mod) return `unknown ingestion source "${type}"`;
  if (db && !(await pluginInstalled(db, `source:${type}`)))
    return `the ${mod.manifest.label} source isn't installed — add it on the Plugins page`;
  if (source.recursive !== undefined && typeof source.recursive !== "boolean")
    return "ingest.source.recursive must be a boolean";

  if (type === "folder") {
    if (!hasRoot) return "ingestion root is not configured on the server (INGEST_ROOT)";
    // Blank = the ingest root itself (like a remote source's blank prefix). The
    // jail check still rejects escapes; resolveJailed("") resolves to the root.
    const folder = typeof source.folder === "string" ? source.folder : "";
    if (!resolveJailed("/jail-check", folder)) return "ingest.source.folder escapes the ingestion root";
    return null;
  }

  // Remote sources reference a saved connection + a string subpath.
  if (mod.manifest.needsConnection) {
    const conn = await getSourceConnection(db, source.connectionId);
    if (!conn) return "pick a connection for this source";
    if (conn.type !== type) return "the chosen connection is for a different source";
  }
  if (source.path !== undefined && typeof source.path !== "string") return "ingest.source.path must be a string";
  return null;
}

// The installed source backends for a file board, each with its per-board field
// schema and — for remote sources — the connections a manager can pick (labels
// only, no secrets). Drives the modal's Source section. Folder reports whether
// the server has an INGEST_ROOT (ready) at all.
export async function listSources(db) {
  const out = [];
  for (const mod of sourceModules()) {
    const m = mod.manifest;
    if (!(await pluginInstalled(db, `source:${m.name}`))) continue;
    const entry = {
      type: m.name,
      label: m.label,
      description: m.description || "",
      browsable: !!m.browsable,
      needsConnection: !!m.needsConnection,
      sourceSchema: m.sourceSchema || [],
      // Every source offers every mode (defaults not laws): a remote source CAN
      // watch continuously — the listing cache bounds the real cost — but the
      // modal defaults it to interval and hints that continuous is a ~30s poll,
      // steering without forbidding.
      triggerModes: FILE_TRIGGERS,
      ready: true,
    };
    if (m.needsConnection) {
      entry.connections = (await listSourceConnections(db, m.name)).map((c) => ({ id: c.id, label: c.label }));
    } else if (m.name === "folder") {
      entry.ready = !!process.env.INGEST_ROOT;
    }
    out.push(entry);
  }
  return out;
}

const parentPath = (p) => {
  if (!p) return null;
  const trimmed = p.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i);
};

// One directory level for the source-browse modal: folders (to descend) and
// files (context). `navPath` is where the modal currently is; the saved base
// path plays no part — you navigate the whole source and pick a folder.
// `limit` exists for the modal's health probe (limit: 1 answers "does this
// level open" without paying for a listing); the tree view omits it and gets
// the full level. Defaulted AND clamped here, the route passes the body value
// raw — one owner for the bound.
export async function browse(db, source = {}, navPath = "", { limit } = {}) {
  const lim = Math.min(1000, Math.max(1, Number(limit) || 1000));
  const type = source.type || "folder";
  const mod = getSourceBackend(type);
  if (!mod || !mod.manifest.browsable) throw new Error("this source can't be browsed");
  const be = await resolveBackend(db, { ...source, path: navPath, folder: navPath });
  const { entries, truncated } = await be.list({ path: navPath, recursive: false, includeDirs: true, limit: lim });
  const dirs = entries.filter((e) => e.type === "dir");
  const filesE = entries.filter((e) => e.type === "file");
  return {
    path: navPath,
    parent: parentPath(navPath),
    truncated,
    entries: [...dirs, ...filesE].map((e) => ({
      name: e.name, path: e.path, key: e.key, type: e.type, size: e.size, modified: e.modified,
    })),
  };
}
