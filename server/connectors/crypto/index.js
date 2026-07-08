// Crypto connector — the cryptocurrency domain adapter. It owns the canonical
// field set, the board template, and the search/fetch contract; the actual
// data comes from a pluggable provider (coingecko today, coinmarketcap next)
// selected app-globally in settings. Mappings bind to `crypto:price` and never
// mention the provider, so switching backends leaves every board intact.
//
// Two layers by design (domain → provider), mirroring the AI tagger's
// domain → provider split. `category: "finance"` is a display label that lets
// the template picker group siblings (Crypto, later Stocks) — it is not a
// third structural layer. See slice-5b-crypto-provider-plan.md.
import * as coingecko from "./coingecko.js";
import { getSetting } from "../../db.js";

const PROVIDERS = { coingecko };
const DEFAULT_PROVIDER = "coingecko";

export const manifest = {
  label: "Crypto",
  category: "finance",
  description: "Cryptocurrency prices and market data",
  fields: [
    { key: "price",      kind: "number", fn: "price",      label: "Price (USD)" },
    { key: "market_cap", kind: "number", fn: "market_cap", label: "Market cap (USD)" },
    { key: "change_24h", kind: "number", fn: "change_24h", label: "24h change (%)" },
    { key: "url",        kind: "url",    fn: "url",        label: "Market page" },
  ],
  template: {
    input: { connector: "crypto" },
    identity: { from: "connector" },
    fields: [
      { key: "price",      kind: "number", from: "connector", fn: "price" },
      { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" },
      { key: "change_24h", kind: "number", from: "connector", fn: "change_24h" },
      { key: "url",        kind: "url",    from: "connector", fn: "url" },
    ],
  },
  // Static provider descriptors (no db); the active choice is resolved per call.
  providers: Object.entries(PROVIDERS).map(([name, p]) => ({
    name,
    label: p.label,
    needsKey: !!p.needsKey,
  })),
};

// Resolve the active provider + its key from settings. An unset or unknown
// provider name falls back to the default — defaults not laws, so a stale
// setting never breaks adds.
export async function activeProvider(db) {
  const setName = await getSetting(db, "crypto_provider");
  const name = PROVIDERS[setName] ? setName : DEFAULT_PROVIDER;
  const apiKey = (await getSetting(db, "crypto_api_key")) || null;
  return { name, provider: PROVIDERS[name], apiKey };
}

export async function search(db, query) {
  const { provider, apiKey } = await activeProvider(db);
  return provider.search(query, { apiKey });
}

// Assemble the connector entity from the active provider's raw values:
//  - identity = lowercase symbol (portable across providers; dedupes the same
//    asset added under two backends), falling back to the provider id;
//  - src = provider name stamped on every field (truthful provenance);
//  - source = { provider, id } — the provider handle a future liveness slice
//    re-fetches from (stored by the route on the tag-vehicle instance).
export async function fetchEntity(db, id) {
  const { name, provider, apiKey } = await activeProvider(db);
  const e = await provider.fetchEntity(id, { apiKey });
  const symbol = e.symbol || null;
  const identity = (symbol || "").toLowerCase() || e.id;
  const fields = {};
  for (const [k, v] of Object.entries(e.fields || {})) fields[k] = { ...v, src: name };
  return { identity, display_name: e.display_name, symbol, source: { provider: name, id: e.id }, fields };
}

export async function testConnection(db) {
  const { provider, apiKey } = await activeProvider(db);
  if (!provider.testConnection) throw new Error("provider has no connection test");
  return provider.testConnection({ apiKey });
}
