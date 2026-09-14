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
import { addJobLog, boardLaneQueues } from "../server/db.js";

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
