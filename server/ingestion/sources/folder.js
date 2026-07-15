// The local-folder ingestion source: files under the server's INGEST_ROOT.
// "Watching" is a periodic scan (the worker tick is the cron) — no fs.watch,
// which is unreliable through Docker bind mounts. Strictly one-directional and
// additive: source files are never modified, moved or deleted, and deletions
// don't propagate in either direction.
//
// This is the built-in `source:folder` plugin (core). It's a source BACKEND —
// list / fetch / test — that the shared file adapter (../files.js) drives; the
// adapter owns the filter catalog, candidate mapping and the admit path, so a
// new source (ftp, s3, …) is just another backend beside this one, not a new
// adapter. (Distinct from server/sources/ — those are MEDIA handlers that read
// file bytes; these are INGESTION sources that fetch the bytes to begin with.)
import fs from "node:fs";
import path from "node:path";

// Resolve a board-configured subpath inside the root jail; null when it
// escapes (.., absolutes, or prefix collisions like /root vs /rootX).
export function resolveJailed(root, sub) {
  if (!root) return null;
  const base = path.resolve(root);
  const p = path.resolve(base, sub || "");
  const rel = path.relative(base, p);
  if (rel === "") return p;
  return !rel.startsWith("..") && !path.isAbsolute(rel) ? p : null;
}

export const manifest = {
  name: "folder",
  label: "Local folder",
  description: "Ingest files from a folder under the server's ingest root",
  core: true, // a capability the app has, not a connection you add — always installed
  browsable: true,
  needsConnection: false, // uses INGEST_ROOT, not a saved credential
  connectionSchema: [],
  // Per-board fields. Folder keeps its historical `folder` key so existing
  // saved configs — and the folder tests — are untouched.
  sourceSchema: [
    { key: "folder", type: "folder", label: "Folder" },
    { key: "recursive", type: "boolean", label: "Include subfolders", default: true },
  ],
};

const MAX_BYTES_DEFAULT = 10 * 1024 * 1024;

// Build a backend bound to one board's source config (its base folder). The
// adapter calls resolveBackend → backend({ source }) per run/request.
export function backend({ source } = {}) {
  const base = source?.folder ?? source?.path ?? "";

  return {
    // One directory level (includeDirs, non-recursive) for the browse modal, or
    // a bounded recursive walk for enumerate. `accept(name)` + `maxBytes` are the
    // adapter's shared file-acceptance policy, applied here so `limit` counts
    // only the files a run would actually take — identical to the pre-split
    // behaviour. The settle window (a half-copied local file waits a scan) is
    // folder-specific and stays here.
    async list({ path: sub = base, recursive = false, limit = Infinity, accept = null, maxBytes = MAX_BYTES_DEFAULT, includeDirs = false } = {}) {
      const settleMs = Number(process.env.INGEST_SETTLE_MS) || 10000;
      const dir = resolveJailed(process.env.INGEST_ROOT, sub);
      if (!dir) throw new Error("ingestion folder is not configured or escapes the ingestion root");
      const cutoff = Date.now() - settleMs;
      const entries = [];
      let truncated = false;

      async function walk(abs, rel) {
        let dirents;
        try {
          dirents = await fs.promises.readdir(abs, { withFileTypes: true });
        } catch (err) {
          if (rel === "") throw new Error(`ingestion folder unreadable: ${err.message}`);
          return; // a vanished/unreadable subfolder shouldn't fail the whole scan
        }
        for (const e of dirents) {
          if (entries.length >= limit) { truncated = true; return; }
          if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
          const absChild = path.join(abs, e.name);
          const relChild = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) {
            if (includeDirs) entries.push({ key: relChild, name: e.name, path: relChild, type: "dir", size: 0, modified: null, created: null });
            if (recursive) await walk(absChild, relChild);
            continue;
          }
          if (!e.isFile()) continue;
          if (accept && !accept(e.name)) continue;
          let st;
          try {
            st = await fs.promises.stat(absChild);
          } catch {
            continue; // vanished between readdir and stat
          }
          if (st.size > maxBytes || st.mtimeMs > cutoff) continue;
          entries.push({
            key: relChild, // posix-style relpath = the ledger source_key
            name: e.name,
            path: relChild,
            type: "file",
            // stat gives float ms; rounded so payload stamps stay integer ms.
            size: st.size,
            modified: Math.round(st.mtimeMs),
            // birthtime is 0/epoch on filesystems without creation time —
            // degrade to null exactly like browser uploads.
            created: st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : null,
          });
        }
      }

      await walk(dir, "");
      return { entries, truncated };
    },

    // Copy the source file to tmp (never consume the original). key is relative
    // to the board's configured folder. Re-jail the joined path too — key is
    // trusted today (it comes from the jailed walk), but this keeps fetch safe
    // if a caller ever hands it a client-influenced key.
    async fetch(key, tmpPath) {
      const dir = resolveJailed(process.env.INGEST_ROOT, base);
      if (!dir) throw new Error("ingestion folder is not configured");
      const src = resolveJailed(dir, key);
      if (!src) throw new Error("source path escapes the ingestion root");
      await fs.promises.copyFile(src, tmpPath);
    },

    async test() {
      if (!process.env.INGEST_ROOT) throw new Error("no ingestion root configured (INGEST_ROOT)");
      return { ok: true };
    },
  };
}
