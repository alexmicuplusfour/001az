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
  assert.equal(manifest.template.identity.source, "connector");
  assert.ok(manifest.fields.some((field) => field.key === "price"));
  assert.ok(manifest.fields.some((field) => field.key === "sector"));
  assert.ok(manifest.providers.some((provider) =>
    provider.name === "financialmodelingprep" && provider.needsKey
  ));
  assert.deepEqual(manifest.faces[0].periods, ["7d", "30d", "90d", "1y", "5y"]);
  assert.ok(getConnector("stocks"));
});

test("FMP search: normalizes symbols and keeps every quotable USD listing (OTC included)", async () => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    // Real /stable/search-* rows: symbol, name, currency, exchange (short form).
    // OTC is quotable on this tier (verified 2026-08-13); non-US venues like
    // TSX are premium-gated at the quote endpoint, so they stay out.
    return response([
      { symbol: "aapl", name: "Apple Inc.", currency: "USD", exchange: "NASDAQ" },
      { symbol: "SHOP.TO", name: "Shopify", currency: "CAD", exchange: "TSX" },
      { symbol: "ACME", name: "Acme OTC", currency: "USD", exchange: "OTC" },
    ]);
  };
  try {
    assert.deepEqual(await fmp.search("apple", { apiKey: "test-key" }), [
      { id: "AAPL", symbol: "AAPL", label: "Apple Inc.", exchange: "NASDAQ" },
      { id: "ACME", symbol: "ACME", label: "Acme OTC", exchange: "OTC" },
    ]);
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

test("FMP list: universe hits carry full columns; the search bridge reaches past the screener", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    // Real /stable/company-screener rows: exchangeShortName + a full exchange
    // name, and no intraday change field. MID's volume is 0 — FMP's
    // outside-session zeroing, which must render as null, never a false 0.
    if (u.includes("/company-screener?")) return response([
      { symbol: "SMALL", companyName: "Small Co.", marketCap: 10, price: 2, volume: 20, sector: "Energy", exchangeShortName: "NYSE", exchange: "New York Stock Exchange" },
      { symbol: "BIG", companyName: "Big Co.", marketCap: 100, price: 20, volume: 200, sector: "Technology", exchangeShortName: "NASDAQ", exchange: "NASDAQ Global Select" },
      { symbol: "MID", companyName: "Mid Co.", marketCap: 50, price: 10, volume: 0, sector: "Healthcare", exchangeShortName: "NYSE", exchange: "New York Stock Exchange" },
      // An unpriced fringe listing: FMP reports marketCap 0 — missing data,
      // which must sort LAST ascending, not ahead of every real micro-cap.
      { symbol: "ZERO", companyName: "Zero Co.", marketCap: 0, price: 1, volume: 0, sector: "Energy", exchangeShortName: "AMEX", exchange: "NYSE American" },
    ]);
    // The bridge: search knows BIGO (an OTC listing the screener never
    // carries); one quote fills its columns. BIG also comes back from search
    // and must dedupe against the universe row.
    if (u.includes("/search-symbol?")) return response([
      { symbol: "BIG", name: "Big Co.", currency: "USD", exchange: "NASDAQ" },
      { symbol: "BIGO", name: "Big Otc Energy", currency: "USD", exchange: "OTC" },
    ]);
    if (u.includes("/search-name?")) return response([]);
    if (u.includes("/quote?symbol=BIGO")) return response([
      { symbol: "BIGO", name: "Big Otc Energy", price: 5, marketCap: 7, volume: 0, exchange: "OTC" },
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
    assert.equal(rows[1].values.volume, null, "session-zeroed volume serves null");
    // The screener asks for what the TIER can serve and nothing narrower:
    // still-trading listings on the quotable venues, at full depth, one
    // request per venue (FMP caps a single response at 10k rows, so the
    // universe is assembled from disjoint slices). No country filter (it
    // excluded every ADR) and no isEtf/isFund exclusion (they're a `type`
    // filter now, the user's choice rather than the manifest's).
    const screeners = seen.filter((u) => u.includes("/company-screener?"));
    assert.deepEqual(
      screeners.map((u) => new URL(u).searchParams.get("exchange")),
      ["NASDAQ", "NYSE", "AMEX"],
      "one disjoint slice per venue"
    );
    assert.ok(screeners.every((u) => u.includes("isActivelyTrading=true")));
    assert.ok(screeners.every((u) => !u.includes("country=")), "domicile is not a tier gate");
    assert.ok(screeners.every((u) => !u.includes("isEtf=")), "ETFs are browsable, then filterable");
    assert.ok(screeners.every((u) => !u.includes("isFund=")));
    assert.ok(screeners.every((u) => u.includes("limit=30000")), "default depth asks for the whole universe");

    // Ascending market cap starts at the smallest REAL company; the unpriced
    // row (marketCap 0 → null) trails everything it has no number to beat.
    const asc = await fmp.list({ sort: "market_cap", order: "asc", page: 1, pageSize: 4 }, { apiKey: "test-key" });
    assert.deepEqual(asc.map((row) => row.symbol), ["SMALL", "MID", "BIG", "ZERO"]);
    assert.equal(asc[3].values.market_cap, null);

    // A query: universe matches keep their free full columns AND the bridge
    // appends what only search knows — BIGO arrives quote-filled, without
    // rank/sector (the screener is their only source), and BIG doesn't double.
    const hits = await fmp.list({ query: "big" }, { apiKey: "test-key" });
    assert.deepEqual(hits.map((row) => row.symbol), ["BIG", "BIGO"]);
    assert.equal(hits[0].values.price, 20);
    assert.equal(hits[1].values.price, 5);
    assert.equal(hits[1].values.rank, null);
    assert.equal(hits[1].values.sector, null);
    assert.equal(hits[1].values.volume, null);
    assert.equal(hits[1].values.exchange, "OTC");
    assert.equal(seen.filter((u) => u.includes("/company-screener?")).length, VENUES, "query reuses the cached universe — no second fill");

    // Same query again: the bridge result is cached — no new search/quote.
    const before = seen.length;
    await fmp.list({ query: "big" }, { apiKey: "test-key" });
    assert.equal(seen.length, before, "bridge cache serves a repeated query");

    // Filters are exact matches on screener vocabulary; a bridge row has no
    // sector, so a sector filter honestly excludes it.
    const tech = await fmp.list({ query: "big", sector: "Technology" }, { apiKey: "test-key" });
    assert.deepEqual(tech.map((row) => row.symbol), ["BIG"]);
    const nyse = await fmp.list({ exchange: "NYSE" }, { apiKey: "test-key" });
    assert.deepEqual(nyse.map((row) => row.symbol).sort(), ["MID", "SMALL"]);
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP list: a bridge row that JOINS the universe stops doubling on the next fill", async () => {
  // The bridge cache (5 min) and the universe (5 min) don't tick together, so
  // a cached bridge row outlives the fill it was deduped against. When the
  // symbol later enters the screener, the row must not render twice.
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  let screenerRequests = 0;
  const OLDCO = { symbol: "OLDCO", companyName: "Old Co", marketCap: 100, price: 5, volume: 10, exchangeShortName: "NYSE" };
  const NEWCO = { symbol: "NEWCO", companyName: "New Co", marketCap: 50, price: 3, volume: 5, exchangeShortName: "NASDAQ" };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/company-screener?")) {
      screenerRequests++;
      // Every venue slice returns the same rows here (the union dedupes);
      // past the first fill's worth of slices, NEWCO has listed.
      return response(screenerRequests <= VENUES ? [OLDCO] : [OLDCO, NEWCO]);
    }
    if (u.includes("/search-symbol?")) return response([{ symbol: "NEWCO", name: "New Co", currency: "USD", exchange: "NASDAQ" }]);
    if (u.includes("/search-name?")) return response([]);
    if (u.includes("/quote?symbol=NEWCO")) return response([{ symbol: "NEWCO", name: "New Co", price: 3, marketCap: 50, volume: 5, exchange: "NASDAQ" }]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const first = await fmp.list({ query: "co" }, { apiKey: "k" });
    assert.deepEqual(first.map((r) => r.symbol), ["OLDCO", "NEWCO"]); // NEWCO via the bridge

    // Cross the universe TTL: the next call blocks on a fresh fill that now
    // carries NEWCO, while the bridge cache still holds its quote-filled row.
    fmp._ageScreenerCache(61 * 60 * 1000);
    const second = await fmp.list({ query: "co" }, { apiKey: "k" });
    assert.equal(screenerRequests, 2 * VENUES, "exactly two fills");
    assert.deepEqual(second.map((r) => r.symbol), ["OLDCO", "NEWCO"], "no double row");
    assert.equal(second.find((r) => r.symbol === "NEWCO").values.rank, 2, "served from the universe, with its rank");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP list: a plan-gated screener still serves search; a plain browse says so once", async () => {
  // The screener isn't in FMP's free tier at all. A query can still be served
  // (search + quote ARE free-tier endpoints), so search degrades to
  // bridge-only rather than dying — and the failed fill isn't re-bought on
  // every keystroke (the free tier's budget is 250 requests A DAY).
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    if (u.includes("/company-screener?")) return response({ "Error Message": "Exclusive Endpoint: This endpoint is not available under your current subscription" }, 402);
    if (u.includes("/search-symbol?")) return response([{ symbol: "AAPL", name: "Apple Inc.", currency: "USD", exchange: "NASDAQ" }]);
    if (u.includes("/search-name?")) return response([]);
    if (u.includes("/quote?symbol=AAPL")) return response([{ symbol: "AAPL", name: "Apple Inc.", price: 210, marketCap: 3e12, volume: 4e7, exchange: "NASDAQ" }]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const rows = await fmp.list({ query: "apple" }, { apiKey: "k" });
    assert.deepEqual(rows.map((r) => r.symbol), ["AAPL"]);
    assert.equal(rows[0].values.price, 210);
    assert.equal(rows[0].values.rank, null, "no universe → no rank, honestly");

    // A plain browse IS the universe, so its absence propagates as the real
    // provider error (the modal shows it; the plugin health row records it).
    await assert.rejects(fmp.list({}, { apiKey: "k" }), /Exclusive Endpoint/);

    // The gated screener was attempted for ONE fill, not once per call.
    assert.equal(seen.filter((u) => u.includes("/company-screener?")).length, VENUES);
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: ADRs, ETFs and funds are IN it, and `type` is how a user narrows", async () => {
  // The three exclusions this universe used to carry, each represented: a
  // foreign-domiciled ADR (excluded by country=US), an ETF and a closed-end
  // fund (excluded by isEtf/isFund=false). All three quote on this tier, and
  // a feed — which can't fall back to search — could never reach them.
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (!u.includes("/company-screener?")) throw new Error(`unexpected URL ${u}`);
    return response([
      { symbol: "AAPL", companyName: "Apple Inc.", marketCap: 3e12, price: 210, volume: 5e7, sector: "Technology", country: "US", exchangeShortName: "NASDAQ" },
      { symbol: "TSM", companyName: "Taiwan Semiconductor", marketCap: 8e11, price: 180, volume: 1e7, sector: "Technology", country: "TW", exchangeShortName: "NYSE" },
      { symbol: "SPY", companyName: "SPDR S&P 500 ETF Trust", marketCap: 5e11, price: 550, volume: 8e7, exchangeShortName: "AMEX", isEtf: true },
      { symbol: "PDI", companyName: "PIMCO Dynamic Income Fund", marketCap: 5e9, price: 19, volume: 1e6, exchangeShortName: "NYSE", isFund: true },
    ]);
  };
  try {
    const all = await fmp.list({ sort: "market_cap", order: "desc", pageSize: 50 }, { apiKey: "k" });
    assert.deepEqual(all.map((r) => r.symbol), ["AAPL", "TSM", "SPY", "PDI"]);
    assert.deepEqual(all.map((r) => r.values.type), ["Stock", "Stock", "ETF", "Fund"]);
    assert.equal(all[1].values.rank, 2, "an ADR ranks in the universe like any listing");

    // Each type narrows to itself — the choice the exclusions used to make.
    for (const [type, symbols] of [
      ["Stock", ["AAPL", "TSM"]], ["ETF", ["SPY"]], ["Fund", ["PDI"]],
    ]) {
      const rows = await fmp.list({ type, sort: "market_cap", order: "desc" }, { apiKey: "k" });
      assert.deepEqual(rows.map((r) => r.symbol), symbols);
    }
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: disjoint venue slices carry it past FMP's 10k-per-response cap", async () => {
  // FMP caps a screener RESPONSE at 10,000 rows however large a `limit` you
  // send, and its page param overlaps — so one call can never see more than
  // 10k. The universe is bigger than that, and asking per venue is how it
  // gets served whole: three responses at the cap = 30k distinct listings.
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const CAP = 10000;
  const venueRows = (venue) =>
    Array.from({ length: CAP }, (_, i) => ({
      symbol: `${venue}${i}`, companyName: `${venue} ${i}`,
      marketCap: CAP - i, price: 1, volume: 1, exchangeShortName: venue,
    }));
  globalThis.fetch = async (url) => {
    const params = new URL(String(url)).searchParams;
    // A venue that is itself at the cap gets split by listing type; this stub
    // has no ETFs or funds, so those sub-slices come back empty.
    if (params.get("isEtf") === "true" || params.get("isFund") === "true") return response([]);
    return response(venueRows(params.get("exchange")));
  };
  try {
    const page = await fmp.list({ sort: "market_cap", order: "desc", pageSize: 250 }, { apiKey: "k" });
    assert.equal(page.length, 250);
    // Ranks span the UNION, so the universe really is 3 × the response cap.
    const deep = await fmp.list({ sort: "market_cap", order: "desc", page: 120, pageSize: 250 }, { apiKey: "k" });
    assert.equal(deep[deep.length - 1].values.rank, 30000, "the 30,000th listing is reachable");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: a venue at the cap is re-split by listing type, and dedupes", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const CAP = 10000;
  const seen = [];
  // Real screener rows always carry isEtf/isFund, whichever slice they came
  // from — so a row's type doesn't depend on which slice won the dedupe.
  const SHARED = { symbol: "SHARED", companyName: "Shared ETF", marketCap: 9, price: 1, volume: 1, exchangeShortName: "NASDAQ", isEtf: true, isFund: false };
  const FUNDX = { symbol: "FUNDX", companyName: "Fund X", marketCap: 8, price: 1, volume: 1, exchangeShortName: "NASDAQ", isEtf: false, isFund: true };
  const PLAINCO = { symbol: "PLAINCO", companyName: "Plain Co", marketCap: 7, price: 1, volume: 1, exchangeShortName: "NASDAQ", isEtf: false, isFund: false };
  globalThis.fetch = async (url) => {
    const params = new URL(String(url)).searchParams;
    seen.push({ exchange: params.get("exchange"), isEtf: params.get("isEtf"), isFund: params.get("isFund") });
    if (params.get("exchange") !== "NASDAQ") return response([]);
    // NASDAQ alone saturates → the sub-split adds what the capped response
    // couldn't carry. SHARED is in BOTH the capped response and the ETF
    // slice, and must not become two rows (and two ranks).
    if (params.get("isEtf") === "true") return response([SHARED]);
    if (params.get("isFund") === "true") return response([FUNDX]);
    if (params.get("isEtf") === "false") return response([PLAINCO]);
    return response([SHARED, ...Array.from({ length: CAP - 1 }, (_, i) =>
      ({ symbol: `N${i}`, companyName: `N ${i}`, marketCap: 100, price: 1, volume: 1, exchangeShortName: "NASDAQ", isEtf: false, isFund: false }))]);
  };
  try {
    // Ascending market cap surfaces exactly the three small rows, in order —
    // two of which ONLY the sub-slices could reach.
    const rows = await fmp.list({ sort: "market_cap", order: "asc", pageSize: 3 }, { apiKey: "k" });
    assert.deepEqual(rows.map((r) => r.symbol), ["PLAINCO", "FUNDX", "SHARED"]);
    assert.deepEqual(rows.map((r) => r.values.type), ["Stock", "Fund", "ETF"]);

    // The capped response is kept too, so its rows are still there.
    const top = await fmp.list({ sort: "market_cap", order: "desc", pageSize: 2 }, { apiKey: "k" });
    assert.ok(top.every((r) => r.symbol.startsWith("N")), "the 10k already bought is still served");

    // And the overlap collapsed: one SHARED, one rank.
    const shared = await fmp.list({ query: "shared", pageSize: 50 }, { apiKey: "k" });
    assert.equal(shared.filter((r) => r.symbol === "SHARED").length, 1, "the overlap collapses to one row");

    // Only the saturated venue paid for the extra slices.
    const splits = seen.filter((s) => s.isEtf != null || s.isFund != null);
    assert.equal(splits.length, 3);
    assert.ok(splits.every((s) => s.exchange === "NASDAQ"));
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: a saturated venue's split is ADDITIVE, and survives a refused slice", async () => {
  // The saturated response is 10,000 real listings already bought. Replacing
  // it with the sub-slices would mean a refused slice costs the venue — and
  // Promise.all would have failed the whole universe over one of them.
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const CAP = 10000;
  globalThis.fetch = async (url) => {
    const params = new URL(String(url)).searchParams;
    if (params.get("exchange") !== "NASDAQ") return response([]);
    if (params.get("isEtf") === "true") throw new Error("slice refused");           // rejects
    if (params.get("isFund") === "true") return response([{ symbol: "FUNDX", companyName: "Fund X", marketCap: 8, price: 1, volume: 1, exchangeShortName: "NASDAQ", isFund: true }]);
    if (params.get("isEtf") === "false") return response([]);                        // narrows to nothing
    return response(Array.from({ length: CAP }, (_, i) =>
      ({ symbol: `N${i}`, companyName: `N ${i}`, marketCap: CAP - i, price: 1, volume: 1, exchangeShortName: "NASDAQ" })));
  };
  try {
    const rows = await fmp.list({ sort: "market_cap", order: "desc", pageSize: 5 }, { apiKey: "k" });
    assert.equal(rows[0].symbol, "N0", "the saturated response is still served");
    // The one slice that answered adds to it; the refusal costs nothing.
    const fund = await fmp.list({ query: "fund x", pageSize: 5 }, { apiKey: "k" });
    assert.ok(fund.some((r) => r.symbol === "FUNDX"), "the slice that answered still contributes");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP list: a type filter excludes bridge rows rather than guessing them", async () => {
  // A bridge row is quote-filled and carries no isEtf/isFund flags, so it has
  // no type to show. It must not be assumed to be a Stock — SPY reached by
  // search is precisely the row that assumption gets wrong.
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/company-screener?")) return response([
      { symbol: "REALCO", companyName: "Real Co", marketCap: 100, price: 5, volume: 10, exchangeShortName: "NYSE" },
    ]);
    if (u.includes("/search-symbol?")) return response([{ symbol: "SPY", name: "SPDR S&P 500 ETF Trust", currency: "USD", exchange: "AMEX" }]);
    if (u.includes("/search-name?")) return response([]);
    if (u.includes("/quote?symbol=SPY")) return response([{ symbol: "SPY", name: "SPDR S&P 500 ETF Trust", price: 550, marketCap: 5e11, volume: 8e7, exchange: "AMEX" }]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    const unfiltered = await fmp.list({ query: "sp" }, { apiKey: "k" });
    const spy = unfiltered.find((r) => r.symbol === "SPY");
    assert.ok(spy, "the bridge still reaches it");
    assert.equal(spy.values.type, null, "no flags to read → no type claimed");

    const asStock = await fmp.list({ query: "sp", type: "Stock" }, { apiKey: "k" });
    assert.ok(!asStock.some((r) => r.symbol === "SPY"), "an ETF must not pass a Stock filter");
    const asEtf = await fmp.list({ query: "sp", type: "ETF" }, { apiKey: "k" });
    assert.ok(!asEtf.some((r) => r.symbol === "SPY"), "nor claim a type it can't verify");
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP universe: the venue list is the tier's boundary, and it's tunable", async () => {
  // Non-US venues are premium-gated at the quote endpoint, so browse would
  // only list rows that fail on add — that boundary is real and stays. OTC is
  // quotable here, so widening to it is supported without a code change.
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => { seen.push(String(url)); return response([]); };
  process.env.FMP_EXCHANGES = "NASDAQ,NYSE,AMEX,OTC";
  try {
    await fmp.list({}, { apiKey: "k" });
    assert.deepEqual(
      seen.map((u) => new URL(u).searchParams.get("exchange")),
      ["NASDAQ", "NYSE", "AMEX", "OTC"],
      "a widened venue list is one more disjoint slice, not a longer single query"
    );
  } finally {
    delete process.env.FMP_EXCHANGES;
    globalThis.fetch = original;
    fmp._resetScreenerCache();
  }
});

test("FMP: industry is a provider-supplied filter vocabulary, and it narrows the universe", async () => {
  fmp._resetScreenerCache();
  const original = globalThis.fetch;
  let industryHits = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/available-industries")) {
      industryHits++;
      return response([{ industry: "Software - Application" }, { industry: "Biotechnology" }]);
    }
    if (u.includes("/company-screener?")) return response([
      { symbol: "SOFT", companyName: "Soft Co", marketCap: 100, price: 10, volume: 5, sector: "Technology", industry: "Software - Application", exchangeShortName: "NASDAQ" },
      { symbol: "BIO", companyName: "Bio Co", marketCap: 50, price: 5, volume: 3, sector: "Healthcare", industry: "Biotechnology", exchangeShortName: "NASDAQ" },
    ]);
    throw new Error(`unexpected URL ${u}`);
  };
  try {
    // Bare values: shaping and ordering are browseFilters' job, so a provider
    // only has to say what the vocabulary IS.
    const { industry, exchange } = await fmp.filterOptions({ apiKey: "k" });
    assert.deepEqual(industry, ["Software - Application", "Biotechnology"]);
    // Exchange is derived from the venue list the universe was built from, so
    // widening FMP_EXCHANGES widens the control with it — frozen in the
    // manifest, the two used to disagree and the route rejected the new venue.
    assert.deepEqual(exchange, ["NASDAQ", "NYSE", "AMEX"]);

    await fmp.filterOptions({ apiKey: "k" });
    assert.equal(industryHits, 1, "cached a day — not re-bought per modal open");

    const rows = await fmp.list({ industry: "Biotechnology" }, { apiKey: "k" });
    assert.deepEqual(rows.map((r) => r.symbol), ["BIO"]);
  } finally {
    globalThis.fetch = original;
    fmp._resetScreenerCache();
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
//
// One universe FILL is one screener request per venue: FMP caps a single
// response at 10,000 rows, so the universe is assembled from disjoint venue
// slices and unioned. The counts below are therefore per-fill, not per-request
// — what single-flight and the caches promise is one FILL, not one HTTP call.
const VENUES = 3; // the default FMP_EXCHANGES list: NASDAQ, NYSE, AMEX

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
    assert.equal(paced.length, VENUES); // cold universe fill: one slice per venue
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
    assert.equal(screenerHits, VENUES, "ONE fill's worth of slices, not two callers' worth");
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
  let requests = 0;
  // Every venue slice of the FIRST fill serves OLD; the refill's slices serve
  // NEW. (Each venue returns the same one row here — the union dedupes it.)
  globalThis.fetch = async () => {
    requests++;
    const symbol = requests <= VENUES ? "OLD" : "NEW";
    return response([{ symbol, companyName: "X", marketCap: 1, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
  };
  try {
    assert.equal((await fmp.list({}, { apiKey: "k" }))[0].symbol, "OLD");
    fmp._ageScreenerCache(6 * 60 * 1000); // past BROWSE_TTL, inside the hard bar
    const stale = await fmp.list({}, { apiKey: "k" });
    assert.equal(stale[0].symbol, "OLD"); // no caller ever waits on the refill
    for (let i = 0; i < 100 && requests < 2 * VENUES; i++) await new Promise((r) => setTimeout(r, 5));
    assert.equal(requests, 2 * VENUES, "exactly one background refresh fired");
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
  let requests = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  globalThis.fetch = async () => {
    requests++;
    // The first fill's slices answer at once; every slice of the second waits
    // on the gate, so the whole refill is still in flight when we check.
    if (requests <= VENUES) return response([{ symbol: "OLD", companyName: "X", marketCap: 1, price: 1, volume: 1, exchangeShortName: "NYSE" }]);
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
    assert.equal(page1.length, 250); // the feed adapter's default page size fits in one slice
    const page2 = await fmp.list({ sort: "market_cap", order: "desc", page: 2, pageSize: 250 }, { apiKey: "k" });
    assert.equal(page2.length, 50);
    assert.equal(page2[0].values.rank, 251); // offset math consistent with the clamp
    assert.equal(seen.length, VENUES, "both page slices served from one fill");
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
