// The folder ingestion adapter: file boards feed from a watched folder under
// INGEST_ROOT. "Watching" is a periodic scan (the worker tick is the cron) —
// no fs.watch, which is unreliable through Docker bind mounts. Strictly
// one-directional and additive: source files are never modified, moved or
// deleted, and deletions don't propagate in either direction.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { admitFile } from "../ingest.js";
import { withTx, recordIngest } from "../db.js";
import { isDocName } from "../sources/doc.js";

// Name-level pre-filter only — the image handler's sharp sniff is the real
// gate (undecodable bytes come back null and the sweep ledgers the skip).
const IMAGE_EXTS = new Set(["jpg", "jpeg", "png", "webp", "avif", "heif", "heic", "gif", "svg"]);
const acceptsName = (name) => isDocName(name) || IMAGE_EXTS.has(extOf(name));
const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || "").toLowerCase();

// Mirror the upload backstop (server/ingest.js MAX_BYTES) — multer isn't in
// this path, so the scan enforces it.
const MAX_BYTES = 10 * 1024 * 1024;

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

export function descriptor() {
  return {
    source: [
      { key: "folder", type: "folder", label: "Folder" },
      { key: "recursive", type: "boolean", label: "Include subfolders", default: true },
    ],
    filters: [
      { fn: "name", kind: "text", label: "File name" },
      { fn: "extension", kind: "text", label: "Extension" },
      { fn: "path", kind: "text", label: "Relative path" },
      { fn: "file_size", kind: "number", label: "File size (bytes)" },
      { fn: "modified", kind: "date", label: "Modified" },
      { fn: "created", kind: "date", label: "Created" },
    ],
    sorts: [
      { by: "modified", label: "Modified" },
      { by: "created", label: "Created" },
      { by: "name", label: "File name" },
      { by: "file_size", label: "File size" },
    ],
    triggerModes: ["manual", "continuous", "interval", "daily"],
  };
}

// Scan the board's jailed folder into candidates. Skips dotfiles, symlinks
// (jail safety), unaccepted extensions, oversized files, and files still
// settling (mtime within INGEST_SETTLE_MS — a copy in progress waits for the
// next scan). `limit` bounds the walk for preview; enumeration order is
// directory order, sorting happens downstream in the shared engine.
export async function enumerate(_db, _board, cfg, { limit = Infinity } = {}) {
  const settleMs = Number(process.env.INGEST_SETTLE_MS) || 10000;
  const dir = resolveJailed(process.env.INGEST_ROOT, cfg.source?.folder);
  if (!dir) throw new Error("ingestion folder is not configured or escapes the ingestion root");
  const recursive = cfg.source?.recursive !== false;
  const cutoff = Date.now() - settleMs;
  const candidates = [];
  let truncated = false;

  async function walk(abs, rel) {
    let entries;
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true });
    } catch (err) {
      if (rel === "") throw new Error(`ingestion folder unreadable: ${err.message}`);
      return; // a vanished/unreadable subfolder shouldn't fail the whole scan
    }
    for (const e of entries) {
      if (candidates.length >= limit) { truncated = true; return; }
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const absChild = path.join(abs, e.name);
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (recursive) await walk(absChild, relChild);
        continue;
      }
      if (!e.isFile() || !acceptsName(e.name)) continue;
      let st;
      try {
        st = await fs.promises.stat(absChild);
      } catch {
        continue; // vanished between readdir and stat
      }
      if (st.size > MAX_BYTES || st.mtimeMs > cutoff) continue;
      candidates.push({
        key: relChild, // posix-style relpath = the ledger source_key
        label: e.name,
        values: {
          name: e.name,
          path: relChild,
          extension: extOf(e.name),
          file_size: st.size,
          // stat gives float ms; rounded so payload stamps stay integer ms
          // like every other timestamp in the app.
          modified: Math.round(st.mtimeMs),
          // birthtime is 0/epoch on filesystems without creation time —
          // degrade to null exactly like browser uploads.
          created: st.birthtimeMs > 0 ? Math.round(st.birthtimeMs) : null,
        },
      });
    }
  }

  await walk(dir, "");
  return { candidates, truncated };
}

// Admit one candidate: copy the source to tmp (never consume the original),
// then birth the entity+item and the ledger row in one transaction, through
// the same admitFile the upload route uses. The gallery/thumbnail writes
// inside admitFile precede COMMIT, so a rollback cleans them up best-effort —
// the same latent orphan window the upload route has.
export async function admit(db, board, candidate, { sources }) {
  const dir = resolveJailed(process.env.INGEST_ROOT, board.ingest?.source?.folder);
  if (!dir) throw new Error("ingestion folder is not configured");
  const src = path.join(dir, candidate.key);
  const tmp = path.join(os.tmpdir(), `ingest-${crypto.randomBytes(8).toString("hex")}`);
  await fs.promises.copyFile(src, tmp);
  let admitted = null;
  try {
    return await withTx(db, async (client) => {
      admitted = await admitFile(client, sources, board, tmp, candidate.label, {
        addedAt: Date.now(),
        modifiedAt: candidate.values.modified,
        createdAt: candidate.values.created, // folder ingestion fills `created` (media/universal.js)
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
    // page-cap refusals) is deterministic — skip means the sweep ledgers it
    // and stops rescanning. Infra failures (db, disk) stay retryable.
    if (err.unprocessable) err.skip = true;
    throw err;
  } finally {
    await fs.promises.unlink(tmp).catch(() => {});
  }
}
