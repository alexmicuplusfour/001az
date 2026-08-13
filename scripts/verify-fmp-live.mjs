// Live verification for planning/connector-scale-plan.md and
// planning/connector-full-catalog.md — drives the REAL provider module
// against the REAL FMP API (key via FMP_KEY env; never printed). Read-only:
// no DB, no board mutations. Kept as the standing check that the measured
// posture (full universe, search bridge, snapshot economics) still holds.
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

// How big the universe actually is, and whether any single response came back
// at FMP's 10,000-row cap (which is what the per-venue partitioning exists to
// get past — a slice sitting exactly on it means that venue needs splitting
// further, and the provider logs a warning when it detects that itself).
await timed("universe size + composition (is anything still truncated?)", async () => {
  const seen = new Map();
  for (let page = 1; page <= 200; page++) {
    const rows = await fmp.list({ sort: "market_cap", order: "desc", page, pageSize: 250 }, { apiKey });
    if (!rows.length) break;
    for (const row of rows) seen.set(row.symbol, row.values.type || "—");
  }
  const byType = {};
  for (const type of seen.values()) byType[type] = (byType[type] || 0) + 1;
  const composition = Object.entries(byType).map(([t, n]) => `${t} ${n}`).join(", ");
  return `${seen.size} listings (${composition})` +
    (seen.size % 10000 === 0 ? " — WARNING: a multiple of the 10k response cap, likely still truncated" : "");
});

await timed("ADRs and ETFs are IN the universe (not search-only)", async () => {
  const wanted = ["TSM", "BABA", "ASML", "SPY", "QQQ"];
  const found = [];
  for (const symbol of wanted) {
    // Exact-symbol lookups against the cached universe: zero HTTP, and a hit
    // means BROWSE and FEEDS can reach it, not just search.
    const rows = await fmp.list({ query: symbol, pageSize: 50 }, { apiKey });
    const hit = rows.find((r) => r.symbol === symbol);
    if (hit && hit.values.rank != null) found.push(`${symbol}(#${hit.values.rank},${hit.values.type})`);
  }
  if (found.length < wanted.length)
    throw new Error(`only ${found.join(" ") || "none"} — the rest aren't in the universe`);
  return found.join(" ");
});

await timed("universe covers the whole US-listed catalog (asc = real micro-caps)", async () => {
  const rows = await fmp.list({ sort: "market_cap", order: "asc", page: 1, pageSize: 5 }, { apiKey });
  const caps = rows.map((r) => r.values.market_cap);
  return `smallest caps: ${caps.join(", ")} (should be far below $1B)`;
});

await timed("query bridge reaches past the screener (SPY — an ETF the screener never carries)", async () => {
  const rows = await fmp.list({ query: "SPY" }, { apiKey });
  const hit = rows.find((r) => r.symbol === "SPY");
  if (!hit) throw new Error("SPY not returned");
  if (hit.values.rank != null) throw new Error("SPY has a universe rank — bridge not exercised");
  return `price=${hit.values.price} mcap=${hit.values.market_cap} exch=${hit.values.exchange} (quote-filled, rank null as expected)`;
});

await timed("sector filter narrows the universe server-side of the modal", async () => {
  const rows = await fmp.list({ sector: "Healthcare", pageSize: 250 }, { apiKey });
  const bad = rows.filter((r) => r.values.sector !== "Healthcare").length;
  return `${rows.length} healthcare rows, ${bad} mismatched (want 0)`;
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
