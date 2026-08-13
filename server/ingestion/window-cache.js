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

// Drop entries whose window has lapsed. Called on every write, so residency
// tracks the live set rather than every config ever enumerated — an expired
// entry is a guaranteed miss anyway, and each one can pin a whole catalog.
export function pruneExpired(cache, now, ttl) {
  for (const [k, v] of cache) if (now - v.at >= ttl) cache.delete(k);
}
