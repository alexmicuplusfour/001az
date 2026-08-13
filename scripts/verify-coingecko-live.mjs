// Live verification for planning/connector-full-catalog.md — drives the REAL
// CoinGecko provider module against the REAL API. Keyless by default (set
// CG_KEY for the demo tier); read-only, no DB, no board mutations. The
// standing check that the measured posture still holds: the market-row shape
// carries every canonical field, the batched cache collapses a sweep into one
// request, and the category filter composes with a search.
//
// Paced by hand (SPACING_MS) because the keyless tier is a 5–15/min pool
// shared per source IP and counts FAILED requests against the limit — a
// verification run that 429s is a verification run that spent quota to learn
// nothing.
import * as cg from "../server/connectors/crypto/coingecko.js";

const apiKey = process.env.CG_KEY || null;
const SPACING_MS = Number(process.env.CG_VERIFY_SPACING_MS) || (apiKey ? 1500 : 6000);

let httpCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...args) => { httpCalls++; return realFetch(...args); };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ctx = { apiKey };

const timed = async (label, fn) => {
  await sleep(SPACING_MS);
  const t0 = Date.now();
  const before = httpCalls;
  try {
    const out = await fn();
    console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${httpCalls - before} HTTP request(s)${out ? ` — ${out}` : ""}`);
  } catch (e) {
    console.log(`${label}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s — ${e.message}`);
  }
};

console.log(`CoinGecko live check — ${apiKey ? "demo key" : "keyless"} tier, ${SPACING_MS}ms spacing\n`);

await timed("filterOptions (category taxonomy)", async () => {
  const { category } = await cg.filterOptions(ctx);
  return `${category.length} categories, first: ${category[0]?.label} (${category[0]?.value})`;
});

await timed("list page 1 (browse, market-cap desc)", async () => {
  const rows = await cg.list({ sort: "market_cap", order: "desc", page: 1, pageSize: 5 }, ctx);
  const top = rows[0];
  const windows = ["change_24h", "change_7d"].filter((k) => top?.values[k] != null);
  return `${rows.length} rows, top: ${top?.symbol} rank ${top?.values.rank}, windows present: ${windows.join(", ") || "NONE"}`;
});

await timed("list with a category (server-side narrowing)", async () => {
  const rows = await cg.list({ category: "meme-token", pageSize: 5 }, ctx);
  return `${rows.length} meme-token rows, top: ${rows[0]?.symbol}`;
});

await timed("category + query compose (the intersection, not the category)", async () => {
  const rows = await cg.list({ query: "bitcoin", category: "meme-token", pageSize: 10 }, ctx);
  const ids = rows.map((r) => r.id);
  if (ids.includes("bitcoin")) throw new Error("bitcoin survived a meme-token filter — no intersection");
  return `${rows.length} row(s): ${ids.join(", ") || "(none — bitcoin correctly excluded)"}`;
});

await timed("prefetch 3 ids (one batched request)", async () => {
  cg._resetQuoteCache();
  await cg.prefetch(["bitcoin", "ethereum", "solana"], ctx);
  return "warmed";
});

await timed("fetchFields off the warm cache (must cost ZERO http)", async () => {
  const before = httpCalls;
  const r = await cg.fetchFields("ethereum", ["price", "change_1h", "change_7d", "change_30d", "rank", "ath", "circulating_supply", "volume"], ctx);
  const missing = Object.entries(r.fields).filter(([, v]) => v.v == null).map(([k]) => k);
  if (httpCalls !== before) throw new Error("cache miss — the prefetch didn't cover it");
  return `price=${r.fields.price.v} 7d=${r.fields.change_7d.v} rank=${r.fields.rank.v}${missing.length ? ` | null: ${missing.join(",")}` : ""}`;
});

await timed("history 30d (chart face)", async () => {
  const series = await cg.history("bitcoin", "30d", ctx);
  return `${series.length} points, last: ${series.at(-1)?.price}`;
});

console.log(`\ntotal: ${httpCalls} HTTP request(s)`);
process.exit(0);
