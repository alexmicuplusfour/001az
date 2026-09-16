// The worker's ingestion sweep end-to-end: due-board selection, the per-tick
// admission cap draining a larger logical run WITHOUT over-admitting past the
// run's `limit` (drain_left budget), state writes, error backoff, and the
// manual trigger disarming after its run.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, seedBoard } from "./helpers.js";
import { getBoard, updateBoard, dueIngestBoards, setIngestNextRun, setIngestState, stopIngestRun, clearIngestLog, deleteInstance } from "../server/db.js";
import { startWorker } from "../server/worker.js";
import { createSources } from "../server/sources/index.js";

let srv, db, sources, root, stop;
const OLD = Date.now() - 120000;

function put(rel, content = "words") {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  fs.utimesSync(p, new Date(OLD), new Date(OLD));
}

before(async () => {
  srv = await startServer();
  db = srv.db;
  sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  root = fs.mkdtempSync(path.join(srv.galleryDir, "..", "ingest-root-"));
  process.env.INGEST_ROOT = root;
  process.env.POLL_MS = "50";
  process.env.INGEST_RUN_CAP = "2"; // force multi-tick drains
  stop = startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir, sources });
});
after(async () => {
  await stop();
  delete process.env.INGEST_ROOT;
  delete process.env.POLL_MS;
  delete process.env.INGEST_RUN_CAP;
  sources.close?.();
  await srv.close();
});

async function until(fn, ms = 8000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("condition never held");
    await new Promise((r) => setTimeout(r, 60));
  }
}

const names = async (id) => (await db.query(
  "SELECT payload->'files'->0->>'original_name' AS name FROM items WHERE board_id=$1 ORDER BY 1", [id]
)).rows.map((r) => r.name);

// Settled ingest rows for a board, newest first.
const jobRows = async (id) => (await db.query(
  "SELECT detail, outcome, started_at FROM job_log WHERE board_id=$1 AND kind='ingest' AND outcome <> 'running' ORDER BY started_at DESC, id DESC",
  [id])).rows;
// The run-state stamp and the job-log row are written separately, and runOnce
// below only waits for the stamp — the disarm it also waits for on a MANUAL
// board is what keeps those reads off a half-written row. A scheduled board
// re-arms instead, so there is no second signal, and a test that snapshots the
// log can catch it a row short; the row then lands during the next run and
// that run gets blamed for writing it. Wait for the count instead.
const jobRowsAtLeast = (id, n) => until(async () => {
  const rows = await jobRows(id);
  return rows.length >= n ? rows : null;
});

// One run: arm the timer, wait for a fresh stamp. A manual board also
// disarms itself afterwards and waiting for that avoids reading the row
// mid-write; a SCHEDULED board re-arms instead, so there the stamp is the
// whole signal (`disarms: false`).
async function runOnce(id, after = 0, { disarms = true } = {}) {
  await setIngestNextRun(db, id, Date.now() - 1);
  return until(async () => {
    const b = await getBoard(db, id);
    const stamped = (b.ingest_state?.last_run_at || 0) > after;
    return stamped && (!disarms || b.ingest_next_run_at === null) ? b : null;
  });
}

// A board's ingest config, with only what a test actually varies spelled out.
const watch = (id, folder, extra = {}) => updateBoard(db, id, {
  ingest: {
    enabled: true,
    source: { folder, recursive: true },
    filters: [],
    sort: { by: "name", order: "asc" },
    trigger: { mode: "manual" },
    ...extra,
  },
});

test("dueIngestBoards: armed + due only — the stamp decides, not `enabled`", async () => {
  // Timestamps live an hour out so the RUNNING worker's own dueIngestBoards
  // (which queries Date.now()) never claims these rows mid-test.
  const T = Date.now() + 3600_000;
  const mk = async (name, ingest, nextRun) => {
    const id = await seedBoard(db, name);
    await updateBoard(db, id, { ingest });
    if (nextRun !== undefined) await setIngestNextRun(db, id, nextRun);
    return id;
  };
  const cfg = { enabled: true, source: { folder: "none" }, trigger: { mode: "manual" } };
  const due = await mk("due", cfg, T - 1000);
  await mk("future", cfg, T + 60000);
  await mk("disarmed", cfg); // next_run_at null
  await mk("unconfigured", undefined, T - 1000);
  // A paused board is normally disarmed (the save path nulls the stamp), so it
  // reaches the sweep only when "Run now" armed it — and then it SHOULD run.
  // The pause lives in the re-arm after the run, not in a gate before it.
  const pausedRunNow = await mk("paused-run-now", { ...cfg, enabled: false }, T - 1000);

  const rows = await dueIngestBoards(db, T);
  assert.deepEqual(rows.map((r) => r.id).sort(), [due, pausedRunNow].sort());
  await setIngestNextRun(db, due, null);
  await setIngestNextRun(db, pausedRunNow, null);
});

test("a paused schedule that was hand-fired runs once, then disarms itself", async () => {
  put("paused/a.txt", "one");
  const id = await seedBoard(db, "paused-sched");
  await watch(id, "paused", { enabled: false, trigger: { mode: "continuous" } }); // held
  // What "Run now" does: arm the stamp for the next tick.
  await setIngestNextRun(db, id, Date.now() - 1);

  // The sweep writes ingest_state and ingest_next_run_at as TWO statements
  // (same race the backoff test below guards): waiting on the state alone can
  // read the board in between and still see the hand-fired arm stamp. Wait
  // for the disarm too; the assertions then judge settled values.
  const board = await until(async () => {
    const b = await getBoard(db, id);
    return b.ingest_state && b.ingest_next_run_at == null ? b : null;
  });
  assert.equal(board.ingest_state.last_error, null);
  assert.equal(board.ingest_state.last_added, 1, "the hand-fired run admitted the file");
  assert.equal(board.ingest_next_run_at, null,
    "one run, not a resumed watch — an unpaused continuous board would have re-armed at +30s");
});

test("a capped run drains across ticks and honors the logical limit exactly", async () => {
  for (let i = 1; i <= 5; i++) put(`drain/f${i}.txt`, `file ${i}`);
  const id = await seedBoard(db, "drain");
  await watch(id, "drain", { limit: 3 }); // run cap < files available, > per-tick cap of 2
  await setIngestNextRun(db, id, Date.now() - 1);

  // Manual trigger: after the run fully drains, the timer disarms.
  const board = await until(async () => {
    const b = await getBoard(db, id);
    return b.ingest_next_run_at === null && b.ingest_state ? b : null;
  });

  const { rows } = await db.query(
    "SELECT payload->'files'->0->>'original_name' AS name FROM items WHERE board_id=$1 ORDER BY 1",
    [id]
  );
  assert.deepEqual(rows.map((r) => r.name), ["f1.txt", "f2.txt", "f3.txt"],
    "exactly `limit` admitted, name-ascending — drain ticks resumed the budget, not a fresh limit");
  assert.equal(board.ingest_state.last_error, null);
  assert.equal(board.ingest_state.drain_left ?? 0, 0, "drain bookkeeping cleared on completion");
});

// job-control-plan.md Stage 5. The sweep is the one producer in the app, and
// its writes are now value-fenced like every landing in db.js: the stamp a
// tick claimed the board under is the run's identity, checked between
// admissions AND at settle. Without the settle half, the tick already in
// flight writes drain_left straight back over the stop — and since a tick
// walks a catalog and then admits its whole batch, "mid-tick" is the normal
// state during a drain, not a narrow window.
test("a stop mid-drain ends the run: the tick in flight can't restore the budget", async () => {
  for (let i = 1; i <= 12; i++) put(`stopdrain/f${i}.txt`, `file ${i}`);
  const id = await seedBoard(db, "stopdrain");
  await watch(id, "stopdrain", { limit: 12 }); // per-tick cap is 2 → six ticks
  await setIngestNextRun(db, id, Date.now() - 1);
  await until(async () => ((await getBoard(db, id)).ingest_state?.drain_left || 0) > 0);

  const stop = await stopIngestRun(db, id, null); // manual board → no next run
  assert.equal(stop.stopped, true);
  assert.ok(stop.dropped > 0, "the dropped remainder is reported back to the caller");

  // Several drain periods later the run is still over: nothing re-armed it,
  // nothing rewrote the budget, and no further files were admitted.
  await new Promise((r) => setTimeout(r, 500));
  const b = await getBoard(db, id);
  assert.equal(b.ingest_state.drain_left ?? 0, 0, "the budget stayed dropped");
  assert.equal(b.ingest_next_run_at, null, "…and the run could not re-arm itself");
  const landed = (await names(id)).length;
  assert.ok(landed < 12, `the run stopped short (${landed} of 12)`);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal((await names(id)).length, landed, "no admissions after the stop");
});

test("a cleared memory heals from item provenance instead of duplicating", async () => {
  put("wipe/a.txt", "one");
  const id = await seedBoard(db, "wipe");
  await watch(id, "wipe");
  let b = await runOnce(id);
  assert.equal(b.ingest_state.last_added, 1);
  assert.deepEqual(await names(id), ["a.txt"]);

  // Re-run without clearing: the ledger holds the file back.
  b = await runOnce(id, b.ingest_state.last_run_at);
  assert.equal(b.ingest_state.last_added, 0);
  assert.deepEqual(await names(id), ["a.txt"]);

  // Clear, run again: stage 1 pinned "the whole folder re-imports as
  // duplicates" here; stage 2 replaced it — the admit probe recognizes the
  // LIVE item by its payload provenance, throws the connector-shaped
  // `.duplicate`, and the sweep re-ledgers the key, link included. The board
  // does not grow; the ledger rebuilds itself. (Items born BEFORE provenance
  // existed are invisible to the probe and still duplicate — why files.js
  // keeps forgetAllIsSafe false for now.)
  await clearIngestLog(db, id);
  b = await runOnce(id, b.ingest_state.last_run_at);
  assert.equal(b.ingest_state.last_added, 0);
  assert.deepEqual(await names(id), ["a.txt"], "no duplicate birth — the heal");
  const { rows } = await db.query(
    "SELECT reason, item_id FROM ingest_log WHERE board_id=$1", [id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "admitted");
  assert.ok(rows[0].item_id != null, "rebuilt WITH the link the wipe destroyed");
});

test("an unreadable source lands in ingest_state with a spaced retry, not a wedged loop", async () => {
  const id = await seedBoard(db, "broken");
  await updateBoard(db, id, {
    ingest: { enabled: true, source: { folder: "does-not-exist" }, trigger: { mode: "continuous" } },
  });
  const armedAt = Date.now();
  await setIngestNextRun(db, id, armedAt - 1);

  // The sweep writes ingest_state and ingest_next_run_at as TWO statements, so
  // waiting on the first alone can read the board in between and see the
  // pre-run arm time — the re-arm assertion below then fails for a reason that
  // has nothing to do with backoff. Wait for both writes; under an 8-way
  // parallel run the gap between them is wide enough to land in.
  const board = await until(async () => {
    const b = await getBoard(db, id);
    return b.ingest_state?.last_error && Number(b.ingest_next_run_at) > armedAt ? b : null;
  });
  assert.match(board.ingest_state.last_error, /doesn't exist under the ingest root/);
  assert.ok(board.ingest_next_run_at > armedAt + 4 * 60000, "5-minute backoff, not the continuous cadence");
  await setIngestNextRun(db, id, null);
});

test("an error tick preserves a mid-drain budget — the retry can't over-admit the run", async () => {
  const id = await seedBoard(db, "drain-err");
  await updateBoard(db, id, {
    ingest: { enabled: true, source: { folder: "vanished" }, limit: 5, trigger: { mode: "manual" } },
  });
  // Simulate an interrupted drain: 3 of the run's 5 still owed, then the
  // source folder breaks before the next drain tick.
  await setIngestState(db, id, { last_run_at: Date.now(), last_added: 2, last_error: null, drain_left: 3 });
  await setIngestNextRun(db, id, Date.now() - 1);

  const board = await until(async () => {
    const b = await getBoard(db, id);
    return b.ingest_state?.last_error ? b : null;
  });
  assert.equal(board.ingest_state.drain_left, 3, "budget survives the failure — a fresh `limit` would over-admit");
  await setIngestNextRun(db, id, null);
});

test("continuous trigger reschedules itself on the continuous cadence", async () => {
  put("cont/a.txt");
  const id = await seedBoard(db, "cont");
  await updateBoard(db, id, {
    ingest: { enabled: true, source: { folder: "cont" }, trigger: { mode: "continuous" } },
  });
  const t0 = Date.now();
  await setIngestNextRun(db, id, t0 - 1);

  // Both of the sweep's writes, not just the first — see the backoff test
  // above: last_run_at lands one statement before the re-arm, and reading in
  // between sees the t0-1 arm this test set itself.
  const board = await until(async () => {
    const b = await getBoard(db, id);
    return b.ingest_state?.last_run_at && Number(b.ingest_next_run_at) > t0 ? b : null;
  });
  assert.equal(board.ingest_state.last_added, 1);
  assert.ok(board.ingest_next_run_at >= t0 + 5000, "rearmed in the future");
  assert.ok(board.ingest_next_run_at <= Date.now() + 35000, "on the continuous cadence, not a backoff");
  await setIngestNextRun(db, id, null);
});

// ── "Keep top N": total is MEMBERSHIP (first N of the sorted set), not pacing ──

test("the spool case: a reused path holding DIFFERENT bytes is imported, not skipped", async () => {
  // The workflow this stage exists for: the watch folder is a drop zone, not
  // a library. Drop, ingest, clear the folder — the board item stays and
  // nobody deleted anything — then drop a different file under the same name.
  // Judged by path alone that second file is invisible forever, with no
  // error, no badge and no run row to say so.
  put("spool/drop.txt", "first payload");
  const id = await seedBoard(db, "spool");
  await watch(id, "spool");
  let board = await runOnce(id);
  assert.equal(board.ingest_state.last_added, 1);

  // Still sitting there, untouched: recognized by path+size+mtime, no read.
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0);

  // Folder cleared, different bytes dropped under the same name.
  fs.rmSync(path.join(root, "spool/drop.txt"));
  put("spool/drop.txt", "a completely different payload");
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 1, "the slot was reused — these are new bytes");
  const { rows } = await db.query(
    "SELECT payload->'provenance'->>'hash' AS hash FROM items WHERE board_id=$1", [id]);
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].hash, rows[1].hash, "two items, two distinct contents");
});

test("a touched file is recognized by content and stops drifting", async () => {
  put("touch/f.txt", "stable bytes");
  const id = await seedBoard(db, "touched");
  await watch(id, "touch");
  let board = await runOnce(id);
  assert.equal(board.ingest_state.last_added, 1);

  // Same bytes, new mtime — drift says "re-read me", content says "already
  // here". The re-ledger must record the NEW mtime, or this repeats forever.
  // Still older than the settle window (10s), or the listing would skip the
  // file outright and there would be no drift to notice.
  const later = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(root, "touch/f.txt"), later, later);
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0);
  assert.equal((await names(id)).length, 1, "recognized by content — no second item");
  const { rows: [led] } = await db.query(
    "SELECT modified_at, reason FROM ingest_log WHERE board_id=$1", [id]);
  assert.equal(led.reason, "admitted");
  assert.equal(Number(led.modified_at), later.getTime(), "the slot's facts were re-stamped");

  // Proof it settled: the next tick finds no drift, so nothing is re-read
  // and the run reports no duplicate either.
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0);
  assert.equal((await jobRows(id))[0].detail.duplicates ?? 0, 0,
    "a settled slot is skipped by the cheap check — the file is never re-read");
});

test("renames: a live file is recognized, a deleted one stays deleted", async () => {
  put("ren/keep.txt", "the keeper");
  put("ren/gone.txt", "the rejected one");
  const id = await seedBoard(db, "renames");
  await watch(id, "ren");
  let board = await runOnce(id);
  assert.equal(board.ingest_state.last_added, 2);

  // Delete one from the board; the other stays.
  const { rows: [gone] } = await db.query(
    "SELECT id FROM items WHERE board_id=$1 AND payload->'provenance'->>'key'='gone.txt'", [id]);
  await deleteInstance(db, gone.id);

  // Rename both on disk. The live one must NOT duplicate; the deleted one
  // must NOT come back.
  fs.renameSync(path.join(root, "ren/keep.txt"), path.join(root, "ren/keep-2024.txt"));
  fs.renameSync(path.join(root, "ren/gone.txt"), path.join(root, "ren/gone-2024.txt"));
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0, "both were recognized by content");
  assert.equal((await names(id)).length, 1, "one item still — the rename did not clone it");

  const { rows: led } = await db.query(
    "SELECT source_key, reason, item_id FROM ingest_log WHERE board_id=$1 ORDER BY source_key", [id]);
  const by = Object.fromEntries(led.map((r) => [r.source_key, r]));
  assert.equal(by["keep-2024.txt"].reason, "admitted");
  assert.equal(Number(by["keep-2024.txt"].item_id), Number(by["keep.txt"].item_id),
    "the new name points at the SAME item — so deleting it stamps both keys");
  assert.equal(by["gone-2024.txt"].reason, "deleted", "content you deleted, under a new name");

  // A held-back rename is an EVENT: it ledgers a key permanently, so the run
  // row is its only trace and must survive.
  const latest = (await jobRows(id))[0];
  assert.equal(latest.detail.held, 1);
  assert.deepEqual(latest.detail.held_labels, ["gone-2024.txt"]);

  // And deleting the live item now stamps BOTH of its keys.
  const { rows: [keep] } = await db.query(
    "SELECT id FROM items WHERE board_id=$1", [id]);
  await deleteInstance(db, keep.id);
  const { rows: after } = await db.query(
    "SELECT reason FROM ingest_log WHERE board_id=$1 AND source_key IN ('keep.txt','keep-2024.txt')", [id]);
  assert.deepEqual(after.map((r) => r.reason), ["deleted", "deleted"]);
});

test("keep top: first `total` in sort order; ingested rows occupy slots; newcomers join, fallen rows stay", async () => {
  for (let i = 1; i <= 5; i++) put(`top/m${i}.txt`, `file ${i}`);
  const id = await seedBoard(db, "keep-top");
  await watch(id, "top", { total: 3 });
  let board = await runOnce(id);
  assert.deepEqual(await names(id), ["m1.txt", "m2.txt", "m3.txt"],
    "exactly the first `total` of the sorted set — m4/m5 are outside the membership, not queued behind it");
  assert.equal(board.ingest_state.drain_left ?? 0, 0);

  // Run again: the membership is full and every member ledgered — admits 0.
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0, "a full membership admits nothing — ingested rows count toward the cap");

  // A newcomer that sorts INTO the top 3 is admitted; m3 — now outside the
  // top 3 — stays on the board (the ledger never evicts), and doesn't
  // consume a slot.
  put("top/a0.txt", "newcomer");
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 1);
  assert.deepEqual(await names(id), ["a0.txt", "m1.txt", "m2.txt", "m3.txt"]);
});

test("keep top: a deleted member's slot backfills; the deleted key never resurrects", async () => {
  for (let i = 1; i <= 5; i++) put(`backfill/b${i}.txt`, `file ${i}`);
  const id = await seedBoard(db, "backfill");
  await watch(id, "backfill", { total: 3 });
  let board = await runOnce(id);
  assert.deepEqual(await names(id), ["b1.txt", "b2.txt", "b3.txt"]);

  // Delete b2: deleteInstance stamps its ledger row `deleted` (stage 2), and
  // stage 3's slot rule frees its seat — the board keeps itself at N
  // ELIGIBLE members, so rank 4 fills the gap while the deleted key itself
  // stays held back.
  const { rows: [b2] } = await db.query(
    "SELECT id FROM items WHERE board_id=$1 AND payload->'files'->0->>'original_name'='b2.txt'", [id]);
  await deleteInstance(db, b2.id);
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 1);
  assert.deepEqual(await names(id), ["b1.txt", "b3.txt", "b4.txt"],
    "rank 4 backfilled the freed slot; b2 was not resurrected");

  // A full-again membership admits nothing more.
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0);
  assert.deepEqual(await names(id), ["b1.txt", "b3.txt", "b4.txt"]);
});

test("keep top: an unprocessable file's slot backfills too", async () => {
  put("skipfill/a1.png", "not a png at all"); // sorts first, cannot decode
  for (const n of ["a2.txt", "a3.txt", "a4.txt"]) put(`skipfill/${n}`, `file ${n}`);
  const id = await seedBoard(db, "skipfill");
  await watch(id, "skipfill", { total: 2 });
  // Run 1: membership = [a1.png, a2.txt]; a1 skips (ledgered `skipped`),
  // a2 admits. Run 2: the skipped key holds no slot — a corrupt file is no
  // more an eligible member than a rejected one — so a3 backfills.
  let board = await runOnce(id);
  assert.deepEqual(await names(id), ["a2.txt"]);
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 1);
  assert.deepEqual(await names(id), ["a2.txt", "a3.txt"]);
});

test("`ignored` rides the run row but never makes a flat tick eventful", async () => {
  put("ign/x1.txt", "one");
  put("ign/x2.txt", "two");
  const id = await seedBoard(db, "ignored");
  // SCHEDULED, not manual: retracting a flat tick is a schedule-only rule (a
  // hand-fired run always keeps its row — somebody asked). A month-long
  // interval means the cadence can't re-fire mid-test.
  await watch(id, "ign", { trigger: { mode: "interval", every: 43200 } });
  let board = await runOnce(id, 0, { disarms: false });
  assert.equal(board.ingest_state.last_added, 2);

  // Delete one: its row is stamped `deleted`, so the next scan matches it and
  // holds it back — that is the run row's `ignored`.
  const { rows: [x1] } = await db.query(
    "SELECT id FROM items WHERE board_id=$1 AND payload->'files'->0->>'original_name'='x1.txt'", [id]);
  await deleteInstance(db, x1.id);

  // A run that admits nothing, errs on nothing and only has a standing
  // `ignored` to report is a FLAT TICK: its row is retracted, not stamped.
  // Otherwise a continuous watch writes "1 ignored" every 30s forever — the
  // volume lesson the retract-and-fold logic exists for.
  const before = await jobRowsAtLeast(id, 1);
  board = await runOnce(id, board.ingest_state.last_run_at, { disarms: false });
  assert.equal(board.ingest_state.last_added, 0);

  // On a run that DID something, the figure rides along — and that row
  // landing is also what proves the flat tick above is FINISHED. Asserting
  // the retraction the moment the flat run stamps would pass just as happily
  // against a row still in flight, which is the trap this test sat in.
  put("ign/x3.txt", "three");
  board = await runOnce(id, board.ingest_state.last_run_at, { disarms: false });
  assert.equal(board.ingest_state.last_added, 1);
  const rows = await jobRowsAtLeast(id, 2);
  assert.equal(rows.length, 2, "three runs, two rows — the flat tick retracted its own");
  assert.deepEqual(rows[1], before[0], "and it left the earlier run's row alone");
  const latest = rows[0];
  assert.equal(latest.detail.admitted, 1);
  assert.equal(latest.detail.ignored, 1, "one match is held back by a deletion");
});

test("keep top + per-run limit: the budget drains inside the membership, never past it", async () => {
  for (let i = 1; i <= 5; i++) put(`topdrain/f${i}.txt`, `file ${i}`);
  const id = await seedBoard(db, "keep-top-drain");
  // limit: per-run budget < membership, > the per-tick cap of 2 → forces a drain
  await watch(id, "topdrain", { total: 4, limit: 3 });
  let board = await runOnce(id);
  assert.deepEqual(await names(id), ["f1.txt", "f2.txt", "f3.txt"],
    "run 1: the per-run budget, drained across ticks, all inside the membership");
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 1, "run 2: the membership's remainder");
  assert.deepEqual(await names(id), ["f1.txt", "f2.txt", "f3.txt", "f4.txt"]);
  board = await runOnce(id, board.ingest_state.last_run_at);
  assert.equal(board.ingest_state.last_added, 0, "f5 is outside the membership, ever");
});
