// Financial Modeling Prep provider for the stocks connector. V1 deliberately
// targets actively traded US equities in USD. FMP's stable API supplies search,
// screening, quotes, company profiles, and end-of-day price history.
import { providerSignal } from "../runtime.js";

const BASE = "https://financialmodelingprep.com/stable";
const PROFILE_TTL = 6 * 60 * 60 * 1000;
const BROWSE_TTL = 5 * 60 * 1000;
const MAX_BROWSE_ROWS = 1000;
const US_EXCHANGE = /NASDAQ|NYSE|AMEX/i;

export const label = "Financial Modeling Prep";
export const description = "US stock quotes, fundamentals, and price history — needs a key";
export const needsKey = true;
// The runtime's token bucket paces *logical* connector calls, but FMP meters raw
// HTTP requests and a cold fetchEntity fans out to three (quote + profile +
// ratios). profile/ratios are cached (PROFILE_TTL), so a warm refresh sweep is
// ~1 request/entity while a cold bulk add is up to 3 — rpm 60 keeps even the cold
// case (~180 req/min) under FMP's 300/min paid-tier ceiling with headroom for
// history/face calls. (Free-tier *daily* quotas are a separate limit this
// per-minute bucket doesn't model.)
export const rpm = 60;
export const burst = 2;

function fail(message, status) {
  const e = new Error(`Financial Modeling Prep: ${message}`);
  if (status != null) e.status = status;
  return e;
}

async function fmp(endpoint, params, apiKey) {
  if (!apiKey) throw fail("needs an API key");
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  url.searchParams.set("apikey", apiKey);

  const r = await fetch(url, { signal: providerSignal() });
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

export async function search(query, { apiKey } = {}) {
  const q = String(query || "").trim();
  if (!q) return [];
  // FMP splits ticker and company-name lookup into separate endpoints. Merge
  // both so one connector search box behaves naturally for either input — and
  // tolerate one being unavailable (tier-gated / rate-limited) rather than
  // failing the whole search; only a total failure (both rejected) propagates.
  const [symRes, nameRes] = await Promise.allSettled([
    fmp("search-symbol", { query: q, limit: 25 }, apiKey),
    fmp("search-name", { query: q, limit: 25 }, apiKey),
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

async function profileFor(symbol, apiKey) {
  const cached = profileCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.value;
  const rows = await fmp("profile", { symbol }, apiKey);
  const value = Array.isArray(rows) ? rows[0] : null;
  if (value) profileCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function ratiosFor(symbol, apiKey) {
  const cached = ratiosCache.get(symbol);
  if (cached && Date.now() - cached.at < PROFILE_TTL) return cached.value;
  const rows = await fmp("ratios-ttm", { symbol }, apiKey);
  const value = Array.isArray(rows) ? rows[0] : null;
  if (value) ratiosCache.set(symbol, { at: Date.now(), value });
  return value;
}

function number(value) {
  return value == null || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
}

export async function fetchEntity(id, { apiKey } = {}) {
  const requested = String(id || "").trim().toUpperCase();
  if (!requested) throw fail("symbol is required");
  // quote is the required core (price / market cap / volume / change). profile
  // and ratios are enrichment — a tier that gates or rate-limits them shouldn't
  // sink the add, so they degrade to null while quote still yields an entity. A
  // quote failure keeps its status (via allSettled's reason) so the runtime can
  // still recognise and retry a 429.
  const [quoteRes, profileRes, ratiosRes] = await Promise.allSettled([
    fmp("quote", { symbol: requested }, apiKey),
    profileFor(requested, apiKey),
    ratiosFor(requested, apiKey),
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

let screenerCache = { at: 0, rows: null };

async function stockUniverse(apiKey) {
  if (screenerCache.rows && Date.now() - screenerCache.at < BROWSE_TTL) return screenerCache.rows;
  const rows = await fmp("company-screener", {
    country: "US",
    exchange: "NASDAQ,NYSE,AMEX",
    isEtf: false,
    isFund: false,
    isActivelyTrading: true,
    limit: MAX_BROWSE_ROWS,
  }, apiKey);
  const list = Array.isArray(rows) ? rows : [];
  // Market-cap rank within the universe, computed here rather than trusted
  // from response order — it makes "top 50 stocks" expressible as a feed
  // filter (rank ≤ 50), mirroring crypto's market_cap_rank.
  [...list]
    .sort((a, b) => (number(b?.marketCap) ?? 0) - (number(a?.marketCap) ?? 0))
    .forEach((row, i) => { row.mcapRank = i + 1; });
  screenerCache = { at: Date.now(), rows: list };
  return screenerCache.rows;
}

export async function list({ sort, order, page = 1, pageSize = 50, query } = {}, { apiKey } = {}) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const pageNo = Math.max(1, Number(page) || 1);
  const universe = await stockUniverse(apiKey);

  // A query filters the same screened universe rather than routing through
  // search(): the screener rows already carry name / price / market cap /
  // volume / sector / exchange, so the browse columns stay populated (a bare
  // search hit has only the symbol) and it costs no extra request. Trade-off:
  // matches are limited to the actively-traded US universe (MAX_BROWSE_ROWS by
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

const PERIOD_DAYS = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, "5y": 5 * 365 };
export const periods = Object.keys(PERIOD_DAYS);

export async function history(id, period, { apiKey } = {}) {
  const symbol = String(id || "").trim().toUpperCase();
  const days = PERIOD_DAYS[period] || PERIOD_DAYS["1y"];
  const to = new Date();
  const from = new Date(to.getTime() - days * 86400000);
  const rows = await fmp("historical-price-eod/full", {
    symbol,
    from: from.toISOString().slice(0, 10),
    to: to.toISOString().slice(0, 10),
  }, apiKey);
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

export async function testConnection({ apiKey } = {}) {
  const rows = await fmp("search-symbol", { query: "AAPL", limit: 1 }, apiKey);
  if (!Array.isArray(rows)) throw fail("unexpected search response");
  return true;
}
