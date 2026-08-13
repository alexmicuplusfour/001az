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

// The canonical field set. Every key here is served by BOTH providers from the
// same market-quote row their browse/refresh paths already buy — multi-window
// change, volume, rank and supply are riders on requests the board pays for
// anyway, never extra calls. The one asymmetry: `ath` is CoinGecko-only (CMC's
// quote payload has no all-time-high), served as an honest null under CMC.
export const manifest = {
  label: "Crypto",
  category: "finance",
  description: "Cryptocurrency prices and market data",
  fields: [
    { key: "price",      kind: "number", fn: "price",      label: "Price (USD)" },
    { key: "market_cap", kind: "number", fn: "market_cap", label: "Market cap (USD)" },
    { key: "change_1h",  kind: "number", fn: "change_1h",  label: "1h change (%)" },
    { key: "change_24h", kind: "number", fn: "change_24h", label: "24h change (%)" },
    { key: "change_7d",  kind: "number", fn: "change_7d",  label: "7d change (%)" },
    { key: "change_30d", kind: "number", fn: "change_30d", label: "30d change (%)" },
    { key: "volume",     kind: "number", fn: "volume",     label: "24h volume (USD)" },
    { key: "rank",       kind: "number", fn: "rank",       label: "Market cap rank" },
    { key: "ath",        kind: "number", fn: "ath",        label: "All-time high (USD)" },
    { key: "circulating_supply", kind: "number", fn: "circulating_supply", label: "Circulating supply" },
    { key: "url",        kind: "url",    fn: "url",        label: "Market page" },
  ],
  template: {
    input: { connector: "crypto" },
    identity: { from: "connector" },
    // The card face is the chart, always. The symbol tile is what a card falls
    // back to when the chart can't be rendered (a provider without history(), an
    // empty series) — a fallback, not a board's choice, so it isn't offered as
    // one. Cadence off by default: the chart renders once, on the face leg, when
    // the coin is added; a board that wants a moving chart turns liveness on.
    face: { from: "connector", producer: "chart", period: "1y" },
    // The template binds the whole catalog, like stocks — the mapping modal is
    // where a board trims to taste.
    fields: [
      { key: "price",      kind: "number", from: "connector", fn: "price" },
      { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" },
      { key: "change_1h",  kind: "number", from: "connector", fn: "change_1h" },
      { key: "change_24h", kind: "number", from: "connector", fn: "change_24h" },
      { key: "change_7d",  kind: "number", from: "connector", fn: "change_7d" },
      { key: "change_30d", kind: "number", from: "connector", fn: "change_30d" },
      { key: "volume",     kind: "number", from: "connector", fn: "volume" },
      { key: "rank",       kind: "number", from: "connector", fn: "rank" },
      { key: "ath",        kind: "number", from: "connector", fn: "ath" },
      { key: "circulating_supply", kind: "number", from: "connector", fn: "circulating_supply" },
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
  // Periods reflect what the providers' tiers serve — both CoinGecko's demo
  // tier and CMC's Basic historical access cap out at 365 days back.
  // `requires` names the provider method a producer needs; a provider that
  // lacks it can't render this face (both bundled providers now can — the
  // gate matters for plugin providers).
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
      { key: "change_7d",  label: "7d",      kind: "percent" },
      { key: "market_cap", label: "Mkt cap", kind: "usd", preview: true },
      { key: "volume",     label: "Volume",  kind: "usd", preview: true },
    ],
    sorts: [
      { key: "market_cap", label: "Market cap" },
      { key: "volume",     label: "Volume" },
      { key: "price",      label: "Price" },
      { key: "name",       label: "Name" },
    ],
    // Narrowing filters. `from: "provider"` means the vocabulary is the active
    // backend's to supply (runtime.browseFilters) rather than frozen here:
    // CoinGecko's category taxonomy is ~857 entries and moves with the market.
    // A provider that can't supply it (CoinMarketCap organizes by its own
    // tags) renders no control — the same rule the face `requires` gate uses.
    filters: [
      { key: "category", label: "Category", from: "provider" },
    ],
    defaultSort: "market_cap",
    pageSize: 50,
    // No feedWindow: a feed sees the whole catalog here too (~18.4k coins on
    // CoinGecko), which is the point — a rationed window would make every coin
    // past the ration permanently unreachable by a feed. It is the expensive
    // one to walk, though: 250 rows per metered request, so a full pass is
    // ~74 requests against a monthly budget (CoinGecko demo 10k credits, CMC
    // Basic 15k — checked 2026-08-13). The window cache means that's per
    // TTL, not per page of preview; an operator who wants it rationed anyway
    // sets INGEST_FEED_CAP.
  },
};
