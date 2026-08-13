// The quote plane both crypto providers run on. What differs between them is
// the request (a CoinGecko `/coins/markets` page vs a CoinMarketCap
// `quotes/latest` bundle) and the field mapping — everything AROUND that is
// the same machinery, and it was written twice: the TTL, the eviction bound,
// the dedupe in prefetch, the "read cache, else fetch" step, the key-subset
// projection, the test seam.
//
// It had already drifted after one commit (one provider stringified its keys
// and the other leaned on its caller to do it), which is the argument for one
// copy: these are economics knobs, and a board's monthly cost depends on them
// agreeing.
//
// The TTL default matches what both vendors publish as their own cache
// frequency for these endpoints — polling faster buys nothing but quota.
const DEFAULT_TTL = 60 * 1000;
const DEFAULT_MAX = 20000;

export function createQuoteCache({ ttl = DEFAULT_TTL, max = DEFAULT_MAX, idOf = (row) => row?.id } = {}) {
  const rows = new Map(); // String(id) -> { at, row }

  // Ids arrive as numbers from one API and strings from the other, and as
  // whatever a stored board payload holds. Normalising here is what stops a
  // cache that silently never hits.
  const fresh = (id) => {
    const hit = rows.get(String(id));
    return hit && Date.now() - hit.at < ttl ? hit.row : null;
  };

  const warm = (fetched) => {
    for (const row of fetched || []) {
      const id = idOf(row);
      if (id == null) continue;
      const key = String(id);
      // Delete before set so re-insertion moves the key to the end: Map keeps
      // an existing key's original position, which would otherwise evict the
      // HOTTEST entries (the ones a sweep keeps refreshing) ahead of one-off
      // browse rows.
      rows.delete(key);
      rows.set(key, { at: Date.now(), row });
      if (rows.size > max) rows.delete(rows.keys().next().value);
    }
    return fetched;
  };

  // The ids a batch actually has to buy — deduped, minus what's already warm.
  const missing = (ids) => [...new Set((ids || []).map(String))].filter((id) => !fresh(id));

  return { fresh, warm, missing, reset: () => rows.clear(), get size() { return rows.size; } };
}

// The requested subset of an already-built field map. Absent keys stay absent
// rather than becoming nulls: runtime.refresh treats a missing due key as
// "this provider can't serve it" and falls back to the whole-object fetch,
// which is the behaviour a null would silently defeat.
export const pickFields = (all, keys) => {
  const fields = {};
  for (const key of new Set(keys || [])) if (all[key]) fields[key] = all[key];
  return fields;
};
