// The poll cadence with lane work in the picture
// (planning/first-class-work-plan.md): a running sweep row is work MOVING —
// it holds the fast poll open exactly like an actively-worked item, paused
// board included (pause gates claims, not work already in the air). A lane
// backlog with nothing running is work WAITING, and it drains at sweep pace
// (one clip at a time, a transcription is minutes) — so it holds the SLOW
// tier, not the fast one, and the running row a claim produces promotes the
// cadence the moment work actually moves.
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

test("a lane backlog holds the slow tier, running or not paused", () => {
  setWork({ running: [], queued: [{ kind: "transcribe", label: "Transcription", n: 3 }] });
  assert.equal(workRunning(), false);
  assert.equal(workInFlight(), true);
  assert.equal(pollDelay(), 30000, "waiting lane work drains at sweep pace — track it, don't spin");
  state.boardPaused = true;
  assert.equal(pollDelay(), 30000, "paused backlog: intact queue, nothing on the way");
});

test("setWork ignores an absent payload and drained work lets the poll wind down", () => {
  setWork({ running: [], queued: [{ kind: "embed", label: "Embedding", n: 2 }] });
  setWork(undefined); // a server that predates the payload — keep the last known state
  assert.equal(workInFlight(), true);
  setWork({ running: [], queued: [] });
  assert.equal(workInFlight(), false);
  assert.equal(pollDelay(), 0);
});
