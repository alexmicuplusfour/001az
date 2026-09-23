// First-class work (planning/first-class-work-plan.md): the lane half of
// in-flight work — running sweep rows and the backlogs no items.status
// carries — goes over the wire as `work`, on three carriers through one
// composer. The backlog counts share their predicates with the lanes' claim
// queries, so what the wire reports as waiting is exactly what the lane
// will claim: gated on a served engine (worker.js servedBacklogLanes),
// blind to in-flight items and to the running rows' own items (one unit of
// work, one count).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedInstance, adminSession, req, primeSidecars } from "./helpers.js";
import { addJobLog, boardLaneQueues, pipelineWork, createEntity, insertItem, listRunningJobs, RUNNING_JOBS_SQL } from "../server/db.js";

let srv, db, base, sid;

before(async () => {
  srv = await startServer();
  db = srv.db;
  base = srv.base;
  sid = (await adminSession(db)).sid;
  // The transcribe lane's served verdict is sidecar presence — prime it so
  // servedBacklogLanes admits the lane and the wire test exercises the
  // served path rather than the unserved no-op.
  primeSidecars();
});
after(() => srv.close());

// One audio entity+instance; `extra` lands in the payload (transcript /
// transcript_error), `status` defaults to the invisible-to-the-chip case.
const seedAudio = (boardId, name, { status = "held", extra = {} } = {}) =>
  seedInstance(db, boardId, status, {
    payload: { identity: name, files: [{ name, original_name: name, kind: "audio" }], ...extra },
  });

test("transcribe backlog counts claimable, invisible clips only", async () => {
  const b = await seedBoard(db, "lanes-transcribe");
  await seedAudio(b, "one.mp3");
  const two = await seedAudio(b, "two.mp3");
  await seedAudio(b, "done.mp3", { extra: { transcript: "hello" } });
  await seedAudio(b, "silent.mp3", { extra: { transcript: "" } }); // empty transcript still counts as answered
  await seedAudio(b, "dead.mp3", { extra: { transcript_error: "no engine liked it" } });
  await seedAudio(b, "visible.mp3", { status: "pending" }); // already on the wire as an in-flight item

  assert.deepEqual(await boardLaneQueues(db, b, []), [],
    "no served lanes, nothing counted — a backlog nobody will claim is a config gap, not work");
  assert.deepEqual(await boardLaneQueues(db, b, [{ kind: "transcribe" }]), [{ kind: "transcribe", n: 2 }],
    "transcribed, failed and in-flight clips are all excluded");
  assert.deepEqual(await boardLaneQueues(db, b, [{ kind: "transcribe" }], [two.id]), [{ kind: "transcribe", n: 1 }],
    "a running row's own clip is running, not also waiting");
});

test("embed backlog mirrors the sweep's predicate", async () => {
  const b = await seedBoard(db, "lanes-embed");
  // Tagged item, no vector: counts.
  await seedInstance(db, b, "tagged", { payload: { files: [{ name: "a.png", kind: "image" }] } });
  // Untagged audio with a transcript: counts (searchable even when the board doesn't tag).
  await seedAudio(b, "talk.mp3", { extra: { transcript: "words" } });
  // Held image: not in the corpus, doesn't count.
  await seedInstance(db, b, "held", { payload: { files: [{ name: "b.png", kind: "image" }] } });

  assert.deepEqual(await boardLaneQueues(db, b, [{ kind: "embed", model: "m-test" }]),
    [{ kind: "embed", n: 2 }]);
});

test("the three carriers serve one work payload, labelled from the kind vocabulary", async () => {
  const b = await seedBoard(db, "lanes-wire");
  const clip = await seedAudio(b, "clip.mp3");
  await seedAudio(b, "next.mp3"); // waiting behind it
  await addJobLog(db, {
    boardId: b, entityId: clip.eid, itemId: clip.id, target: "clip.mp3", kind: "transcribe",
  });

  // Carrier 1: the delta poll.
  const delta = await req(base, "GET", `/api/items?board=${b}&since=0`, { sid });
  assert.equal(delta.status, 200);
  const work = delta.json.work;
  assert.equal(work.running.length, 1);
  assert.equal(work.running[0].label, "Transcription", "self-describing payload — no client-side label list");
  assert.equal(work.running[0].entity_id, clip.eid, "the dedup key travels");
  assert.deepEqual(work.queued, [{ kind: "transcribe", n: 1, label: "Transcription" }],
    "the waiting clip counts; the running one doesn't");

  // …and its boot leg: the first page carries work, later pages don't.
  const first = await req(base, "GET", `/api/items?board=${b}&limit=1`, { sid });
  assert.ok(first.json.work, "opening a board mid-transcription lights the chip on arrival");
  if (first.json.nextCursor) {
    const second = await req(base, "GET", `/api/items?board=${b}&limit=1&after=${first.json.nextCursor}`, { sid });
    assert.equal(second.json.work, undefined, "one answer per load, not one per page");
  }

  // Carrier 2: the signals tick (the discovery channel for idle boards).
  const errors = await req(base, "GET", `/api/boards/${b}/jobs/errors`, { sid });
  assert.equal(errors.json.work.running.length, 1);
  assert.equal(errors.json.work.queued[0]?.n, 1);

  // Carrier 3: the jobs page — the same payload, same shape.
  const jobs = await req(base, "GET", `/api/boards/${b}/jobs`, { sid });
  assert.equal(jobs.json.work.running.length, 1);
  assert.equal(jobs.json.work.running[0].label, "Transcription");
  assert.equal(jobs.json.work.queued[0]?.n, 1);
});

// ── the pipeline legs on the wire (planning/instance-work-plan.md) ──
// A unit of work is one instance attempt: every claimed instance is a running
// row wearing its leg's kind and its file, every waiting one a count under
// its leg — derived from items.status, nothing written twice.

const seedImage = (boardId, status, name) =>
  seedInstance(db, boardId, status, { payload: { files: [{ name: `${name}.stored`, original_name: name, kind: "image" }] } });

test("pipelineWork: one running row per claimed instance, one count per waiting leg, nothing else", async () => {
  const b = await seedBoard(db, "legs-shape");
  const claimed = {
    fetching: await seedImage(b, "fetching", "fetching.png"),
    facing: await seedImage(b, "facing", "facing.png"),
    extracting: await seedImage(b, "extracting", "extracting.png"),
    processing: await seedImage(b, "processing", "processing.png"),
  };
  for (const s of ["pending_fetch", "pending_face", "pending_extract", "pending"]) await seedImage(b, s, `${s}.png`);
  for (const s of ["held", "tagged", "failed"]) await seedImage(b, s, `${s}.png`); // not work
  // A derived card: the row names its file, and the card's own name rides beside it.
  const emma = await createEntity(db, b, { identity: "emma watson", displayName: "Emma Watson" });
  const named = await insertItem(db, b, { identity: "emma watson", files: [{ name: "x.jpg", original_name: "2jNX7ZT.jpg", kind: "image" }] }, "extracting", emma);

  const work = await pipelineWork(db, b);
  const byItem = new Map(work.running.map((r) => [r.item_id, r]));
  assert.equal(work.running.length, 5, "the four claimed states plus the named card's row; held/tagged/failed are not work");
  assert.deepEqual(
    Object.fromEntries(Object.entries(claimed).map(([s, { id }]) => [s, byItem.get(id).kind])),
    { fetching: "fetch", facing: "face", extracting: "extract", processing: "tag" },
    "each claimed state wears its leg's job kind — the badge History wears");
  const row = byItem.get(claimed.processing.id);
  assert.equal(row.id, null, "not a job_log row, and it says so");
  assert.equal(row.target, "processing.png", "the ORIGINAL filename, never the stored one");
  assert.equal(row.entity_id, claimed.processing.eid);
  assert.equal(row.entity_display, null, "a raw card has no name of its own — the hex identity never leaks");
  const { rows: [{ updated_at }] } = await db.query("SELECT updated_at FROM items WHERE id=$1", [named]);
  assert.equal(byItem.get(named).started_at, updated_at, "started_at is the claim stamp");
  assert.equal(byItem.get(named).entity_display, "Emma Watson");
  assert.equal(byItem.get(named).target, "2jNX7ZT.jpg");
  assert.deepEqual(work.queued,
    [{ kind: "fetch", n: 1 }, { kind: "face", n: 1 }, { kind: "extract", n: 1 }, { kind: "tag", n: 1 }],
    "one count per waiting leg, in pipeline order");
});

test("a clip the tag leg claimed while its transcript is still running is one unit of work", async () => {
  const b = await seedBoard(db, "legs-overlap");
  // The tag leg CLAIMS an audio row and only then finds the transcript missing
  // (worker.js modelInputFor) — so for a moment the clip is both `processing`
  // and the transcribe lane's running row. The running row's item is excluded
  // from the pipeline halves, the frame boardLaneQueues already applies.
  const clip = await seedAudio(b, "clip.mp3", { status: "processing" });
  await addJobLog(db, { boardId: b, entityId: clip.eid, itemId: clip.id, target: "clip.mp3", kind: "transcribe" });

  assert.deepEqual(await pipelineWork(db, b, [clip.id]), { running: [], queued: [] });
  const errors = await req(base, "GET", `/api/boards/${b}/jobs/errors`, { sid });
  assert.equal(errors.json.work.running.length, 1, "the transcribe row, and only it");
  assert.equal(errors.json.work.running[0].kind, "transcribe");
  assert.deepEqual(errors.json.work.queued, [], "…and the clip is not also waiting to tag");
});

test("the legs ride every carrier marked `leg`, and the reprocess answer is the fifth", async () => {
  const b = await seedBoard(db, "legs-wire");
  await seedImage(b, "pending", "a.png");
  await seedImage(b, "pending", "b.png");
  await seedImage(b, "extracting", "c.png");
  const tagLane = { kind: "tag", n: 2, label: "Tagging", leg: true };
  const extractRow = (w) => w.running.find((r) => r.kind === "extract");

  for (const [name, url] of [
    ["delta poll", `/api/items?board=${b}&since=0`],
    ["signals tick", `/api/boards/${b}/jobs/errors`],
    ["jobs page", `/api/boards/${b}/jobs`],
  ]) {
    const { json: { work } } = await req(base, "GET", url, { sid });
    assert.deepEqual(work.queued, [tagLane], `${name}: the waiting leg, labelled from the kind vocabulary and marked leg`);
    const r = extractRow(work);
    assert.ok(r, `${name}: the claimed instance is a running row`);
    assert.equal(r.label, "Extraction");
    assert.equal(r.target, "c.png");
    assert.equal(r.leg, true, `${name}: a running leg row is marked too — the abort gate reads it`);
  }

  // The click: every instance re-enters the pipeline (no mapping → tagging),
  // and the answer carries the queue it just filled in the same shape.
  const r = await req(base, "POST", `/api/admin/boards/${b}/reprocess`, { sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.queued, 3);
  assert.deepEqual(r.json.work.queued, [{ ...tagLane, n: 3 }]);
  assert.deepEqual(r.json.work.running, []);
});

test("a per-card route answers `work` too — the click lights the chip in the same render", async () => {
  const b = await seedBoard(db, "legs-card-route");
  const { eid } = await seedImage(b, "tagged", "d.png");
  const r = await req(base, "POST", `/api/items/${eid}/reprocess`, { sid });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.entities), "the routed report, as before");
  assert.deepEqual(r.json.work.queued, [{ kind: "tag", n: 1, label: "Tagging", leg: true }],
    "…and the work it just queued, in the carriers' shape");
});

test("an upload answers `work` too — a drop lights the chip on the same tick", async () => {
  // The one gallery surface that starts work by MINTING items rather than
  // re-queuing them (instance-work-plan.md, second pass P1). The chip reads
  // the payload alone, so without this the drop sat dark for a poll.
  const b = await seedBoard(db, "legs-upload");
  const fd = new FormData();
  fd.append("files", new File(["hello there"], "note.txt", { type: "text/plain" }));
  const res = await fetch(`${base}/api/upload?board=${b}`, {
    method: "POST", headers: { Cookie: `sid=${sid}` }, body: fd,
  });
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.uploaded.length, 1, "the rows, as before");
  assert.ok(json.work, "…and the work the drop queued");
  const waiting = json.work.queued.find((q) => q.leg);
  assert.deepEqual(waiting, { kind: "tag", n: 1, label: "Tagging", leg: true });
});

test("…and the query every work read runs has an index the planner actually takes", async () => {
  // listRunningJobs is asked on the delta poll (4s, per open tab), the signals
  // tick, the jobs page, and — since the per-card routes answer `work` — on
  // every click and every item of a bulk fan-out. job_log had no index for
  // board_id + outcome='running': idx_job_log_board leads with the board but
  // carries its whole settled history, so the planner took a SEQ SCAN of the
  // table. Measured on a real 7208-row ledger: 4.3ms, growing for the life of
  // the instance. Migration 0053 cuts the partial index — same query, 0.083ms.
  //
  // Pinned as a PLAN and against the app's own SQL string, for the reason the
  // dot's twin test gives: the regression to guard is the query drifting off
  // the index cut for it, which an existence check reads as healthy.
  const b = await seedBoard(db, "legs-index");
  // Enough settled history that a sequential scan is not simply the cheapest
  // thing available.
  await db.query(
    `INSERT INTO job_log (board_id, kind, outcome, started_at, ended_at)
     SELECT $1, 'tag', 'ok', 1000000 + g, 1000000 + g FROM generate_series(1, 500) g`,
    [b]
  );
  await db.query("ANALYZE job_log");

  // The board with nothing running is the common case and the one that used to
  // read the whole table.
  const { rows } = await db.query(`EXPLAIN ${RUNNING_JOBS_SQL}`, [b]);
  const plan = rows.map((r) => r["QUERY PLAN"]).join("\n");
  assert.match(plan, /idx_job_log_running/, `expected the partial index:\n${plan}`);
  assert.doesNotMatch(plan, /Seq Scan on job_log/, `expected no sequential scan:\n${plan}`);
  // …and it still answers correctly through the index.
  assert.deepEqual(await listRunningJobs(db, b), []);
  await addJobLog(db, { boardId: b, kind: "ingest", startedAt: 2000000 });
  assert.equal((await listRunningJobs(db, b)).length, 1);
});
