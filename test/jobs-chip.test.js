// The jobs chip counts the `work` payload, whole, and nothing else
// (planning/instance-work-plan.md): every claimed instance and every waiting
// one, the sweep rows, the lane backlogs. It never reads the cards — reading
// them is what made it say 2 for 23 on a two-card board, and what would let it
// disagree with the modal and with History about what a job is.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import "./jsdom-stub.js";

const { state } = await import("../public/state.js");
const { JobsChip } = await import("../public/toolbar.js");
const { html, render } = await import("../public/vendor/preact.mjs");

beforeEach(() => {
  state.me = { id: 1, name: "tester" };
  state.boardId = "b1";
  state.boardPaused = false;
  state.jobsFailedAt = null;
  // Two cards in flight on every test — the chip must not count them.
  state.items = [
    { id: 1, status: "processing", tags: [] },
    { id: 2, status: "pending_extract", tags: [] },
  ];
  state.work = { running: [], queued: [] };
});

// The chip in a box of its own. It remembers what it last drew (the edge
// below), so a fresh box is a chip that has drawn nothing yet; drawing into
// the same box again is a repaint.
const drawChip = (box = document.createElement("div")) => {
  render(html`<${JobsChip} />`, box);
  return box.firstChild;
};

const leg = (kind, label, item_id) => ({
  id: null, kind, label, target: `${item_id}.png`, item_id, entity_id: 1,
  entity_display: "emma watson", started_at: Date.now() - 5000, leg: true,
});

test("the count is the payload: 3 claimed + 20 waiting on a two-card board reads 23", () => {
  state.work = {
    running: [leg("extract", "Extraction", 11), leg("extract", "Extraction", 12), leg("tag", "Tagging", 13)],
    queued: [{ kind: "extract", label: "Extraction", n: 20, leg: true }],
  };
  const chip = drawChip();
  assert.equal(chip.querySelector(".jobs-chip-count")?.textContent, "23");
  assert.ok(chip.classList.contains("busy"));
  assert.match(chip.title, /Extraction: 2 running, 20 waiting/);
  assert.match(chip.title, /Tagging: 1 running/);
});

test("two cards in flight with no work behind them is not a count", () => {
  const chip = drawChip();
  assert.equal(chip.querySelector(".jobs-chip-count"), null, "the chip is the payload, not the cards");
  assert.equal(chip.classList.contains("busy"), false);
  assert.equal(chip.title, "Job log");
});

test("a sweep row and a lane backlog count as they always did, beside the legs", () => {
  state.work = {
    running: [{ id: 7, kind: "transcribe", label: "Transcription", target: "clip.mp3", item_id: 3, entity_id: 3, entity_display: null, started_at: Date.now() - 60000 }],
    queued: [{ kind: "embed", label: "Embedding", n: 4 }, { kind: "tag", label: "Tagging", n: 2, leg: true }],
  };
  const chip = drawChip();
  assert.equal(chip.querySelector(".jobs-chip-count")?.textContent, "7");
  assert.match(chip.title, /Transcription: 1 running — Embedding: 4 waiting — Tagging: 2 waiting/);
});

test("a running embed batch counts as its items, beside the items still waiting", () => {
  // planning/embed-work-plan.md Stage 2: the server keeps a running batch's
  // items out of the waiting count and puts their number on the row as `n`.
  // Counted as one row, a 64-item batch would read "1 running" and the total
  // would drop by 63 the moment the batch started.
  state.work = {
    running: [{ id: 9, kind: "embed", label: "Embedding", target: null, item_id: null, entity_id: null, entity_display: null, started_at: Date.now() - 800, n: 64 }],
    queued: [{ kind: "embed", label: "Embedding", n: 936, fast: true }],
  };
  const chip = drawChip();
  assert.equal(chip.querySelector(".jobs-chip-count")?.textContent, "1000");
  assert.match(chip.title, /Embedding: 64 running, 936 waiting/);
});

// The idle↔busy edge (planning/ui-updates-plan.md, Stage 2). The chip is one
// element across repaints, so crossing the edge wears a class for the length
// of its CSS animation, dropped by a timer: with reduced motion the animations
// are off, and an animation's end would never come to drop it.
test("crossing into work wears .igniting and crossing out wears .cooling with the last count, each for 450ms", async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (ok) => { for (let i = 0; i < 100 && !ok(); i++) await wait(20); return ok(); };
  const box = document.createElement("div");
  const chip = drawChip(box);
  assert.equal(chip.className, "mapping-chip jobs-chip", "setup: idle, and nothing crossed yet");

  state.work = { running: [], queued: [{ kind: "tag", label: "Tagging", n: 5, leg: true }] };
  assert.equal(drawChip(box), chip, "a repaint keeps the element");
  assert.equal(chip.className, "mapping-chip jobs-chip busy igniting", "going busy wears the ignite class");
  await wait(250);
  assert.equal(chip.className, "mapping-chip jobs-chip busy igniting", "still igniting partway through the 450ms");
  assert.ok(await until(() => chip.className === "mapping-chip jobs-chip busy"), `the class goes once its time is up (${chip.className})`);

  state.work = { running: [], queued: [] };
  drawChip(box);
  assert.equal(chip.className, "mapping-chip jobs-chip cooling", "the queue draining wears the cool class");
  assert.equal(chip.querySelector(".jobs-chip-count")?.textContent, "5", "the ghost of the last count rides the cool-down");
  assert.ok(await until(() => chip.className === "mapping-chip jobs-chip"), `then the chip is idle (${chip.className})`);
  assert.equal(chip.querySelector(".jobs-chip-count"), null, "and the ghost is gone");
});
