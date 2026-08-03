// Financial Modeling Prep provider for the stocks connector. V1 deliberately
// targets actively traded US equities in USD. FMP's stable API supplies search,
// screening, quotes, company profiles, and end-of-day price history.
//
// Scale posture (see planning/connector-scale-plan.md for the measurements):
// on this API the `company-screener` is the one bulk fact — a flat ~15 s of
// server-side compute REGARDLESS of row count (limit=10 and limit=3000 cost
// the same), carrying price/market cap/volume/sector/industry/exchange for
// the whole universe. Every batch-quote endpoint is premium-gated, and the
// stable `quote` endpoint silently returns [] for comma lists — so the
// screener snapshot, cached and revalidated below, is what makes a
// 1000-entity board cheap: browse, feeds, and the bulk of the refresh sweep
// all read from it, and only change_1d costs a per-symbol quote.
import { providerSignal, providerBudgetMs } from "../runtime.js";

const BASE = "https://financialmodelingprep.com/stable";
const PROFILE_TTL = 6 * 60 * 60 * 1000;
// Universe freshness: inside BROWSE_TTL serve as-is; past it serve stale and
// revalidate in the background; past SCREENER_MAX_AGE block on a fresh fetch
// so the data can't go silently ancient (an hour of drift in a market-cap
// ordering is fine; a day is not).
const BROWSE_TTL = 5 * 60 * 1000;
const SCREENER_MAX_AGE = 60 * 60 * 1000;
const US_EXCHANGE = /NASDAQ|NYSE|AMEX/i;

// How deep the screener universe goes — the ceiling for browse, feeds, and
// market-cap rank. One request either way (depth is free: 3000 rows measured
// at the same flat latency as 10), so the knob trades only memory (~430 KB
// per 1000 rows) and response size. Read per call so tests can steer it.
const universeRows = () =>
  Math.max(100, Math.min(5000, Number(process.env.FMP_UNIVERSE_ROWS) || 2000));

export const label = "Financial Modeling Prep";
export const description = "US stock quotes, fundamentals, and price history — needs a key";
export const needsKey = true;
// Truthful request pacing: this provider awaits ctx.pace() before every raw
// HTTP request (pacesRequests — see runtime.callProvider), so rpm meters what
// FMP actually meters. 240 sustained + burst 20 stays under the 300/min
// paid-tier ceiling with headroom for retries; a cold fetchEntity honestly
// pays 3 tokens (quote + profile + ratios), a warm cache-served list() pays 0.
// (Free-tier *daily* quotas are a separate limit this bucket doesn't model.)
export const pacesRequests = true;
export const rpm = 240;
export const burst = 20;

function fail(message, status) {
  const e = new Error(`Financial Modeling Prep: ${message}`);
  if (status != null) e.status = status;
  return e;
}

// One raw FMP request: paced (when the runtime threaded a pacer in), bounded
// by the call class's budget, and with timeouts renamed from the bare
// DOMException text to something an operator can act on. The timeout error
// stays status-less on purpose — withRetry must not retry a slow endpoint.
async function fmp(endpoint, params, apiKey, { bulk = false, pace } = {}) {
  if (!apiKey) throw fail("needs an API key");
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("apikey", apiKey);

  await pace?.();
  let r;
  try {
    r = await fetch(url, { signal: providerSignal(bulk ? "bulk" : undefined) });
  } catch (e) {
    if (e?.name === "TimeoutError")
      throw fail(`${endpoint} timed out after ${Math.round(providerBudgetMs(bulk ? "bulk" : undefined) / 1000)}s`);
    throw e;
  }
  const text = await r.text();
  let body;
  try { body = text ? JSON.parse(text) : null; }
  catch { throw fail(`invalid response (HTTP ${r.status})`, r.status); }

  const apiMessage = body?.["Error Message"] || body?.error || body?.message;
  if (!r.ok || apiMessage) {
    const safe = String(apiMessage || `HTTP ${r.status}`).replaceAll(apiKey, "[redacted]");
    const e = fail(safe, r.status);
    const retryAfter = r.headers?.get?.("retry-after");
    if (retryAfter != null) e.retryAfter = retryAfter;
    throw e;
  }
  return body;
}

const symbolOf = (row) => String(row?.symbol || "").trim().toUpperCase();
const exchangeOf = (row) => row?.exchangeShortName || row?.exchange || row?.stockExchange || "";
const isUsListing = (row) =>
  (!row?.currency || String(row.currency).toUpperCase() === "USD") &&
  US_EXCHANGE.test(exchangeOf(row));

export async function search(query, { apiKey, pace } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  // FMP splits ticker and company-name lookup into separate endpoints. Merge
  // both so one connector search box behaves naturally for either input — and
  // tolerate one being unavailable (tier-gated / rate-limited) rather than
  // failing the whole search; only a total failure (both rejected) propagates.
  const [symRes, nameRes] = await Promise.allSettled([
    fmp("search-symbol", { query: q, limit: 25 }, apiKey, { pace }),
    fmp("search-name", { query: q, limit: 25 }, apiKey, { pace }),
  ]);
  if (symRes.status === "rejected" && nameRes.status === "rejected") throw symRes.reason;
  const rowsOf = (res) => (res.status === "fulfilled" && Array.isArray(res.value) ? res.value : []);
  const unique = new Map();
  for (const row of [...rowsOf(symRes), ...rowsOf(nameRes)]) {
    const symbol = symbolOf(row);
    if (symbol && !unique.has(symbol)) unique.set(symbol, row);
  }
  return [...unique.values()]
    .filter((row) => symbolOf(row) && isUsListing(row))
    .slice(0, 10)
    .map((row) => ({
      id: symbolOf(row),
      symbol: symbolOf(row),
      label: row.name || row.companyName || symbolOf(row),
      exchange: exchangeOf(row) || null,
    }));
}

const profileCache = new Map();
const ratiosCache = new Map();

async function profileFor(symbol, apiKey, pace) {
  const cached = profileCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.value;
  const rows = await fmp("profile", { symbol }, apiKey, { pace });
  const value = Array.isArray(rows) ? rows[0] : null;
  if (value) profileCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function ratiosFor(symbol, apiKey, pace) {
  const cached = ratiosCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.value;
  const rows = await fmp("ratios-ttm", { symbol }, apiKey, { pace });
  const value = Array.isArray(rows) ? rows[0] : null;
  if (value) ratiosCache.set(symbol, { at: Date.now(), value });
  return value;
}

function number(value) {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

export async function fetchEntity(id, { apiKey, pace } = {}) {
  const requested = String(id || "").trim().toUpperCase();
  if (!requested) throw fail("symbol is required");
  // quote is the required core (price / market cap / volume / change). profile
  // and ratios are enrichment — a tier that gates or rate-limits them shouldn't
  // sink the add, so they degrade to null while quote still yields an entity. A
  // quote failure keeps its status (via allSettled's reason) so the runtime can
  // still recognise and retry a 429.
  const [quoteRes, profileRes, ratiosRes] = await Promise.allSettled([
    fmp("quote", { symbol: requested }, apiKey, { pace }),
    profileFor(requested, apiKey, pace),
    ratiosFor(requested, apiKey, pace),
  ]);
  if (quoteRes.status === "rejected") throw quoteRes.reason;
  const quote = Array.isArray(quoteRes.value) ? quoteRes.value[0] : null;
  if (!quote) throw fail(`no quote for ${requested}`);
  const profile = profileRes.status === "fulfilled" ? profileRes.value : null;
  const ratios = ratiosRes.status === "fulfilled" ? ratiosRes.value : null;

  const symbol = symbolOf(quote) || symbolOf(profile) || requested;
  const change = quote.changePercentage ?? quote.changesPercentage ?? profile?.changePercentage ?? profile?.changesPercentage;
  const exchange = exchangeOf(quote) || exchangeOf(profile) || null;
  const dividendYield = number(ratios?.dividendYieldTTM);
  return {
    id: symbol,
    symbol,
    display_name: quote.name || profile?.companyName || symbol,
    fields: {
      price:      { v: number(quote.price ?? profile?.price), kind: "number" },
      change_1d:  { v: number(change), kind: "number" },
      market_cap: { v: number(quote.marketCap ?? profile?.marketCap), kind: "number" },
      volume:     { v: number(quote.volume ?? profile?.volume), kind: "number" },
      pe_ratio:   { v: number(quote.pe ?? ratios?.priceToEarningsRatioTTM), kind: "number" },
      dividend_yield: {
        v: dividendYield == null ? null : dividendYield * 100,
        kind: "number",
      },
      sector:     { v: profile?.sector || null, kind: "text" },
      industry:   { v: profile?.industry || null, kind: "text" },
      exchange:   { v: exchange, kind: "text" },
      currency:   { v: profile?.currency || "USD", kind: "text" },
      website:    { v: profile?.website || null, kind: "url" },
    },
  };
}

// Browse row from a screener row. The screener carries name / price / market
// cap / volume / sector / exchange but no intraday change — so `change_1d` is
// deliberately absent here (and from browse.columns); boards still get it live
// from the quote-fed field refresh.
function browseRow(row) {
  const symbol = symbolOf(row);
  const name = row?.companyName || row?.name || symbol;
  return {
    id: symbol,
    symbol,
    label: name,
    values: {
      rank: row?.mcapRank ?? null,
      name,
      price: number(row?.price),
      market_cap: number(row?.marketCap),
      volume: number(row?.volume),
      sector: row?.sector || null,
      exchange: exchangeOf(row) || null,
    },
  };
}

function sortRows(rows, sort, order) {
  const key = { name: "companyName", price: "price", market_cap: "marketCap", volume: "volume" }[sort] || "marketCap";
  const direction = order === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const av = a?.[key], bv = b?.[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return direction * (typeof av === "string"
      ? av.localeCompare(String(bv))
      : Number(av) - Number(bv));
  });
}

// The screener universe: rows + a symbol index for O(1) refresh lookups +
// the in-flight fetch shared by every concurrent caller (preview, sweep, and
// browse race on a cold board — without single-flight each would burn its own
// ~15 s metered request; with it, one request, one token, one failure wave).
let screenerCache = { at: 0, rows: null, bySymbol: null, inflight: null };

function fetchUniverse(apiKey, pace) {
  if (!screenerCache.inflight) {
    const p = (async () => {
      const rows = await fmp("company-screener", {
        country: "US",
        exchange: "NASDAQ,NYSE,AMEX",
        isEtf: false,
        isFund: false,
        isActivelyTrading: true,
        limit: universeRows(),
      }, apiKey, { bulk: true, pace });
      const list = Array.isArray(rows) ? rows : [];
      // Market-cap rank within the universe, computed here rather than trusted
      // from response order — it makes "top 50 stocks" expressible as a feed
      // filter (rank ≤ 50), mirroring crypto's market_cap_rank.
      [...list]
        .sort((a, b) => (number(b?.marketCap) ?? 0) - (number(a?.marketCap) ?? 0))
        .forEach((row, i) => { row.mcapRank = i + 1; });
      const bySymbol = new Map();
      for (const row of list) bySymbol.set(symbolOf(row), row);
      screenerCache = { at: Date.now(), rows: list, bySymbol, inflight: null };
      return list;
    })();
    screenerCache.inflight = p;
    // A failed fill releases the flight so the next caller retries fresh;
    // the stale rows (if any) stay served meanwhile.
    p.catch(() => { screenerCache.inflight = null; });
  }
  return screenerCache.inflight;
}

async function stockUniverse(apiKey, pace) {
  const age = Date.now() - screenerCache.at;
  if (screenerCache.rows) {
    if (age < BROWSE_TTL) return screenerCache.rows;
    if (age < SCREENER_MAX_AGE) {
      // Stale-while-revalidate: serve now, refresh behind the request. The
      // background fetch runs outside callProvider/withPluginHealth — one
      // request per TTL window (noise against rpm 240), and a failure keeps
      // the stale rows; the next hard miss surfaces it on the health row.
      fetchUniverse(apiKey, pace).catch((e) =>
        console.warn(`FMP screener refresh failed (serving stale universe): ${e.message}`));
      return screenerCache.rows;
    }
  }
  return fetchUniverse(apiKey, pace);
}

export async function list({ sort, order, page = 1, pageSize = 50, query } = {}, { apiKey, pace } = {}) {
  // The clamp bounds one logical page of the LOCALLY cached universe — it is
  // not a remote API limit. 250 matches the feed adapter's ENUM_PAGE so a
  // window fill is 4 slices, not 10 (each logical call is otherwise free:
  // cache-served slices pace zero requests).
  const size = Math.max(1, Math.min(250, Number(pageSize) || 50));
  const pageNo = Math.max(1, Number(page) || 1);
  const universe = await stockUniverse(apiKey, pace);

  // A query filters the same screened universe rather than routing through
  // search(): the screener rows already carry name / price / market cap /
  // volume / sector / exchange, so the browse columns stay populated (a bare
  // search hit has only the symbol) and it costs no extra request. Trade-off:
  // matches are limited to the actively-traded US universe (universeRows() by
  // market cap); an exact ticker outside it won't appear here.
  const q = query && String(query).trim().toLowerCase();
  const base = q
    ? universe.filter(
        (row) =>
          symbolOf(row).toLowerCase().includes(q) ||
          String(row?.companyName || "").toLowerCase().includes(q)
      )
    : universe;

  const sorted = sortRows(base, sort, order);
  const pageRows = sorted.slice((pageNo - 1) * size, pageNo * size);
  return pageRows.map(browseRow);
}

// Field-aware refresh (runtime.refresh calls this with the DUE keys): route
// each key to its cheapest source. Universe-covered keys cost zero HTTP while
// the snapshot is warm; change_1d is the one per-symbol quote; pe/dividend
// ride the 6 h ratios cache, website/currency the 6 h profile cache. Any key
// this can't produce is simply absent — the runtime falls back to the
// whole-object fetchEntity, so a partial answer can never strand a field.
const UNIVERSE_FIELDS = new Set(["price", "market_cap", "volume", "sector", "industry", "exchange"]);

export async function fetchFields(id, keys, { apiKey, pace } = {}) {
  const symbol = String(id || "").trim().toUpperCase();
  if (!symbol) throw fail("symbol is required");
  const want = new Set(keys || []);
  const fields = {};

  let row = null;
  if ([...want].some((k) => UNIVERSE_FIELDS.has(k))) {
    // A universe failure isn't fatal here: the quote overlay below covers the
    // headline numbers, and the runtime's fetchEntity fallback surfaces any
    // real provider fault (bad key, outage) on its usual paths.
    const universe = await stockUniverse(apiKey, pace).catch(() => null);
    row = universe ? screenerCache.bySymbol?.get(symbol) || null : null;
    if (row) {
      if (want.has("price"))      fields.price      = { v: number(row.price), kind: "number" };
      if (want.has("market_cap")) fields.market_cap = { v: number(row.marketCap), kind: "number" };
      if (want.has("volume"))     fields.volume     = { v: number(row.volume), kind: "number" };
      if (want.has("sector"))     fields.sector     = { v: row.sector || null, kind: "text" };
      if (want.has("industry"))   fields.industry   = { v: row.industry || null, kind: "text" };
      if (want.has("exchange"))   fields.exchange   = { v: exchangeOf(row) || null, kind: "text" };
    }
  }

  // change_1d needs a per-symbol quote (the screener has no intraday change);
  // a symbol outside the universe depth falls back to the quote for the
  // headline numbers too. When the quote is fetched anyway, its values are
  // fresher than the snapshot — overlay, never serve older data than the call
  // already bought.
  const needQuote = want.has("change_1d") || (!row && [...want].some((k) => UNIVERSE_FIELDS.has(k)));
  if (needQuote) {
    const rows = await fmp("quote", { symbol }, apiKey, { pace });
    const quote = Array.isArray(rows) ? rows[0] : null;
    if (quote) {
      if (want.has("change_1d")) {
        const change = quote.changePercentage ?? quote.changesPercentage;
        fields.change_1d = { v: number(change), kind: "number" };
      }
      if (want.has("price"))      fields.price      = { v: number(quote.price), kind: "number" };
      if (want.has("market_cap")) fields.market_cap = { v: number(quote.marketCap), kind: "number" };
      if (want.has("volume"))     fields.volume     = { v: number(quote.volume), kind: "number" };
      if (want.has("exchange"))   fields.exchange   = { v: exchangeOf(quote) || null, kind: "text" };
    }
  }

  // Enrichment keys degrade like fetchEntity's: a gated/failing profile or
  // ratios call yields null values rather than a dead refresh.
  if (want.has("pe_ratio") || want.has("dividend_yield")) {
    const ratios = await ratiosFor(symbol, apiKey, pace).catch(() => null);
    if (want.has("pe_ratio")) fields.pe_ratio = { v: number(ratios?.priceToEarningsRatioTTM), kind: "number" };
    if (want.has("dividend_yield")) {
      const dy = number(ratios?.dividendYieldTTM);
      fields.dividend_yield = { v: dy == null ? null : dy * 100, kind: "number" };
    }
  }
  if (want.has("website") || want.has("currency")) {
    const profile = await profileFor(symbol, apiKey, pace).catch(() => null);
    if (want.has("website"))  fields.website  = { v: profile?.website || null, kind: "url" };
    if (want.has("currency")) fields.currency = { v: profile?.currency || "USD", kind: "text" };
  }

  return { fields };
}

const PERIOD_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, "5y": 5 * 365 };
export const periods = Object.keys(PERIOD_DAYS);

export async function history(id, period, { apiKey, pace } = {}) {
  const symbol = String(id || "").trim().toUpperCase();
  const days = PERIOD_DAYS[period] || PERIOD_DAYS["1y"];
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const rows = await fmp("historical-price-eod/full", {
    symbol,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }, apiKey, { pace });
  // The stable EOD endpoint returns an (unadjusted) `close` per day — no
  // adjusted-close field — so the chart plots the raw close.
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      t: Date.parse(`${row.date}T00:00:00Z`),
      price: number(row.close),
    }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.price))
    .sort((a, b) => a.t - b.t);
}

export async function testConnection({ apiKey, pace } = {}) {
  const rows = await fmp("search-symbol", { query: "AAPL", limit: 1 }, apiKey, { pace });
  if (!Array.isArray(rows)) throw fail("unexpected search response");
  return true;
}

// Test seams only (house convention: provider-pacing's _resetBuckets). Aging
// lets a test cross the TTL/hard-bar thresholds without waiting them out.
export function _resetScreenerCache() {
  screenerCache = { at: 0, rows: null, bySymbol: null, inflight: null };
}
export function _ageScreenerCache(ms) {
  screenerCache.at -= ms;
}
