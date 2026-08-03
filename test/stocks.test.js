import { test } from "node:test";
import assert from "node:assert/strict";
import { getConnector, listConnectors } from "../server/connectors/index.js";
import { manifest } from "../server/connectors/stocks/index.js";
import * as fmp from "../server/connectors/stocks/financialmodelingprep.js";

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
  };
}

test("stocks manifest: registered finance connector with FMP and a chart face", () => {
  const stocks = listConnectors().find((connector) => connector.name === "stocks");
  assert.ok(stocks);
  assert.equal(stocks.category, "finance");
  assert.equal(manifest.template.input.connector, "stocks");
  assert.equal(manifest.template.identity.from, "connector");
  assert.ok(manifest.fields.some((field) => field.key === "price"));
  assert.ok(manifest.fields.some((field) => field.key === "sector"));
  assert.ok(manifest.providers.some((provider) =>
    provider.name === "financialmodelingprep" && provider.needsKey
  ));
  assert.deepEqual(manifest.faces[0].periods, ["7d", "30d", "90d", "1y", "5y"]);
  assert.ok(getConnector("stocks"));
});

test("FMP search: normalizes symbols and keeps US USD listings", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    // Real /stable/search-* rows: symbol, name, currency, exchange (short form).
    return response([
      { symbol: "aapl", name: "Apple Inc.", currency: "USD", exchange: "NASDAQ" },
      { symbol: "SHOP.TO", name: "Shopify", currency: "CAD", exchange: "TSX" },
      { symbol: "ACME", name: "Acme OTC", currency: "USD", exchange: "OTC" },
    ]);
  };
  try {
    assert.deepEqual(await fmp.search("apple", { apiKey: "test-key" }), [{
      id: "AAPL",
      symbol: "AAPL",
      label: "Apple Inc.",
      exchange: "NASDAQ",
    }]);
    assert.ok(seen.some((url) => url.includes("/search-symbol?")));
    assert.ok(seen.some((url) => url.includes("/search-name?")));
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP fetchEntity: combines quote and profile into canonical stock fields", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/quote?")) return response([{
      symbol: "ACME",
      name: "Acme Corp.",
      price: 42.5,
      changePercentage: 1.25,
      marketCap: 5_000_000_000,
      volume: 123456,
      exchange: "NYSE",
    }]);
    if (u.includes("/profile?")) return response([{
      symbol: "ACME",
      companyName: "Acme Corp.",
      sector: "Industrials",
      industry: "Tools",
      currency: "USD",
      website: "https://acme.example",
      exchange: "NYSE",
    }]);
    if (u.includes("/ratios-ttm?")) return response([{
      symbol: "ACME",
      priceToEarningsRatioTTM: 18.6,
      dividendYieldTTM: 0.0125,
    }]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const entity = await fmp.fetchEntity("acme", { apiKey: "test-key" });
    assert.equal(entity.id, "ACME");
    assert.equal(entity.symbol, "ACME");
    assert.equal(entity.display_name, "Acme Corp.");
    assert.deepEqual(entity.fields.price, { v: 42.5, kind: "number" });
    assert.deepEqual(entity.fields.change_1d, { v: 1.25, kind: "number" });
    assert.deepEqual(entity.fields.market_cap, { v: 5_000_000_000, kind: "number" });
    assert.deepEqual(entity.fields.pe_ratio, { v: 18.6, kind: "number" });
    assert.deepEqual(entity.fields.dividend_yield, { v: 1.25, kind: "number" });
    assert.deepEqual(entity.fields.sector, { v: "Industrials", kind: "text" });
    assert.deepEqual(entity.fields.website, { v: "https://acme.example", kind: "url" });
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP list: screens US stocks, sorts, paginates, and filters a query against the cached universe", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    // Real /stable/company-screener rows: exchangeShortName + a full exchange
    // name, and no intraday change field.
    if (u.includes("/company-screener?")) return response([
      { symbol: "SMALL", companyName: "Small Co.", marketCap: 10, price: 2, volume: 20, sector: "Energy", exchangeShortName: "NYSE", exchange: "New York Stock Exchange" },
      { symbol: "BIG", companyName: "Big Co.", marketCap: 100, price: 20, volume: 200, sector: "Technology", exchangeShortName: "NASDAQ", exchange: "NASDAQ Global Select" },
      { symbol: "MID", companyName: "Mid Co.", marketCap: 50, price: 10, volume: 100, sector: "Healthcare", exchangeShortName: "NYSE", exchange: "New York Stock Exchange" },
    ]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const rows = await fmp.list(
      { sort: "market_cap", order: "desc", page: 1, pageSize: 2 },
      { apiKey: "test-key" }
    );
    assert.deepEqual(rows.map((row) => row.symbol), ["BIG", "MID"]);
    assert.equal(rows[0].values.rank, 1, "market-cap rank stamped at universe load (BIG is largest)");
    assert.equal(rows[1].values.rank, 2);
    assert.equal(rows[0].values.price, 20);
    assert.equal(rows[0].values.sector, "Technology");
    assert.equal(rows[0].values.exchange, "NASDAQ"); // short form, not the full name
    assert.equal(rows[0].label, "Big Co."); // company name, never the ticker
    assert.ok(seen.some((u) => u.includes("country=US") && u.includes("isEtf=false")));

    // A query filters the same universe (full columns, no per-symbol request) and
    // reuses the cache — no extra screener call.
    const before = seen.length;
    const hits = await fmp.list({ query: "big" }, { apiKey: "test-key" });
    assert.deepEqual(hits.map((row) => row.symbol), ["BIG"]);
    assert.equal(hits[0].label, "Big Co.");
    assert.equal(hits[0].values.price, 20);
    assert.equal(seen.length, before, "query reuses the cached universe");
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP history: requests an EOD range and returns chronological chart points", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    assert.match(u, /\/historical-price-eod\/full\?/);
    assert.match(u, /symbol=AAPL/);
    assert.match(u, /from=\d{4}-\d{2}-\d{2}/);
    assert.match(u, /to=\d{4}-\d{2}-\d{2}/);
    // Real /stable EOD rows carry `close` (unadjusted); no adjusted-close field.
    return response([
      { date: "2026-07-10", close: 210 },
      { date: "2026-07-09", close: 205 },
    ]);
  };
  try {
    assert.deepEqual(await fmp.history("aapl", "30d", { apiKey: "test-key" }), [
      { t: Date.parse("2026-07-09T00:00:00Z"), price: 205 },
      { t: Date.parse("2026-07-10T00:00:00Z"), price: 210 },
    ]);
  } finally {
    globalThis.fetch = original;
  }
});

test("FMP errors never expose the API key", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => response(
    { "Error Message": "Invalid key secret-test-key" },
    403
  );
  try {
    await assert.rejects(
      fmp.search("AAPL", { apiKey: "secret-test-key" }),
      (error) => {
        assert.match(error.message, /\[redacted\]/);
        assert.doesNotMatch(error.message, /secret-test-key/);
        return true;
      }
    );
  } finally {
    globalThis.fetch = original;
  }
});

// ─── scale posture (see planning/connector-scale-plan.md) ────────────────────
// Each test below resets the module-level screener cache at its start and end
// — never mid-test (the list test above RELIES on intra-test persistence).

test("FMP pace truthfulness: every raw request pays a token, cache hits pay none", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const paced = [];
  const pace = async () => { paced.push(1); };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/search-symbol?") || u.includes("/search-name?")) return response([]);
    if (u.includes("/quote?")) return response([{ symbol: "PACE1", name: "P", price: 1, marketCap: 2, volume: 3, exchangeShortName: "NYSE" }]);
    if (u.includes("/profile?")) return response([{ symbol: "PACE1", companyName: "P" }]);
    if (u.includes("/ratios-ttm?")) return response([{ symbol: "PACE1" }]);
    if (u.includes("/company-screener?")) return response([{ symbol: "AAA", companyName: "A", marketCap: 1, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
    if (u.includes("/historical-price-eod/")) return response([]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    await fmp.search("apple", { apiKey: "k", pace });
    assert.equal(paced.length, 2); // ticker + name endpoints

    paced.length = 0;
    await fmp.fetchEntity("PACE1", { apiKey: "k", pace });
    assert.equal(paced.length, 3); // cold: quote + profile + ratios
    paced.length = 0;
    await fmp.fetchEntity("PACE1", { apiKey: "k", pace });
    assert.equal(paced.length, 1); // warm: profile/ratios cached → quote only

    paced.length = 0;
    await fmp.list({ pageSize: 50 }, { apiKey: "k", pace });
    assert.equal(paced.length, 1); // cold universe fill
    paced.length = 0;
    await fmp.list({ pageSize: 50, page: 2 }, { apiKey: "k", pace });
    assert.equal(paced.length, 0); // warm slice: zero requests, zero tokens

    paced.length = 0;
    await fmp.history("PACE1", "30d", { apiKey: "k", pace });
    assert.equal(paced.length, 1);
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: concurrent cold callers share one screener request (single-flight)", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  let screenerHits = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async (url) => {
    assert.match(String(url), /company-screener/);
    screenerHits++;
    await gate;
    return response([{ symbol: "AAA", companyName: "A", marketCap: 5, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
  };
  try {
    const p1 = fmp.list({}, { apiKey: "k" });
    const p2 = fmp.list({}, { apiKey: "k" });
    await new Promise((r) => setTimeout(r, 20)); // both reach the flight
    assert.equal(screenerHits, 1);
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1[0].symbol, "AAA");
    assert.equal(r2[0].symbol, "AAA");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: stale-while-revalidate serves old rows now, refreshes behind", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  let fills = 0;
  globalThis.fetch = async () => {
    fills++;
    return response([{ symbol: fills === 1 ? "OLD" : "NEW", companyName: "X", marketCap: 1, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
  };
  try {
    assert.equal((await fmp.list({}, { apiKey: "k" }))[0].symbol, "OLD");
    fmp._ageScreenerCache(6 * 60 * 1000); // past BROWSE_TTL, inside the hard bar
    const stale = await fmp.list({}, { apiKey: "k" });
    assert.equal(stale[0].symbol, "OLD"); // no caller ever waits on the refill
    for (let i = 0; i < 100 && fills < 2; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(fills, 2, "exactly one background refresh fired");
    // The refill lands a few microtasks after the fetch starts — poll for the swap.
    let latest = stale;
    for (let i = 0; i < 100 && latest[0].symbol !== "NEW"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      latest = await fmp.list({}, { apiKey: "k" });
    }
    assert.equal(latest[0].symbol, "NEW");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: past the hard bar callers block on a fresh fetch", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  let fills = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => {
    fills++;
    if (fills === 1) return response([{ symbol: "OLD", companyName: "X", marketCap: 1, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
    await gate;
    return response([{ symbol: "NEW", companyName: "Y", marketCap: 1, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
  };
  try {
    await fmp.list({}, { apiKey: "k" });
    fmp._ageScreenerCache(61 * 60 * 1000); // past SCREENER_MAX_AGE
    let settled = false;
    const p = fmp.list({}, { apiKey: "k" }).then((rows) => { settled = true; return rows; });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(settled, false, "ancient data must not be served");
    release();
    assert.equal((await p)[0].symbol, "NEW");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe depth knob reaches the screener; local page clamp is 250", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const seen = [];
  const universe = Array.from({ length: 300 }, (_, i) => ({
    symbol: `S${String(i).padStart(3, "0")}`,
    companyName: `Co ${i}`,
    marketCap: 1000 - i,
    price: 1,
    volume: 1,
    exchangeShortName: "NYSE",
  }));
  globalThis.fetch = async (url) => { seen.push(String(url)); return response(universe); };
  process.env.FMP_UNIVERSE_ROWS = "1234";
  try {
    const page1 = await fmp.list({ sort: "market_cap", order: "desc", page: 1, pageSize: 250 }, { apiKey: "k" });
    assert.ok(seen[0].includes("limit=1234"), "depth knob steers the screener request");
    assert.equal(page1.length, 250); // the feed adapter's ENUM_PAGE fits in one slice
    const page2 = await fmp.list({ sort: "market_cap", order: "desc", page: 2, pageSize: 250 }, { apiKey: "k" });
    assert.equal(page2.length, 50);
    assert.equal(page2[0].values.rank, 251); // offset math consistent with the clamp
    assert.equal(seen.length, 1, "both slices served from one fill");
  } finally {
    delete process.env.FMP_UNIVERSE_ROWS;
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP screener timeout names the endpoint, not the DOMException", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  };
  try {
    await assert.rejects(fmp.list({}, { apiKey: "k" }), /company-screener timed out after \d+s/);
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP fetchFields: each due key rides its cheapest source", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/company-screener?")) return response([
      { symbol: "BULK", companyName: "Bulk Co", marketCap: 100, price: 10, volume: 1000, sector: "Tech", industry: "Software", exchangeShortName: "NASDAQ" },
    ]);
    if (u.includes("/quote?")) return response([
      { symbol: "BULK", price: 11, changePercentage: 2.5, marketCap: 110, volume: 1100, exchangeShortName: "NASDAQ" },
    ]);
    if (u.includes("/ratios-ttm?")) return response([
      { symbol: "RATX", priceToEarningsRatioTTM: 21, dividendYieldTTM: 0.02 },
    ]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    await fmp.list({}, { apiKey: "k" }); // warm the universe

    // Universe-covered keys: a whole refresh cycle costs zero HTTP.
    const before = seen.length;
    const r1 = await fmp.fetchFields("BULK", ["price", "market_cap", "volume", "sector", "industry", "exchange"], { apiKey: "k" });
    assert.equal(seen.length, before, "universe-served refresh makes no requests");
    assert.deepEqual(r1.fields.price, { v: 10, kind: "number" });
    assert.deepEqual(r1.fields.sector, { v: "Tech", kind: "text" });
    assert.deepEqual(r1.fields.exchange, { v: "NASDAQ", kind: "text" });

    // change_1d forces one quote — whose fresher numbers overlay the snapshot's.
    const r2 = await fmp.fetchFields("BULK", ["change_1d", "price", "market_cap"], { apiKey: "k" });
    assert.equal(seen.length, before + 1);
    assert.match(seen[seen.length - 1], /\/quote\?/);
    assert.deepEqual(r2.fields.change_1d, { v: 2.5, kind: "number" });
    assert.equal(r2.fields.price.v, 11, "quote overlay beats the snapshot");
    assert.equal(r2.fields.market_cap.v, 110);

    // pe/dividend ride the 6h-cached ratios endpoint; dividend is a percent.
    const r3 = await fmp.fetchFields("RATX", ["pe_ratio", "dividend_yield"], { apiKey: "k" });
    assert.match(seen[seen.length - 1], /\/ratios-ttm\?/);
    assert.deepEqual(r3.fields.pe_ratio, { v: 21, kind: "number" });
    assert.deepEqual(r3.fields.dividend_yield, { v: 2, kind: "number" });

    // A symbol outside the universe depth falls back to the quote.
    const r4 = await fmp.fetchFields("ELSEWHERE", ["price"], { apiKey: "k" });
    assert.match(seen[seen.length - 1], /\/quote\?/);
    assert.equal(r4.fields.price.v, 11);
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});
