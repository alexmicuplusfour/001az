// Stage 1 of the job log (planning/job-log-plan.md): the ledger itself and
// the two families that were invisible without it — transcription and ingest
// runs. Ledger helpers first (pure db), then the worker write points with a
// stubbed transcriber sidecar / a real folder source, and the cardinal rule
// pinned last: ledger writes can never break the job they observe.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { startServer, seedBoard, seedUser, adminSession, req } from "./helpers.js";
import {
  addJobLog,
  stampJobLog,
  listJobLog,
  listRunningJobs,
  latestSettledJob,
  markInterruptedJobs,
  pruneJobLog,
  createEntity,
  insertItem,
  updateBoard,
  setIngestNextRun,
  createAiKey,
  createBoard,
  setPluginState,
  addFieldSnapshot,
  itemsNeedingEmbedding,
  setSetting,
} from "../server/db.js";
import { startWorker, embedBatch } from "../server/worker.js";
import { createSources } from "../server/sources/index.js";

let srv, db, sources, root;
const OLD = Date.now() - 120000; // past the ingest settle window

before(async () => {
  srv = await startServer();
  db = srv.db;
  sources = createSources({ galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir });
  root = fs.mkdtempSync(path.join(srv.galleryDir, "..", "ingest-root-"));
  process.env.INGEST_ROOT = root;
  process.env.POLL_MS = "50";
});
after(async () => {
  delete process.env.INGEST_ROOT;
  delete process.env.POLL_MS;
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

const runWorker = (opts = {}) =>
  startWorker({ db, galleryDir: srv.galleryDir, thumbsDir: srv.thumbsDir, ...opts });

const jobsFor = async (boardId) =>
  (await db.query("SELECT * FROM job_log WHERE board_id=$1 ORDER BY id", [boardId])).rows;

const itemPayload = async (id) =>
  (await db.query("SELECT payload FROM items WHERE id=$1", [id])).rows[0]?.payload;

// One audio entity+instance, file on disk so the transcribe loop can read it.
async function seedAudio(boardId, name) {
  fs.mkdirSync(srv.galleryDir, { recursive: true });
  fs.writeFileSync(path.join(srv.galleryDir, name), "RIFF-not-really-audio");
  const eid = await createEntity(db, boardId, { identity: name });
  const iid = await insertItem(
    db,
    boardId,
    { identity: name, files: [{ name, original_name: name, kind: "audio" }] },
    "held",
    eid
  );
  return { eid, iid };
}

// The transcriber sidecar is one fetch away; stub it per test.
function stubFetch(handler) {
  const real = global.fetch;
  global.fetch = handler;
  return () => {
    global.fetch = real;
  };
}
// The sidecar speaks the async job protocol: POST /transcribe → 202 {job},
// then GET /jobs/<id> polls until settled. sidecarOk settles on the first poll;
// pass `turns` to include the structured half (omitted = a pre-turns image).
const sidecarOk = (text, turns) => async (url, opts = {}) =>
  opts.method === "POST"
    ? new Response(JSON.stringify({ job: "stub", status: "queued" }), { status: 202 })
    : new Response(JSON.stringify({ status: "done", progress: { done_s: 1, total_s: 1 }, text, model: "small",
        ...(turns ? { turns } : {}) }), { status: 200 });
const sidecarStatus = (status) => async () => new Response("nope", { status });
const sidecarDown = () => async () => {
  throw new TypeError("fetch failed");
};

// --- ledger helpers (pure db) ---

test("add → stamp roundtrip: detail merges, error caps at 500, running vs settled listing", async () => {
  const board = await seedBoard(db, "jobs-helpers");
  const eid = await createEntity(db, board, { identity: "clip.mp3" });

  const id = await addJobLog(db, {
    boardId: board, entityId: eid, itemId: 7, target: "clip.mp3",
    kind: "transcribe", detail: { trigger: "manual" },
  });
  let running = await listRunningJobs(db, board);
  assert.equal(running.length, 1);
  assert.equal(running[0].outcome, "running");
  assert.equal(running[0].entity_identity, "clip.mp3"); // the display join
  assert.equal((await listJobLog(db, board)).jobs.length, 0); // settled only

  await stampJobLog(db, id, { outcome: "ok", error: "x".repeat(600), detail: { chars: 11 } });
  running = await listRunningJobs(db, board);
  assert.equal(running.length, 0);
  const { jobs } = await listJobLog(db, board);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].outcome, "ok");
  assert.equal(jobs[0].error.length, 500); // capped like items.error
  assert.deepEqual(jobs[0].detail, { trigger: "manual", chars: 11 }); // stamp merges over start context
  assert.ok(Number(jobs[0].ended_at) >= Number(jobs[0].started_at));
});

test("listJobLog: newest first, keyset cursor, kind/outcome filters", async () => {
  const board = await seedBoard(db, "jobs-list");
  // Recent timestamps: ancient ones would be swept by the prune test's cutoff
  // (the prune is global, not per-board).
  const T = Date.now() - 60000;
  const mk = (kind, outcome, startedAt) =>
    addJobLog(db, { boardId: board, kind, outcome, startedAt, endedAt: startedAt + 5 });
  await mk("transcribe", "ok", T + 1000);
  await mk("ingest", "failed", T + 2000);
  await mk("transcribe", "ok", T + 3000);

  const page1 = await listJobLog(db, board, { limit: 2 });
  assert.deepEqual(page1.jobs.map((j) => Number(j.started_at)), [T + 3000, T + 2000]);
  assert.ok(page1.nextCursor);
  const page2 = await listJobLog(db, board, { limit: 2, after: page1.nextCursor });
  assert.deepEqual(page2.jobs.map((j) => Number(j.started_at)), [T + 1000]);
  assert.equal(page2.nextCursor, null);

  const onlyIngest = await listJobLog(db, board, { kind: "ingest" });
  assert.deepEqual(onlyIngest.jobs.map((j) => j.kind), ["ingest"]);
  const onlyFailed = await listJobLog(db, board, { outcome: "failed" });
  assert.deepEqual(onlyFailed.jobs.map((j) => Number(j.started_at)), [T + 2000]);
});

test("latestSettledJob: newest settled row, board-level vs per-item", async () => {
  const board = await seedBoard(db, "jobs-latest");
  const T = Date.now() - 60000;
  await addJobLog(db, { boardId: board, kind: "ingest", outcome: "ok", startedAt: T + 1000, endedAt: T + 1001 });
  const newest = await addJobLog(db, { boardId: board, kind: "ingest", outcome: "failed", error: "boom", startedAt: T + 2000, endedAt: T + 2001 });
  const running = await addJobLog(db, { boardId: board, kind: "ingest", startedAt: T + 3000 }); // running — never the answer
  await addJobLog(db, { boardId: board, itemId: 7, kind: "transcribe", outcome: "requeued", startedAt: T + 4000, endedAt: T + 4001 });

  const boardLevel = await latestSettledJob(db, board, "ingest");
  assert.equal(Number(boardLevel.id), Number(newest)); // settled only; per-item rows excluded
  assert.equal((await latestSettledJob(db, board, "transcribe", 7)).outcome, "requeued");
  assert.equal(await latestSettledJob(db, board, "transcribe", 8), null);
  // Settle the running row — the boot-sweep test below counts globally.
  await stampJobLog(db, running, { outcome: "ok" });
});

test("markInterruptedJobs flips only running rows from before the boot fence", async () => {
  const board = await seedBoard(db, "jobs-interrupt");
  const bootAt = Date.now();
  const orphan = await addJobLog(db, { boardId: board, kind: "transcribe", startedAt: bootAt - 5000 });
  const settled = await addJobLog(db, { boardId: board, kind: "ingest", outcome: "ok", startedAt: bootAt - 5000, endedAt: bootAt - 4000 });
  const fresh = await addJobLog(db, { boardId: board, kind: "transcribe", startedAt: bootAt + 50 });

  assert.equal(await markInterruptedJobs(db, bootAt), 1);
  const rows = await jobsFor(board);
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(byId[orphan].outcome, "interrupted");
  assert.match(byId[orphan].error, /restart/);
  assert.equal(Number(byId[orphan].ended_at), bootAt);
  assert.equal(byId[settled].outcome, "ok"); // settled rows untouched
  assert.equal(byId[fresh].outcome, "running"); // this boot's own row survives
});

test("pruneJobLog removes old settled rows, never running ones", async () => {
  const board = await seedBoard(db, "jobs-prune");
  const now = Date.now();
  await addJobLog(db, { boardId: board, kind: "ingest", outcome: "ok", startedAt: now - 10 * 86400000, endedAt: now - 10 * 86400000 });
  await addJobLog(db, { boardId: board, kind: "transcribe", startedAt: now - 10 * 86400000 }); // running orphan: boot sweep's job, not the prune's
  await addJobLog(db, { boardId: board, kind: "ingest", outcome: "ok", startedAt: now, endedAt: now });

  assert.equal(await pruneJobLog(db, now - 86400000), 1);
  const left = await jobsFor(board);
  assert.deepEqual(left.map((r) => r.outcome).sort(), ["ok", "running"]);
});

// --- the transcribe write point ---

test("transcription success: one row, running→ok, chars + engine detail; turns land on the payload", async () => {
  const board = await seedBoard(db, "jobs-transcribe-ok");
  const { eid, iid } = await seedAudio(board, "interview.mp3");
  const restore = stubFetch(sidecarOk("hello world", [{ start: 0, end: 1, text: "hello world", speaker: "S1" }]));
  const stop = runWorker();
  try {
    await until(async () => (await itemPayload(iid))?.transcript);
  } finally {
    await stop();
    restore();
  }
  const p = await itemPayload(iid);
  assert.deepEqual(p.transcript_turns, [{ start: 0, end: 1, text: "hello world", speaker: "S1" }],
    "the structured turns — speaker labels included — land beside the flat transcript");
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, "transcribe");
  assert.equal(r.outcome, "ok");
  assert.equal(Number(r.item_id), iid);
  assert.equal(Number(r.entity_id), eid);
  assert.equal(r.target, "interview.mp3");
  assert.deepEqual(r.detail, { chars: 11, turns: 1, speakers: 1, engine: "whisper:small" });
  assert.ok(Number(r.ended_at) >= Number(r.started_at));
});

test("transcription permanent failure (422): failed row alongside the payload marker", async () => {
  const board = await seedBoard(db, "jobs-transcribe-fail");
  const { iid } = await seedAudio(board, "static.mp3");
  const restore = stubFetch(sidecarStatus(422));
  const stop = runWorker();
  try {
    await until(async () => (await itemPayload(iid))?.transcript_error);
  } finally {
    await stop();
    restore();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
  assert.match(rows[0].error, /HTTP 422/);
});

test("transcription transient failure: requeued row; the retry is a fresh row (per-attempt)", async () => {
  const board = await seedBoard(db, "jobs-transcribe-transient");
  const { iid } = await seedAudio(board, "flaky.mp3");

  let restore = stubFetch(sidecarDown());
  let stop = runWorker();
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.outcome === "requeued"));
  } finally {
    await stop();
    restore();
  }
  // Nothing marked on the item — the clip is still owed a transcript.
  const p = await itemPayload(iid);
  assert.equal(p.transcript, undefined);
  assert.equal(p.transcript_error, undefined);

  // A new worker (fresh backoff) with a healthy sidecar: the retry attempt
  // opens its own row rather than mutating the first one.
  restore = stubFetch(sidecarOk("recovered"));
  stop = runWorker();
  try {
    await until(async () => (await itemPayload(iid))?.transcript);
  } finally {
    await stop();
    restore();
  }
  // The turnless done payload (an older sidecar image) leaves the key absent.
  assert.equal((await itemPayload(iid)).transcript_turns, undefined);
  const rows = await jobsFor(board);
  assert.deepEqual(rows.map((r) => r.outcome), ["requeued", "ok"]);
  assert.match(rows[0].error, /unreachable/);
});

test("transcription: repeated transient failures fold into one requeued row", async () => {
  const board = await seedBoard(db, "jobs-transcribe-fold");
  const { iid } = await seedAudio(board, "outage.mp3");

  // Attempt 1 (sidecar down): the first failure writes its own row.
  let restore = stubFetch(sidecarDown());
  let stop = runWorker();
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.outcome === "requeued"));
  } finally {
    await stop();
    restore();
  }

  // Attempt 2 (a new worker = fresh backoff, still down): folds into the same
  // row — attempts bumped, no second row. Restarting between attempts also
  // proves the fold finds the prior row in the ledger, not in memory.
  restore = stubFetch(sidecarDown());
  stop = runWorker();
  try {
    await until(async () => (await jobsFor(board)).some((r) => Number(r.detail?.attempts) === 2));
  } finally {
    await stop();
    restore();
  }
  let rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "requeued");

  // The recovery still gets its own row: [folded retry story, ok].
  restore = stubFetch(sidecarOk("back"));
  stop = runWorker();
  try {
    await until(async () => (await itemPayload(iid))?.transcript);
  } finally {
    await stop();
    restore();
  }
  rows = await jobsFor(board);
  assert.deepEqual(rows.map((r) => r.outcome), ["requeued", "ok"]);
  assert.equal(Number(rows[0].detail.attempts), 2);
});

// --- the ingest write point ---

test("ingest run: ok row with the run's counts", async () => {
  for (const f of ["a.txt", "b.txt", "c.txt"]) {
    const p = path.join(root, "jobsok", f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `content of ${f}`);
    fs.utimesSync(p, new Date(OLD), new Date(OLD));
  }
  const board = await seedBoard(db, "jobs-ingest-ok");
  await updateBoard(db, board, {
    ingest: { enabled: true, source: { folder: "jobsok" }, trigger: { mode: "manual" } },
  });
  await setIngestNextRun(db, board, Date.now() - 1000);

  const stop = runWorker({ sources });
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.outcome !== "running"));
  } finally {
    await stop();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.kind, "ingest");
  assert.equal(r.outcome, "ok");
  assert.equal(r.item_id, null); // a board run, not an instance job
  assert.equal(r.error, null);
  assert.deepEqual(r.detail, { trigger: "manual", scanned: 3, fresh: 3, admitted: 3, skipped: 0, drain_left: 0 });
});

test("idle scheduled scans leave no history; a manual no-op run keeps its row", async () => {
  fs.mkdirSync(path.join(root, "idle"), { recursive: true });
  const auto = await seedBoard(db, "jobs-ingest-idle");
  await updateBoard(db, auto, {
    ingest: { enabled: true, source: { folder: "idle" }, trigger: { mode: "continuous" } },
  });
  await setIngestNextRun(db, auto, Date.now() - 1000);
  const manual = await seedBoard(db, "jobs-ingest-manual-noop");
  await updateBoard(db, manual, {
    ingest: { enabled: true, source: { folder: "idle" }, trigger: { mode: "manual" } },
  });
  await setIngestNextRun(db, manual, Date.now() - 1000);

  const stop = runWorker({ sources });
  try {
    // Manual: the user asked, so "0 admitted" IS the answer — the row stays.
    await until(async () => (await jobsFor(manual)).some((r) => r.outcome === "ok"));
    // Continuous: the run really happened (state stamped) but its flat tick
    // retracts the running row — no history residue.
    await until(async () => {
      const { rows: [b] } = await db.query("SELECT ingest_state FROM boards WHERE id=$1", [auto]);
      return b.ingest_state?.last_run_at;
    });
    await until(async () => (await jobsFor(auto)).length === 0);
  } finally {
    await stop();
  }
  const kept = (await jobsFor(manual)).filter((r) => r.kind === "ingest");
  assert.equal(kept.length, 1);
  assert.equal(kept[0].detail.admitted, 0);
});

test("ingest run failure: failed row with the run's error", async () => {
  const board = await seedBoard(db, "jobs-ingest-fail");
  await updateBoard(db, board, {
    ingest: { enabled: true, source: { folder: "does-not-exist" }, trigger: { mode: "manual" } },
  });
  await setIngestNextRun(db, board, Date.now() - 1000);

  const stop = runWorker({ sources });
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.outcome !== "running"));
  } finally {
    await stop();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
  // The friendly form — job-log rows are member-visible, so the message names
  // the configured subpath, never the server's resolved absolute path.
  assert.match(rows[0].error, /folder "does-not-exist" doesn't exist under the ingest root/);
});

test("a scheduled scan that ledgers a skip keeps its row and names the file", async () => {
  // A .png whose bytes aren't an image passes the extension gate, fails the
  // sniff at admit → err.skip → ledgered out of every future scan. The run
  // row is the only trace that ever happened, so it must not be retracted.
  const p = path.join(root, "skips", "fake.png");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, "not a png at all");
  fs.utimesSync(p, new Date(OLD), new Date(OLD));
  const board = await seedBoard(db, "jobs-ingest-skip");
  await updateBoard(db, board, {
    ingest: { enabled: true, source: { folder: "skips" }, trigger: { mode: "continuous" } },
  });
  await setIngestNextRun(db, board, Date.now() - 1000);

  const runAt = async () =>
    Number((await db.query("SELECT ingest_state FROM boards WHERE id=$1", [board])).rows[0].ingest_state?.last_run_at || 0);
  const stop = runWorker({ sources });
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.outcome === "ok"));
    // Scan 2: the key is now ledgered, nothing is fresh — a true flat tick
    // again, retracted as usual.
    const t1 = await runAt();
    await setIngestNextRun(db, board, Date.now() - 1000);
    await until(async () => (await runAt()) > t1);
  } finally {
    await stop();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  const d = rows[0].detail;
  assert.equal(d.admitted, 0);
  assert.equal(d.skipped, 1);
  assert.deepEqual(d.skipped_labels, ["fake.png"]);
});

test("a scheduled run failing the same way folds into one row per outage", async () => {
  const board = await seedBoard(db, "jobs-ingest-failfold");
  await updateBoard(db, board, {
    ingest: { enabled: true, source: { folder: "gone" }, trigger: { mode: "continuous" } },
  });
  await setIngestNextRun(db, board, Date.now() - 1000);

  const stop = runWorker({ sources });
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.outcome === "failed"));
    // Pull the 5-minute backoff forward: the retry hits the same missing
    // folder and folds instead of stacking a second identical row.
    await setIngestNextRun(db, board, Date.now() - 1000);
    await until(async () => (await jobsFor(board)).some((r) => Number(r.detail?.attempts) === 2));
  } finally {
    await stop();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
  assert.match(rows[0].error, /folder "gone" doesn't exist under the ingest root/);
});

// --- the pipeline legs (Stage 3) ---
// The face leg runs keyless end-to-end (the queue.test.js pattern); the tag
// and extract legs run against an installed openai key with the compat wire's
// fetch stubbed — one tool-call response can serve both record_fields and
// record_tags, so a single item flows extract → tag under one stub.

const FACETS = [{ key: "kind", label: "Kind", single: true, values: ["a", "b"] }];

async function seedLegItem(boardId, name, status, extraPayload = {}) {
  const eid = await createEntity(db, boardId, { identity: name });
  const iid = await insertItem(db, boardId, { identity: name, files: [], fields: {}, ...extraPayload }, status, eid);
  return { eid, iid };
}

const itemStatus = async (id) => (await db.query("SELECT status FROM items WHERE id=$1", [id])).rows[0]?.status;

// Echoes the request's OWN tool name — the wire matches the call by name, so
// a nameless stub would read as "model did not call record_fields". `seen`
// collects request bodies for prompt-shape assertions.
const toolCallResponse = (args, seen = null) => async (_url, opts) => {
  const body = JSON.parse(opts.body);
  seen?.push(body);
  return new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: body.tools?.[0]?.function?.name, arguments: JSON.stringify(args) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200 });
};

test("face leg: a keyless render-nothing advance writes an ok row", async () => {
  const board = await seedBoard(db, "jobs-face");
  const { iid } = await seedLegItem(board, "btc", "pending_face");
  const stop = runWorker();
  try {
    await until(async () => (await itemStatus(iid)) === "pending");
  } finally {
    await stop();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "face");
  assert.equal(rows[0].outcome, "ok");
  // `connector`, not `provider` — the AI legs own that key now (metering Stage 2).
  assert.deepEqual(rows[0].detail, { connector: null, rendered: false });
});

test("tag leg: the facet-less completion is a real ok row with zero tags", async () => {
  const keyId = await createAiKey(db, "jobs-k1", "openai", "sk-test");
  const board = await createBoard(db, "jobs-tag-nofacets", [], "", true, keyId); // key only opens the claim gate — no call is made
  const { iid } = await seedLegItem(board, "beef1234deadbeef.png", "pending", {
    files: [{ name: "beef1234deadbeef.png", original_name: "holiday.png", kind: "image" }],
  });
  const stop = runWorker();
  try {
    await until(async () => (await itemStatus(iid)) === "tagged");
  } finally {
    await stop();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "tag");
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[0].target, "holiday.png"); // the ORIGINAL name, not the stored hex name
  assert.deepEqual(rows[0].detail, { tags: 0 });
});

test("extract + tag legs: one ok row each, with fields/identity and tags detail", async () => {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "jobs-k2", "openai", "sk-test");
  const mapping = { identity: { source: "extract" }, fields: [{ key: "role", source: "extract", kind: "text" }] };
  const board = await createBoard(db, "jobs-legs", FACETS, "", true, keyId, null, {}, false, { mapping });
  const { eid, iid } = await seedLegItem(board, "resume.txt", "pending_extract", { mapping });
  const seen = [];
  const restore = stubFetch(toolCallResponse({
    identity: { value: "Maya Chen", why: "letterhead" },
    role: { value: "engineer", why: "title line" },
    kind: { values: ["a"], reasoning: "fits a" },
    fit: { verdict: "fits", reasoning: "on-topic" },
  }, seen));
  const stop = runWorker();
  try {
    await until(async () => (await itemStatus(iid)) === "tagged");
  } finally {
    await stop();
    restore();
  }
  const rows = await jobsFor(board);
  assert.deepEqual(rows.map((r) => [r.kind, r.outcome]), [["extract", "ok"], ["tag", "ok"]]);
  const [ext, tag] = rows;
  assert.equal(ext.detail.fields, 1);
  assert.equal(ext.detail.identity, "derived");
  assert.equal(typeof ext.detail.model, "string");
  assert.equal(tag.detail.tags, 1);
  assert.equal(Number(tag.item_id), iid);
  // Stage 2 (metering-plan.md): each paid leg's row says what it cost and who
  // served it — the stub bills 10/5 per call, no cache so no cache key.
  assert.deepEqual(ext.detail.tokens, { in: 10, out: 5 });
  assert.equal(ext.detail.provider, "openai");
  assert.deepEqual(tag.detail.tokens, { in: 10, out: 5 });
  assert.equal(tag.detail.provider, "openai");
  // The derivation really landed — the entity was renamed by the extract leg.
  const { rows: [e] } = await db.query("SELECT identity FROM entities WHERE id=$1", [eid]);
  assert.equal(e.identity, "maya chen");
  // Each leg's user turn asks for ITS tool. This item is fileless, so the
  // extract leg rode the modelInputFor fallback — the path that used to say
  // "record_tags" while offering only record_fields.
  const userText = (b) => b.messages[1].content.map((p) => p.text || "").join(" ");
  const extractReq = seen.find((b) => b.tools[0].function.name === "record_fields");
  const tagReq = seen.find((b) => b.tools[0].function.name === "record_tags");
  assert.match(userText(extractReq), /record_fields/);
  assert.doesNotMatch(userText(extractReq), /record_tags/);
  assert.match(userText(tagReq), /record_tags/);
});

test("tag leg: a permanent provider error (400) writes a failed row", async () => {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "jobs-k3", "openai", "sk-test");
  const board = await createBoard(db, "jobs-tag-fail", FACETS, "", true, keyId);
  const { iid } = await seedLegItem(board, "junk", "pending");
  const restore = stubFetch(async () =>
    new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 }));
  const stop = runWorker();
  try {
    await until(async () => (await itemStatus(iid)) === "failed");
  } finally {
    await stop();
    restore();
  }
  const rows = await jobsFor(board);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "tag");
  assert.equal(rows[0].outcome, "failed");
  assert.ok(rows[0].error);
});

// --- the deferred families (Stage 4) ---

test("retag sweep: one board-run row with the queued count", async () => {
  const board = await seedBoard(db, "jobs-retag");
  await seedLegItem(board, "old-item", "tagged");
  await updateBoard(db, board, { autoTagPeriodic: true, autoTagEveryMin: 60, autoTagNextRunAt: Date.now() - 1000 });
  const stop = runWorker();
  try {
    await until(async () => (await jobsFor(board)).some((r) => r.kind === "retag"));
  } finally {
    await stop();
  }
  const rows = (await jobsFor(board)).filter((r) => r.kind === "retag");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "ok");
  assert.equal(rows[0].detail.queued, 1);
  assert.equal(rows[0].item_id, null); // a board run, not an instance job
});

test("embed: a marked-and-skipped poison item writes a failed row", async () => {
  const board = await seedBoard(db, "jobs-embed");
  const insertTagged = async (description) => (await db.query(
    `INSERT INTO items (board_id, payload, status, tags, tag_reasoning, created_at, updated_at)
     VALUES ($1,$2,'tagged','["a/b"]',$3,$4,$4) RETURNING id`,
    [board, JSON.stringify({ identity: "clip", files: [], fields: {} }), JSON.stringify({ description }), Date.now()]
  )).rows[0].id;
  await insertTagged("a fine description");
  const poison = await insertTagged("POISON text the embedder rejects");

  // The embed-sweep stub: /embeddings 400s any request whose input mentions
  // POISON, so the batch fails, isolation runs, and only the poison is marked.
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!String(url).includes("/embeddings")) return realFetch(url, opts);
    const { input } = JSON.parse(opts.body);
    if (input.some((t) => t.includes("POISON")))
      return { ok: false, status: 400, json: async () => ({ error: { message: "rejected input" } }) };
    return { ok: true, status: 200, json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: [1, 0] })), usage: {} }) };
  };
  try {
    const rows = await itemsNeedingEmbedding(db, "text-embedding-3-small", 64);
    const r = await embedBatch(db, { provider: "openai", apiKey: "k", model: "text-embedding-3-small" }, rows);
    assert.ok(r.skipped >= 1);
  } finally {
    global.fetch = realFetch;
  }
  const rows = (await jobsFor(board)).filter((r) => r.kind === "embed");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, "failed");
  assert.equal(Number(rows[0].item_id), poison);
  assert.match(rows[0].error, /rejected input/);
});

test("kind=refresh serves field_snapshots; has_refresh and scheduled stamps ride along", async () => {
  const member = await seedUser(db, "jobs-refresh@test.local");
  const board = await seedBoard(db, "jobs-refresh", [member.id]);
  const eid = await createEntity(db, board, { identity: "bitcoin" });
  const T = Date.now() - 60000;
  await addFieldSnapshot(db, eid, { price: { v: 64210 } }, "crypto", T + 1000);
  await addFieldSnapshot(db, eid, { price: { v: 64900 }, cap: { v: 1 } }, "crypto", T + 2000);
  // Arm every scheduled family (all in the future, so no worker interferes).
  await db.query("UPDATE entities SET refresh_at=$1 WHERE id=$2", [T + 999000, eid]);
  await updateBoard(db, board, {
    autoTagPeriodic: true, autoTagNextRunAt: T + 500000,
    ingest: { enabled: true, source: { folder: "x" }, trigger: { mode: "manual" } },
  });
  await setIngestNextRun(db, board, T + 300000);

  const r = await req(srv.base, "GET", `/api/boards/${board}/jobs`, { sid: member.sid });
  assert.equal(r.json.has_refresh, true);
  assert.deepEqual(r.json.jobs, []); // refresh rows are NOT in the default view
  assert.equal(r.json.scheduled.refresh_next_at, T + 999000);
  assert.equal(r.json.scheduled.retag_next_run_at, T + 500000);
  assert.equal(r.json.scheduled.ingest_next_run_at, T + 300000);

  const p1 = await req(srv.base, "GET", `/api/boards/${board}/jobs?kind=refresh&limit=1`, { sid: member.sid });
  assert.equal(p1.json.jobs.length, 1);
  const j = p1.json.jobs[0];
  assert.equal(j.kind, "refresh");
  assert.equal(j.outcome, "ok");
  assert.equal(j.entity_display, "bitcoin");
  assert.deepEqual(j.detail, { fields: { price: { v: 64900 }, cap: { v: 1 } }, provider: "crypto" });
  assert.ok(p1.json.nextCursor);
  const p2 = await req(srv.base, "GET", `/api/boards/${board}/jobs?kind=refresh&limit=1&after=${p1.json.nextCursor}`, { sid: member.sid });
  assert.deepEqual(p2.json.jobs[0].detail.fields, { price: { v: 64210 } });
  // A full page always hands back a cursor ("maybe more" — the listJobLog
  // convention); following it off the end terminates with an empty page.
  const p3 = await req(srv.base, "GET", `/api/boards/${board}/jobs?kind=refresh&limit=1&after=${p2.json.nextCursor}`, { sid: member.sid });
  assert.deepEqual(p3.json.jobs, []);
  assert.equal(p3.json.nextCursor, null);
});

// --- the endpoint (Stage 2) ---

test("GET /api/boards/:id/jobs: running + paged history, member-visible, 404 outside", async () => {
  const member = await seedUser(db, "jobs-member@test.local");
  const outsider = await seedUser(db, "jobs-outsider@test.local");
  const board = await seedBoard(db, "jobs-endpoint", [member.id]);
  const T = Date.now() - 30000;
  await addJobLog(db, { boardId: board, kind: "transcribe", target: "clip.mp3", startedAt: T + 100 }); // running
  await addJobLog(db, { boardId: board, kind: "ingest", outcome: "ok", startedAt: T + 200, endedAt: T + 300, detail: { admitted: 2 } });
  await addJobLog(db, { boardId: board, kind: "transcribe", outcome: "failed", error: "boom", target: "bad.mp3", startedAt: T + 400, endedAt: T + 500 });

  // Anonymous → 401; a signed-in non-member → 404 (forbidden and missing are
  // indistinguishable, the access.test.js convention).
  assert.equal((await req(srv.base, "GET", `/api/boards/${board}/jobs`)).status, 401);
  assert.equal((await req(srv.base, "GET", `/api/boards/${board}/jobs`, { sid: outsider.sid })).status, 404);

  // A provisional upload entity: identity is the stored hex name, no display
  // name — the label must fall to the frozen target (the original filename),
  // never the hex identity.
  const hexEntity = await createEntity(db, board, { identity: "ab12cd34ef56.png" });
  await addJobLog(db, {
    boardId: board, entityId: hexEntity, itemId: 9, target: "photo.png",
    kind: "tag", outcome: "ok", startedAt: T + 150, endedAt: T + 160, detail: { tags: 2 },
  });

  const r = await req(srv.base, "GET", `/api/boards/${board}/jobs`, { sid: member.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.running.length, 1);
  assert.equal(r.json.running[0].kind, "transcribe");
  assert.equal(r.json.running[0].entity_display, "clip.mp3"); // no entity → frozen target
  assert.equal(r.json.jobs.find((j) => j.kind === "tag").entity_display, "photo.png");
  assert.deepEqual(r.json.jobs.map((j) => j.outcome), ["failed", "ok", "ok"]); // newest first, running excluded
  assert.equal(r.json.jobs[0].error, "boom"); // error detail for every member
  assert.equal(r.json.nextCursor, null);
  assert.equal(typeof r.json.now, "number");

  const only = await req(srv.base, "GET", `/api/boards/${board}/jobs?kind=ingest`, { sid: member.sid });
  assert.deepEqual(only.json.jobs.map((j) => j.kind), ["ingest"]);

  const page1 = await req(srv.base, "GET", `/api/boards/${board}/jobs?limit=1`, { sid: member.sid });
  assert.deepEqual(page1.json.jobs.map((j) => j.outcome), ["failed"]);
  assert.ok(page1.json.nextCursor);
  const page2 = await req(srv.base, "GET", `/api/boards/${board}/jobs?limit=1&after=${page1.json.nextCursor}`, { sid: member.sid });
  assert.deepEqual(page2.json.jobs.map((j) => j.outcome), ["ok"]);
});

test("DELETE /api/boards/:id/jobs: manager clears settled rows, running survives, member 403", async () => {
  const member = await seedUser(db, "jobs-clear-member@test.local");
  const admin = await adminSession(db);
  const board = await seedBoard(db, "jobs-clear", [member.id]);
  const T = Date.now() - 30000;
  await addJobLog(db, { boardId: board, kind: "ingest", outcome: "ok", startedAt: T + 100, endedAt: T + 200 });
  await addJobLog(db, { boardId: board, kind: "tag", outcome: "failed", error: "boom", startedAt: T + 300, endedAt: T + 400 });
  const live = await addJobLog(db, { boardId: board, kind: "transcribe", target: "clip.mp3", startedAt: T + 500 });

  // Reading the log is member transparency; destroying it is management.
  assert.equal((await req(srv.base, "DELETE", `/api/boards/${board}/jobs`, { sid: member.sid })).status, 403);

  const r = await req(srv.base, "DELETE", `/api/boards/${board}/jobs`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.cleared, 2);
  const left = await jobsFor(board);
  assert.equal(left.length, 1);
  assert.equal(Number(left[0].id), Number(live)); // in-flight work survives the wipe
  await stampJobLog(db, live, { outcome: "ok" }); // settle — don't leak a running row
});

// --- what the model was actually shown (ai-image-input-plan.md, Slice 4) ---

test("tag leg: the board's image preset beats the app default, and the row records what was sent", async () => {
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "jobs-img", "openai", "sk-test");
  const board = await createBoard(db, "jobs-image-preset", FACETS, "", true, keyId);
  // App default says thumbnails; this board overrides to High. The board wins.
  await setSetting(db, "tag_image_preset", "thumb");
  await updateBoard(db, board, { boardBindings: { tag_image_preset: "high" } });

  // A real 2400px upload through the actual ingest path, so the item has both
  // a stored original and a ≤600px card face on disk.
  const tmp = path.join(srv.galleryDir, "..", "src-shot.png");
  fs.writeFileSync(tmp, await sharp({ create: { width: 2400, height: 1400, channels: 3, background: { r: 12, g: 90, b: 200 } } }).png().toBuffer());
  const entry = await sources.forUpload("shot.png").ingest(tmp, "shot.png");
  const { iid } = await seedLegItem(board, "shot.png", "pending", { files: [entry] });

  const seen = [];
  const restore = stubFetch(toolCallResponse({
    kind: { values: ["a"], reasoning: "fits a" },
    fit: { verdict: "fits", reasoning: "on-topic" },
  }, seen));
  const stop = runWorker();
  try {
    await until(async () => (await itemStatus(iid)) === "tagged");
  } finally {
    await stop();
    restore();
    await setSetting(db, "tag_image_preset", null);
  }

  // What actually went over the wire: the compat wire sends a data URL.
  const sentImage = seen[0].messages[1].content.find((p) => p.type === "image_url");
  const bytes = Buffer.from(sentImage.image_url.url.split(",")[1], "base64");
  const m = await sharp(bytes).metadata();
  assert.equal(Math.max(m.width, m.height), 1568, "the board's High preset, not the 600px card face");
  assert.ok(entry.w <= 600, "…and the card face really is the small one");

  // …and the ledger says so, which is the only way to catch a board silently
  // riding the thumbnail fallback.
  const tagRow = (await jobsFor(board)).find((r) => r.kind === "tag");
  assert.equal(tagRow.outcome, "ok");
  assert.equal(tagRow.detail.image.source, "original");
  assert.equal(tagRow.detail.image.preset, "high", "the board's pin, not the app default");
  assert.equal(tagRow.detail.image.edge, 1568);
  assert.ok(tagRow.detail.image.bytes > 0);
  // What the rendition COST, which is what the deferred rendition cache
  // (ai-image-input-plan.md §8) is gated on — the ledger is where that
  // measurement has to survive, not a one-off benchmark.
  assert.equal(typeof tagRow.detail.image.ms, "number");
  assert.ok(tagRow.detail.image.ms >= 0);
});

test("extract leg: an image extraction records its rendition too, not just the tag leg", async () => {
  // Extraction sends an image whenever the item has no text sidecar, and a
  // silent fallback there is exactly as invisible as on the tag leg — so the
  // two legs answer "what did the model see" the same way or the answer has a
  // hole in it.
  await setPluginState(db, "ai:openai", { installed: true });
  const keyId = await createAiKey(db, "jobs-img-x", "openai", "sk-test");
  const mapping = { fields: [{ key: "role", source: "extract", kind: "text" }] };
  const board = await createBoard(db, "jobs-extract-image", FACETS, "", true, keyId, null, {}, false, { mapping });
  await updateBoard(db, board, { boardBindings: { tag_image_preset: "standard" } });

  const tmp = path.join(srv.galleryDir, "..", "src-x.png");
  fs.writeFileSync(tmp, await sharp({ create: { width: 1900, height: 1200, channels: 3, background: { r: 40, g: 160, b: 90 } } }).png().toBuffer());
  const entry = await sources.forUpload("x.png").ingest(tmp, "x.png");
  const { iid } = await seedLegItem(board, "x.png", "pending_extract", { mapping, files: [entry] });

  const restore = stubFetch(toolCallResponse({
    role: { value: "engineer", why: "badge" },
    kind: { values: ["a"], reasoning: "fits a" },
    fit: { verdict: "fits", reasoning: "on-topic" },
  }));
  const stop = runWorker();
  try {
    await until(async () => (await itemStatus(iid)) === "tagged");
  } finally {
    await stop();
    restore();
  }

  const ext = (await jobsFor(board)).find((r) => r.kind === "extract");
  assert.equal(ext.outcome, "ok");
  // Extraction reuses TAGGING's preset — one dial for one decision — so the
  // board's `standard` pin governs here too.
  assert.equal(ext.detail.image.preset, "standard");
  assert.equal(ext.detail.image.source, "original");
  assert.equal(ext.detail.image.edge, 1024, "standard's long edge, not the 600px card face");
});

// --- the cardinal rule (keep this test last: it drops the table) ---

test("ledger writes never break the job: with job_log gone, transcription still lands", async () => {
  const board = await seedBoard(db, "jobs-cardinal");
  const { iid } = await seedAudio(board, "survivor.mp3");
  await db.query("DROP TABLE job_log");
  const restore = stubFetch(sidecarOk("still works"));
  const stop = runWorker();
  try {
    const payload = await until(async () => (await itemPayload(iid))?.transcript && (await itemPayload(iid)));
    assert.equal(payload.transcript, "still works");
  } finally {
    await stop();
    restore();
  }
});
