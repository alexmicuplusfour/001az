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
