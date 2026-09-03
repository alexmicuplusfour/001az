// Backup & restore core. An archive is a plain .tar:
//
//   manifest.json            app/version/kind, schema migration id, table list
//   db/<table>.jsonl.gz      one gzipped JSONL per table, rows as arrays of
//                            ::text-cast values (null preserved) — round-trips
//                            every type (jsonb, bytea, timestamptz) without a
//                            pg_dump binary in the image
//   gallery/…  thumbnails/…  plugins/…   (full backups only)
//
// Dump: one REPEATABLE READ transaction, so the DB half is a single MVCC
// snapshot even while the worker runs; files are copied after. Drift is
// bounded, never fatal: a file created after the snapshot rides along as an
// orphan; one deleted after it is skipped (the live instance had already lost
// it — restore just inherits that); a torn read can't happen (bounded by the
// scanned size, read through a held fd).
//
// Restore is wipe-and-replace: drop the schema, rebuild it at the archive's
// migration id, load the data, swap the file trees, then run the remaining
// migrations forward — so an archive from an older app restores into a newer
// one, and an archive from a NEWER app is refused up front, before anything
// is touched.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { TarWriter, readTar } from "./tarfile.js";
import { runMigrations, migrationIds } from "./migrate.js";
import { initDb, seedAdmin, getSetting, setSetting } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_NAME = "001az";
export const APP_VERSION = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8")
).version;

const NAME_RE = /^[a-z_][a-z0-9_]*$/; // table/column identifiers
const TYPE_RE = /^[a-zA-Z0-9_ ()\[\],."]+$/; // format_type() output

// ---------------------------------------------------------------------------
// One job at a time (manual or scheduled, backup or restore) — the admin UI
// polls this. Module-level so worker and routes share the same mutex.
export const job = { current: null };

export function startJob(kind) {
  if (job.current && !job.current.done) {
    const err = new Error(`a ${job.current.kind} is already running`);
    err.status = 409;
    throw err;
  }
  job.current = { kind, phase: "starting", detail: "", startedAt: Date.now(), done: false, error: null, result: null };
  return job.current;
}

export function publicJob() {
  return job.current ? { ...job.current } : null;
}

const phase = (j, p, detail = "") => { if (j) { j.phase = p; j.detail = detail; } };

// ---------------------------------------------------------------------------
// Schema introspection

async function tableColumns(client) {
  // `identity` drives OVERRIDING SYSTEM VALUE on load; `sequence` marks any
  // OWNED sequence — identity or plain serial (source_connections is BIGSERIAL)
  // — because restore must re-point them all past the loaded ids.
  const { rows } = await client.query(`
    SELECT c.relname AS table, a.attname AS name,
           format_type(a.atttypid, a.atttypmod) AS type,
           a.attidentity <> '' AS identity,
           pg_get_serial_sequence(quote_ident(n.nspname) || '.' || quote_ident(c.relname), a.attname)
             IS NOT NULL AS has_sequence
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
      AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY c.relname, a.attnum`);
  const tables = new Map();
  for (const r of rows) {
    if (!tables.has(r.table)) tables.set(r.table, []);
    tables.get(r.table).push({ name: r.name, type: r.type, identity: r.identity, sequence: r.has_sequence });
  }
  tables.delete("schema_migrations"); // the manifest's migrationId carries this
  return tables;
}

// Parents-first order so a sequential load never hits an FK before its target.
async function loadOrder(client, names) {
  const { rows } = await client.query(`
    SELECT conrelid::regclass::text AS child, confrelid::regclass::text AS parent
    FROM pg_constraint
    WHERE contype = 'f' AND connamespace = 'public'::regnamespace`);
  const deps = new Map(names.map((n) => [n, new Set()]));
  for (const { child, parent } of rows) {
    if (child !== parent && deps.has(child) && deps.has(parent)) deps.get(child).add(parent);
  }
  const out = [];
  const placed = new Set();
  while (out.length < names.length) {
    const ready = names.filter((n) => !placed.has(n) && [...deps.get(n)].every((p) => placed.has(p)));
    if (!ready.length) {
      // FK cycle (none exist today) — fall back to name order and let the
      // transaction surface any real violation.
      const rest = names.filter((n) => !placed.has(n));
      console.warn(`backup: FK cycle among ${rest.join(", ")} — falling back to name order`);
      out.push(...rest);
      break;
    }
    for (const n of ready) { out.push(n); placed.add(n); }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Backup

const stamp = (d = new Date()) => {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

async function dumpTable(client, table, cols, outPath, j) {
  const sel = cols.map((c) => `"${c.name}"::text`).join(", ");
  await client.query(`DECLARE bk_cur NO SCROLL CURSOR FOR SELECT ${sel} FROM "${table}"`);
  let rows = 0;
  try {
    // One pipeline from cursor to gzipped spool: backpressure, teardown, and
    // error propagation all live in pipeline(). A destination error (disk
    // full) aborts the generator and rejects the single awaited promise —
    // never an orphan promise whose rejection can kill the process, never a
    // write against a destroyed stream. The abort lands at a yield, so the
    // in-flight FETCH always settles before the finally below reuses the
    // client (pg forbids overlapped queries on one connection).
    async function* gen() {
      for (;;) {
        const res = await client.query({ text: "FETCH 1000 FROM bk_cur", rowMode: "array" });
        if (!res.rows.length) return;
        for (const r of res.rows) {
          rows++;
          yield JSON.stringify(r) + "\n";
        }
        phase(j, "snapshot", `${table} (${rows} rows)`);
      }
    }
    await pipeline(gen, zlib.createGzip(), fs.createWriteStream(outPath));
    return rows;
  } finally {
    await client.query("CLOSE bk_cur").catch(() => {});
  }
}

// Regular files under root, relative paths posix-style. Missing root = empty
// (dev machines have no /data/plugins; an empty tree is a valid answer).
// Exported for the storage gauge (storage.js) — same walk, summed not tarred.
export async function collectFiles(root) {
  const out = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(abs, r);
      else if (e.isFile()) {
        let st;
        try {
          st = await fs.promises.stat(abs);
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          continue; // deleted between readdir and stat — as if the walk came later
        }
        out.push({ rel: r, abs, size: st.size, mtime: st.mtimeMs });
      }
      // symlinks and specials are skipped — nothing in server-owned state uses them
    }
  }
  await walk(root, "");
  return out;
}

// A file can change under us mid-archive (the worker writing a thumbnail).
// The tar header already promised `size`, so emit exactly that: truncate
// growth, zero-pad shrinkage — a padded thumbnail is regenerable, a failed
// 20 GB backup is not. Reads go through the caller's held handle, not the
// path, so a concurrent delete can't ENOENT us mid-entry.
function boundedStream(fh, abs, size) {
  async function* gen() {
    let sent = 0;
    for await (const chunk of fh.createReadStream({ autoClose: false })) {
      if (sent >= size) break;
      const take = chunk.subarray(0, Math.min(chunk.length, size - sent));
      sent += take.length;
      yield take;
    }
    if (sent < size) {
      console.warn(`backup: "${abs}" shrank mid-archive — padded ${size - sent} bytes`);
      yield Buffer.alloc(size - sent);
    }
  }
  return Readable.from(gen());
}

// kind: "full" (db + gallery + thumbnails + plugins) or "db" (db only).
// Returns { name, size }. Progress lands on `j` (a startJob() object).
export async function createBackup({ db, kind, backupsDir, dirs = null, prefix = APP_NAME, j = null }) {
  if (kind !== "full" && kind !== "db") throw new Error(`unknown backup kind "${kind}"`);
  await fs.promises.mkdir(backupsDir, { recursive: true });
  const spool = path.join(backupsDir, ".spool-" + crypto.randomBytes(6).toString("hex"));
  await fs.promises.mkdir(spool, { recursive: true });
  const name = `${prefix}-${stamp()}-${kind}.tar`;
  const partial = path.join(backupsDir, name + ".partial");

  try {
    // --- DB snapshot ---
    phase(j, "snapshot");
    const client = await db.connect();
    let tables, order, counts = {}, migrationId;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      ({ rows: [{ migration_id: migrationId }] } = await client.query(
        "SELECT MAX(id) AS migration_id FROM schema_migrations"
      ));
      tables = await tableColumns(client);
      order = await loadOrder(client, [...tables.keys()].sort());
      for (const t of order) {
        counts[t] = await dumpTable(client, t, tables.get(t), path.join(spool, t + ".jsonl.gz"), j);
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // --- file inventory (after the snapshot: drift = orphan files at worst) ---
    const roots = kind === "full"
      ? [["gallery", dirs.galleryDir], ["thumbnails", dirs.thumbsDir], ["plugins", dirs.pluginsDir]]
      : [];
    const fileSets = [];
    let fileCount = 0, fileBytes = 0;
    for (const [label, root] of roots) {
      phase(j, "files", `scanning ${label}`);
      const files = await collectFiles(root);
      fileSets.push([label, files]);
      fileCount += files.length;
      fileBytes += files.reduce((s, f) => s + f.size, 0);
    }

    const manifest = {
      app: APP_NAME,
      version: APP_VERSION,
      kind,
      createdAt: new Date().toISOString(),
      migrationId,
      tables: order.map((t) => ({ name: t, rows: counts[t], columns: tables.get(t) })),
      files: { count: fileCount, bytes: fileBytes },
    };

    // --- archive ---
    phase(j, "archive");
    const tw = new TarWriter(fs.createWriteStream(partial));
    const mbuf = Buffer.from(JSON.stringify(manifest, null, 2));
    await tw.file("manifest.json", mbuf.length, mbuf);
    for (const t of order) {
      const p = path.join(spool, t + ".jsonl.gz");
      const st = await fs.promises.stat(p);
      await tw.file(`db/${t}.jsonl.gz`, st.size, fs.createReadStream(p));
    }
    let archived = 0;
    for (const [label, files] of fileSets) {
      for (const f of files) {
        // Open BEFORE the header is written: a file deleted since the scan
        // (the worker unlinks old derived files when regenerating) skips
        // cleanly here — once a header has promised the entry, padding is the
        // only way out.
        let fh;
        try {
          fh = await fs.promises.open(f.abs, "r");
        } catch (err) {
          if (err.code !== "ENOENT") throw err;
          console.warn(`backup: "${f.abs}" vanished before archiving — skipped`);
          continue;
        }
        try {
          await tw.file(`${label}/${f.rel}`, f.size, boundedStream(fh, f.abs, f.size), { mtime: f.mtime });
        } finally {
          await fh.close().catch(() => {});
        }
        if (++archived % 200 === 0) phase(j, "archive", `${archived}/${fileCount} files`);
      }
    }
    await tw.end();

    await fs.promises.rename(partial, path.join(backupsDir, name));
    const { size } = await fs.promises.stat(path.join(backupsDir, name));
    return { name, size };
  } finally {
    await fs.promises.rm(spool, { recursive: true, force: true }).catch(() => {});
    await fs.promises.rm(partial, { force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Restore

const collect = async (stream, cap) => {
  const chunks = [];
  let total = 0;
  for await (const c of stream) {
    total += c.length;
    if (total > cap) throw new Error("archive member too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
};

// Entry paths come from an uploaded archive — treat as hostile. Flat roots
// (gallery/thumbnails/db) take a single segment; plugins nests.
function safeSegments(rel, { flat }) {
  const segs = rel.split("/");
  if (flat && segs.length !== 1) return null;
  for (const s of segs) {
    if (!s || s === "." || s === ".." || s.includes("\\") || s.includes("\0")) return null;
  }
  return segs;
}

function validateManifest(manifest) {
  if (!manifest) throw new Error("archive has no manifest.json — not a backup archive");
  if (manifest.app !== APP_NAME) throw new Error(`archive is not a ${APP_NAME} backup (app: ${manifest.app ?? "unknown"})`);
  if (manifest.kind !== "full" && manifest.kind !== "db") throw new Error(`unknown archive kind "${manifest.kind}"`);
  if (typeof manifest.migrationId !== "string") throw new Error("archive manifest is missing its schema version");
  if (!migrationIds().includes(manifest.migrationId)) {
    throw new Error(`archive schema "${manifest.migrationId}" is unknown — it was made by a newer app version; upgrade first, then restore`);
  }
  if (!Array.isArray(manifest.tables)) throw new Error("archive manifest has no table list");
  const seenTables = new Set();
  for (const t of manifest.tables) {
    if (!NAME_RE.test(t.name) || !Number.isInteger(t.rows) || t.rows < 0 || !Array.isArray(t.columns)) {
      throw new Error(`archive manifest is malformed (table "${t.name}")`);
    }
    // A duplicate table would load the same dump twice (a unique violation
    // deep inside the load transaction, AFTER the wipe); a duplicate column
    // would mis-shape the INSERT. Both are one-line refusals here.
    if (seenTables.has(t.name)) throw new Error(`archive manifest lists table "${t.name}" twice`);
    seenTables.add(t.name);
    if (t.name === "schema_migrations") {
      throw new Error("archive manifest may not carry schema_migrations — the migration ledger is rebuilt, not restored");
    }
    const seenCols = new Set();
    for (const c of t.columns) {
      if (!NAME_RE.test(c.name) || typeof c.type !== "string" || !TYPE_RE.test(c.type)) {
        throw new Error(`archive manifest is malformed (column "${t.name}.${c.name}")`);
      }
      if (seenCols.has(c.name)) throw new Error(`archive manifest lists column "${t.name}.${c.name}" twice`);
      seenCols.add(c.name);
    }
  }
}

// One gunzipped JSONL line at a time, length-bounded. readline would happily
// assemble a multi-GB "line" from a corrupt member as one giant string before
// anyone could refuse it — gzip expands ~1000:1, so a few MB of archive can be
// an OOM. The bound applies both to a line completed inside the buffer and to
// a partial line still accumulating across chunks.
function gzLines(spoolPath, maxLine = Number(process.env.BACKUP_MAX_LINE_BYTES) || 64 * 1024 * 1024) {
  return (async function* () {
    const src = fs.createReadStream(spoolPath);
    const gz = src.pipe(zlib.createGunzip());
    try {
      const dec = new StringDecoder("utf8");
      let buf = "";
      for await (const chunk of gz) {
        buf += dec.write(chunk);
        let start = 0;
        for (let i; (i = buf.indexOf("\n", start)) >= 0; start = i + 1) {
          if (i - start > maxLine) throw new Error(`a dump line exceeds ${maxLine} bytes`);
          yield buf.slice(start, i);
        }
        if (start) buf = buf.slice(start);
        if (buf.length > maxLine) throw new Error(`a dump line exceeds ${maxLine} bytes`);
      }
      buf += dec.end();
      if (buf) yield buf;
    } finally {
      // An early exit (verify's bail, a thrown bound) must not strand the fd —
      // the staging dir gets removed right after, open handles and all.
      src.destroy();
      gz.destroy();
    }
  })();
}

// A dump row must be exactly what dumpTable emits: an array of ::text values,
// one per column, each a string or SQL NULL. Anything else — a width mismatch,
// or nested values a hand-edited archive could smuggle into node-pg's
// parameter serialization — refuses here.
function checkRow(line, table, columns) {
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    throw new Error(`archive data for "${table}" is not valid JSONL`);
  }
  if (!Array.isArray(row) || row.length !== columns.length) {
    throw new Error(`archive data for "${table}" does not match its manifest`);
  }
  for (const v of row) {
    if (v !== null && typeof v !== "string") {
      throw new Error(`archive data for "${table}" holds a non-text value`);
    }
  }
  return row;
}

// Full pre-flight read of one dump member — gunzip, parse, count — so gzip
// bit-rot or tampering refuses while the instance is still intact. The one
// place a bad member must never surface first is after DROP SCHEMA; an extra
// pass over the compressed dumps is the price (BACKUP-REVIEW #5).
async function verifyDump(spoolPath, { name, rows, columns }, j) {
  let n = 0;
  for await (const line of gzLines(spoolPath)) {
    if (!line) continue;
    checkRow(line, name, columns);
    if (++n > rows) break; // already a lie — no need to read the rest
    if (n % 5000 === 0) phase(j, "verify", `${name} (${n}/${rows} rows)`);
  }
  if (n > rows) throw new Error(`"${name}": dump holds more rows than the manifest's ${rows}`);
  if (n < rows) throw new Error(`"${name}": dump holds ${n} rows, manifest says ${rows}`);
}

// `columns` is the manifest's column list re-typed from the REBUILT schema
// (resolveColumns) — the archive names the columns, the live catalog is the
// authority on their types, so a manifest can't smuggle arbitrary text into
// the cast expressions and any name drift fails loudly before data moves.
async function loadTable(client, { name, rows, columns }, spoolPath, j) {
  const colList = columns.map((c) => `"${c.name}"`).join(", ");
  const overriding = columns.some((c) => c.identity) ? "OVERRIDING SYSTEM VALUE " : "";
  const batchRows = Math.max(1, Math.floor(30000 / columns.length));

  let batch = [];
  let batchChars = 0;
  let loaded = 0;
  const flush = async () => {
    if (!batch.length) return;
    const placeholders = batch
      .map((_, r) => `(${columns.map((c, i) => `$${r * columns.length + i + 1}::${c.type}`).join(",")})`)
      .join(",");
    await client.query(
      `INSERT INTO "${name}" (${colList}) ${overriding}VALUES ${placeholders}`,
      batch.flat()
    );
    loaded += batch.length;
    batch = [];
    batchChars = 0;
    phase(j, "load", `${name} (${loaded}/${rows} rows)`);
  };

  for await (const line of gzLines(spoolPath)) {
    if (!line) continue;
    batch.push(checkRow(line, name, columns));
    // verifyDump already refused an honest surplus; this bounds a member that
    // changed after verification to one extra batch instead of a full load.
    if (loaded + batch.length > rows) throw new Error(`"${name}": dump holds more rows than the manifest's ${rows}`);
    batchChars += line.length;
    if (batch.length >= batchRows || batchChars > 4 * 1024 * 1024) await flush();
  }
  await flush();
  if (loaded !== rows) throw new Error(`"${name}": loaded ${loaded} rows, manifest says ${rows}`);
}

// Replace liveDir with stagingDir (same volume: two renames; EXDEV: copy).
async function swapDir(stagingDir, liveDir) {
  const old = liveDir + ".old-" + crypto.randomBytes(4).toString("hex");
  await fs.promises.mkdir(path.dirname(liveDir), { recursive: true });
  let hadOld = true;
  try {
    await fs.promises.rename(liveDir, old);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    hadOld = false;
  }
  try {
    await fs.promises.rename(stagingDir, liveDir);
  } catch (err) {
    if (err.code === "EXDEV") {
      await fs.promises.cp(stagingDir, liveDir, { recursive: true });
    } else {
      if (hadOld) await fs.promises.rename(old, liveDir).catch(() => {});
      throw err;
    }
  }
  if (hadOld) fs.promises.rm(old, { recursive: true, force: true }).catch(() => {});
}

// Wipe-and-replace restore. Everything that can be checked is checked BEFORE
// the database is touched — extraction, manifest shape, and a full gunzip +
// parse + count pass over every db member — then a db-only safety dump of the
// current state lands in the backups dir. Only then does the wipe start; a
// failure past that point migrates the (empty) schema forward to the present
// so the instance comes back consistent, with the safety dump one restore
// away and the error in the caller's job state. File trees swap only after
// the DB load committed. Sessions are never restored — a backup's cookies
// must not come back to life.
export async function restoreBackup({ db, archivePath, dirs, adminEmail = "", j = null }) {
  const staging = path.join(path.dirname(archivePath), ".restore-" + crypto.randomBytes(6).toString("hex"));
  const sub = (s) => path.join(staging, s);
  for (const s of ["db", "gallery", "thumbnails", "plugins"]) {
    await fs.promises.mkdir(sub(s), { recursive: true });
  }
  const warnings = [];

  try {
    // --- extract + validate, touching nothing live ---
    phase(j, "extract");
    let manifest = null;
    let extracted = 0;
    for await (const entry of readTar(fs.createReadStream(archivePath))) {
      const name = entry.name.replace(/^(\.\/)+/, "");
      if (entry.type === "dir") continue;
      if (entry.type === "skip") {
        warnings.push(`skipped non-file entry "${name}"`);
        continue;
      }
      if (name === "manifest.json") {
        manifest = JSON.parse((await collect(entry.body, 32 * 1024 * 1024)).toString("utf8"));
        continue;
      }
      const dbm = name.match(/^db\/([a-z_][a-z0-9_]*)\.jsonl\.gz$/);
      const filem = dbm ? null : name.match(/^(gallery|thumbnails|plugins)\/(.+)$/);
      let dest = null;
      if (dbm) {
        dest = path.join(sub("db"), dbm[1] + ".jsonl.gz");
      } else if (filem) {
        const segs = safeSegments(filem[2], { flat: filem[1] !== "plugins" });
        if (segs) dest = path.join(sub(filem[1]), ...segs);
      }
      if (!dest || !dest.startsWith(staging + path.sep)) {
        warnings.push(`ignored unexpected entry "${name}"`);
        continue; // generator drains the body
      }
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await pipeline(entry.body, fs.createWriteStream(dest));
      if (++extracted % 200 === 0) phase(j, "extract", `${extracted} entries`);
    }
    validateManifest(manifest);
    for (const t of manifest.tables) {
      if (t.rows > 0 && !fs.existsSync(path.join(sub("db"), t.name + ".jsonl.gz"))) {
        throw new Error(`archive is missing data for table "${t.name}"`);
      }
    }

    // --- verify every db member end to end, still BEFORE the wipe ---
    // Gunzip + parse + count each dump now: gzip bit-rot or a tampered member
    // refuses cleanly here, while the instance is intact, instead of surfacing
    // for the first time after DROP SCHEMA (BACKUP-REVIEW #5).
    phase(j, "verify");
    for (const t of manifest.tables) {
      if (t.rows === 0) continue;
      await verifyDump(path.join(sub("db"), t.name + ".jsonl.gz"), t, j);
    }

    // --- safety net: dump what the wipe is about to take (BACKUP-REVIEW #5) ---
    // If the restore still fails past the drop, the pre-restore state is one
    // restore away instead of gone. Best-effort: an instance being restored
    // BECAUSE its data is broken must not become un-restorable over a failed
    // dump — a refused safety backup is a warning, not a wall.
    const backupsDir = path.dirname(archivePath);
    phase(j, "safety");
    let safety = null;
    try {
      ({ name: safety } = await createBackup({ db, kind: "db", backupsDir, prefix: "prerestore", j }));
    } catch (err) {
      warnings.push(`pre-restore safety backup failed: ${err.message}`);
      console.warn(`restore: pre-restore safety backup failed: ${err.message}`);
    }

    let dropped = false;
    try {
    // --- rebuild the schema at the archive's version ---
    phase(j, "schema", manifest.migrationId);
    const client = await db.connect();
    try {
      // One transaction under a lock timeout: the gate stops new requests,
      // not in-flight ones, and a straggler's open transaction would park
      // DROP SCHEMA forever with the whole instance 503ing behind the gate.
      // Timing out rolls back — a clean refusal, nothing touched — and
      // SET LOCAL dies with the transaction, so the pooled client returns
      // unpoisoned.
      const lockMs = Math.max(1, Number(process.env.BACKUP_LOCK_TIMEOUT_MS) || 15000);
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL lock_timeout = '${lockMs}ms'`);
        await client.query("DROP SCHEMA public CASCADE");
        await client.query("CREATE SCHEMA public");
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err.code === "55P03" // lock_not_available
          ? new Error("another connection is holding a table lock — try again in a moment")
          : err;
      }
    } finally {
      client.release();
    }
    dropped = true;
    await runMigrations(db, { upTo: manifest.migrationId });

    // --- load, one transaction: fail = empty-but-consistent, never half ---
    phase(j, "load");
    const loader = await db.connect();
    try {
      // Re-type every manifest column from the schema just rebuilt: the
      // catalog is the authority on casts (nothing attacker-shaped reaches
      // the SQL), and a column the schema doesn't know refuses loudly here
      // instead of half-way into the load.
      const live = await tableColumns(loader);
      // The reverse of the existence checks below: a manifest that OMITS a
      // table the rebuilt schema has would restore it silently empty — data
      // loss dressed as success (BACKUP-REVIEW #20).
      const listed = new Set(manifest.tables.map((t) => t.name));
      const missing = [...live.keys()].filter((n) => !listed.has(n));
      if (missing.length) {
        throw new Error(`archive manifest omits table(s) ${missing.join(", ")} — refusing a partial restore`);
      }
      const tables = manifest.tables.map((t) => {
        const liveCols = new Map((live.get(t.name) || []).map((c) => [c.name, c]));
        if (!liveCols.size) throw new Error(`archive table "${t.name}" does not exist at schema ${manifest.migrationId}`);
        return {
          ...t,
          columns: t.columns.map((c) => {
            const lc = liveCols.get(c.name);
            if (!lc) throw new Error(`archive column "${t.name}.${c.name}" does not exist at schema ${manifest.migrationId}`);
            return lc;
          }),
        };
      });
      await loader.query("BEGIN");
      for (const t of tables) {
        if (t.rows === 0) continue;
        // Sessions are point-in-time bearer grants, not data: loading them
        // would re-arm every cookie minted before the backup — including ones
        // revoked since (stolen-device logout-all, then a restore from before
        // = the thief is back in). The restore dialog has always promised
        // "everyone is signed out"; leaving the table empty keeps it.
        if (t.name === "sessions") continue;
        await loadTable(loader, t, path.join(sub("db"), t.name + ".jsonl.gz"), j);
      }
      // Every owned sequence, not just identity columns — the rebuilt schema's
      // sequences all start at 1, and a missed one (source_connections.id is
      // plain BIGSERIAL) hands out already-taken ids on the next insert.
      for (const t of tables) {
        for (const c of t.columns) {
          if (!c.sequence) continue;
          await loader.query(
            `SELECT setval(pg_get_serial_sequence('${t.name}','${c.name}'),
                    GREATEST((SELECT COALESCE(MAX("${c.name}"),0) FROM "${t.name}"), 1))`
          );
        }
      }
      await loader.query("COMMIT");
    } catch (err) {
      await loader.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      loader.release();
    }

    // --- file trees (full archives own the truth, empty trees included) ---
    if (manifest.kind === "full") {
      phase(j, "files");
      await swapDir(sub("gallery"), dirs.galleryDir);
      await swapDir(sub("thumbnails"), dirs.thumbsDir);
      await swapDir(sub("plugins"), dirs.pluginsDir);
    }

    // --- forward to the present ---
    phase(j, "finish");
    await initDb(db); // remaining migrations + live-schedule reconcile
    if (adminEmail) await seedAdmin(db, adminEmail);
    // External-plugin install records carry absolute paths from the archive's
    // environment (boot reloads each row's `dir`). Re-anchor them under THIS
    // instance's plugins dir — its basename is the stable part — so restoring
    // a prod archive onto a scratch box loads its plugins instead of erroring
    // on a foreign path. Same-instance restores no-op here.
    const { rows: exts } = await db.query("SELECT id, dir FROM external_plugins");
    for (const e of exts) {
      const base = String(e.dir || "").split(/[\\/]/).filter(Boolean).at(-1);
      if (!base) continue;
      const dir = path.join(dirs.pluginsDir, base);
      if (dir !== e.dir) await db.query("UPDATE external_plugins SET dir=$1 WHERE id=$2", [dir, e.id]);
    }
    } catch (err) {
      // Past the drop the old data is gone; what must not ALSO happen is an
      // old-schema DB serving under new code — every request 500s until a
      // human reboots (BACKUP-REVIEW #5). Migrate forward to the present so
      // the instance comes back empty but consistent, admin login reseeded,
      // with the error in the job state and the safety dump on disk.
      if (dropped) {
        try {
          await db.query("CREATE SCHEMA IF NOT EXISTS public"); // belt-and-braces; the drop txn is atomic
          await initDb(db);
          if (adminEmail) await seedAdmin(db, adminEmail);
          if (safety) err.message += ` — the instance was reset empty; restore ${safety} to return to the pre-restore state`;
        } catch (healErr) {
          err.message += ` (migrating forward failed too: ${healErr.message} — restart the app to recover)`;
        }
      }
      throw err;
    }

    // Keep the last few safety dumps, pruned only after the restore they
    // insured succeeded. Manual and auto archives have their own lifecycles.
    for (const n of (await fs.promises.readdir(backupsDir))
      .filter((n) => /^prerestore-.*-db\.tar$/.test(n))
      .sort()
      .reverse()
      .slice(2)) {
      await fs.promises.unlink(path.join(backupsDir, n)).catch(() => {});
    }

    return { warnings, safety, manifest: { kind: manifest.kind, createdAt: manifest.createdAt, migrationId: manifest.migrationId } };
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Scheduled safety net: a daily DB-only archive into the backups dir, on by
// default — anyone who backs up the appdata volume then gets a usable dump
// for free. Full backups stay manual: duplicating the gallery onto the same
// disk every night would double the volume for no extra safety.

// Debris from interrupted runs: dump spools, restore staging, partial
// archives, abandoned multer temps (32-hex, extensionless). Shared with the
// boot sweep in backup-routes.js.
export const isDebrisName = (n) =>
  /^\.(spool|restore)-/.test(n) || n.endsWith(".partial") || /^[0-9a-f]{32}$/.test(n);

export async function sweepDebris(backupsDir, minAgeMs = 0) {
  let names;
  try {
    names = await fs.promises.readdir(backupsDir);
  } catch {
    return;
  }
  for (const n of names) {
    if (!isDebrisName(n)) continue;
    const p = path.join(backupsDir, n);
    try {
      if (minAgeMs && Date.now() - (await fs.promises.stat(p)).mtimeMs < minAgeMs) continue;
      await fs.promises.rm(p, { recursive: true, force: true });
      console.log(`backups: cleaned up leftover ${n}`);
    } catch { /* raced its owner or already gone */ }
  }
}

let lastSweepCheck = 0;
let lastDebrisSweep = 0;
export async function autoBackupSweep({ db, backupsDir }) {
  // The maintenance loop ticks every few seconds; a due-check per minute is plenty.
  if (Date.now() - lastSweepCheck < 60000) return;
  lastSweepCheck = Date.now();
  if (job.current && !job.current.done) return;
  // Boot sweeps debris synchronously; a long-lived process re-sweeps daily for
  // what accumulates between reboots — aborted uploads' multer temps, mostly.
  // The age floor keeps anything plausibly still in flight.
  if (Date.now() - lastDebrisSweep > 24 * 3600 * 1000) {
    lastDebrisSweep = Date.now();
    await sweepDebris(backupsDir, 24 * 3600 * 1000);
  }
  if (((await getSetting(db, "backup_auto")) ?? "1") !== "1") return;
  const at = (await getSetting(db, "backup_auto_at")) || "03:30";
  const keep = Math.max(1, Number(await getSetting(db, "backup_auto_keep")) || 7);
  const [h, m] = at.split(":").map(Number);
  const now = new Date();
  const sched = new Date(now);
  sched.setHours(h, m, 0, 0);
  if (sched.getTime() > now.getTime()) sched.setDate(sched.getDate() - 1);
  const last = Number(await getSetting(db, "backup_auto_last")) || 0;
  if (last >= sched.getTime()) return;

  // Claim the slot up front: a failing backup logs loudly and tries again
  // tomorrow, instead of hammering every worker pass.
  await setSetting(db, "backup_auto_last", String(Date.now()));
  const j = startJob("backup");
  try {
    const res = await createBackup({ db, kind: "db", backupsDir, prefix: "auto", j });
    j.done = true;
    j.result = res;
    console.log(`auto-backup: wrote ${res.name} (${(res.size / 1048576).toFixed(1)} MB, keeping ${keep})`);
    const files = (await fs.promises.readdir(backupsDir))
      .filter((f) => /^auto-.*-db\.tar$/.test(f))
      .sort()
      .reverse();
    for (const f of files.slice(keep)) {
      await fs.promises.unlink(path.join(backupsDir, f)).catch(() => {});
    }
  } catch (err) {
    j.done = true;
    j.error = err.message;
    console.error(`auto-backup failed: ${err.message}`);
  }
}
