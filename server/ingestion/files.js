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
import { withTx, recordIngest, getSourceConnection, listSourceConnections } from "../db.js";
// MEDIA-side helpers: which extensions a handler accepts, and the ext of a name.
import { acceptsName, extOf } from "../sources/index.js";
import { getSourceBackend, SOURCE_MODULES } from "./sources/index.js";
import { resolveJailed } from "./sources/folder.js";
import { pluginInstalled } from "../plugins.js";

// Mirror the upload backstop (server/ingest.js MAX_BYTES): remote fetches don't
// pass through multer, so the scan enforces it.
const MAX_BYTES = 10 * 1024 * 1024;

// The file filter catalog + sorts, shared by every file source. `values` a
// backend fills (name/path/extension/file_size/modified/created) feed these.
const FILE_FILTERS = [
  { fn: "name", kind: "text", label: "File name" },
  { fn: "extension", kind: "text", label: "Extension" },
  { fn: "path", kind: "text", label: "Relative path" },
  { fn: "file_size", kind: "number", label: "File size (bytes)" },
  { fn: "modified", kind: "date", label: "Modified" },
  { fn: "created", kind: "date", label: "Created" },
];
const FILE_SORTS = [
  { by: "modified", label: "Modified" },
  { by: "created", label: "Created" },
  { by: "name", label: "File name" },
  { by: "file_size", label: "File size" },
];
const FILE_TRIGGERS = ["manual", "continuous", "interval", "daily"];

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
  return mod.backend({ source, conn: conn.config });
}

// Per-board source config → the directory/prefix a backend should read.
const sourcePath = (source = {}) => source.folder ?? source.path ?? "";

// The descriptor the routes serve and the modal renders. The `source` schema is
// the folder backend's for now (every file board is folder-typed until remote
// sources land); the filter/sort/trigger catalog is shared across all sources.
export function descriptor() {
  return {
    source: getSourceBackend("folder").manifest.sourceSchema,
    filters: FILE_FILTERS,
    sorts: FILE_SORTS,
    triggerModes: FILE_TRIGGERS,
  };
}

// List the source's files into candidates the shared engine filters/sorts on.
// `accept`/`maxBytes` are applied inside the backend walk so `limit` counts only
// admissible files (identical to the pre-split folder behaviour).
export async function enumerate(db, board, cfg, { limit = Infinity } = {}) {
  const be = await resolveBackend(db, cfg.source);
  const { entries, truncated } = await be.list({
    path: sourcePath(cfg.source),
    recursive: cfg.source?.recursive !== false,
    limit,
    accept: acceptsName,
    maxBytes: MAX_BYTES,
  });
  const candidates = entries
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
  return { candidates, truncated };
}

// Admit one candidate: fetch the source file to tmp (never consume the
// original), then birth the entity+item and the ledger row in one transaction,
// through the same admitFile the upload route uses. The gallery/thumbnail writes
// inside admitFile precede COMMIT, so a rollback cleans them up best-effort —
// the same latent orphan window the upload route has.
export async function admit(db, board, candidate, { sources } = {}) {
  const be = await resolveBackend(db, board.ingest?.source);
  const tmp = path.join(os.tmpdir(), `ingest-${crypto.randomBytes(8).toString("hex")}`);
  await be.fetch(candidate.key, tmp);
  let admitted = null;
  try {
    return await withTx(db, async (client) => {
      admitted = await admitFile(client, sources, board, tmp, candidate.label, {
        addedAt: Date.now(),
        modifiedAt: candidate.values.modified,
        createdAt: candidate.values.created, // file sources fill `created` (media/universal.js)
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
  for (const mod of SOURCE_MODULES) {
    const m = mod.manifest;
    if (!(await pluginInstalled(db, `source:${m.name}`))) continue;
    const entry = {
      type: m.name,
      label: m.label,
      description: m.description || "",
      browsable: !!m.browsable,
      needsConnection: !!m.needsConnection,
      sourceSchema: m.sourceSchema || [],
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
export async function browse(db, source = {}, navPath = "") {
  const type = source.type || "folder";
  const mod = getSourceBackend(type);
  if (!mod || !mod.manifest.browsable) throw new Error("this source can't be browsed");
  const be = await resolveBackend(db, { ...source, path: navPath, folder: navPath });
  const { entries, truncated } = await be.list({ path: navPath, recursive: false, includeDirs: true, limit: 1000 });
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
