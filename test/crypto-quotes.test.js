// The crypto providers' quote plane (connector-full-catalog, second pass):
// the batched market-row cache that makes refresh economics flat. A sweep
// prefetches its due ids in one metered request per provider; fetchFields,
// fetchEntity and the browse paths all read/warm the same cache, so a board
// added straight out of the browse modal re-buys nothing. Pure provider
// tests — fetch is stubbed, ctx passed directly, no server or db.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as coingecko from "../server/connectors/crypto/coingecko.js";
import * as coinmarketcap from "../server/connectors/crypto/coinmarketcap.js";

const jsonResponse = (body) => ({ ok: true, status: 200, text: async () => "", json: async () => body });

// A CoinGecko /coins/markets row, full multi-window shape.
const cgRow = (id, over = {}) => ({
  id,
  symbol: id.slice(0, 3),
  name: id[0].toUpperCase() + id.slice(1),
  current_price: 100,
  market_cap: 1e9,
  market_cap_rank: 42,
  total_volume: 5e7,
  price_change_percentage_24h: -1.5,
  price_change_percentage_1h_in_currency: 0.3,
  price_change_percentage_7d_in_currency: 4.2,
  price_change_percentage_30d_in_currency: -8.8,
  ath: 250,
  circulating_supply: 1_000_000,
  ...over,
});

test("coingecko: prefetch batches the whole set into one request; fetchFields then costs zero HTTP", async () => {
  coingecko._resetQuoteCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    const ids = (new URL(u).searchParams.get("ids") || "").split(",").filter(Boolean);
    return jsonResponse(ids.map((id) => cgRow(id)));
  };
  try {
    await coingecko.prefetch(["bitcoin", "ethereum", "solana"], {});
    assert.equal(calls.length, 1, "one markets request for the whole set");
    assert.ok(calls[0].includes("price_change_percentage=1h,24h,7d,30d"));

    // Every canonical field rides the cached row — no further HTTP.
    const r = await coingecko.fetchFields("bitcoin", [
      "price", "market_cap", "change_1h", "change_24h", "change_7d", "change_30d",
      "volume", "rank", "ath", "circulating_supply", "url",
    ], {});
    assert.equal(calls.length, 1, "cache hit: zero requests");
    assert.equal(r.fields.price.v, 100);
    assert.equal(r.fields.change_1h.v, 0.3);
    assert.equal(r.fields.change_7d.v, 4.2);
    assert.equal(r.fields.change_30d.v, -8.8);
    assert.equal(r.fields.rank.v, 42);
    assert.equal(r.fields.ath.v, 250);
    assert.equal(r.fields.circulating_supply.v, 1_000_000);
    assert.equal(r.fields.url.v, "https://www.coingecko.com/en/coins/bitcoin");

    // A fresh set skips ids already warm — only the miss is bought.
    await coingecko.prefetch(["bitcoin", "dogecoin"], {});
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes("ids=dogecoin") && !calls[1].includes("bitcoin"));

    // fetchEntity reads the same cache: an add right after a browse/prefetch
    // is free.
    const e = await coingecko.fetchEntity("ethereum", {});
    assert.equal(calls.length, 2, "fetchEntity served from the warm cache");
    assert.equal(e.symbol, "ETH");
    assert.equal(Object.keys(e.fields).length, 11);

    // A url-only refresh is derivable from the id — never spends HTTP even cold.
    const u = await coingecko.fetchFields("uncached-coin", ["url"], {});
    assert.equal(calls.length, 2);
    assert.equal(u.fields.url.v, "https://www.coingecko.com/en/coins/uncached-coin");
  } finally {
    globalThis.fetch = original;
    coingecko._resetQuoteCache();
  }
});

test("coingecko: prefetch chunks at the endpoint's 250-id cap; a cold single miss pays one light call", async () => {
  coingecko._resetQuoteCache();
  const original = globalThis.fetch;
  const perCall = [];
  globalThis.fetch = async (url) => {
    const ids = (new URL(String(url)).searchParams.get("ids") || "").split(",").filter(Boolean);
    perCall.push(ids.length);
    return jsonResponse(ids.map((id) => cgRow(id)));
  };
  try {
    await coingecko.prefetch(Array.from({ length: 260 }, (_, i) => `coin-${i}`), {});
    assert.deepEqual(perCall, [250, 10]);

    perCall.length = 0;
    const r = await coingecko.fetchFields("coin-999", ["price", "change_7d"], {});
    assert.deepEqual(perCall, [1], "a cold fetchFields buys exactly its own row");
    assert.equal(r.fields.price.v, 100);

    // An id the catalog doesn't know: served keys stay empty (the runtime
    // falls back to fetchEntity's error path), nothing throws here.
    globalThis.fetch = async () => jsonResponse([]);
    const miss = await coingecko.fetchFields("no-such-coin", ["price"], {});
    assert.deepEqual(miss.fields, {});
  } finally {
    globalThis.fetch = original;
    coingecko._resetQuoteCache();
  }
});

test("coingecko.list query: rows come back in relevance order and warm the cache for the add", async () => {
  coingecko._resetQuoteCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/search?query=")) {
      return jsonResponse({ coins: [{ id: "beta-coin" }, { id: "alpha-coin" }] }); // relevance: beta first
    }
    if (u.includes("/coins/markets")) {
      // The endpoint answers in market-cap order regardless of ids order.
      return jsonResponse([cgRow("alpha-coin", { market_cap: 9e9 }), cgRow("beta-coin", { market_cap: 1e9 })]);
    }
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const rows = await coingecko.list({ query: "co", pageSize: 50 }, {});
    assert.deepEqual(rows.map((r) => r.id), ["beta-coin", "alpha-coin"], "search relevance order, not the endpoint's");
    assert.equal(rows[0].values.change_7d, 4.2, "browse columns carry the 7d window");

    const before = calls.length;
    await coingecko.fetchEntity("alpha-coin", {});
    assert.equal(calls.length, before, "the add right after the search is cache-served");
  } finally {
    globalThis.fetch = original;
    coingecko._resetQuoteCache();
  }
});

test("coingecko: the category filter narrows server-side AND composes with a search", async () => {
  // Verified live 2026-08-13: category=meme-token with ids=bitcoin,dogecoin
  // returns dogecoin alone — the intersection, not the category's own rows.
  // So a filtered search stays a real search, and neither path re-filters
  // locally over data it doesn't have.
  coingecko._resetQuoteCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("/search?query=")) return jsonResponse({ coins: [{ id: "bitcoin" }, { id: "dogecoin" }] });
    if (u.includes("/coins/markets")) {
      const cat = new URL(u).searchParams.get("category");
      const ids = (new URL(u).searchParams.get("ids") || "").split(",").filter(Boolean);
      const pool = cat === "meme-token" ? ["dogecoin"] : ["bitcoin", "dogecoin"];
      const served = ids.length ? pool.filter((id) => ids.includes(id)) : pool;
      return jsonResponse(served.map((id) => cgRow(id)));
    }
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const browse = await coingecko.list({ category: "meme-token", pageSize: 50 }, {});
    assert.deepEqual(browse.map((r) => r.id), ["dogecoin"]);
    assert.ok(calls[0].includes("category=meme-token"));

    calls.length = 0;
    const searched = await coingecko.list({ query: "coin", category: "meme-token", pageSize: 50 }, {});
    assert.deepEqual(searched.map((r) => r.id), ["dogecoin"], "search hits narrowed by category");
    assert.ok(calls.some((u) => u.includes("/coins/markets") && u.includes("category=meme-token") && u.includes("ids=")));

    // No category → no param at all (never an empty one the API must parse).
    calls.length = 0;
    await coingecko.list({ pageSize: 50 }, {});
    assert.ok(!calls[0].includes("category="));
  } finally {
    globalThis.fetch = original;
    coingecko._resetQuoteCache();
  }
});

test("coingecko.filterOptions: the category taxonomy is fetched once a day, sorted by name", async () => {
  coingecko._resetQuoteCache();
  const original = globalThis.fetch;
  let hits = 0;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/coins\/categories\/list/);
    hits++;
    return jsonResponse([
      { category_id: "meme-token", name: "Meme" },
      { category_id: "zk", name: "Zero Knowledge (ZK)" },
      { category_id: "ai-agents", name: " AI Agents" }, // their data carries stray whitespace
      { category_id: null, name: "Broken" },            // idless rows can't be filtered on
    ]);
  };
  try {
    const { category } = await coingecko.filterOptions({});
    assert.deepEqual(category, [
      { value: "ai-agents", label: "AI Agents" },
      { value: "meme-token", label: "Meme" },
      { value: "zk", label: "Zero Knowledge (ZK)" },
    ]);
    await coingecko.filterOptions({});
    assert.equal(hits, 1, "cached — a dropdown's vocabulary isn't re-bought per open");
  } finally {
    globalThis.fetch = original;
    coingecko._resetQuoteCache();
  }
});

// A CoinMarketCap quotes/listings row.
const cmcRow = (id, over = {}) => ({
  id,
  name: `Coin ${id}`,
  symbol: `C${id}`,
  slug: `coin-${id}`,
  cmc_rank: id,
  circulating_supply: 5_000_000,
  quote: { USD: {
    price: 10 * id, market_cap: 1e8 * id, volume_24h: 1e6 * id,
    percent_change_1h: 0.1, percent_change_24h: 1.1, percent_change_7d: 2.2, percent_change_30d: 3.3,
    ...over,
  } },
});

test("coinmarketcap: prefetch chunks at 100 ids; fetchFields serves every canonical key from the cache", async () => {
  coinmarketcap._resetQuoteCache();
  const original = globalThis.fetch;
  const perCall = [];
  globalThis.fetch = async (url) => {
    const ids = (new URL(String(url)).searchParams.get("id") || "").split(",").filter(Boolean);
    perCall.push(ids.length);
    return jsonResponse({ status: { error_code: 0 }, data: Object.fromEntries(ids.map((id) => [id, cmcRow(Number(id))])) });
  };
  try {
    await coinmarketcap.prefetch(Array.from({ length: 120 }, (_, i) => String(i + 1)), { apiKey: "k" });
    assert.deepEqual(perCall, [100, 20], "chunked so a chunk is one credit under either accounting");

    perCall.length = 0;
    const r = await coinmarketcap.fetchFields("7", [
      "price", "market_cap", "change_1h", "change_24h", "change_7d", "change_30d",
      "volume", "rank", "ath", "circulating_supply", "url",
    ], { apiKey: "k" });
    assert.deepEqual(perCall, [], "cache hit: zero requests");
    assert.equal(r.fields.price.v, 70);
    assert.equal(r.fields.change_7d.v, 2.2);
    assert.equal(r.fields.rank.v, 7);
    assert.equal(r.fields.ath.v, null, "CMC has no ATH — an honest null, still a served key");
    assert.equal(r.fields.url.v, "https://coinmarketcap.com/currencies/coin-7/");

    const e = await coinmarketcap.fetchEntity("9", { apiKey: "k" });
    assert.deepEqual(perCall, [], "fetchEntity rides the same cache");
    assert.equal(e.display_name, "Coin 9");
    assert.equal(Object.keys(e.fields).length, 11);
  } finally {
    globalThis.fetch = original;
    coinmarketcap._resetQuoteCache();
  }
});

test("coinmarketcap.list: a listings page warms the cache — bulk add straight from browse re-buys nothing", async () => {
  coinmarketcap._resetQuoteCache();
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("/listings/latest")) {
      return jsonResponse({ status: { error_code: 0 }, data: [cmcRow(1), cmcRow(2)] });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  try {
    const rows = await coinmarketcap.list({ sort: "market_cap", page: 1, pageSize: 50 }, { apiKey: "k" });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].values.change_7d, 2.2);
    const before = calls.length;
    const e = await coinmarketcap.fetchEntity("2", { apiKey: "k" });
    assert.equal(calls.length, before, "the add is served from the listings row");
    assert.equal(e.symbol, "C2");
  } finally {
    globalThis.fetch = original;
    coinmarketcap._resetQuoteCache();
  }
});

test("coinmarketcap.history: chart points from Basic-tier historical quotes, either payload shape", async () => {
  const original = globalThis.fetch;
  const seen = [];
  const quotes = [
    { timestamp: "2026-08-01T00:00:00.000Z", quote: { USD: { price: 100 } } },
    { timestamp: "2026-08-02T00:00:00.000Z", quote: { USD: { price: 105 } } },
  ];
  try {
    // Single-id shape: { data: { quotes } }.
    globalThis.fetch = async (url) => { seen.push(String(url)); return jsonResponse({ status: { error_code: 0 }, data: { quotes } }); };
    const points = await coinmarketcap.history("1027", "1y", { apiKey: "k" });
    assert.match(seen[0], /quotes\/historical\?id=1027&interval=1d&count=365/);
    assert.deepEqual(points, [
      { t: Date.parse("2026-08-01T00:00:00.000Z"), price: 100 },
      { t: Date.parse("2026-08-02T00:00:00.000Z"), price: 105 },
    ]);

    // Keyed shape: { data: { "<id>": { quotes } } }.
    globalThis.fetch = async () => jsonResponse({ status: { error_code: 0 }, data: { 1027: { quotes } } });
    const keyed = await coinmarketcap.history("1027", "24h", { apiKey: "k" });
    assert.equal(keyed.length, 2);

    // Period → interval mapping keeps point counts (and their credit price)
    // proportionate: hourly only where a day-scale line needs it.
    seen.length = 0;
    globalThis.fetch = async (url) => { seen.push(String(url)); return jsonResponse({ status: { error_code: 0 }, data: { quotes: [] } }); };
    await coinmarketcap.history("1", "7d", { apiKey: "k" });
    assert.match(seen[0], /interval=1h&count=168/);
    await coinmarketcap.history("1", "30d", { apiKey: "k" });
    assert.match(seen[1], /interval=1d&count=30/);
  } finally {
    globalThis.fetch = original;
  }
});
