// The generated per-kind loop (queue-by-resource-plan.md Stage 3a): the one
// shape the worker's eight hand-written loops all were, with the resource pool
// underneath instead of a lane counter per pipeline stage.
//
// A KIND OF WORK hands over what's ready, how to identify a unit, what a unit
// contends for, and how to run one. The loop owns everything about WHEN and HOW
// MANY: reading the pool, sizing a claim, launching under containment, the
// sleep-and-wake cadence, the in-flight set, and the drain on stop. The kind
// keeps everything about what the work MEANS — its fences, its ledger writes,
// its retry policy — inside `run`, untouched.
//
//   kind = {
//     name,                       // the log
//     claims,                     // does `due` flip state? (the pipeline legs: yes)
//     due(db, { exclude, limit, onlyBoards?, excludeBoards? }) → unit[]
//     resourceOf(db, unit)→ string|null       // null = contends for nothing
//     run(db, unit)       → void              // one unit; may throw, the loop contains it
//     keys?(unit)         → id[]              // identity in the in-flight set; default [unit.id]
//     boardOf?(unit)      → boardId           // claiming kinds: to learn board → resource
//     prep?(db, unit[])   → void              // best-effort batch warm, never fatal
//     limit?, pollMs?, inFlight?              // batch; cadence; a SHARED set
//   }
//
// Kinds handed ONE in-flight set are one pipeline: they share a row namespace,
// so a settle on any of them wakes all of them.
//
// Two shapes of tick, because the two shapes of `due` are honestly different:
//
//   A CLAIMING kind's `due` flips rows in-flight in the database, so it may only
//   take what will actually run. Its tick is two steps. Step 1: for each resource
//   the loop already knows about that has room, an allow-list claim sized to
//   EXACTLY `free(r)`, restricted to that resource's boards. That is what sizes a
//   claim to a key once the stage lanes are gone — sum `free()` across resources
//   instead and one board with a hundred pending claims twenty-four rows against
//   a key with room for eight. Step 2: one deny-list catch-all, excluding every
//   known board, sized to a small allowance — how boards never seen before get
//   discovered, and how a board that contends for nothing gets served.
//
//   A SWEEP kind's `due` is a read. It enumerates once, the loop groups by
//   resource, launches at most `free(r)` per group, and drops the rest —
//   over-enumerating costs nothing, the leftovers come back next tick.
//
// Cadence: short after a tick that launched something (work is flowing), the
// kind's own poll otherwise; and every settling run wakes its loop, so a freed
// slot is refilled promptly rather than at the next poll. The old sweeps'
// `more` return value is subsumed by that wake — a run that stopped at its cap
// re-arms itself and `due` answers with it again the moment the loop asks.
//
// `sleep` is injectable so the cadence is TESTED by the delay it chose, never by
// a clock. worker-rework's Stage 3 wrote down why: a timing-based concurrency
// test proved flaky and was dropped.
import { free } from "./resource-pool.js";

const SHORT_MS = 200;
const DEFAULT_POLL_MS = Number(process.env.POLL_MS || 3000);
const DEFAULT_LIMIT = 8;  // a sweep's batch when it names none
const ALLOWANCE = 4;      // a claiming kind's catch-all; the one bounded over-claim

// A cancellable sleep. Cancel resolves it early — that is the wake.
export const realSleep = (ms) => {
  let timer, resolve;
  const promise = new Promise((r) => { resolve = r; timer = setTimeout(r, ms); });
  return { promise, cancel: () => { clearTimeout(timer); resolve(); } };
};

export function runKinds(kinds, { db, sleep = realSleep, pollMs = DEFAULT_POLL_MS, log = console } = {}) {
  let running = true;
  const runs = new Set();    // every in-flight run, for the drain
  const wakes = new Map();   // kind -> wake()

  const keysOf = (kind, unit) => (kind.keys ? kind.keys(unit) : [unit.id]);

  function launch(kind, unit) {
    const set = kind.inFlight;
    const ids = keysOf(kind, unit);
    for (const id of ids) set.add(id);
    const p = Promise.resolve()
      .then(() => kind.run(db, unit))
      // Containment. Each kind's `run` keeps its own catch blocks — but those
      // blocks write to the database, and a database that has gone away
      // rejects the catch itself. Nobody awaits this promise until stop(), so
      // an escaped throw here is an unhandled rejection and Node exits.
      .catch((e) => log.error(`worker ${kind.name} error (${ids.join(",")}):`, e?.message ?? e))
      .finally(() => {
        for (const id of ids) set.delete(id);
        runs.delete(p);
        // A slot freed — refill now, not at the next poll. Every kind sharing
        // this set is woken: a shared namespace means the kinds hand rows to
        // each other (an extract landing writes `pending`, the tag leg's queue),
        // and the single dispatcher they replace got this free by refilling all
        // four lanes on any settle.
        for (const k of kinds) if (k.inFlight === set) wakes.get(k)?.();
      });
    runs.add(p);
  }

  async function launchAll(kind, units) {
    if (!units.length) return 0;
    if (kind.prep) {
      // An economics hook (a cache prewarm). A throw here must not strand rows
      // a claiming `due` already flipped in-flight, so it can never abort the tick.
      try { await kind.prep(db, units); }
      catch (e) { log.warn(`worker ${kind.name} prep failed (continuing):`, e?.message ?? e); }
    }
    for (const unit of units) launch(kind, unit);
    return units.length;
  }

  // `known` is what this claiming kind has learned about which board contends
  // for what — per kind, because a board's tag key and its extract key can
  // differ. Stale for at most one tick after a board's binding changes (the
  // launch re-resolves and rewrites the entry), which is a bounded mis-grouping,
  // never a wrong claim.
  async function learn(kind, known, units) {
    if (!kind.boardOf) return;
    for (const unit of units) {
      try { known.set(kind.boardOf(unit), await kind.resourceOf(db, unit)); }
      catch { /* unresolvable = unconstrained; the board just never enters step 1 */ }
    }
  }

  async function tickClaiming(kind, known) {
    let launched = 0;

    // Step 1 — per known resource with room, exactly its free slots.
    const byResource = new Map();
    for (const [boardId, r] of known) {
      if (r == null) continue;
      if (!byResource.has(r)) byResource.set(r, []);
      byResource.get(r).push(boardId);
    }
    for (const [r, boards] of byResource) {
      const n = free(r);
      if (n <= 0) continue;
      const units = await kind.due(db, { exclude: [...kind.inFlight], limit: n, onlyBoards: boards });
      await learn(kind, known, units);
      launched += await launchAll(kind, units);
    }

    // Step 2 — the catch-all: boards never seen, and boards that contend for
    // nothing. Every known constrained board is excluded, so nothing here can
    // exceed what step 1 already sized.
    const constrained = [...known].filter(([, r]) => r != null).map(([b]) => b);
    const units = await kind.due(db, { exclude: [...kind.inFlight], limit: ALLOWANCE, excludeBoards: constrained });
    await learn(kind, known, units);
    launched += await launchAll(kind, units);
    return launched;
  }

  async function tickSweep(kind) {
    const units = await kind.due(db, { exclude: [...kind.inFlight], limit: kind.limit ?? DEFAULT_LIMIT });
    if (!units.length) return 0;
    // Group by resource; a null resource contends for nothing and all of it goes.
    const groups = new Map();
    for (const unit of units) {
      const r = await kind.resourceOf(db, unit);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r).push(unit);
    }
    const picked = [];
    for (const [r, us] of groups) picked.push(...(r == null ? us : us.slice(0, free(r))));
    return launchAll(kind, picked);
  }

  async function loop(kind) {
    kind.inFlight ??= new Set();
    const known = new Map();  // boardId -> resource|null (claiming kinds only)
    // A wake mid-sleep cancels the sleep; a wake mid-tick is kept for the end of
    // the tick rather than lost until the next poll — the dispatcher this
    // replaces covered that gap with its short poll and still lost the idle case.
    let sleeping = null;
    let pending = false;
    wakes.set(kind, () => { if (sleeping) sleeping.cancel(); else pending = true; });
    while (running) {
      let launched = 0;
      try { launched = await (kind.claims ? tickClaiming(kind, known) : tickSweep(kind)); }
      catch (e) { log.error(`worker ${kind.name} tick error:`, e?.message ?? e); }
      if (!running) break;
      if (pending) { pending = false; continue; }
      sleeping = sleep(launched ? SHORT_MS : (kind.pollMs ?? pollMs));
      await sleeping.promise;
      sleeping = null;
    }
  }

  const loops = kinds.map((k) => loop(k));

  // Nudge every kind. Three callers create claimable rows without knowing which
  // kind picks them up — a retag, a moved live field, a feed admission.
  const wakeAll = () => { for (const w of wakes.values()) w(); };

  // Stop claiming now; the returned promise resolves once every loop has left
  // its tick and every launched run has settled. The caller caps the wait.
  const stop = () => {
    running = false;
    wakeAll();
    return (async () => {
      await Promise.all(loops);
      await Promise.all([...runs]);
    })();
  };

  return { stop, wakeAll };
}
