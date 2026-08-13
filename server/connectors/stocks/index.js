// Stocks connector — US-listed securities in USD: companies (including ADRs
// of foreign issuers), ETFs and closed-end funds, i.e. everything the
// provider's tier can actually quote. The domain defines stable fields and
// presentation while provider modules normalize their own APIs.
import * as financialmodelingprep from "./financialmodelingprep.js";

export const providers = { financialmodelingprep };
export const defaultProvider = "financialmodelingprep";
// Face wiring: the shared price-chart producer (server/faces), by name. See crypto.
export const faces = { chart: "price-chart" };

export const manifest = {
  label: "Stocks",
  category: "finance",
  description: "US-listed stocks, ADRs and ETFs — quotes, company data, price history",
  fields: [
    { key: "price",      kind: "number", fn: "price",      label: "Price (USD)" },
    { key: "change_1d",  kind: "number", fn: "change_1d",  label: "Daily change (%)" },
    { key: "market_cap", kind: "number", fn: "market_cap", label: "Market cap (USD)" },
    { key: "volume",     kind: "number", fn: "volume",     label: "Volume" },
    { key: "pe_ratio",   kind: "number", fn: "pe_ratio",   label: "P/E ratio" },
    { key: "dividend_yield", kind: "number", fn: "dividend_yield", label: "Dividend yield (%)" },
    { key: "sector",     kind: "text",   fn: "sector",     label: "Sector" },
    { key: "industry",   kind: "text",   fn: "industry",   label: "Industry" },
    { key: "exchange",   kind: "text",   fn: "exchange",   label: "Exchange" },
    { key: "currency",   kind: "text",   fn: "currency",   label: "Currency" },
    { key: "website",    kind: "url",    fn: "website",    label: "Company website" },
  ],
  template: {
    input: { connector: "stocks" },
    identity: { from: "connector" },
    // The price chart is the face; the symbol tile is only its fallback. See the
    // crypto template — same rule, same cadence-off default.
    face: { from: "connector", producer: "chart", period: "1y" },
    fields: [
      { key: "price",      kind: "number", from: "connector", fn: "price" },
      { key: "change_1d",  kind: "number", from: "connector", fn: "change_1d" },
      { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" },
      { key: "volume",     kind: "number", from: "connector", fn: "volume" },
      { key: "pe_ratio",   kind: "number", from: "connector", fn: "pe_ratio" },
      { key: "dividend_yield", kind: "number", from: "connector", fn: "dividend_yield" },
      { key: "sector",     kind: "text",   from: "connector", fn: "sector" },
      { key: "industry",   kind: "text",   from: "connector", fn: "industry" },
      { key: "exchange",   kind: "text",   from: "connector", fn: "exchange" },
      { key: "currency",   kind: "text",   from: "connector", fn: "currency" },
      { key: "website",    kind: "url",    from: "connector", fn: "website" },
    ],
  },
  providers: Object.entries(providers).map(([name, provider]) => ({
    name,
    label: provider.label,
    description: provider.description || "",
    needsKey: !!provider.needsKey,
  })),
  faces: [
    {
      name: "chart",
      label: "Price chart",
      periods: financialmodelingprep.periods,
      requires: "history",
    },
  ],
  browse: {
    // No "Day" (change_1d) column: the screener that backs browse has no
    // intraday change, so it would always render blank. The field still exists
    // on the board, fed live by the quote refresh. `rank` is the universe's
    // market-cap rank (computed at screener load) — it's what lets a feed say
    // "top 50" as a filter. `preview: true` picks the compact set the ingest
    // preview shows (volume among them — it's a headline metric, not filler).
    columns: [
      { key: "rank",       label: "#",       kind: "number", width: 40 },
      { key: "name",       label: "Name",    kind: "text", primary: true },
      { key: "price",      label: "Price",   kind: "usd", preview: true },
      { key: "market_cap", label: "Mkt cap", kind: "usd", preview: true },
      { key: "volume",     label: "Volume",  kind: "number", preview: true },
      // The universe carries ETFs and funds alongside companies, so a row has
      // to say which it is — an ETF's blank Sector reads as missing data
      // otherwise, when it's simply not a thing an ETF has.
      { key: "type",       label: "Type",    kind: "text" },
      { key: "sector",     label: "Sector",  kind: "text" },
      { key: "exchange",   label: "Exchange", kind: "text" },
    ],
    sorts: [
      { key: "market_cap", label: "Market cap" },
      { key: "volume",     label: "Volume" },
      { key: "price",      label: "Price" },
      { key: "name",       label: "Name" },
    ],
    // Narrowing filters for the browse modal. Options double as the route's
    // whitelist, so they must be exact screener vocabulary — the sector list
    // is FMP's own `available-sectors` (fetched live 2026-08-13; it's the
    // standard 11-sector taxonomy and effectively static).
    filters: [
      // Listing type. The universe is everything this tier can quote —
      // companies, ETFs, closed-end funds — so narrowing to one is the user's
      // choice here rather than a screener parameter they never see.
      { key: "type", label: "Type", options: ["Stock", "ETF", "Fund"] },
      {
        key: "sector",
        label: "Sector",
        options: [
          "Basic Materials", "Communication Services", "Consumer Cyclical",
          "Consumer Defensive", "Energy", "Financial Services", "Healthcare",
          "Industrials", "Real Estate", "Technology", "Utilities",
        ],
      },
      { key: "exchange", label: "Exchange", options: ["NASDAQ", "NYSE", "AMEX"] },
      // Industry is the screener's fine-grained cut (~150 values under the 11
      // sectors) — too many to freeze here and FMP publishes them, so the
      // vocabulary comes from the provider (runtime.browseFilters).
      { key: "industry", label: "Industry", from: "provider" },
    ],
    defaultSort: "market_cap",
    pageSize: 50,
    // No feedWindow: a feed sees the whole universe. FMP serves any depth from
    // one cached screener call, so there is nothing to ration — the provider's
    // own depth (FMP_UNIVERSE_ROWS, default 10000) is the only bound, and it's
    // the API's shape rather than a number this app picked.
  },
};
