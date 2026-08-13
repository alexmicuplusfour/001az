// What the two ingestion adapters share about their enumerated-window caches.
// Both walk a source in full and cache the result briefly; both bound cost by
// FREQUENCY (one listing per cache window) rather than by reach, because a
// capped window CLOGS — the ledger dedups downstream, not during the walk, so
// once the first N are ingested they keep filling the window and everything
// past N becomes permanently unreachable.
//
// They kept private copies of these three pieces until the connector window
// lost its ration and grew from 1,000 rows to a whole catalog: at that size a
// cache that never evicts is the leak `pruneExpired` was written to prevent on
// the file side, and the file side was the only one that had it.

// Out-of-memory backstop for a pathological source, NOT a product ceiling —
// the reach limit is deliberately absent. Also the bound `validateIngest`
// checks a per-run limit against: past this, a limit couldn't be honored
// anyway, so a number that large is a typo rather than an intent.
export const SAFETY_CAP = 100000;

// Window cache TTL, read per call (not frozen at import) so tests can disable
// it; 0 = always fresh. Empty string counts as unset (default 60s), NOT as 0 —
// compose passes an unset knob through as "" (`${VAR:-}`), and Number("") is
// 0, which would silently disable the cache in the container. An explicit "0"
// still disables.
export const cacheTtl = () => {
  const v = process.env.INGEST_FEED_CACHE_MS;
  return v == null || v === "" ? 60000 : Number(v);
};

// How long one entry is worth keeping: the configured clock, or a multiple of
// what it COST to build, whichever is longer.
//
// A flat TTL assumes every fill costs about the same, and the metered catalogs
// broke that assumption in the most damaging possible way — a full CoinGecko
// walk is ~75 paced requests, so the fill took LONGER THAN THE TTL. An entry
// that expires before anything can reach it is not a cache: click Preview,
// wait, tweak a filter, click again, pay the whole walk a second time. Scaling
// by cost fixes it in the direction that matters and only there: the walk
// nobody wants to repeat is the one that sticks around.
//
// Three bounds keep that from becoming a licence. COST_MIN — a fill has to be
// genuinely slow before its duration counts for anything, so a cache-served FMP
// slice or an 8 ms local listing still expires on whatever clock the operator
// configured; without it, "10× the fill" would quietly overrule a deliberately
// short TTL with a number the operator never chose. COST_FACTOR — how many
// reads a fill that slow is worth. COST_TTL_MAX — "expensive" must not become
// "immortal"; a stale catalog is still a wrong answer.
const COST_MIN = 1000;
const COST_FACTOR = 10;
const COST_TTL_MAX = 15 * 60 * 1000;
const liveMs = (entry, ttl) =>
  (entry.cost || 0) < COST_MIN ? ttl : Math.max(ttl, Math.min(COST_TTL_MAX, entry.cost * COST_FACTOR));

// Drop entries whose window has lapsed. Called on every write, so residency
// tracks the live set rather than every config ever enumerated — an expired
// entry is a guaranteed miss anyway, and each one can pin a whole catalog.
// Reads the same per-entry lifetime the hit rule does, or a cheap fill would
// evict the expensive one it was meant to protect.
export function pruneExpired(cache, now, ttl) {
  for (const [k, v] of cache) if (now - v.at >= liveMs(v, ttl)) cache.delete(k);
}

// An entry carries TWO timestamps and they are not interchangeable: `at` is the
// last touch — what the TTL and pruneExpired read — and `first` is the fill,
// which a holding caller is measured against so a hold can't slide itself alive
// forever. Reading and writing them lives here rather than in each adapter
// because the adapters were already spelling the entry out twice, `at` came to
// mean "fill" on one side and "last touch" on the other, and pruneExpired reads
// it for both. Same reason the three pieces above ended up here.
//
// `hold` is the caller saying "I am mid-run and this window IS my run" (a drain
// tick resuming; see the ingestion sweep): serve the entry past the clock up to
// `hold` ms from its FILL, and touch it so a sibling's write can't prune a
// window still in use. 0 or absent = the clock alone, which is what every
// interactive caller wants. Returns null on a miss so the caller walks.
export function readWindow(cache, key, { ttl, hold = 0 } = {}) {
  const hit = cache.get(key);
  if (!hit || ttl <= 0) return null; // "0 disables" has to mean disabled for holders too
  const now = Date.now();
  if (!(now - hit.at < liveMs(hit, ttl) || (hold > 0 && now - hit.first < hold))) return null;
  if (hold > 0) hit.at = now;
  return { candidates: hit.candidates, truncated: hit.truncated };
}

// `startedAt` is when the fill began — the caller has it and the cache can't
// infer it. That duration is the entry's own lifetime input (see liveMs).
export function writeWindow(cache, key, ttl, result, startedAt = Date.now()) {
  if (ttl > 0) {
    const now = Date.now();
    pruneExpired(cache, now, ttl);
    cache.set(key, { at: now, first: now, cost: now - startedAt, ...result });
  }
  return result;
}

// Test seams (house convention: provider-pacing's _resetBuckets, FMP's
// _ageScreenerCache). Aging lets a test cross a TTL or a hold without waiting
// either out; both know the entry's two timestamps, so both live here.
export const resetWindow = (cache) => cache.clear();
export const ageWindow = (cache, ms) => {
  for (const v of cache.values()) { v.at -= ms; v.first -= ms; }
};
