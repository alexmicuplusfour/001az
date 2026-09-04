// Board pause (planning/job-control-plan.md, Stage 1): one flag, read by every
// due/claim query — pause gates EXECUTION, never intake. The queue keeps
// filling while paused and resume continues exactly where it left off, so the
// tests here are all pairs: gated while paused, claimable again after.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startServer, seedBoard, seedUser, adminSession, req, seedInstance } from "./helpers.js";
import {
  claimNextWork,
  updateBoard,
  dueBoards,
  dueIngestBoards,
  setIngestNextRun,
  dueLiveEntities,
  setEntityRefreshAt,
  itemsNeedingEmbedding,
  boardsWithVotes,
  getBoard,
  oneAudioNeedingTranscription,
} from "../server/db.js";

let srv, db, base;
before(async () => {
  srv = await startServer();
  ({ db, base } = srv);
});
after(() => srv.close());


test("claim: a paused board's queue waits, all four stages; resume claims again", async () => {
  const bid = await seedBoard(db, "pause-claim");
  for (const s of ["pending", "pending_extract", "pending_face", "pending_fetch"]) {
    await seedInstance(db, bid, s);
  }
  await updateBoard(db, bid, { paused: true });
  assert.equal(await claimNextWork(db, true), null, "nothing claims while paused");
  await updateBoard(db, bid, { paused: false });
  const claimed = [];
  for (let i = 0; i < 4; i++) claimed.push(await claimNextWork(db, true));
  assert.equal(claimed.filter(Boolean).length, 4, "the intact queue drains on resume");
  await db.query("UPDATE items SET status='failed' WHERE board_id=$1", [bid]);
});

test("scheduled retag: paused board is not due; the stamp survives and owes one run on resume", async () => {
  const bid = await seedBoard(db, "pause-retag");
  const past = Date.now() - 60000;
  await updateBoard(db, bid, { autoTag: true, autoTagPeriodic: true, autoTagEveryMin: 60, autoTagNextRunAt: past, paused: true });
  assert.ok(!(await dueBoards(db, Date.now())).some((b) => b.id === bid), "paused: not due");
  await updateBoard(db, bid, { paused: false });
  assert.ok((await dueBoards(db, Date.now())).some((b) => b.id === bid), "resume: the owed run is due");
  assert.equal(Number((await getBoard(db, bid)).auto_tag_next_run_at), past, "the stamp was never touched");
});

test("ingest sweep: paused board is not due even when armed ('Run now' defers to resume)", async () => {
  const bid = await seedBoard(db, "pause-ingest");
  await updateBoard(db, bid, { ingest: { source: {}, trigger: { mode: "manual" }, enabled: true }, paused: true });
  await setIngestNextRun(db, bid, Date.now() - 1000); // the "Run now" arm
  assert.ok(!(await dueIngestBoards(db, Date.now())).some((b) => b.id === bid), "armed but paused: waits");
  await updateBoard(db, bid, { paused: false });
  assert.ok((await dueIngestBoards(db, Date.now())).some((b) => b.id === bid), "resume: the queued run fires");
});

test("refresh sweep: a paused board's due entities are invisible", async () => {
  const bid = await seedBoard(db, "pause-refresh");
  const { eid } = await seedInstance(db, bid, "tagged", { payload: { source: { id: "x" } } });
  await setEntityRefreshAt(db, eid, Date.now() - 1000);
  assert.ok((await dueLiveEntities(db, Date.now())).some((r) => r.entity.id === eid), "due while running");
  await updateBoard(db, bid, { paused: true });
  assert.ok(!(await dueLiveEntities(db, Date.now())).some((r) => r.entity.id === eid), "gone while paused");
});

test("embed sweep: a paused board's tagged items are skipped", async () => {
  const bid = await seedBoard(db, "pause-embed");
  const { id } = await seedInstance(db, bid, "tagged");
  const mine = (rows) => rows.some((r) => r.id === id);
  assert.ok(mine(await itemsNeedingEmbedding(db, "m", 500)), "needs a vector while running");
  await updateBoard(db, bid, { paused: true });
  assert.ok(!mine(await itemsNeedingEmbedding(db, "m", 500)), "skipped while paused");
});

test("transcribe lane: a paused board's audio is skipped", async () => {
  const bid = await seedBoard(db, "pause-audio");
  const { id } = await seedInstance(db, bid, "held", { payload: { files: [{ name: "a.mp3", kind: "audio" }] } });
  assert.equal((await oneAudioNeedingTranscription(db, [], { globally: true }))?.id, id, "claims while running");
  await updateBoard(db, bid, { paused: true });
  assert.notEqual((await oneAudioNeedingTranscription(db, [], { globally: true }))?.id, id, "skipped while paused");
  await db.query("UPDATE items SET payload = payload || '{\"transcript\": \"\"}' WHERE id=$1", [id]);
});

test("facet diagnosis: a paused board leaves the vote roster", async () => {
  const bid = await seedBoard(db, "pause-diagnose");
  await updateBoard(db, bid, { aiVotes: 3 });
  assert.ok((await boardsWithVotes(db)).some((b) => b.id === bid), "on the roster while running");
  await updateBoard(db, bid, { paused: true });
  assert.ok(!(await boardsWithVotes(db)).some((b) => b.id === bid), "off the roster while paused");
});

test("the PATCH: managers flip it, members can't, both payloads carry it", async () => {
  const admin = await adminSession(db);
  const member = await seedUser(db, "pause-member@test.local");
  const bid = await seedBoard(db, "pause-patch", [member.id]);

  const denied = await req(base, "PATCH", `/api/boards/${bid}`, { sid: member.sid, body: { paused: true } });
  assert.equal(denied.status, 403, "a member can read the board, not hold it");

  const r = await req(base, "PATCH", `/api/boards/${bid}`, { sid: admin.sid, body: { paused: true } });
  assert.equal(r.status, 200);
  // The save response echoes it, and that is load-bearing: the client stamps
  // board payloads through one funnel that RESETS paused from whatever it is
  // handed, so an ingest save that omitted the flag would silently resume the
  // board on the client.
  assert.equal(r.json.paused, true, "the save response echoes the flag");
  const kept = await req(base, "PATCH", `/api/boards/${bid}`, { sid: admin.sid, body: { name: "pause-patch" } });
  assert.equal(kept.json.paused, true, "a save that doesn't mention pause still echoes it");
  const boardPayload = await req(base, "GET", `/api/boards/${bid}`, { sid: member.sid });
  assert.equal(boardPayload.json.paused, true, "the board payload says paused (chip + poll cadence)");
  const jobsPayload = await req(base, "GET", `/api/boards/${bid}/jobs`, { sid: member.sid });
  assert.equal(jobsPayload.json.paused, true, "the jobs payload says paused (the modal's heartbeat)");
});

test("unpause floors overdue refresh stamps to now; future stamps and pausing itself touch nothing", async () => {
  const admin = await adminSession(db);
  const bid = await seedBoard(db, "pause-floor");
  const overdue = await seedInstance(db, bid, "tagged", { payload: { source: { id: "a" } } });
  const future = await seedInstance(db, bid, "tagged", { payload: { source: { id: "b" } } });
  const deepPast = Date.now() - 3 * 86400000;
  const ahead = Date.now() + 3600000;
  await setEntityRefreshAt(db, overdue.eid, deepPast);
  await setEntityRefreshAt(db, future.eid, ahead);

  await req(base, "PATCH", `/api/boards/${bid}`, { sid: admin.sid, body: { paused: true } });
  const stampAt = async (eid) => Number((await db.query("SELECT refresh_at FROM entities WHERE id=$1", [eid])).rows[0].refresh_at);
  assert.equal(await stampAt(overdue.eid), deepPast, "pausing floors nothing");

  const t0 = Date.now();
  await req(base, "PATCH", `/api/boards/${bid}`, { sid: admin.sid, body: { paused: false } });
  assert.ok((await stampAt(overdue.eid)) >= t0, "the overdue stamp floored to now — no head-of-line drain");
  assert.equal(await stampAt(future.eid), ahead, "a future stamp keeps its schedule");

  // A no-op save (paused stays false) must not floor either — the side-effect
  // fires only on the true→false edge.
  await setEntityRefreshAt(db, overdue.eid, deepPast);
  await req(base, "PATCH", `/api/boards/${bid}`, { sid: admin.sid, body: { paused: false, name: "pause-floor" } });
  assert.equal(await stampAt(overdue.eid), deepPast, "false→false is not an unpause");
});
