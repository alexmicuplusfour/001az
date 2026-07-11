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
