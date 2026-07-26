// Backup & restore: the tar container round-trips (PAX long names included),
// a full backup captures DB + files, restore wipes and faithfully replays them
// (ids, sequences, sessions, secrets), and the guardrails hold — admin-only,
// typed confirmation, newer-version archives refused before anything is
// touched, hostile entry paths never escape staging.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { Readable, Writable } from "node:stream";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";
import { createAiKey, listAiKeys, insertItem, createEntity, createSourceConnection } from "../server/db.js";
import { TarWriter, readTar } from "../server/tarfile.js";
import { migrationIds } from "../server/migrate.js";

// --- tar container (no server needed) --------------------------------------

test("tar: entries round-trip, including PAX long names", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tar-test-"));
  const tarPath = path.join(tmp, "t.tar");
  const longName = "plugins/" + "deeply/".repeat(30) + "x".repeat(120) + ".js"; // way past ustar's 100
  const big = crypto.randomBytes(300 * 1024); // spans many blocks
  try {
    const tw = new TarWriter(fs.createWriteStream(tarPath));
    await tw.file("manifest.json", 2, Buffer.from("{}"));
    await tw.dir("gallery");
    await tw.file("gallery/a.png", big.length, big);
    await tw.file(longName, 5, Buffer.from("hello"));
    await tw.end();

    const got = {};
    for await (const entry of readTar(fs.createReadStream(tarPath))) {
      if (entry.type !== "file") continue;
      const chunks = [];
      for await (const c of entry.body) chunks.push(c);
      got[entry.name] = Buffer.concat(chunks);
    }
    assert.deepEqual(Object.keys(got).sort(), ["gallery/a.png", "manifest.json", longName].sort());
    assert.equal(got["manifest.json"].toString(), "{}");
    assert.ok(got["gallery/a.png"].equals(big));
    assert.equal(got[longName].toString(), "hello");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("tar: unconsumed bodies are drained, truncated archives throw", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tar-test-"));
  const tarPath = path.join(tmp, "t.tar");
  try {
    const tw = new TarWriter(fs.createWriteStream(tarPath));
    await tw.file("a", 10, Buffer.from("aaaaaaaaaa"));
    await tw.file("b", 3, Buffer.from("bbb"));
    await tw.end();

    // Skip a's body entirely — b must still parse cleanly.
    const names = [];
    for await (const entry of readTar(fs.createReadStream(tarPath))) names.push(entry.name);
    assert.deepEqual(names, ["a", "b"]);

    const cut = fs.readFileSync(tarPath).subarray(0, 600); // mid-body
    await assert.rejects(async () => {
      for await (const entry of readTar(Readable.from([cut]))) {
        for await (const _ of entry.body) void _;
      }
    }, /truncated/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The job mutex: one backup/restore at a time. This imports a private copy of
// backup.js (the server under test imports its own via the cache-busted
// server.js), so poking it can't disturb the live routes.
test("job mutex: a second job 409s until the first settles", async () => {
  const { startJob, job } = await import("../server/backup.js?bust=unit");
  startJob("backup");
  assert.throws(() => startJob("restore"), (err) => err.status === 409);
  job.current.done = true;
  startJob("restore");
  job.current.done = true;
});

// --- full cycle over the API -------------------------------------------------

let srv, db, base, galleryDir, thumbsDir, backupsDir, pluginsDir;
let admin, member, board;
let itemA, itemB;

before(async () => {
  srv = await startServer();
  ({ db, base, galleryDir, thumbsDir, backupsDir, pluginsDir } = srv);
  admin = await adminSession(db);
  member = await seedUser(db, "member@test.local");
  board = await seedBoard(db, "B", [member.id]);
  itemA = await seedItem(db, board);
  itemB = await seedItem(db, board);
  fs.mkdirSync(galleryDir, { recursive: true });
  fs.mkdirSync(thumbsDir, { recursive: true });
  for (const it of [itemA, itemB]) {
    fs.writeFileSync(path.join(galleryDir, it.filename), "original:" + it.filename);
    fs.writeFileSync(path.join(thumbsDir, it.filename + ".webp"), "thumb:" + it.filename);
  }
  await createAiKey(db, "prod key", "anthropic", "sk-ant-secret-roundtrip");
  // source_connections is the one BIGSERIAL (non-identity) id in the schema —
  // its sequence must be re-pointed on restore like the identity ones.
  await createSourceConnection(db, "ftp", "seed ftp", { host: "ftp.example.com", password: "s3cret" });
  // An installed external plugin, as if this archive came from a docker box:
  // the code tree rides in the archive, the install record's absolute `dir`
  // points at the ORIGIN environment and must be re-anchored on restore.
  fs.mkdirSync(path.join(pluginsDir, "vendor_widget"), { recursive: true });
  fs.writeFileSync(path.join(pluginsDir, "vendor_widget", "index.js"), "export default 1;");
  await db.query(
    `INSERT INTO external_plugins (id, kind, source_url, resolved_ref, dir, manifest, installed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    ["ai:vendor.widget", "ai-provider", "https://example.com/x.git", "abc123",
     "/data/plugins/vendor_widget", "{}", Date.now()]
  );
});

after(() => srv.close());

async function waitJob(sid, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await req(base, "GET", "/api/admin/backups/status", { sid });
    if (r.status === 200 && r.json.job?.done) return r.json.job;
    if (Date.now() > deadline) throw new Error("job did not finish in time");
    await new Promise((res) => setTimeout(res, 100));
  }
}

test("backup routes are admin-only", async () => {
  assert.equal((await req(base, "GET", "/api/admin/backups", { sid: member.sid })).status, 403);
  assert.equal((await req(base, "POST", "/api/admin/backups", { sid: member.sid, body: { kind: "db" } })).status, 403);
  assert.equal((await req(base, "GET", "/api/admin/backups", {})).status, 403);
});

let archiveName;

test("a full backup archives the DB snapshot and the file trees", async () => {
  const r = await req(base, "POST", "/api/admin/backups", { sid: admin.sid, body: { kind: "full" } });
  assert.equal(r.status, 202);
  const job = await waitJob(admin.sid);
  assert.equal(job.error, null);
  archiveName = job.result.name;
  assert.match(archiveName, /-full\.tar$/);

  // The archive self-describes: manifest first, sane versions and counts.
  let manifest = null;
  const entries = [];
  for await (const entry of readTar(fs.createReadStream(path.join(backupsDir, archiveName)))) {
    entries.push(entry.name);
    if (entry.name === "manifest.json") {
      const chunks = [];
      for await (const c of entry.body) chunks.push(c);
      manifest = JSON.parse(Buffer.concat(chunks).toString());
    }
  }
  assert.equal(manifest.app, "001az");
  assert.equal(manifest.kind, "full");
  assert.equal(manifest.migrationId, migrationIds().at(-1));
  const items = manifest.tables.find((t) => t.name === "items");
  assert.equal(items.rows, 2);
  assert.ok(entries.includes(`gallery/${itemA.filename}`));
  assert.ok(entries.includes(`thumbnails/${itemA.filename}.webp`));
  // parents land before children so the sequential load can't hit an FK
  const order = manifest.tables.map((t) => t.name);
  assert.ok(order.indexOf("boards") < order.indexOf("items"));
  assert.ok(order.indexOf("entities") < order.indexOf("items"));
  assert.ok(order.indexOf("users") < order.indexOf("sessions"));

  const list = await req(base, "GET", "/api/admin/backups", { sid: admin.sid });
  assert.ok(list.json.backups.some((b) => b.name === archiveName && b.kind === "full"));
});

// Mid-backup deletion: the worker unlinks old derived files while it runs
// (face/waveform regeneration), so a file listed by the scan can vanish before
// the archive loop reaches it. The backup must skip it — the file was
// regenerable or already lost; a failed 20 GB archive helps nobody — and the
// archive must stay well-formed.
test("a file deleted between scan and archive is skipped, not fatal", async () => {
  const { createBackup } = await import("../server/backup.js?bust=unit");
  const victim = path.join(galleryDir, "vanish.bin");
  const survivor = path.join(galleryDir, "survivor.bin");
  fs.writeFileSync(victim, "doomed bytes");
  fs.writeFileSync(survivor, "kept bytes");

  // The job object is the only mid-run hook: deleting when the thumbnails
  // scan starts lands exactly between the gallery scan and the archive loop.
  let deleted = false;
  const j = {
    phase: null,
    _detail: "",
    get detail() { return this._detail; },
    set detail(v) {
      this._detail = v;
      if (v === "scanning thumbnails" && !deleted) {
        fs.rmSync(victim, { force: true });
        deleted = true;
      }
    },
  };

  const res = await createBackup({
    db, kind: "full", backupsDir,
    dirs: { galleryDir, thumbsDir, pluginsDir },
    prefix: "vanish", j,
  });
  assert.ok(deleted, "the mid-scan deletion hook never fired — did the phase detail strings change?");

  // The archive parses end to end; the survivor is intact, the victim absent.
  const got = {};
  for await (const entry of readTar(fs.createReadStream(path.join(backupsDir, res.name)))) {
    if (entry.type !== "file") continue;
    const chunks = [];
    for await (const c of entry.body) chunks.push(c);
    got[entry.name] = Buffer.concat(chunks);
  }
  assert.equal(got["gallery/survivor.bin"].toString(), "kept bytes");
  assert.ok(!("gallery/vanish.bin" in got), "deleted file must be skipped, not archived");

  fs.rmSync(path.join(backupsDir, res.name), { force: true });
  fs.rmSync(survivor, { force: true });
});

// Disk-full during a backup must fail THE BACKUP, not the process. Both write
// paths used to leak: the dump's gzip pipeline promise rejected with nobody
// listening when ENOSPC struck while the loop awaited a FETCH (unhandled
// rejection = process death; with a listener installed it instead hung on a
// drain that never comes), and the tar writer's output stream had no 'error'
// listener (uncaught 'error' event = process death).
test("a write error mid-backup fails the backup cleanly, not the process", async () => {
  const { createBackup } = await import("../server/backup.js?bust=unit");
  const realCWS = fs.createWriteStream;
  const strays = [];
  const onStray = (err) => strays.push(err);
  process.on("unhandledRejection", onStray);
  // Streams for matching paths accept one chunk, then fail like a full disk.
  const faultyFor = (suffix) => {
    fs.createWriteStream = function (p, ...rest) {
      if (!String(p).endsWith(suffix)) return realCWS.call(fs, p, ...rest);
      let writes = 0;
      return new Writable({
        write(_chunk, _enc, cb) {
          if (++writes <= 1) return cb();
          cb(Object.assign(new Error("ENOSPC: fake disk full"), { code: "ENOSPC" }));
        },
      });
    };
  };
  try {
    // Poorly compressible bulk so gzip flushes to the spool mid-dump, while
    // the cursor loop is still FETCHing — the window where the orphaned
    // pipeline promise used to reject unobserved.
    await db.query(
      "CREATE TABLE bulk_junk AS SELECT g AS id, md5(g::text) || md5((g*7)::text) AS blob FROM generate_series(1,20000) g"
    );

    // The spool (gzip pipeline) vector. Raced so the old code's hang shows up
    // as a bounded failure instead of wedging the suite.
    faultyFor("bulk_junk.jsonl.gz");
    const outcome = await Promise.race([
      assert.rejects(createBackup({ db, kind: "db", backupsDir, prefix: "boom", j: null }), /ENOSPC/)
        .then(() => "rejected"),
      new Promise((r) => setTimeout(r, 10000, "hung").unref()),
    ]);
    assert.equal(outcome, "rejected", "dump write error must reject createBackup (hang = drain on a destroyed stream)");

    // The archive (TarWriter) vector: the header block passes, the manifest
    // body write errors.
    faultyFor(".partial");
    await assert.rejects(createBackup({ db, kind: "db", backupsDir, prefix: "boom", j: null }), /ENOSPC/);

    await new Promise((r) => setImmediate(r)); // let any stray rejection land
    assert.deepEqual(strays.map((e) => String(e?.message ?? e)), [],
      "backup write errors must never escape as unhandled rejections");
  } finally {
    fs.createWriteStream = realCWS;
    process.removeListener("unhandledRejection", onStray);
    await db.query("DROP TABLE IF EXISTS bulk_junk");
  }
});

test("restore requires the typed confirmation", async () => {
  const r = await req(base, "POST", `/api/admin/backups/${archiveName}/restore`, {
    sid: admin.sid, body: { confirm: "yes please" },
  });
  assert.equal(r.status, 400);
});

test("restore replays the archive exactly: rows, files, secrets, sequences", async () => {
  // Drift the instance in every direction the restore must undo.
  const extra = await seedItem(db, board);
  fs.writeFileSync(path.join(galleryDir, extra.filename), "original:" + extra.filename);
  fs.rmSync(path.join(galleryDir, itemB.filename)); // "lost" original
  fs.writeFileSync(path.join(galleryDir, "stray.bin"), "not in the backup");

  const r = await req(base, "POST", `/api/admin/backups/${archiveName}/restore`, {
    sid: admin.sid, body: { confirm: "RESTORE" },
  });
  assert.equal(r.status, 202);
  const job = await waitJob(admin.sid);
  assert.equal(job.error, null);

  // Rows: back to the snapshot — the extra item is gone, the originals are back.
  const { rows: [{ n: itemCount }] } = await db.query("SELECT COUNT(*)::int AS n FROM items");
  assert.equal(itemCount, 2);
  const { rows: gone } = await db.query("SELECT 1 FROM entities WHERE id=$1", [extra.id]);
  assert.equal(gone.length, 0);

  // Files: the tree is the archive's tree, nothing more, nothing less.
  assert.equal(fs.readFileSync(path.join(galleryDir, itemB.filename), "utf8"), "original:" + itemB.filename);
  assert.ok(!fs.existsSync(path.join(galleryDir, extra.filename)));
  assert.ok(!fs.existsSync(path.join(galleryDir, "stray.bin")));
  assert.equal(fs.readFileSync(path.join(thumbsDir, itemA.filename + ".webp"), "utf8"), "thumb:" + itemA.filename);

  // Secrets round-trip (the archive carries them — that's documented).
  const keys = await listAiKeys(db);
  assert.equal(keys.length, 1);
  const { rows: [key] } = await db.query("SELECT api_key FROM ai_keys");
  assert.equal(key.api_key, "sk-ant-secret-roundtrip");

  // External plugin: code tree restored, install record re-anchored from the
  // archive's /data/plugins onto this instance's plugins dir.
  assert.equal(
    fs.readFileSync(path.join(pluginsDir, "vendor_widget", "index.js"), "utf8"),
    "export default 1;"
  );
  const { rows: [ext] } = await db.query("SELECT dir FROM external_plugins WHERE id='ai:vendor.widget'");
  assert.equal(ext.dir, path.join(pluginsDir, "vendor_widget"));

  // Sessions were in the snapshot: the admin who clicked restore is still in.
  const me = await req(base, "GET", "/api/me", { sid: admin.sid });
  assert.equal(me.status, 200);
  assert.equal(me.json.email, admin.email);

  // Sequences continue past the restored ids instead of colliding.
  const { rows: [{ max }] } = await db.query("SELECT MAX(id)::int AS max FROM entities");
  const freshEntity = await createEntity(db, board, { identity: "post-restore" });
  assert.ok(freshEntity > max, `new entity id ${freshEntity} must clear restored max ${max}`);
  const freshItem = await insertItem(db, board, { identity: "post-restore", files: [], fields: {} }, "held", freshEntity);
  assert.ok(freshItem > 0);

  // Serial sequences too: source_connections.id is BIGSERIAL, not identity —
  // the rebuilt sequence starts at 1, so without a re-point the next insert
  // collides with a restored id.
  const { rows: [conn] } = await db.query("SELECT id, label, config FROM source_connections ORDER BY id LIMIT 1");
  assert.equal(conn.label, "seed ftp");
  assert.equal(conn.config.password, "s3cret");
  const { rows: [{ max: connMax }] } = await db.query("SELECT MAX(id)::int AS max FROM source_connections");
  const freshConn = await createSourceConnection(db, "ftp", "post-restore", {});
  assert.ok(freshConn > connMax, `new source connection id ${freshConn} must clear restored max ${connMax}`);
});

test("a database-only backup restores rows but leaves the file trees alone", async () => {
  const r = await req(base, "POST", "/api/admin/backups", { sid: admin.sid, body: { kind: "db" } });
  assert.equal(r.status, 202);
  let job = await waitJob(admin.sid);
  assert.equal(job.error, null);
  const dbArchive = job.result.name;
  assert.match(dbArchive, /-db\.tar$/);

  const drift = await seedItem(db, board);
  fs.writeFileSync(path.join(galleryDir, "kept-on-db-restore.bin"), "files untouched");
  const before = (await db.query("SELECT COUNT(*)::int AS n FROM items")).rows[0].n;

  const rr = await req(base, "POST", `/api/admin/backups/${dbArchive}/restore`, {
    sid: admin.sid, body: { confirm: "RESTORE" },
  });
  assert.equal(rr.status, 202);
  job = await waitJob(admin.sid);
  assert.equal(job.error, null);

  // Rows rolled back to the snapshot; the disk was not touched.
  const after = (await db.query("SELECT COUNT(*)::int AS n FROM items")).rows[0].n;
  assert.equal(after, before - 1);
  assert.equal((await db.query("SELECT 1 FROM entities WHERE id=$1", [drift.id])).rows.length, 0);
  assert.equal(fs.readFileSync(path.join(galleryDir, "kept-on-db-restore.bin"), "utf8"), "files untouched");
  assert.ok(fs.existsSync(path.join(galleryDir, itemA.filename)));
});

test("an archive from a newer app version is refused before anything is touched", async () => {
  const tarPath = path.join(backupsDir, "crafted-future.tar");
  const manifest = Buffer.from(JSON.stringify({
    app: "001az", version: "99.0.0", kind: "db", createdAt: new Date().toISOString(),
    migrationId: "9999_from_the_future", tables: [], files: { count: 0, bytes: 0 },
  }));
  const tw = new TarWriter(fs.createWriteStream(tarPath));
  await tw.file("manifest.json", manifest.length, manifest);
  await tw.end();

  const before = (await db.query("SELECT COUNT(*)::int AS n FROM items")).rows[0].n;
  const r = await req(base, "POST", "/api/admin/backups/crafted-future.tar/restore", {
    sid: admin.sid, body: { confirm: "RESTORE" },
  });
  assert.equal(r.status, 202);
  const job = await waitJob(admin.sid);
  assert.match(job.error, /newer app version/);
  const after = (await db.query("SELECT COUNT(*)::int AS n FROM items")).rows[0].n;
  assert.equal(after, before, "refused restore must leave the data untouched");
});

test("auto-backup settings validate and persist", async () => {
  const bad = await req(base, "POST", "/api/admin/backups/settings", { sid: admin.sid, body: { at: "25:99" } });
  assert.equal(bad.status, 400);
  const set = await req(base, "POST", "/api/admin/backups/settings", {
    sid: admin.sid, body: { auto: false, at: "02:15", keep: 3 },
  });
  assert.deepEqual(set.json, { auto: false, at: "02:15", keep: 3 });
  const get = await req(base, "GET", "/api/admin/backups", { sid: admin.sid });
  assert.deepEqual(get.json.settings, { auto: false, at: "02:15", keep: 3 });
});

// Upload minting: whatever the browser calls the file, the stored name must
// satisfy the same validName filter the list/restore/delete routes use — a
// minted name that fails it is an invisible orphan on disk (the upload said
// "ok", but no route can ever see it again).
test("uploaded archives get names the archive routes can actually see", async () => {
  const upload = async (filename) => {
    const fd = new FormData();
    fd.append("file", new Blob([Buffer.alloc(1024)]), filename);
    const r = await fetch(base + "/api/admin/backups/upload", {
      method: "POST",
      headers: { Cookie: `sid=${admin.sid}` },
      body: fd,
    });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const listedNames = async () =>
    (await req(base, "GET", "/api/admin/backups", { sid: admin.sid })).json.backups.map((b) => b.name);

  // Uppercase extension: minted name must come out lowercase-.tar and listed.
  const upper = await upload("My Backup.TAR");
  assert.equal(upper.status, 200);
  assert.equal(upper.json.name, "uploaded-My_Backup.tar");
  assert.ok((await listedNames()).includes(upper.json.name), "uploaded .TAR archive must appear in the list");

  // A name that sanitizes to nothing falls back instead of losing the suffix.
  const emoji = await upload("😀.tar");
  assert.equal(emoji.status, 200);
  assert.equal(emoji.json.name, "uploaded-backup.tar");
  assert.ok((await listedNames()).includes(emoji.json.name));

  // Both are reachable through the API (delete = the reachability proof).
  for (const n of [upper.json.name, emoji.json.name]) {
    assert.equal((await req(base, "DELETE", `/api/admin/backups/${n}`, { sid: admin.sid })).status, 200, `DELETE ${n}`);
  }

  // Not a tar: refused, and the multer spool file is not left behind.
  assert.equal((await upload("notes.txt")).status, 400);
  const spooled = fs.readdirSync(backupsDir).filter((n) => /^[0-9a-f]{32}$/.test(n));
  assert.deepEqual(spooled, [], "refused upload must not leave a multer temp file");
});

test("archive names that don't parse are rejected everywhere", async () => {
  for (const name of ["..%2F..%2Fetc", "no-extension", ".hidden.tar", "a%00b.tar"]) {
    const del = await req(base, "DELETE", `/api/admin/backups/${name}`, { sid: admin.sid });
    assert.equal(del.status, 400, `DELETE ${name}`);
    const dl = await req(base, "GET", `/api/admin/backups/${name}/download`, { sid: admin.sid });
    assert.equal(dl.status, 400, `download ${name}`);
  }
});

// LAST: this restore succeeds with an empty table list, wiping the test data —
// which is exactly what proves hostile paths were dropped rather than written.
test("hostile entry paths in an uploaded archive never escape staging", async () => {
  const tarPath = path.join(backupsDir, "crafted-hostile.tar");
  const manifest = Buffer.from(JSON.stringify({
    app: "001az", version: "1.0.0", kind: "full", createdAt: new Date().toISOString(),
    migrationId: migrationIds().at(-1), tables: [], files: { count: 2, bytes: 8 },
  }));
  const tw = new TarWriter(fs.createWriteStream(tarPath));
  await tw.file("manifest.json", manifest.length, manifest);
  await tw.file("gallery/../../evil.txt", 4, Buffer.from("evil"));
  await tw.file("plugins/nested/../../../evil2.txt", 4, Buffer.from("evil"));
  await tw.file("gallery/ok.png", 2, Buffer.from("ok"));
  await tw.end();

  const r = await req(base, "POST", "/api/admin/backups/crafted-hostile.tar/restore", {
    sid: admin.sid, body: { confirm: "RESTORE" },
  });
  assert.equal(r.status, 202);
  // The admin's session dies with the wipe (empty tables), so the status poll
  // flips 403 once the gate drops; poll the file system outcome instead.
  const deadline = Date.now() + 60000;
  for (;;) {
    const done = fs.existsSync(path.join(galleryDir, "ok.png"));
    if (done) break;
    if (Date.now() > deadline) throw new Error("restore did not finish");
    await new Promise((res) => setTimeout(res, 100));
  }
  // The legitimate entry landed; the traversals didn't — not in the parents of
  // the staging dir, the backups dir, or anywhere else we can name.
  for (const p of [
    path.join(backupsDir, "..", "evil.txt"),
    path.join(backupsDir, "evil.txt"),
    path.join(backupsDir, "..", "..", "evil.txt"),
    path.join(backupsDir, "..", "evil2.txt"),
    path.join(backupsDir, "..", "..", "evil2.txt"),
    path.join(galleryDir, "evil.txt"),
  ]) {
    assert.ok(!fs.existsSync(p), `traversal escaped to ${p}`);
  }
  const { rows: [{ n }] } = await db.query("SELECT COUNT(*)::int AS n FROM items");
  assert.equal(n, 0, "the empty archive's truth replaced the instance");
});
