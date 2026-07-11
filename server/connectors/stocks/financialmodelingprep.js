// Financial Modeling Prep provider for the stocks connector. V1 deliberately
// targets actively traded US equities in USD. FMP's stable API supplies search,
// screening, quotes, company profiles, and adjusted EOD history.
const BASE = "https://financialmodelingprep.com/stable";
const PROFILE_TTL = 6 * 60 * 60 * 1000;
const BROWSE_TTL = 5 * 60 * 1000;
const MAX_BROWSE_ROWS = 1000;
const US_EXCHANGE = /NASDAQ|NYSE|AMEX/i;

export const label = "Financial Modeling Prep";
export const needsKey = true;
// A cold entity fetch uses quote + profile + ratios; keep runtime calls conservative
// against FMP's lowest paid tier (300 HTTP requests/minute).
export const rpm = 80;
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

  const r = await fetch(url);
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
  // both so one connector search box behaves naturally for either input.
  const [symbolRows, nameRows] = await Promise.all([
    fmp("search-symbol", { query: q, limit: 25 }, apiKey),
    fmp("search-name", { query: q, limit: 25 }, apiKey),
  ]);
  const unique = new Map();
  for (const row of [...(Array.isArray(symbolRows) ? symbolRows : []), ...(Array.isArray(nameRows) ? nameRows : [])]) {
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
  const [quotes, profile, ratios] = await Promise.all([
    fmp("quote", { symbol: requested }, apiKey),
    profileFor(requested, apiKey),
    ratiosFor(requested, apiKey),
  ]);
  const quote = Array.isArray(quotes) ? quotes[0] : null;
  if (!quote) throw fail(`no quote for ${requested}`);

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

function browseRow(base, quote) {
  const symbol = symbolOf(quote) || symbolOf(base);
  const name = quote?.name || base?.companyName || base?.name || symbol;
  return {
    id: symbol,
    symbol,
    label: name,
    values: {
      name,
      price: number(quote?.price ?? base?.price),
      change_1d: number(quote?.changePercentage ?? quote?.changesPercentage ?? base?.changePercentage),
      market_cap: number(quote?.marketCap ?? base?.marketCap),
      volume: number(quote?.volume ?? base?.volume),
      sector: base?.sector || null,
      exchange: exchangeOf(quote) || exchangeOf(base) || null,
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
  screenerCache = { at: Date.now(), rows: Array.isArray(rows) ? rows : [] };
  return screenerCache.rows;
}

export async function list({ sort, order, page = 1, pageSize = 50, query } = {}, { apiKey } = {}) {
  const size = Math.max(1, Math.min(100, Number(pageSize) || 50));
  const pageNo = Math.max(1, Number(page) || 1);

  if (query && String(query).trim()) {
    const hits = await search(query, { apiKey });
    return hits.slice(0, size).map((hit) => browseRow(hit, null));
  }

  const sorted = sortRows(await stockUniverse(apiKey), sort, order);
  const pageRows = sorted.slice((pageNo - 1) * size, pageNo * size);
  return pageRows.map((row) => browseRow(row, null));
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
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      t: Date.parse(`${row.date}T00:00:00Z`),
      price: number(row.adjustedClose ?? row.adjClose ?? row.close),
    }))
    .filter((row) => Number.isFinite(row.t) && Number.isFinite(row.price))
    .sort((a, b) => a.t - b.t);
}

export async function testConnection({ apiKey } = {}) {
  const rows = await fmp("search-symbol", { query: "AAPL", limit: 1 }, apiKey);
  if (!Array.isArray(rows)) throw fail("unexpected search response");
  return true;
}
