// Stocks connector — US-listed equities in USD. The domain defines stable
// fields and presentation while provider modules normalize their own APIs.
import * as financialmodelingprep from "./financialmodelingprep.js";
import { renderChart } from "../faces/price-chart.js";

export const providers = { financialmodelingprep };
export const defaultProvider = "financialmodelingprep";
export const faces = { chart: renderChart };

export const manifest = {
  label: "Stocks",
  category: "finance",
  description: "US equity quotes, company data, and price history",
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
    // on the board, fed live by the quote refresh.
    columns: [
      { key: "name",       label: "Name",    kind: "text", primary: true },
      { key: "price",      label: "Price",   kind: "usd" },
      { key: "market_cap", label: "Mkt cap", kind: "usd" },
      { key: "volume",     label: "Volume",  kind: "number" },
      { key: "sector",     label: "Sector",  kind: "text" },
      { key: "exchange",   label: "Exchange", kind: "text" },
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
