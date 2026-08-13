// The cadence layer, extracted from signals.js so /boards can share it
// (boards-signals-plan.md). Every behaviour below is behaviour signals.js has
// had since it shipped and none of it was pinned — which is the argument for
// doing the extraction as its own slice rather than as part of the feature that
// wanted it.
//
// Driven through the returned `tick()` rather than through mocked timers: each
// case here is a property of ONE tick, and a fake clock would add a moving part
// to tests whose subject is exactly the handling of time. Intervals are chosen
// instead — `every: 0` for always-due, a large `every` for never-due — so the
// real clock is never raced.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./browser-stub.js";

const { createTicker } = await import("../public/ticker.js");

// browser-stub's document has no `hidden`, and the visibilitychange listener
// start() registers needs somewhere to go. Both are set here rather than in the
// stub: this is the only test that has an opinion about tab visibility, and the
// stub is shared.
globalThis.document.hidden = false;
globalThis.document.addEventListener = () => {};

const NEVER = 10 * 60 * 1000;

// start() arms a real setInterval, which would hold the event loop open long
// after the assertions are done — the test run simply never exits. Every case
// that starts a ticker goes through here, which also makes the interval
// countable for the idempotence case.
function starting(t) {
  let intervals = 0;
  const real = globalThis.setInterval;
  // A TRUTHY handle: the double-start guard is `if (timer) return`, and a stub
  // returning 0 would defeat it and report a bug the browser cannot have — no
  // engine hands out timer id 0.
  globalThis.setInterval = () => ++intervals;
  try {
    t.start();
    t.start();
  } finally {
    globalThis.setInterval = real;
  }
  return intervals;
}

// A signal that records its calls, with an optional gate and an optional hang.
function probe(name, { every = 0, when, hang } = {}) {
  const s = {
    name, every, when,
    calls: 0,
    run() {
      s.calls++;
      return hang ? new Promise((res) => { s.release = res; }) : Promise.resolve();
    },
  };
  return s;
}

test("a hidden tab fetches nothing", async () => {
  const s = probe("a");
  const t = createTicker({ tickMs: NEVER, signals: [s] });
  globalThis.document.hidden = true;
  await t.tick();
  assert.equal(s.calls, 0, "hidden tab must not fetch");
  globalThis.document.hidden = false;
  await t.tick();
  assert.equal(s.calls, 1, "and must catch up once visible");
});

test("`ready` gates the whole ticker, not one signal", async () => {
  const s = probe("a");
  let live = false;
  const t = createTicker({ tickMs: NEVER, signals: [s], ready: () => live });
  await t.tick();
  assert.equal(s.calls, 0);
  live = true;
  await t.tick();
  assert.equal(s.calls, 1);
});

test("start() stamps, so the first tick is a refresh rather than a duplicate", async () => {
  // The boot fetch has already filled these; a tick that ran immediately would
  // re-issue the same requests a moment after the page issued them.
  const s = probe("a", { every: NEVER });
  const t = createTicker({ tickMs: NEVER, signals: [s] });
  starting(t);
  await t.tick();
  assert.equal(s.calls, 0);
});

test("a signal is not fetched more often than its own `every`", async () => {
  const fast = probe("fast", { every: 0 });
  const slow = probe("slow", { every: NEVER });
  const t = createTicker({ tickMs: NEVER, signals: [fast, slow] });
  await t.tick();
  await t.tick();
  assert.equal(fast.calls, 2);
  assert.equal(slow.calls, 1, "due once on the first tick, not again");
});

test("`when` skipping a signal leaves its lastAt alone", async () => {
  // The point of the rule: closing the jobs modal must refresh on the NEXT tick,
  // not up to `every` later. If a skipped tick stamped, the signal would look
  // freshly fetched at the moment it became eligible again.
  let visible = false;
  const s = probe("a", { every: NEVER, when: () => visible });
  const t = createTicker({ tickMs: NEVER, signals: [s] });
  await t.tick();
  assert.equal(s.calls, 0, "skipped while its surface is off screen");
  visible = true;
  await t.tick();
  assert.equal(s.calls, 1, "due immediately once it comes back");
});

test("lastAt is stamped before the await, so a slow fetch is not double-started", async () => {
  // A real `every` is load-bearing here: at `every: 0` a signal is due every
  // tick by definition, and a second fetch would be correct rather than a bug.
  // What is being pinned is that the stamp lands before the await, so the tick
  // arriving mid-fetch sees a signal that has already been claimed.
  const s = probe("a", { every: NEVER, hang: true });
  const t = createTicker({ tickMs: NEVER, signals: [s] });
  const first = t.tick();
  await t.tick(); // lands while the first fetch is still in flight
  assert.equal(s.calls, 1, "one in-flight fetch, not two");
  s.release();
  await first;
});

test("one signal's failure takes neither the batch nor the render with it", async () => {
  const bad = { name: "bad", every: 0, run: () => Promise.reject(new Error("network")) };
  const good = probe("good");
  let batches = 0;
  const t = createTicker({ tickMs: NEVER, signals: [bad, good], onBatch: () => batches++ });
  await t.tick(); // must not reject — a rejection here is an unhandled one
  assert.equal(good.calls, 1);
  assert.equal(batches, 1);
});

test("onBatch fires once per batch, and not at all when nothing is due", async () => {
  // Every signal feeds the same surface, so a render per signal repaints it to
  // the same pixels.
  const a = probe("a", { every: 0 });
  const b = probe("b", { every: 0 });
  let batches = 0;
  const t = createTicker({ tickMs: NEVER, signals: [a, b], onBatch: () => batches++ });
  await t.tick();
  assert.equal(batches, 1, "two signals, one render");
  a.every = b.every = NEVER;
  await t.tick();
  assert.equal(batches, 1, "nothing due, nothing rendered");
});

test("start() is idempotent", async () => {
  // Which is also what keeps the visibilitychange listener registered once —
  // `starting` calls start() twice, so one interval is the whole assertion.
  const t = createTicker({ tickMs: NEVER, signals: [probe("a", { every: NEVER })] });
  assert.equal(starting(t), 1);
});
