// CoinMarketCap provider for the crypto connector — the keyed alternative to
// CoinGecko. Proves the domain/provider split: same canonical crypto fields,
// a different backend. Auth is the X-CMC_PRO_API_KEY header.
//
// CMC has no fuzzy-search endpoint like CoinGecko's /search. Instead it exposes
// /cryptocurrency/map (the full id<->symbol<->name listing — a documented
// ZERO-credit call), so search fetches that once (cached), then filters
// locally; fetchEntity does an exact quote lookup by id. Same provider
// contract, assembled differently.
//
// Credit economics (verified against docs 2026-08-13): Basic = 15,000
// credits/month at 50 req/min; quotes and listings bill 1 credit per bundle
// of ids/rows (the bundle size was raised to 250 in CMC's 2026-08-07
// changelog; the batching below assumes the older 100 so it can't be wrong in
// the expensive direction). Per-coin calls are the one shape that wastes the
// budget — hence the quote cache + prefetch: a whole sweep's coins ride one
// batched request.
import { providerSignal } from "../runtime.js";

const BASE = "https://pro-api.coinmarketcap.com";
const MAP_TTL = 6 * 60 * 60 * 1000; // the id/symbol map barely changes (and re-reads are free)

export const label = "CoinMarketCap";
export const description = "Live crypto prices — needs a key";
export const needsKey = true;
export const attribution = { text: "Data by CoinMarketCap", url: "https://coinmarketcap.com" };
// Truthful request pacing (pacesRequests — see runtime.callProvider): each
// raw request awaits the threaded pace(), so a map-cache-served search pays
// zero tokens and the query-path list() honestly pays for both requests.
// Basic is a documented 50 req/min (2026-08-13); pace under it with headroom
// for retries. The monthly credit budget is the real meter — guarded by the
// caches here, not by rpm.
export const pacesRequests = true;
export const rpm = 45;

// GET + parse, surfacing CMC's structured error (it returns error_message both
// on non-2xx and inline as status.error_code on a 200).
async function cmc(path, apiKey, pace) {
  if (!apiKey) throw new Error("CoinMarketCap needs an API key");
  await pace?.();
  const r = await fetch(`${BASE}${path}`, {
    headers: { "X-CMC_PRO_API_KEY": apiKey, Accept: "application/json" },
    signal: providerSignal(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body?.status?.error_code) {
    const e = new Error(`CoinMarketCap: ${body?.status?.error_message || `HTTP ${r.status}`}`);
    e.status = r.status;
    const ra = r.headers?.get?.("retry-after");
    if (ra != null) e.retryAfter = ra;
    throw e;
  }
  return body;
}

let mapCache = { at: 0, list: null };

async function coinMap(apiKey, pace) {
  if (mapCache.list && Date.now() - mapCache.at < MAP_TTL) return mapCache.list;
  // No limit param: the map is the whole active listing (~10k rows, one
  // zero-credit request, cached 6 h). A top-N cap here silently made every
  // coin past N unsearchable and unaddable — the catalog's edge belongs to
  // CMC, not us.
  const body = await cmc(
    `/v1/cryptocurrency/map?listing_status=active&sort=cmc_rank`,
    apiKey, pace
  );
  mapCache = { at: Date.now(), list: body.data || [] };
  return mapCache.list;
}

// Up to 10 matching coins, ranked by match quality then market-cap rank.
export async function search(query, { apiKey, pace } = {}) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const c of await coinMap(apiKey, pace)) {
    const sym = (c.symbol || "").toLowerCase();
    const name = (c.name || "").toLowerCase();
    let score;
    if (sym === q) score = 0;
    else if (name === q) score = 1;
    else if (sym.startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 4;
    else continue;
    scored.push({ score, rank: c.rank || 1e9, c });
  }
  scored.sort((a, b) => a.score - b.score || a.rank - b.rank);
  return scored.slice(0, 10).map(({ c }) => ({
    id: String(c.id),
    label: c.name,
    symbol: (c.symbol || "").toUpperCase(),
    rank: c.rank || null,
  }));
}

const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));

// One coin's canonical crypto fields from a quotes/listings row (both carry
// the same {id, cmc_rank, circulating_supply, quote.USD} shape). ATH is the
// one canonical field CMC's quote payload doesn't publish — served as an
// honest null (src still stamps this provider), matching fetchEntity, so a
// live `ath` under CMC settles as "—" instead of forcing a whole-object
// re-fetch that would answer the same nothing.
const quoteFields = (d) => {
  const usd = d.quote?.USD || {};
  return {
    price:              { v: num(usd.price), kind: "number" },
    market_cap:         { v: num(usd.market_cap), kind: "number" },
    change_1h:          { v: num(usd.percent_change_1h), kind: "number" },
    change_24h:         { v: num(usd.percent_change_24h), kind: "number" },
    change_7d:          { v: num(usd.percent_change_7d), kind: "number" },
    change_30d:         { v: num(usd.percent_change_30d), kind: "number" },
    volume:             { v: num(usd.volume_24h), kind: "number" },
    rank:               { v: num(d.cmc_rank), kind: "number" },
    ath:                { v: null, kind: "number" },
    circulating_supply: { v: num(d.circulating_supply), kind: "number" },
    url:                { v: d.slug ? `https://coinmarketcap.com/currencies/${d.slug}/` : null, kind: "url" },
  };
};

// Quote cache: full quote rows by id, warmed by every path that already paid
// for them (browse listings, query quotes, prefetch) — so bulk-adding coins
// straight out of the browse modal re-buys nothing, and a refresh sweep's
// per-entity reads all hit the one batched prefetch call.
const QUOTE_TTL = 60 * 1000; // CMC's own update cadence for these endpoints
const quoteCache = new Map(); // id (string) -> { at, row }
const freshQuote = (id) => {
  const hit = quoteCache.get(String(id));
  return hit && Date.now() - hit.at < QUOTE_TTL ? hit.row : null;
};
function warmQuotes(rows) {
  for (const d of rows) {
    if (d?.id == null) continue;
    quoteCache.set(String(d.id), { at: Date.now(), row: d });
    if (quoteCache.size > 20000) quoteCache.delete(quoteCache.keys().next().value);
  }
}

// Batched quote lookup. Chunked at 100 ids — a single credit per chunk under
// CMC's older accounting AND the 2026 one, so the estimate can't be wrong in
// the expensive direction.
async function quotesByIds(ids, { apiKey, pace } = {}) {
  const out = [];
  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100);
    const body = await cmc(
      `/v2/cryptocurrency/quotes/latest?id=${chunk.map(encodeURIComponent).join(",")}&convert=USD`,
      apiKey, pace
    );
    for (const id of chunk) if (body.data?.[id]) out.push(body.data[id]);
  }
  warmQuotes(out);
  return out;
}

// Batch-warm the quote cache for a refresh sweep's due ids (the worker's
// prefetch leg). Best-effort by contract: a failure means per-entity retail.
export async function prefetch(ids, ctx = {}) {
  const missing = [...new Set(ids.map(String))].filter((id) => !freshQuote(id));
  if (missing.length) await quotesByIds(missing, ctx);
}

// One coin's canonical crypto fields via the v2 quotes endpoint (data keyed
// by id). Returns { v, kind }; the connector adds identity + `src`.
export async function fetchEntity(id, ctx = {}) {
  let d = freshQuote(id);
  if (!d) {
    await quotesByIds([String(id)], ctx);
    d = freshQuote(id);
  }
  if (!d) throw new Error(`CoinMarketCap: no data for id ${id}`);
  return {
    id: String(d.id),
    symbol: (d.symbol || "").toUpperCase(),
    display_name: d.name,
    fields: quoteFields(d),
  };
}

// Field-aware refresh (runtime.refresh sends the DUE keys): every canonical
// field lives on the cached quote row, so a prefetched sweep serves whole
// boards from memory and a cold single entity pays one batched-shape request.
export async function fetchFields(id, keys, ctx = {}) {
  const want = [...new Set(keys || [])];
  const fields = {};
  let d = freshQuote(id);
  if (!d) {
    await quotesByIds([String(id)], ctx);
    d = freshQuote(id);
  }
  if (!d) return { fields }; // unknown id → runtime falls back to fetchEntity's error path
  const all = quoteFields(d);
  for (const k of want) if (all[k]) fields[k] = all[k];
  return { fields };
}

// Price history for the chart face. CMC's Basic tier serves historical quotes
// as of 2026 (intraday capped at 1 month back, daily at 1 year — the plan
// matrix on the quotes/historical doc), so the chart face renders under CMC
// too, within the same 1y ceiling as CoinGecko's demo tier. Interval per
// period keeps the point count (and its 1-credit-per-100-points price)
// proportionate: hourly only where a day-scale line needs it.
const HIST = {
  "24h": { interval: "1h", count: 24 },
  "7d":  { interval: "1h", count: 168 },
  "30d": { interval: "1d", count: 30 },
  "90d": { interval: "1d", count: 90 },
  "1y":  { interval: "1d", count: 365 },
};
export const periods = Object.keys(HIST);

export async function history(id, period, { apiKey, pace } = {}) {
  const { interval, count } = HIST[period] || HIST["1y"];
  const body = await cmc(
    `/v2/cryptocurrency/quotes/historical?id=${encodeURIComponent(id)}&interval=${interval}&count=${count}&convert=USD`,
    apiKey, pace
  );
  // v2 shapes the payload two ways: { data: { quotes: [...] } } for a single
  // id, { data: { <id>: { quotes: [...] } } } when the request listed several.
  const quotes = body.data?.quotes || body.data?.[String(id)]?.quotes || [];
  return quotes
    .map((q) => ({
      t: Date.parse(q?.timestamp || q?.quote?.USD?.timestamp || ""),
      price: num(q?.quote?.USD?.price),
    }))
    .filter((p) => Number.isFinite(p.t) && p.price != null);
}

// Browse-and-add (the ingestion modal): the same canonical columns as CoinGecko,
// assembled from CMC's endpoints. A plain browse uses /listings/latest (sorted +
// paginated server-side, all four domain sorts native). A text query filters the
// cached id/symbol map locally, then /quotes/latest fills the columns for those
// ids — same row shape either way. Row = { id, symbol, label, values }.
const SORT_FIELD = { market_cap: "market_cap", volume: "volume_24h", price: "price", name: "name" };

function quoteRow(d) {
  const usd = d.quote?.USD || {};
  return {
    id: String(d.id),
    symbol: (d.symbol || "").toUpperCase(),
    label: d.name,
    values: {
      rank:       d.cmc_rank ?? null,
      name:       d.name,
      price:      usd.price ?? null,
      change_24h: usd.percent_change_24h ?? null,
      change_7d:  usd.percent_change_7d ?? null,
      market_cap: usd.market_cap ?? null,
      volume:     usd.volume_24h ?? null,
    },
  };
}

export async function list({ sort, order, page = 1, pageSize = 50, query } = {}, { apiKey, pace } = {}) {
  const dir = order === "asc" ? "asc" : "desc";

  if (query && query.trim()) {
    const q = query.trim().toLowerCase();
    // Page the hit list — the modal appends pages, so a fixed first-slice
    // here would render the same rows again on every "Load more".
    const pageNo = Math.max(1, Number(page) || 1);
    const ids = (await coinMap(apiKey, pace))
      .filter((c) => (c.symbol || "").toLowerCase().includes(q) || (c.name || "").toLowerCase().includes(q))
      .sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9))
      .slice((pageNo - 1) * pageSize, pageNo * pageSize)
      .map((c) => String(c.id));
    if (!ids.length) return [];
    const rows = await quotesByIds(ids, { apiKey, pace });
    const byId = new Map(rows.map((d) => [String(d.id), d]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map(quoteRow);
  }

  const field = SORT_FIELD[sort] || SORT_FIELD.market_cap;
  const start = (page - 1) * pageSize + 1;
  const body = await cmc(
    `/v1/cryptocurrency/listings/latest?start=${start}&limit=${pageSize}&sort=${field}&sort_dir=${dir}&convert=USD`,
    apiKey, pace
  );
  const rows = body.data || [];
  warmQuotes(rows); // a bulk add straight from this page re-buys nothing
  return rows.map(quoteRow);
}

// Cheap authenticated ping for the admin Test button.
export async function testConnection({ apiKey, pace } = {}) {
  await cmc(`/v1/key/info`, apiKey, pace);
  return true;
}

// Test seam only (house convention: provider-pacing's _resetBuckets).
export function _resetQuoteCache() {
  quoteCache.clear();
  mapCache = { at: 0, list: null };
}
