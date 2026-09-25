// The poll cadence with lane work in the picture
// (planning/first-class-work-plan.md): a running sweep row is work MOVING —
// it holds the fast poll open exactly like an actively-worked item, paused
// board included (pause gates claims, not work already in the air). A
// transcription backlog with nothing running is work WAITING, and it drains
// at sweep pace (one clip at a time, minutes each), so it holds the SLOW
// tier, and the running row a claim produces promotes the cadence the moment
// work actually moves. A backlog the server marks `fast` (a leg, an embed
// batch) clears within a tick or two, so it holds the fast tier
// (planning/embed-work-plan.md D2).
import "./browser-stub.js";
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { pollDelay, workRunning, workInFlight, setWork } = await import("../public/data.js");
const { state } = await import("../public/state.js");

beforeEach(() => {
  state.items = [];
  state.uploading = [];
  state.alerts = [];
  state.boardPaused = false;
  state.boardMapping = null;
  state.boardIngestNextRun = null;
  state.work = { running: [], queued: [] };
});

test("a running sweep holds the fast poll open", () => {
  assert.equal(pollDelay(), 0, "nothing anywhere: no poll");
  setWork({ running: [{ id: 1, kind: "transcribe", label: "Transcription" }], queued: [] });
  assert.equal(workRunning(), true);
  assert.equal(pollDelay(), 4000, "a transcription is work moving — the transcript must land live");
  state.boardPaused = true;
  assert.equal(pollDelay(), 4000, "pause gates claims, not the job already in the air");
});

test("a transcription backlog holds the slow tier, running or not paused", () => {
  setWork({ running: [], queued: [{ kind: "transcribe", label: "Transcription", n: 3 }] });
  assert.equal(workRunning(), false);
  assert.equal(workInFlight(), true);
  assert.equal(pollDelay(), 30000, "a waiting transcription drains at sweep pace — track it, don't spin");
  state.boardPaused = true;
  assert.equal(pollDelay(), 30000, "paused backlog: intact queue, nothing on the way");
});

test("setWork ignores an absent payload and drained work lets the poll wind down", () => {
  setWork({ running: [], queued: [{ kind: "embed", label: "Embedding", n: 2, fast: true }] });
  setWork(undefined); // a server that predates the payload — keep the last known state
  assert.equal(workInFlight(), true);
  setWork({ running: [], queued: [] });
  assert.equal(workInFlight(), false);
  assert.equal(pollDelay(), 0);
});

test("a pipeline leg's backlog is fast-tier work; paused, it waits on the slow tier", () => {
  // The worker's next tick takes a waiting leg — unlike a transcription
  // backlog, which drains at sweep pace — so the poll follows it at claim
  // pace. The server marked the lane `fast`; nothing here knows which kinds
  // are legs.
  setWork({ running: [], queued: [{ kind: "tag", label: "Tagging", n: 18, leg: true, fast: true }] });
  assert.equal(workRunning(), false);
  assert.equal(pollDelay(), 4000, "a waiting leg is followed at claim pace");
  state.boardPaused = true;
  assert.equal(pollDelay(), 30000, "paused: the queue is intact and nothing is on the way");
  state.boardPaused = false;
  setWork({ running: [{ id: null, kind: "extract", label: "Extraction", leg: true }], queued: [] });
  assert.equal(pollDelay(), 4000, "a claimed leg is work moving, like any running row");
  // Drain, as the test above does: setWork woke the poll, and its pending tick
  // must find nothing to follow — or the file never exits.
  setWork({ running: [], queued: [] });
  assert.equal(pollDelay(), 0);
});

test("an embed backlog is fast-tier work though it is no leg; paused, it waits on the slow tier", () => {
  // The case that lingered: a tag lands, the next check finds its embedding
  // still due, and nothing is running. The embed sweep picks it up on its
  // next 3s poll and lands it a second or so later, so the check after that
  // has to come in 4s, not 30s, or the chip
  // keeps the count long after the work is done. `fast` is the mark that
  // says so; `leg` is absent because Cancel queued can't pull an embed.
  setWork({ running: [], queued: [{ kind: "embed", label: "Embedding", n: 1, fast: true }] });
  assert.equal(workRunning(), false);
  assert.equal(pollDelay(), 4000, "an embed backlog clears within a tick or two — follow it at claim pace");
  state.boardPaused = true;
  assert.equal(pollDelay(), 30000, "paused: the embed sweep skips this board, so nothing is on the way");
  state.boardPaused = false;
  setWork({ running: [], queued: [] }); // drain, as above
  assert.equal(pollDelay(), 0);
});

test("requeue mirrors the answer's work — the chip lights in the same render, not a poll later", async () => {
  // A per-card route answers the routed report AND the work it queued
  // (instance-work-plan.md, Stage 2 G1); requeue writes both into state.
  const { requeue } = await import("../public/data.js");
  const answer = { running: [], queued: [{ kind: "tag", label: "Tagging", n: 1, leg: true, fast: true }] };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true, entities: [], work: answer }) });
  await requeue("/api/items/1/reprocess");
  assert.deepEqual(state.work, answer, "the answer's work is in state before any poll ran");
  assert.equal(pollDelay(), 4000, "…and the poll follows it at claim pace");
  setWork({ running: [], queued: [] }); // drain, as above
});
