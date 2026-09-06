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
  // The identity slot in this domain's own words (see crypto's note).
  identity: { label: "Ticker", blurb: "each stock is its own card" },
  // The lightbox live chart's control surface (planning/lightbox-live-chart-
  // plan.md): the full Google-parity row, deliberately NOT shrunk to any
  // provider's tier. What a deployment's key can't serve is discovered from
  // the provider's own refusal at request time (runtime.chartSeries' learned
  // model) and drops out of the offer — never declared away here.
  chart: {
    ranges: ["1d", "5d", "1m", "6m", "ytd", "1y", "5y", "max"],
    kinds: ["area", "candles"],
    defaultRange: "1y", // matches the face default period — visual continuity
  },
  template: {
    input: { connector: "stocks" },
    identity: { source: "connector" },
    // The price chart is the face; the symbol tile is only its fallback. See the
    // crypto template — same rule, same no-refresh default.
    face: { source: "connector", producer: "chart", period: "1y" },
    fields: [
      { key: "price",      kind: "number", source: "connector", fn: "price" },
      { key: "change_1d",  kind: "number", source: "connector", fn: "change_1d" },
      { key: "market_cap", kind: "number", source: "connector", fn: "market_cap" },
      { key: "volume",     kind: "number", source: "connector", fn: "volume" },
      { key: "pe_ratio",   kind: "number", source: "connector", fn: "pe_ratio" },
      { key: "dividend_yield", kind: "number", source: "connector", fn: "dividend_yield" },
      { key: "sector",     kind: "text",   source: "connector", fn: "sector" },
      { key: "industry",   kind: "text",   source: "connector", fn: "industry" },
      { key: "exchange",   kind: "text",   source: "connector", fn: "exchange" },
      { key: "currency",   kind: "text",   source: "connector", fn: "currency" },
      { key: "website",    kind: "url",    source: "connector", fn: "website" },
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
      // Feed-filter presets: the standard cap bands as single-ended
      // thresholds — one preset, one plain filter row (the ingest modal's
      // value dropdown; see ingestion/connector.js presetsOf). Labels spell
      // the words out: no "$10B" literacy assumed.
      { key: "market_cap", label: "Mkt cap", kind: "usd", preview: true, presets: [
        { label: "Mega — over $200 billion",   op: "gte", value: 200e9 },
        { label: "Large — over $10 billion",   op: "gte", value: 10e9 },
        { label: "Mid — over $2 billion",      op: "gte", value: 2e9 },
        { label: "Small — over $300 million",  op: "gte", value: 300e6 },
        { label: "Under $2 billion",           op: "lte", value: 2e9 },
        { label: "Under $300 million",         op: "lte", value: 300e6 },
      ] },
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
      // Exchange and industry both come from the provider. Industry because
      // it's the screener's fine cut (~150 values FMP publishes) — too many to
      // freeze. Exchange because the venue set is an operator knob
      // (FMP_EXCHANGES): frozen here, widening it produced rows this control
      // couldn't offer and the route's whitelist then rejected.
      { key: "exchange", label: "Exchange", from: "provider" },
      { key: "industry", label: "Industry", from: "provider" },
    ],
    defaultSort: "market_cap",
    pageSize: 50,
    // No feedWindow: a feed sees the whole universe. FMP serves any depth from
    // one cached fill, so there is nothing to ration — the only bounds left
    // are the API's own (its per-response row cap, which the provider works
    // around by partitioning) and the venue list, not a number this app picked.
  },
};
