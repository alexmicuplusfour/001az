// Concurrency bounded by RESOURCE, beside the rate limiter that is already
// bounded that way (queue-by-resource-plan.md Stage 1).
//
// provider-pacing.js answers "how OFTEN may this key be called". This answers
// "how MANY of its calls may be in flight at once". Same keys, deliberately:
// `ai:<provider>:<keyhash>` from providers.js aiKeyBucket, `conn:<name>` from
// connectors/runtime.js, `sidecar:<engine>` for the on-host engines. Two
// limiters keyed on one vocabulary can't end up bounding different things under
// one name — which is the whole defect this replaces, where concurrency was
// keyed on the PIPELINE STAGE and rate on the resource, so a throttled key held
// slots that boards on other keys needed.
//
// This is the bulkhead pattern: one pool per downstream dependency, so a slow
// one exhausts only its own capacity. The property worth stating, because it is
// the only reason the module exists: saturating one resource leaves every other
// resource untouched.
//
// Unlike the pacing bucket there is no learned penalty here — a count has no
// analogue of "the provider said slow down" until something adapts the limit
// (see the plan's Layer 1 research on adaptive limits; `AI_INFLIGHT` is a
// ceiling for now, not a target).

// resource -> { used, waiters }. Created on first sight; a resource never seen
// is simply idle, which is why `free` answers for one without allocating.
const pools = new Map();

const poolFor = (resource) => {
  let p = pools.get(resource);
  if (!p) { p = { used: 0, waiters: [], backoffUntil: 0 }; pools.set(resource, p); }
  return p;
};

// How many at once, by resource CLASS — the prefix, never a vendor name. A
// provider that wants its own number says so through the Plugins-page config
// the way rpm/burst already do; this is the class default underneath.
//
// Only the prefixes that have a caller today. `src:` (file feeds) arrives with
// the stage that adopts it — an uncalled entry is the same smell as an
// unreachable env knob, and the table is data, so it costs nothing to grow later.
//
//   sidecar:  the extractor, detector and whisper containers are each
//             single-threaded by construction. A second request doesn't run, it
//             waits at the socket — better to wait here, where the dispatcher
//             can see it and claim something else instead.
//   ai:       a key's in-flight fuse. Memory and cost, not rate (the bucket
//             owns rate) — the name and default carry over from AI_INFLIGHT.
//   conn:     one provider's quota, ceiling from FETCH_CONCURRENCY.
//   local:    an on-device model — one model, in this process, so what it
//             contends for is the BOX. The one class NOT held at the wire: it is
//             held by the BULK caller (the embedding sweep), because a search box
//             embedding one string is not what needed bounding, and counting it
//             would make `free()` read zero because somebody typed — the whisper
//             probe stays out of its own count for the same reason.
//   webhook:  one receiving host. Small on purpose, and not for our sake: the
//             endpoint belongs to somebody else, and the win here is that two
//             HOSTS stop queueing behind each other — which the old sweep, one
//             sequential loop over every pending firing, denied them. Within a
//             single host 2 collects essentially all of that and eight
//             simultaneous posts to a stranger's server collects none of it.
//
// Anything else gets a permissive default: defaults, not laws. An unclassified
// resource should behave as it does today, never worse.
const DEFAULT_MAX = 8;
export function maxFor(resource) {
  const r = String(resource || "");
  if (r.startsWith("sidecar:")) return 1;
  if (r.startsWith("ai:")) {
    return Math.max(1, Number(process.env.AI_INFLIGHT) || Number(process.env.TAG_CONCURRENCY) || 8);
  }
  if (r.startsWith("conn:")) return Math.max(1, Number(process.env.FETCH_CONCURRENCY) || 3);
  if (r.startsWith("local:")) return 1;
  if (r.startsWith("webhook:")) return 2;
  return DEFAULT_MAX;
}

// Slots available right now. The DISPATCHER's question — it reads this to size
// a claim and never takes, because a claimed row is a database commitment while
// a slot is a memory one, and the two should not be held on each other. Between
// a claim and its first call a unit holds nothing.
export const free = (resource) => {
  const p = poolFor(resource);
  if (Date.now() < p.backoffUntil) return 0;
  return Math.max(0, maxFor(resource) - p.used);
};

// "This resource is unwell — stop claiming for it." Zeroes `free` for the
// window and touches NOTHING else: not `wait`, not `release`, not the count.
// It is a signal to the dispatcher, which sizes claims by `free`, so a backed-off
// key's boards drop out of the claim and its queue stops growing.
//
// Deliberately not a gate on `wait`. Search routes call embedTexts on the same
// wire; a `wait` that honoured a backoff would hang a search for the whole window.
// Callers proceed and fail fast — the failure is the same one that caused the
// backoff, reported where the caller can see it. This replaces the three
// hand-written `*BackoffUntil` timers the sweeps kept (queue-by-resource-plan.md
// Stage 3a); each of those only ever gated its own loop, which is the same
// contract, spelled once.
export function backoff(resource, ms) {
  poolFor(resource).backoffUntil = Date.now() + Math.max(0, ms);
}

// Take a slot, waiting when the resource is full. The CALLER's question, asked
// at the outbound call itself (the AI wire, callProvider, the sidecar fetches)
// so that routes and the worker land in the same count — half the demand on
// these resources never goes through the worker at all.
//
// Waiters queue FIFO and unbounded, exactly as the pacing chain already does.
// The dispatcher cannot contribute to that queue by construction (it claims no
// more than `free`); a flood of interactive requests could, and that is worth
// knowing before it is worth machinery.
export function wait(resource) {
  const p = poolFor(resource);
  if (p.used < maxFor(resource)) { p.used++; return Promise.resolve(); }
  return new Promise((resolve) => p.waiters.push(resolve));
}

// Hand the slot on: to the next waiter if there is one (the count never dips,
// so a queued caller can't lose its turn to a newcomer), else back to the pool.
//
// Clamped at zero. Release is called from `finally` blocks, which is exactly
// where a double-release comes from — an error path that unwinds twice, a
// retry wrapper that already released. Going negative would silently raise the
// ceiling, so the floor is the safer failure.
export function release(resource) {
  const p = poolFor(resource);
  const next = p.waiters.shift();
  if (next) { next(); return; }
  p.used = Math.max(0, p.used - 1);
}

// Test seam, mirroring provider-pacing's _resetBuckets.
export function _reset() { pools.clear(); }
// Test seam: in-flight count for a resource, which `free` only reports through
// the ceiling.
export const _usedOf = (resource) => pools.get(resource)?.used ?? 0;
