// The storage gauge (storage-plan.md Stage 1): measureStorage reports true
// byte levels per store (walked roots, the DB, the disk pair) with absence
// spelled two ways — a missing root is a genuine 0-byte row, an unconfigured
// store is no row at all; writeSample records a level idempotently (upsert,
// never doubling); sampleStorageDue samples a day once, defers to a row
// already written by the live read, and re-arms on day rollover. The Stage 2
// read (/api/admin/storage) measures live, records today, and attributes
// originals per board with unknown sizes counted, never claimed as 0 B.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, adminSession, seedUser, seedBoard, seedItem, req } from "./helpers.js";
import { measureStorage, writeSample, sampleStorageDue } from "../server/storage.js";
import { insertItem, day } from "../server/db.js";

let srv, db, dirs;

before(async () => {
  srv = await startServer();
  db = srv.db;
  // pluginsDir deliberately points at a path nothing creates: the missing-root
  // case. npmCacheDir is omitted entirely: the unconfigured case.
  dirs = {
    galleryDir: srv.galleryDir,
    thumbsDir: srv.thumbsDir,
    backupsDir: srv.backupsDir,
    pluginsDir: path.join(srv.galleryDir, "..", "no-such-plugins"),
  };
  fs.mkdirSync(srv.galleryDir, { recursive: true });
  fs.mkdirSync(path.join(srv.thumbsDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(srv.galleryDir, "a.png"), Buffer.alloc(1000));
  fs.writeFileSync(path.join(srv.galleryDir, "b.png"), Buffer.alloc(234));
  fs.writeFileSync(path.join(srv.thumbsDir, "nested", "a.webp"), Buffer.alloc(50));
});
after(() => srv.close());

const rowsFor = async (day) =>
  (await db.query("SELECT store, bytes, files FROM storage_sample WHERE day = $1 ORDER BY store", [day])).rows;

test("measureStorage: levels per store, absence spelled both ways", async () => {
  const rows = await measureStorage(db, dirs);
  const by = Object.fromEntries(rows.map((r) => [r.store, r]));

  assert.equal(by.gallery.bytes, 1234);
  assert.equal(by.gallery.files, 2);
  assert.equal(by.thumbnails.bytes, 50); // nested files counted
  assert.equal(by.thumbnails.files, 1);
  assert.deepEqual(by.plugins, { store: "plugins", bytes: 0, files: 0 }); // missing root = true zero
  assert.ok(!("npm_cache" in by)); // unconfigured = not measured, no fake zero

  assert.ok(by.db.bytes > 0, "pg_database_size answers");
  assert.equal(by.db.files, null);
  assert.ok(by.disk_total.bytes > 0 && by.disk_free.bytes > 0);
  assert.ok(by.disk_total.bytes >= by.disk_free.bytes);
  for (const r of rows) assert.equal(typeof r.bytes, "number");
});

test("measureStorage: npm_cache appears when configured", async () => {
  const npmCacheDir = path.join(srv.backupsDir, "..", "npm-cache");
  fs.mkdirSync(npmCacheDir, { recursive: true });
  fs.writeFileSync(path.join(npmCacheDir, "pkg.tgz"), Buffer.alloc(77));
  const rows = await measureStorage(db, { ...dirs, npmCacheDir });
  const npm = rows.find((r) => r.store === "npm_cache");
  assert.deepEqual(npm, { store: "npm_cache", bytes: 77, files: 1 });
});

test("writeSample: recording a level is idempotent, re-measuring refreshes", async () => {
  await writeSample(db, "2020-01-01", [
    { store: "gallery", bytes: 10, files: 1 },
    { store: "db", bytes: 5, files: null },
  ]);
  await writeSample(db, "2020-01-01", [
    { store: "gallery", bytes: 20, files: 2 }, // the level moved; the row follows
    { store: "db", bytes: 5, files: null },
  ]);
  assert.deepEqual(await rowsFor("2020-01-01"), [
    { store: "db", bytes: 5, files: null },
    { store: "gallery", bytes: 20, files: 2 },
  ]);
});

test("sampleStorageDue: samples a day once, defers to the live read, re-arms on rollover", async () => {
  await sampleStorageDue(db, dirs, "2020-02-01");
  const first = await rowsFor("2020-02-01");
  assert.ok(first.some((r) => r.store === "gallery"), "first tick of the day samples");
  assert.ok(first.some((r) => r.store === "disk_total"));

  // Same day again: the in-memory stamp skips without touching the DB — prove
  // it by deleting the rows and seeing them stay gone.
  await db.query("DELETE FROM storage_sample WHERE day = '2020-02-01'");
  await sampleStorageDue(db, dirs, "2020-02-01");
  assert.equal((await rowsFor("2020-02-01")).length, 0);

  // Rollover re-arms; a gallery row already present (the tab's live read got
  // there first, or a pre-restart process did) means the day is covered —
  // nothing is measured on top of it.
  await writeSample(db, "2020-02-02", [{ store: "gallery", bytes: 1, files: 1 }]);
  await sampleStorageDue(db, dirs, "2020-02-02");
  assert.deepEqual(await rowsFor("2020-02-02"), [{ store: "gallery", bytes: 1, files: 1 }]);

  // And a genuinely fresh day samples again.
  await sampleStorageDue(db, dirs, "2020-02-03");
  assert.ok((await rowsFor("2020-02-03")).some((r) => r.store === "gallery"));
});

test("GET /api/admin/storage: admin-only", async () => {
  const user = await seedUser(db, "storage-user@test.local");
  const r = await req(srv.base, "GET", "/api/admin/storage", { sid: user.sid });
  assert.equal(r.status, 403);
});

test("GET /api/admin/storage: live level, today recorded, boards attributed honestly", async () => {
  const admin = await adminSession(db);
  const whale = await seedBoard(db, "Whale board");
  const legacy = await seedBoard(db, "Legacy board");
  // The reader joins items→boards only, so no entity is needed to seed one.
  const sized = (board, name, size) =>
    insertItem(db, board, { identity: name, files: [{ name, size }], fields: {} }, "tagged");
  await sized(whale, "w1.png", 100);
  await sized(whale, "w2.png", 200);
  // A connector tag vehicle holds no bytes and must contribute nothing.
  await insertItem(db, whale, { identity: "vehicle", files: [], fields: {} }, "tagged");
  // seedItem's entry has no size — the pre-file-fields norm: counted, never
  // presented as a 0-byte claim.
  await seedItem(db, legacy);

  const r = await req(srv.base, "GET", "/api/admin/storage", { sid: admin.sid });
  assert.equal(r.status, 200);
  const { now, series, boards } = r.json;

  const by = Object.fromEntries(now.map((x) => [x.store, x]));
  for (const store of ["gallery", "thumbnails", "backups", "plugins", "db", "disk_total", "disk_free"])
    assert.ok(store in by, `now carries ${store}`);
  // The vocabulary rides the response — the tab renders what it is handed and
  // knows no store ids, so every classification it reads has to be served:
  // a label for each measured store, `disk` telling the capacity pair apart
  // from what the app HOLDS, and `prunable` where deleting is safe.
  const { stores } = r.json;
  for (const store of Object.keys(by)) assert.ok(stores[store]?.label, `label served for ${store}`);
  assert.ok(stores.disk_total.disk && stores.disk_free.disk, "the capacity pair is marked");
  assert.ok(!stores.gallery.disk && !stores.db.disk, "held stores are not");
  assert.ok(stores.backups.prunable && !stores.gallery.prunable, "prunable marks the derived stores only");
  assert.ok(series.some((s) => s.day === day() && s.store === "gallery"), "today is in the series");

  const w = boards.find((b) => b.id === whale);
  assert.deepEqual(w, { id: whale, label: "Whale board", bytes: 300, files: 2, unsized: 0 });
  const l = boards.find((b) => b.id === legacy);
  assert.deepEqual(l, { id: legacy, label: "Legacy board", bytes: 0, files: 1, unsized: 1 });
  assert.ok(boards.indexOf(w) < boards.indexOf(l), "sorted by bytes, whale first");
});

test("GET /api/admin/storage: a second read refreshes today's level, never doubles it", async () => {
  const admin = await adminSession(db);
  const before = (await req(srv.base, "GET", "/api/admin/storage", { sid: admin.sid })).json;
  fs.writeFileSync(path.join(srv.galleryDir, "grew.png"), Buffer.alloc(5000));
  const after = (await req(srv.base, "GET", "/api/admin/storage", { sid: admin.sid })).json;

  const todayGallery = (resp) => resp.series.filter((s) => s.day === day() && s.store === "gallery");
  assert.equal(todayGallery(before).length, 1);
  assert.equal(todayGallery(after).length, 1); // refreshed in place, not appended
  assert.equal(todayGallery(after)[0].bytes, todayGallery(before)[0].bytes + 5000);
});

test("sampleStorageDue: a failure logs, never throws, and retries behind a floor", async () => {
  // Small explicit clocks: the floor they leave behind is far in the past for
  // every other test's Date.now() default.
  const broken = { query: () => Promise.reject(new Error("db is down")) };
  await sampleStorageDue(broken, dirs, "2020-03-01", 1000); // must not throw

  // Held off for the next minute — a root the app can't read would otherwise
  // re-walk every tick forever.
  await sampleStorageDue(db, dirs, "2020-03-01", 2000);
  assert.equal((await rowsFor("2020-03-01")).length, 0);

  // The stamp was never set, so once the floor lapses the retry still lands.
  await sampleStorageDue(db, dirs, "2020-03-01", 70000);
  assert.ok((await rowsFor("2020-03-01")).some((r) => r.store === "gallery"));
});
