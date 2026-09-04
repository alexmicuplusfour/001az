// Soft cancel (planning/job-control-plan.md, Stage 2): the mid_pass marker —
// set by the three fenced leg landings, cleared by every queuer — and the
// status-uniform cancel rule it enables: not-started queued rows restore
// (tags) or park (never tagged), queued adds delete, started work finishes.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedUser, adminSession, req, seedInstance } from "./helpers.js";
import {
  cancelBoardQueue,
  claimNextWork,
  markExtracted,
  markTagged,
  retagBoard,
  retagItem,
  getEntity,
  listJobLog,
} from "../server/db.js";

let srv, db, base;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
});
after(() => srv.close());

const rowOf = async (id) =>
  (await db.query("SELECT status, tags, mid_pass, tag_facets, retry_at, error FROM items WHERE id=$1", [id])).rows[0];

test("mid_pass lifecycle: a leg landing sets it, the tag landing and queuers clear it", async () => {
  const bid = await seedBoard(db, "cancel-marker");
  const { id } = await seedInstance(db, bid, "pending_extract", { payload: { mapping: { x: 1 } } });

  const claimed = await claimNextWork(db, true);
  assert.equal(claimed.id, id);
  assert.equal(claimed.status, "extracting");
  await markExtracted(db, id, { a: "b" });
  let row = await rowOf(id);
  assert.equal(row.status, "pending");
  assert.equal(row.mid_pass, true, "the extract landing marks the row started");

  const again = await claimNextWork(db, true);
  assert.equal(again.id, id);
  await markTagged(db, id, ["sector/tech"]);
  row = await rowOf(id);
  assert.equal(row.status, "tagged");
  assert.equal(row.mid_pass, null, "the tag landing consumes the marker");

  await retagItem(db, id);
  assert.equal((await rowOf(id)).mid_pass, null, "a queuer starts the pass unmarked");
});

test("retagBoard queues every row unmarked — a fresh pass is cancellable", async () => {
  const bid = await seedBoard(db, "cancel-fresh");
  const { id } = await seedInstance(db, bid, "tagged", { tags: ["sector/tech"], midPass: true });
  await retagBoard(db, bid);
  const row = await rowOf(id);
  assert.equal(row.status, "pending");
  assert.equal(row.mid_pass, null, "the stale marker died with the queuer");
});

test("cancel: the status-uniform rule across every queued shape", async () => {
  const bid = await seedBoard(db, "cancel-matrix");
  const restoredPending = await seedInstance(db, bid, "pending", { tags: ["sector/tech"] });
  const parkedPending = await seedInstance(db, bid, "pending");
  const parkedExtract = await seedInstance(db, bid, "pending_extract");
  const restoredFace = await seedInstance(db, bid, "pending_face", { tags: ["sector/tech"] });
  const parkedFace = await seedInstance(db, bid, "pending_face");
  const removedFetch = await seedInstance(db, bid, "pending_fetch", { payload: { unfetched: true, source: { id: "x" } } });
  // A FETCHED vehicle re-buying its data (Stage 3a reprocess): real fields and
  // history, not a name-only shell — it must pull back like any leg, never delete.
  const refetching = await seedInstance(db, bid, "pending_fetch", { payload: { source: { id: "y" } } });
  const startedQueued = await seedInstance(db, bid, "pending", { midPass: true });
  const inFlight = await seedInstance(db, bid, "processing");
  // An armed scope on a cancellable row must die with the cancel (0030's
  // "a scoped row is only ever pending or processing").
  await db.query("UPDATE items SET tag_facets=ARRAY['sector'] WHERE id=$1", [restoredPending.id]);

  const counts = await cancelBoardQueue(db, bid);
  assert.deepEqual(counts, { restored: 2, parked: 4, removed: 1, finishing: 2, discarding: 0 });

  for (const { id } of [restoredPending, restoredFace]) {
    const row = await rowOf(id);
    assert.equal(row.status, "tagged", "tags present → the pre-queue state restored");
    assert.deepEqual(row.tags, ["sector/tech"], "tags kept");
    assert.equal(row.tag_facets, null, "no scope survives a cancel");
    assert.equal(row.retry_at, null);
  }
  for (const { id } of [parkedPending, parkedExtract, parkedFace]) {
    assert.equal((await rowOf(id)).status, "held", "never-tagged → parked");
  }
  assert.equal(await rowOf(removedFetch.id), undefined, "the queued add's vehicle is gone");
  assert.equal(await getEntity(db, removedFetch.eid), null, "and its placeholder entity with it");
  assert.equal((await rowOf(refetching.id)).status, "held", "a fetched vehicle survives the cancel, parked");
  assert.ok(await getEntity(db, refetching.eid), "and keeps its entity");
  const started = await rowOf(startedQueued.id);
  assert.equal(started.status, "pending", "a started (mid_pass) row is left to finish");
  assert.equal(started.mid_pass, true, "its marker survives — still mid-pipeline");
  assert.equal((await rowOf(inFlight.id)).status, "processing", "in-flight rows are never touched");
});

// Both verbs through one door, in the order the UI produces them: a soft cancel
// that has to leave work running is exactly what puts Abort on offer (the modal
// reads `finishing` off this row), and the abort that follows reports none left.
test("the route: manager-gated, both verbs, and the arming sequence between them", async () => {
  const admin = await adminSession(db);
  const member = await seedUser(db, "cancel-member@test.local");
  const bid = await seedBoard(db, "cancel-route", [member.id]);
  await seedInstance(db, bid, "pending", { tags: ["sector/tech"] });
  await seedInstance(db, bid, "pending");
  await seedInstance(db, bid, "processing"); // a worker is holding this one

  const denied = await req(base, "POST", `/api/boards/${bid}/jobs/cancel-queued`, { sid: member.sid });
  assert.equal(denied.status, 403, "a member reads the queue, a manager empties it");

  const soft = await req(base, "POST", `/api/boards/${bid}/jobs/cancel-queued`, { sid: admin.sid });
  assert.equal(soft.status, 200);
  assert.equal(soft.json.restored, 1);
  assert.equal(soft.json.parked, 1);
  assert.equal(soft.json.removed, 0);
  assert.equal(soft.json.finishing, 1, "the in-flight row is what arms the hard verb");

  const hard = await req(base, "POST", `/api/boards/${bid}/jobs/cancel-queued`, { sid: admin.sid, body: { abort: true } });
  assert.equal(hard.status, 200);
  assert.equal(hard.json.parked, 1, "the in-flight bare row parked — no fence under abort");
  assert.equal(hard.json.discarding, 1, "its call finishes in the background and is discarded");
  assert.equal(hard.json.finishing, 0, "nothing is left running, so the verb disarms itself");

  const { jobs } = await listJobLog(db, bid, {});
  const rows = jobs.filter((j) => j.kind === "cancel");
  assert.equal(rows.length, 2, "one board-run row per cancel — the 'why did my queue vanish' answer");
  // Newest first: the abort, then the soft cancel that armed it.
  assert.deepEqual(rows.map((j) => j.detail.mode), ["abort", "queued"]);
  assert.equal(rows[0].detail.discarding, 1);
  assert.equal(rows[1].detail.restored, 1);
  assert.equal(rows.every((j) => j.outcome === "ok"), true);
});

// The admin panel's stop button now calls the member-facing route (global
// admins pass requireBoardManager), so there is one cancel door, not two.
test("an admin reaches the same route through board-manager access", async () => {
  const admin = await adminSession(db);
  const bid = await seedBoard(db, "cancel-admin");
  await seedInstance(db, bid, "pending", { tags: ["sector/tech"] });
  const r = await req(base, "POST", `/api/boards/${bid}/jobs/cancel-queued`, { sid: admin.sid });
  assert.equal(r.status, 200);
  assert.equal(r.json.restored, 1);
  assert.equal(r.json.parked, 0);
});

test("abort: the same rule with the fence off — in-flight rows settle, their landings discard", async () => {
  const bid = await seedBoard(db, "abort-matrix");
  const taggedInFlight = await seedInstance(db, bid, "processing", { tags: ["sector/tech"] });
  const bareExtracting = await seedInstance(db, bid, "extracting");
  const bareFacing = await seedInstance(db, bid, "facing");
  const midFetch = await seedInstance(db, bid, "fetching", { payload: { unfetched: true, source: { id: "y" } } });
  const startedQueued = await seedInstance(db, bid, "pending", { midPass: true });

  const counts = await cancelBoardQueue(db, bid, { abort: true });
  assert.deepEqual(counts, { restored: 1, parked: 3, removed: 1, finishing: 0, discarding: 4 });

  assert.equal((await rowOf(taggedInFlight.id)).status, "tagged", "a mid-tag row with tags restores");
  assert.equal((await rowOf(bareExtracting.id)).status, "held", "a mid-extract bare row parks");
  assert.equal((await rowOf(bareFacing.id)).status, "held");
  assert.equal((await rowOf(startedQueued.id)).status, "held", "mid_pass no longer shields a queued row");
  assert.equal(await rowOf(midFetch.id), undefined, "a mid-fetch vehicle is deleted");

  // The whole design leans on this: the call that was in the air lands into
  // the fence and is DISCARDED — the aborted row keeps its settled state.
  const landed = await markTagged(db, taggedInFlight.id, ["sector/finance"]);
  assert.equal(landed, false, "the landing fence drops the in-flight result");
  assert.deepEqual((await rowOf(taggedInFlight.id)).tags, ["sector/tech"], "the restored tags survive the late landing");
});

