// The ingestion status presenter (public/ingest-present.js) — the precedence
// ladder tested the capability-present way: trio in, chip verdict out, no
// DOM. The rules under test are the toolbar chip's two oldest — "a pending
// run outranks the mode" and "failing tints, the countdown IS the retry" —
// pinned here so they can stop being copied per surface
// (ingest-status-plan.md stage 3 migrates the two existing copies onto this).
import test from "node:test";
import assert from "node:assert/strict";
import { presentIngest } from "../public/ingest-present.js";

const NOW = 1_700_000_000_000;
const at = (ms) => NOW + ms;

test("unconfigured / trigger Off: quiet neutral, no pulse", () => {
  assert.deepEqual(presentIngest({ mode: null, now: NOW }), {
    state: "off", tone: "neutral", live: false, dim: true, due: false, left: null,
    label: "Off", title: "No automatic trigger — the board ingests only on demand.",
  });
  // "manual" is the same UI state as unconfigured: the automatic part is off.
  assert.equal(presentIngest({ mode: "manual", now: NOW }).label, "Off");
});

test("the state discriminant names every rung — compact surfaces switch on it", () => {
  const s = (o) => presentIngest({ now: NOW, ...o }).state;
  assert.equal(s({ mode: "scheduled", nextRunAt: NOW }), "running");
  assert.equal(s({ mode: "scheduled", nextRunAt: NOW, error: true }), "retrying");
  assert.equal(s({ mode: "scheduled", nextRunAt: at(60e3), error: true }), "failing");
  assert.equal(s({ mode: "paused", error: true }), "held-failed");
  assert.equal(s({ mode: "manual", error: true }), "off-failed");
  assert.equal(s({ mode: "paused" }), "paused");
  assert.equal(s({ mode: "scheduled", triggerMode: "continuous", nextRunAt: at(60e3) }), "watching");
  assert.equal(s({ mode: "scheduled", nextRunAt: at(60e3) }), "scheduled");
  assert.equal(s({ mode: null }), "off");
});

test("paused: a deliberate hold is dim, never a warning tone", () => {
  const p = presentIngest({ mode: "paused", now: NOW });
  assert.deepEqual([p.tone, p.live, p.dim, p.label], ["neutral", false, true, "Paused"]);
});

test("armed watch: live pulse and a check countdown in the watch's words", () => {
  const p = presentIngest({ mode: "scheduled", triggerMode: "continuous", nextRunAt: at(8000), now: NOW });
  assert.deepEqual([p.tone, p.live, p.label], ["ok", true, "Watching — next check in 8s"]);
  // The countdown rides the verdict too, so compact surfaces (the toolbar's
  // bare eta) never re-derive dueness from raw state.
  assert.deepEqual([p.due, p.left], [false, 8000]);
});

test("armed schedule: static ok — enabled alone never pulses", () => {
  const p = presentIngest({ mode: "scheduled", triggerMode: "daily", nextRunAt: at(2 * 3600e3), now: NOW });
  assert.deepEqual([p.tone, p.live, p.label], ["ok", false, "Scheduled — next run in 2h"]);
});

test("trio-only surfaces (no triggerMode) fall back to schedule wording", () => {
  const p = presentIngest({ mode: "scheduled", nextRunAt: at(720e3), now: NOW });
  assert.equal(p.label, "Scheduled — next run in 12m");
});

test("due stamp: Running now, live — and it outranks the mode (paused included)", () => {
  const due = presentIngest({ mode: "scheduled", triggerMode: "daily", nextRunAt: NOW, now: NOW });
  assert.deepEqual([due.tone, due.live, due.label, due.due], ["ok", true, "Running now", true]);
  // The toolbar's oldest rule: a hand-fired run on a paused board is a run,
  // not the pause it falls back to when it lands.
  const paused = presentIngest({ mode: "paused", nextRunAt: at(-1000), now: NOW });
  assert.deepEqual([paused.tone, paused.label], ["ok", "Running now"]);
});

test("due + failing: the retry runs under the failure's tone", () => {
  const p = presentIngest({ mode: "scheduled", error: true, nextRunAt: NOW, now: NOW });
  assert.deepEqual([p.tone, p.live, p.label], ["error", true, "Retrying now"]);
});

test("failing with the retry ahead: the countdown IS the retry, no pulse", () => {
  const p = presentIngest({ mode: "scheduled", triggerMode: "continuous", error: true, nextRunAt: at(192e3), now: NOW });
  // Failing outranks the watch's wording — never "next check" while broken.
  assert.deepEqual([p.tone, p.live, p.dim, p.label], ["error", false, false, "Failing — retry in 3m"]);
});

test("failure on a hold keeps the hold's name but wears the failure's tone", () => {
  const paused = presentIngest({ mode: "paused", error: true, now: NOW });
  assert.deepEqual([paused.tone, paused.dim, paused.label], ["error", true, "Paused — last run failed"]);
  const off = presentIngest({ mode: "manual", error: true, now: NOW });
  assert.equal(off.label, "Off — last run failed");
});

test("scheduled but not yet stamped: the mode speaks, no countdown invented", () => {
  const watch = presentIngest({ mode: "scheduled", triggerMode: "continuous", now: NOW });
  assert.deepEqual([watch.tone, watch.live, watch.label], ["ok", true, "Watching"]);
  const daily = presentIngest({ mode: "scheduled", triggerMode: "daily", now: NOW });
  assert.deepEqual([daily.tone, daily.live, daily.label], ["ok", false, "Scheduled"]);
});
