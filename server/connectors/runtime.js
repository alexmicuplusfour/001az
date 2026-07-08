// Connector runtime — the domain-agnostic machinery every connector shares.
// A connector module is pure data: a `providers` map, a `defaultProvider`, and
// a `manifest`. The dispatch below is generic over a descriptor
//   conn = { name, providers, defaultProvider }
// so adding a domain (stocks, movies, …) is a directory of data with no edits
// here. Two layers by design — domain → provider — mirroring the AI tagger.
//
// Settings are namespaced by the connector's own name, so domains never collide:
//   <name>_provider           active provider (unset/unknown → defaultProvider)
//   <name>_key_<provider>      that provider's API key (its own slot; no bleed)
import { getSetting } from "../db.js";

const providerKey = (db, conn, name) => getSetting(db, `${conn.name}_key_${name}`);

// Resolve the active provider + its key. An unset or unknown provider name falls
// back to the connector's default — defaults not laws, so a stale setting never
// breaks adds.
export async function activeProvider(db, conn) {
  const set = await getSetting(db, `${conn.name}_provider`);
  const name = conn.providers[set] ? set : conn.defaultProvider;
  return { name, provider: conn.providers[name], apiKey: (await providerKey(db, conn, name)) || null };
}

export async function search(db, conn, query) {
  const { provider, apiKey } = await activeProvider(db, conn);
  return provider.search(query, { apiKey });
}

// Assemble the connector entity from the active provider's raw values:
//  - identity = lowercase symbol (portable across providers; dedupes the same
//    asset added under two backends), falling back to the provider id;
//  - src = provider name on every field (truthful provenance);
//  - at = fetch time on every field (the liveness baseline; read in a later slice);
//  - source = { provider, id } — the provider handle a future refresh re-fetches from.
export async function fetchEntity(db, conn, id, now = Date.now()) {
  const { name, provider, apiKey } = await activeProvider(db, conn);
  const e = await provider.fetchEntity(id, { apiKey });
  const symbol = e.symbol || null;
  const identity = (symbol || "").toLowerCase() || e.id;
  const fields = {};
  for (const [k, v] of Object.entries(e.fields || {})) fields[k] = { ...v, src: name, at: now };
  return { identity, display_name: e.display_name, symbol, source: { provider: name, id: e.id }, fields };
}

// Test a provider's reachability. The admin UI passes the provider it has
// selected (and, when the admin just typed one, an apiKey) so the check reflects
// the form, not whatever is currently active/saved. Both fall back: no override
// → the active provider; no typed key → that provider's stored key.
export async function testConnection(db, conn, { provider: pOverride, apiKey: kOverride } = {}) {
  const name = pOverride && conn.providers[pOverride] ? pOverride : (await activeProvider(db, conn)).name;
  const provider = conn.providers[name];
  if (!provider.testConnection) throw new Error("provider has no connection test");
  const apiKey = kOverride !== undefined && kOverride !== "" ? kOverride : await providerKey(db, conn, name);
  await provider.testConnection({ apiKey });
  return { provider: name };
}

// --- liveness (slice 5c) ---

// A mapping's live connector fields: [{ key, kind, from, fn, live, every }].
export const liveFields = (mapping) =>
  (mapping?.fields || []).filter((f) => f.from === "connector" && f.live);

// Soonest time any live field comes due: min(field.at + every*60000), or null
// when nothing is live. `fields` is the entity's stored field map; a field with
// no `at` yet is treated as due now.
export function nextRefreshAt(fields, live, now = Date.now()) {
  let next = null;
  for (const f of live) {
    const due = (fields?.[f.key]?.at ?? now) + f.every * 60000;
    if (next === null || due < next) next = due;
  }
  return next;
}

// Map a symbol back to a provider id under the active provider — provider ids
// aren't portable (CoinGecko's "bitcoin" ≠ CoinMarketCap's "1"), so a refresh
// after a provider switch re-resolves by ticker. Prefers an exact symbol match.
export async function resolveBySymbol(db, conn, symbol) {
  if (!symbol) return null;
  const want = symbol.toLowerCase();
  const hits = await search(db, conn, symbol);
  const hit = hits.find((h) => (h.symbol || "").toLowerCase() === want) || hits[0];
  return hit ? hit.id : null;
}

// Re-fetch one entity and return the fields to write back — only those live
// fields whose cadence has elapsed. Live config comes from `mapping` (the board
// mapping — the current source of truth an admin edits), NOT the instance's
// stamped mapping, which is frozen at creation and would ignore later liveness
// edits. `inst` carries the provider `source`. Whole-object fetch (one API call)
// even when a single field is due; you can't fetch a field in isolation. `at` is
// always bumped on a refresh (last-checked, not last-changed) so an unchanged
// field doesn't read "due" forever. `moved` holds only value changes.
export async function refresh(db, conn, entity, inst, mapping, now = Date.now()) {
  const live = liveFields(mapping);
  const due = live.filter((f) => now - (entity.fields?.[f.key]?.at ?? 0) >= f.every * 60000);
  if (!due.length) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };

  const src = inst.payload?.source;
  const active = await activeProvider(db, conn);
  const id = active.name === src?.provider ? src.id : await resolveBySymbol(db, conn, entity.symbol);
  if (id == null) return { merged: null, moved: {}, next: nextRefreshAt(entity.fields, live, now) };
  const fetched = await fetchEntity(db, conn, id, now);

  const merged = { ...entity.fields };
  const moved = {};
  for (const f of due) {
    const nv = fetched.fields[f.key];
    if (!nv) continue;
    if (merged[f.key]?.v !== nv.v) moved[f.key] = nv;
    merged[f.key] = nv; // always rewritten so `at` advances → refresh_at recomputes
  }
  return { merged, moved, next: nextRefreshAt(merged, live, now), provider: active.name };
}
