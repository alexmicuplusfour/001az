// Live verification for planning/connector-scale-plan.md — drives the REAL
// provider module against the REAL FMP API (key via FMP_KEY env; never
// printed). Read-only: no DB, no board mutations. Deletable after use.
import * as fmp from "../server/connectors/stocks/financialmodelingprep.js";

const apiKey = process.env.FMP_KEY;
if (!apiKey) { console.error("FMP_KEY env required"); process.exit(1); }

let httpCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { httpCalls++; return realFetch(...args); };

const timed = async (label, fn) => {
  const t0 = Date.now();
  const before = httpCalls;
  try {
    const out = await fn();
    console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${httpCalls - before} HTTP request(s)${out ? ` — ${out}` : ""}`);
  } catch (e) {
    console.log(`${label}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e.message.replaceAll(apiKey, "[redacted]")}`);
  }
};

await timed("cold list() page 1 (universe fill @ default depth)", async () => {
  const rows = await fmp.list({ sort: "market_cap", order: "desc", page: 1, pageSize: 250 }, { apiKey });
  return `${rows.length} rows, top: ${rows[0].symbol} (rank ${rows[0].values.rank})`;
});

await timed("warm list() page 8 (deep slice)", async () => {
  const rows = await fmp.list({ sort: "market_cap", order: "desc", page: 8, pageSize: 250 }, { apiKey });
  return `${rows.length} rows, first: ${rows[0]?.symbol} (rank ${rows[0]?.values.rank})`;
});

await timed("fetchFields AAPL {price, market_cap, volume, sector} (universe-served)", async () => {
  const r = await fmp.fetchFields("AAPL", ["price", "market_cap", "volume", "sector"], { apiKey });
  return `price=${r.fields.price?.v} sector=${r.fields.sector?.v}`;
});

await timed("fetchFields AAPL {change_1d} (one quote)", async () => {
  const r = await fmp.fetchFields("AAPL", ["change_1d"], { apiKey });
  return `change_1d=${r.fields.change_1d?.v}`;
});

await timed("fetchFields AAPL {pe_ratio, dividend_yield} (ratios)", async () => {
  const r = await fmp.fetchFields("AAPL", ["pe_ratio", "dividend_yield"], { apiKey });
  return `pe=${r.fields.pe_ratio?.v} dy=${r.fields.dividend_yield?.v}`;
});

process.exit(0);
