// The generated per-kind loop (queue-by-resource-plan.md Stage 3a), driven by
// a fake kind and an injected sleep. Every cadence assertion reads the delay the
// loop CHOSE; nothing here waits on a clock.
//
// Every fake `due` yields one macrotask, the way a real one does across the
// database round-trip. Without that, wake-on-settle → re-tick is a pure
// microtask cycle that starves setImmediate, and a test that waits for the loop
// to settle never returns — a shape production cannot produce, since every real
// `due` is a query.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { runKinds } from "../server/resource-loop.js";
import { _reset as resetPool, wait, release, free, maxFor, backoff } from "../server/resource-pool.js";

beforeEach(() => resetPool());

const io = () => new Promise((r) => setImmediate(r));
// Drain microtasks and a few macrotask turns — enough for any launch chain the
// loop creates, and stable under load in a way a timeout is not.
const settle = async () => { for (let i = 0; i < 6; i++) await io(); };

// A sleep the test controls: records the delay, resolves only when the test
// releases it (or the loop wakes it). This is what makes the loop steppable.
function fakeSleep() {
  const delays = [];
  const pending = [];
  const sleep = (ms) => {
    delays.push(ms);
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const entry = { resolve, cancelled: false };
    pending.push(entry);
    return { promise, cancel: () => { entry.cancelled = true; resolve(); } };
  };
  const step = async () => { for (const p of pending.splice(0)) p.resolve(); await settle(); };
  return { sleep, delays, pending, step };
}

// A sweep kind over an in-memory backlog. `due` is a READ: it never removes what
// it returns, so a unit still in flight comes back next tick and only `exclude`
// keeps it out. What DOES remove a unit is its work landing — a real sweep's
// "is this due" answer changes when the run completes (the vector is written,
// the transcript lands). The fake mirrors that in a finally, success or throw,
// or a completed unit would be re-launched forever and a held one would never
// let `stop()` drain.
function sweepKind(name, backlog, { resource = () => null, run = async () => {}, limit } = {}) {
  const calls = [];
  return {
    kind: {
      name, claims: false, limit,
      due: async (_db, args) => { await io(); calls.push(args); return backlog.filter((u) => !args.exclude.includes(u.id)).slice(0, args.limit); },
      keys: (u) => [u.id],
      resourceOf: async (_db, u) => resource(u),
      run: async (_db, u) => {
        try { await run(u); }
        finally { const i = backlog.indexOf(u); if (i >= 0) backlog.splice(i, 1); }
      },
    },
    calls,
  };
}

// A claiming kind: `due` REMOVES what it returns (the status flip), and honours
// both lists exactly as claimFairBatch does.
function claimingKind(name, backlog, { resource = () => null, run = async () => {} } = {}) {
  const calls = [];
  return {
    kind: {
      name, claims: true,
      due: async (_db, args) => {
        await io();
        calls.push(args);
        const picked = backlog.filter((u) =>
          !args.exclude.includes(u.id)
          && !(args.excludeBoards || []).includes(u.board)
          && (args.onlyBoards == null || args.onlyBoards.includes(u.board))
        ).slice(0, args.limit);
        for (const u of picked) backlog.splice(backlog.indexOf(u), 1);
        return picked;
      },
      keys: (u) => [u.id],
      boardOf: (u) => u.board,
      resourceOf: async (_db, u) => resource(u),
      run: async (_db, u) => run(u),
    },
    calls,
  };
}

// A run that parks until the test releases it — the only way to observe a tick
// before the loop, correctly, moves on.
function holder() {
  const holds = [];
  const run = () => new Promise((r) => holds.push(r));
  const releaseAll = () => { for (const r of holds.splice(0)) r(); };
  return { run, holds, releaseAll };
}

async function start(kinds, extra = {}) {
  const fs = fakeSleep();
  const ctl = runKinds(kinds, { db: null, sleep: fs.sleep, pollMs: 3000, log: { error() {}, warn() {} }, ...extra });
  await settle();
  return { ctl, ...fs, stop: () => ctl.stop() };
}

test("a sweep honours exclude: a unit in flight is not launched again", async () => {
  const ran = [];
  const h = holder();
  const { kind, calls } = sweepKind("s", [{ id: 1 }, { id: 2 }], { run: async (u) => { ran.push(u.id); await h.run(); } });
  const t = await start([kind]);
  assert.deepEqual(ran, [1, 2], "first tick launched both");
  assert.deepEqual(calls[0].exclude, [], "nothing was in flight yet");

  await t.step(); // a second tick while both still run
  assert.deepEqual(new Set(calls.at(-1).exclude), new Set([1, 2]), "both ids passed as exclude");
  assert.deepEqual(ran, [1, 2], "and neither launched twice");
  h.releaseAll();
  await t.stop();
});

test("a sweep groups by resource and launches at most free(r) per group; the rest come back", async () => {
  const R = "sidecar:extractor"; // max 1
  const ran = [];
  const h = holder();
  // The run takes and hands back its resource's slot, the way the wire does —
  // the loop reads the POOL to size a group, not the run.
  const { kind } = sweepKind("s", [{ id: 1, r: R }, { id: 2, r: R }, { id: 3, r: "conn:x" }], {
    resource: (u) => u.r,
    run: async (u) => { await wait(u.r); ran.push(u.id); try { await h.run(); } finally { release(u.r); } },
  });
  const t = await start([kind]);
  assert.deepEqual(ran, [1, 3], "one of the two on the max-1 resource, plus the other resource's unit");
  assert.equal(free(R), 0, "and the slot is genuinely held");

  h.releaseAll(); // unit 1 finishes, frees R, wakes the loop
  await settle();
  assert.ok(ran.includes(2), "the dropped unit was re-seen and launched once R had room");
  h.releaseAll();
  await t.stop();
});

test("a null resource contends for nothing: launched regardless of any pool state", async () => {
  const R = "sidecar:detector";
  await wait(R); // saturate something, just to prove it is irrelevant
  const ran = [];
  const h = holder();
  const { kind } = sweepKind("s", [{ id: 1 }, { id: 2 }, { id: 3 }], { run: async (u) => { ran.push(u.id); await h.run(); } });
  const t = await start([kind]);
  assert.deepEqual(ran, [1, 2, 3]);
  release(R);
  h.releaseAll();
  await t.stop();
});

test("a claiming kind: step 1 sizes each known resource to exactly free(r); step 2 excludes known boards", async () => {
  const A = "ai:x:aaaaaaaaaaaa";
  const backlog = [];
  for (let i = 1; i <= 20; i++) backlog.push({ id: i, board: "A" });
  for (let i = 21; i <= 25; i++) backlog.push({ id: i, board: "B" });
  const h = holder();
  const { kind, calls } = claimingKind("c", backlog, {
    resource: (u) => (u.board === "A" ? A : null),
    run: h.run,
  });
  const t = await start([kind]);
  // Tick 1: nothing known → only the catch-all ran, at the allowance.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 4);
  assert.deepEqual(calls[0].excludeBoards, []);
  assert.equal(calls[0].onlyBoards, undefined);

  // Tick 2: A is known. Hold one of A's slots directly so step 1's sizing is
  // provably read off the pool rather than a constant.
  await wait(A);
  await t.step();
  const step1 = calls.find((c) => c.onlyBoards);
  assert.ok(step1, "an allow-list claim was made for the known resource");
  assert.deepEqual(step1.onlyBoards, ["A"]);
  assert.equal(step1.limit, maxFor(A) - 1, "sized to exactly the resource's free slots");
  const step2 = calls.at(-1);
  assert.ok(step2.excludeBoards.includes("A"), "the catch-all excludes the known constrained board");
  assert.ok(!step2.excludeBoards.includes("B"), "B contends for nothing and is never excluded");
  release(A);
  h.releaseAll();
  await t.stop();
});

test("a rejecting run is contained and the loop keeps ticking", async () => {
  const errors = [];
  const backlog = [{ id: 1 }];
  let ran = 0;
  const { kind, calls } = sweepKind("s", backlog, {
    run: async () => { ran++; backlog.length = 0; throw new Error("db down"); },
  });
  const t = await start([kind], { log: { error: (...a) => errors.push(a.join(" ")), warn() {} } });
  assert.equal(ran, 1);
  assert.ok(errors.some((e) => /db down/.test(e)), "the throw was logged, not escaped");
  const before = calls.length;
  await t.step();
  assert.ok(calls.length > before, "the loop ticked again after the failure");
  await t.stop();
});

test("cadence: short after a launching tick, the kind's poll after an idle one", async () => {
  const backlog = [{ id: 1 }];
  const h = holder();
  const { kind } = sweepKind("s", backlog, { run: async () => { backlog.length = 0; await h.run(); } });
  kind.pollMs = 7000;
  const t = await start([kind]);
  assert.equal(t.delays[0], 200, "launched one → short poll");
  await t.step();
  assert.equal(t.delays[1], 7000, "launched none → the kind's own poll");
  h.releaseAll();
  await t.stop();
});

test("wakeAll cancels a pending sleep", async () => {
  const { kind } = sweepKind("s", []);
  const t = await start([kind]);
  assert.equal(t.pending.length, 1, "the loop is parked in its sleep");
  t.ctl.wakeAll();
  await settle();
  assert.ok(t.pending[0].cancelled, "the sleep was cancelled, not waited out");
  assert.equal(t.pending.length, 2, "and the loop ticked and parked again");
  await t.stop();
});

test("a settling run wakes its loop, so a freed slot is refilled without waiting for the poll", async () => {
  const h = holder();
  const { kind, calls } = sweepKind("s", [{ id: 1 }], { run: () => h.run() });
  const t = await start([kind]);
  const before = calls.length;
  h.releaseAll();
  await settle();
  assert.ok(calls.length > before, "the settle re-ticked the loop");
  assert.ok(t.pending[0].cancelled, "by cancelling the sleep it was parked in");
  await t.stop();
});

test("stop resolves only after an in-flight run does", async () => {
  const h = holder();
  const { kind } = sweepKind("s", [{ id: 1 }], { run: () => h.run() });
  const t = await start([kind]);
  let stopped = false;
  const stopping = t.ctl.stop().then(() => { stopped = true; });
  await settle();
  assert.equal(stopped, false, "the drain waits for the run");
  h.releaseAll();
  await stopping;
  assert.equal(stopped, true);
});

test("two kinds handed one Set share it — the legs are one row namespace", async () => {
  const shared = new Set();
  const h = holder();
  const a = sweepKind("a", [{ id: 1 }], { run: () => h.run() });
  const b = sweepKind("b", [{ id: 2 }], { run: () => h.run() });
  a.kind.inFlight = shared;
  b.kind.inFlight = shared;
  const t = await start([a.kind, b.kind]);
  assert.deepEqual([...shared].sort(), [1, 2], "both kinds' units are in the one set");
  h.releaseAll();
  await t.stop();
  assert.equal(shared.size, 0, "and both cleared it on settle");
});

// The four worker legs hand rows to each other — an extract landing writes
// `pending`, which is the tag leg's queue — so a settle on one leg must refill
// the others. The single dispatcher they replace got that for free by refilling
// all four lanes on any completion; independent loops only get it because the
// wake follows the SHARED in-flight set.
test("a settle wakes the kinds sharing its in-flight Set, and no others", async () => {
  const shared = new Set();
  const h = holder();
  const a = sweepKind("a", [{ id: 1 }], { run: () => h.run() });
  const b = sweepKind("b", []); // same pipeline as a
  const c = sweepKind("c", []); // a different kind of work entirely
  a.kind.inFlight = shared;
  b.kind.inFlight = shared;
  const t = await start([a.kind, b.kind, c.kind]);
  const bBefore = b.calls.length;
  const cBefore = c.calls.length;

  h.releaseAll(); // a's run settles
  await settle();
  assert.ok(b.calls.length > bBefore, "the sibling sharing the set re-ticked");
  assert.equal(c.calls.length, cBefore, "the unrelated kind was left asleep");
  await t.stop();
});

test("backoff zeroes free for its window while wait still proceeds", async () => {
  const R = "conn:coingecko";
  backoff(R, 60_000);
  assert.equal(free(R), 0, "the dispatcher sees no room");
  let proceeded = false;
  wait(R).then(() => { proceeded = true; });
  await settle();
  assert.equal(proceeded, true, "a caller — a search route, say — is not held hostage to it");
  release(R);
});
