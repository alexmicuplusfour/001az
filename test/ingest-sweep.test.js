// The worker's ingestion sweep end-to-end: due-board selection, the per-tick
// admission cap draining a larger logical run WITHOUT over-admitting past the
// run's `limit` (drain_left budget), state writes, error backoff, and the
// manual trigger disarming after its run.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startServer, seedBoard } from "./helpers.js";
import { getBoard, updateBoard, dueIngestBoards, setIngestNextRun, setIngestState } from "../server/db.js";
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

test("dueIngestBoards: enabled + armed + due only", async () => {
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
  await mk("disabled", { ...cfg, enabled: false }, T - 1000);
  await mk("unconfigured", undefined, T - 1000);

  const rows = await dueIngestBoards(db, T);
  assert.deepEqual(rows.map((r) => r.id), [due]);
  await setIngestNextRun(db, due, null);
});

test("a capped run drains across ticks and honors the logical limit exactly", async () => {
  for (let i = 1; i <= 5; i++) put(`drain/f${i}.txt`, `file ${i}`);
  const id = await seedBoard(db, "drain");
  await updateBoard(db, id, {
    ingest: {
      enabled: true,
      source: { folder: "drain", recursive: true },
      filters: [],
      sort: { by: "name", order: "asc" },
      limit: 3, // logical run cap < files available, > per-tick cap of 2
      trigger: { mode: "manual" },
    },
  });
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
  assert.match(board.ingest_state.last_error, /unreadable|not configured/);
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
