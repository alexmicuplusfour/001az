// Crypto connector — the cryptocurrency domain. Pure data: the canonical field
// set, the board template, and its pluggable provider backends. All behaviour
// (active-provider resolution, key lookup, search/fetch/test dispatch) lives in
// ../runtime.js and is generic across domains, so adding a domain is a directory
// like this one with no runtime edits. Mappings bind to `crypto:price` and never
// name the provider, so switching backends leaves every board intact.
//
// Two layers by design (domain → provider), mirroring the AI tagger's
// domain → provider split. `category: "finance"` is a display label that lets
// the template picker group siblings (Crypto, later Stocks) — not a third
// structural layer. See slice-5b-crypto-provider-plan.md.
import * as coingecko from "./coingecko.js";
import * as coinmarketcap from "./coinmarketcap.js";

export const providers = { coingecko, coinmarketcap };
export const defaultProvider = "coingecko";

// Face wiring — which shared face producer (server/faces) renders this domain's
// card face, keyed by the face-slot name the runtime dispatches on. `chart` → the
// price-chart producer, fed the active provider's history(); missing history →
// symbol-tile fallback. The renderer lives in the registry, not here.
export const faces = { chart: "price-chart" };

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
  // Static provider descriptors (no db); the active choice is resolved per call
  // by the runtime.
  providers: Object.entries(providers).map(([name, p]) => ({
    name,
    label: p.label,
    description: p.description || "",
    needsKey: !!p.needsKey,
  })),
  // Face producers this domain can render; drives the mapping modal's face row.
  // Periods reflect what the default provider's free tier serves (CoinGecko
  // demo caps history at 365 days).
  // `requires` names the provider method a producer needs; a provider that
  // lacks it can't render this face (CoinMarketCap has no history() → tile).
  faces: [
    { name: "chart", label: "Price chart", periods: ["24h", "7d", "30d", "90d", "1y"], requires: "history" },
  ],
  // Browse-and-add: the columns the ingestion modal shows and the sort keys it
  // offers. Domain-level and canonical — every provider's list() fills the same
  // column keys and maps these sort keys to its own API (falling back to its
  // default for any it can't honor). `kind` drives agnostic client formatting
  // (usd/percent/number/text); `primary` pairs the name with its symbol;
  // `preview: true` picks the compact subset the ingest preview shows.
  browse: {
    columns: [
      { key: "rank",       label: "#",       kind: "number", width: 40 },
      { key: "name",       label: "Name",    kind: "text", primary: true },
      { key: "price",      label: "Price",   kind: "usd", preview: true },
      { key: "change_24h", label: "24h",     kind: "percent" },
      { key: "market_cap", label: "Mkt cap", kind: "usd", preview: true },
      { key: "volume",     label: "Volume",  kind: "usd", preview: true },
    ],
    sorts: [
      { key: "market_cap", label: "Market cap" },
      { key: "volume",     label: "Volume" },
      { key: "price",      label: "Price" },
      { key: "name",       label: "Name" },
    ],
    defaultSort: "market_cap",
    pageSize: 50,
  },
};
