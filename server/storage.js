// The storage gauge (planning/storage-plan.md, Stage 1): measure the LEVEL —
// bytes held per store, right now — and keep one row per store per day as its
// history. A sibling mechanism to the meter, never a unit in it: a level is
// idempotent to record (upsert), where the meter's writes add. It knows
// nothing of prices, boards, or the tab that will draw it.
import fs from "node:fs";
import { collectFiles } from "./backup.js";
import { day } from "./db.js";

// The stores, as pure data — the units.js / capabilities.js shape, and for
// their reason: a store spelled once per fact is a store that gets missed by
// one of them. THE WALK DERIVES FROM THIS TABLE (`dir` names the key the
// server passes in `dirs`), and the whole table is served with the route's
// response, so the tab renders the vocabulary it is handed and invents none —
// the standing rule the metering readers earned the hard way. Adding a store
// is one entry here, not one edit in the walk plus one in a client branch.
//
// `disk` marks the statfs pair: they are the CAPACITY, not something the app
// holds, and a reader summing holdings must be able to tell without knowing
// their ids. `prunable` is the operator-facing half of the feature's job 2 —
// what is safe to delete, said by the side that knows, in words the reader
// prints without interpreting (the CAPABILITY_DEFS `rebindWarning` precedent).
// An id the map doesn't know degrades to itself at the reader.
export const STORE_DEFS = {
  gallery:    { label: "originals",  dir: "galleryDir" },
  thumbnails: { label: "thumbnails", dir: "thumbsDir", prunable: "regenerated on demand" },
  backups:    { label: "backups",    dir: "backupsDir", prunable: "retention on the Backups tab" },
  plugins:    { label: "plugins",    dir: "pluginsDir" },
  npm_cache:  { label: "npm cache",  dir: "npmCacheDir", prunable: "rebuilt on the next plugin install" },
  db:         { label: "database" },
  disk_total: { label: "disk", disk: true },
  disk_free:  { label: "free", disk: true },
};

// The level, measured live. One row per store: the walked roots, the DB
// (invisible to any filesystem walk — Postgres lives in its own container),
// and the disk pair from statfs. Absence has two spellings, deliberately:
// a walked root that doesn't exist is a genuine 0-byte row (an empty tree is
// a true zero — dev machines have no /data/plugins), while an UNCONFIGURED
// store (no npmCacheDir outside the container — the npm_config_cache env is
// npm's own and points at the developer's personal cache under `npm run`)
// yields no row at all: nothing was measured, and a 0 would claim it was.
export async function measureStorage(db, dirs) {
  const roots = Object.entries(STORE_DEFS)
    .filter(([, d]) => d.dir && dirs[d.dir])
    .map(([store, d]) => [store, dirs[d.dir]]);

  // Independent I/O — the walks, the size query, and statfs run concurrently.
  const [walked, dbSize, disk] = await Promise.all([
    Promise.all(roots.map(async ([store, root]) => {
      const files = await collectFiles(root);
      return { store, bytes: files.reduce((t, f) => t + f.size, 0), files: files.length };
    })),
    // A number already: db.js sets the global int8 parser (byte counts sit
    // far below 2^53).
    db.query("SELECT pg_database_size(current_database()) AS bytes")
      .then((r) => r.rows[0].bytes),
    // The gallery's filesystem is the disk that fills (on the droplet every
    // volume rides the host root fs). bavail, not bfree: what an unprivileged
    // process can actually use, and the app runs as `node`. ENOENT (a dev
    // boot before any dir exists) falls back to the working directory.
    fs.promises.statfs(dirs.galleryDir).catch(() => fs.promises.statfs(".")),
  ]);

  return [
    ...walked,
    { store: "db", bytes: dbSize, files: null },
    { store: "disk_total", bytes: disk.bsize * disk.blocks, files: null },
    { store: "disk_free", bytes: disk.bsize * disk.bavail, files: null },
  ];
}

// Record a measurement under its day. The meter's own write shape
// (db.js `meter`, jsonb_to_recordset + ON CONFLICT) with the one difference
// that IS the difference between the mechanisms, sitting where it can be read
// off the SQL: the meter adds to what it finds, this replaces it. A level is
// idempotent to record — which is also what makes the two writers (the daily
// sweep and the tab's live read) safe to race.
export async function writeSample(db, dayKey, rows) {
  await db.query(
    `INSERT INTO storage_sample (day, store, bytes, files)
     SELECT $1, s.store, s.bytes, s.files
     FROM jsonb_to_recordset($2::jsonb) AS s(store text, bytes bigint, files bigint)
     ON CONFLICT (day, store) DO UPDATE SET bytes = EXCLUDED.bytes, files = EXCLUDED.files`,
    [dayKey, JSON.stringify(rows)]
  );
}

// The sampled history, for the trend drawing. The TABLE keeps everything — a
// level's history is exactly what can't be re-derived later — but the wire
// takes a floor, the way /api/usage's `from=` already does: the reader says
// how far back it draws, and an install running for years doesn't ship a
// decade of rows to paint a month of bars.
export async function readSeries(db, from) {
  const { rows } = await db.query(
    "SELECT day, store, bytes FROM storage_sample WHERE day >= $1 ORDER BY day, store", [from]
  );
  return rows;
}

// The daily writer, called from the worker's maintain loop every tick. Gated
// by an in-memory day stamp — the loop ticks every few seconds, and a DB read
// per tick for a once-a-day job is the ceremony autoBackup's in-memory
// throttle exists to avoid. The table is consulted exactly once per process
// per day: the first tick after boot or rollover ("is today's gallery row
// present?" — the tab's live read may have sampled today before a restart).
//
// Self-catching, and deliberately so: the maintain loop runs all its sweeps
// inside ONE try, so an uncaught throw here would silently skip whatever runs
// after it. A failure logs and retries — a missed day is a gap in a sparkline,
// not an incident, and the stamp is set only on success so the retries keep
// coming until one lands. But NOT every tick: a root the app can't read (an
// EACCES bind mount) fails identically forever, and without a floor that is
// the full walk plus a log line every POLL_MS, ~29k times a day. The floor is
// autoBackupSweep's answer to the same problem in the same loop.
const RETRY_MS = 60000;
let lastSampledDay = null;
let retryAfter = 0;
export async function sampleStorageDue(db, dirs, dayKey = day(), now = Date.now()) {
  if (lastSampledDay === dayKey || now < retryAfter) return;
  try {
    // Any row for the day proves the day was written — writeSample lands them
    // in one statement, so naming a particular store here would be a second
    // place that knows which stores exist.
    const seen = await db.query("SELECT 1 FROM storage_sample WHERE day = $1 LIMIT 1", [dayKey]);
    if (!seen.rows.length) await writeSample(db, dayKey, await measureStorage(db, dirs));
    lastSampledDay = dayKey;
  } catch (err) {
    retryAfter = now + RETRY_MS;
    console.error("storage sample error:", err.message);
  }
}
