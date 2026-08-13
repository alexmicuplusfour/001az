// CoinGecko provider for the crypto connector — the default data backend.
// Works keyless on the public tier; an optional CoinGecko demo key raises the
// limits (sent as the x-cg-demo-api-key header). A provider answers the
// domain's search/fetch contract and returns raw values; the connector
// (crypto/index.js) derives identity and stamps provenance, so the provider
// stays agnostic about its own registry name.
import { providerSignal, num } from "../runtime.js";
import { createQuoteCache, pickFields } from "./quote-cache.js";

const BASE = "https://api.coingecko.com/api/v3";

export const label = "CoinGecko";
export const description = "Live crypto prices & market data — keyless";
export const needsKey = false;
// The demo tier's ToS requires visible attribution (brand.coingecko.com);
// surfaced by the browse modal next to the rows this provider filled.
export const attribution = { text: "Data by CoinGecko", url: "https://www.coingecko.com" };
// Calls/min the runtime paces to. The two tiers are genuinely different
// numbers: keyless rides a 5–15/min pool shared per source IP, while a demo
// key is documented at 100/min today — but it was 30 within recent memory and
// the docs have said both, so 30 is the number that's correct under either.
// The gap doesn't cost throughput: the caches below, not rpm, are what make a
// board cheap. Pacing over the real allowance is worse than slow — CoinGecko
// counts FAILED requests against the limit, so a 429 storm burns the quota it
// was denied by. The runtime picks keylessRpm when no key is stored
// (activeProvider); the 429/401 backoff covers the residual, and the
// Plugins-page rpm override beats both when an operator knows their tier. The
// burst covers one cold feed-window fill (4 pages) without a short-window
// spike. The MONTHLY meter (10k credits on demo) is guarded by the caches and
// by refresh cadence, not by rpm. Truthful request pacing: each raw fetch
// awaits ctx.pace() (pacesRequests — see runtime.callProvider), so the
// query-path list() honestly pays 2 and nothing pays for cache hits.
export const pacesRequests = true;
export const rpm = 30;
export const keylessRpm = 10;
export const burst = 8;

// Optional demo key raises the rate limit; omitted → keyless public tier.
function cgHeaders(apiKey) {
  const h = { Accept: "application/json" };
  if (apiKey) h["x-cg-demo-api-key"] = apiKey;
  return h;
}

// A failed response as an Error carrying the status + Retry-After, so the
// runtime's rate limiter can recognise a 429 and back off.
function cgFail(r, what) {
  const e = new Error(`CoinGecko ${what} failed: HTTP ${r.status}`);
  e.status = r.status;
  const ra = r.headers?.get?.("retry-after");
  if (ra != null) e.retryAfter = ra;
  return e;
}

// Up to 10 matching coins, normalised to the connector's search-hit shape.
export async function search(query, { apiKey, pace } = {}) {
  await pace?.();
  const r = await fetch(`${BASE}/search?query=${encodeURIComponent(query)}`, {
    headers: cgHeaders(apiKey),
    signal: providerSignal(),
  });
  if (!r.ok) throw cgFail(r, "search");
  const data = await r.json();
  return (data.coins || []).slice(0, 10).map((c) => ({
    id: c.id,
    label: c.name,
    symbol: c.symbol?.toUpperCase() || "",
    rank: c.market_cap_rank || null,
  }));
}

// The multi-window change parameter: one param, no extra request, and the
// SAME markets row then feeds browse columns, fetchFields and the prefetch
// cache — 1h/24h/7d/30d are the windows both providers can serve, so they're
// the domain's canonical change fields.
const CHANGE_WINDOWS = "1h,24h,7d,30d";

// One coin's canonical crypto fields from a /coins/markets row. The row is the
// cheap shape (the /coins/{id} detail is ~50× the bytes for the same numbers),
// and with CHANGE_WINDOWS it carries every canonical field: multi-window
// change, volume, rank, ATH and supply ride along at zero marginal cost.
const marketFields = (c) => ({
  price:              { v: num(c.current_price), kind: "number" },
  market_cap:         { v: num(c.market_cap), kind: "number" },
  change_1h:          { v: num(c.price_change_percentage_1h_in_currency), kind: "number" },
  change_24h:         { v: num(c.price_change_percentage_24h), kind: "number" },
  change_7d:          { v: num(c.price_change_percentage_7d_in_currency), kind: "number" },
  change_30d:         { v: num(c.price_change_percentage_30d_in_currency), kind: "number" },
  volume:             { v: num(c.total_volume), kind: "number" },
  rank:               { v: num(c.market_cap_rank), kind: "number" },
  ath:                { v: num(c.ath), kind: "number" },
  circulating_supply: { v: num(c.circulating_supply), kind: "number" },
  url:                { v: `https://www.coingecko.com/en/coins/${c.id}`, kind: "url" },
});

// Markets rows by coin id, filled in batches. The refresh sweep prefetches its
// whole due set (250 ids per request — the endpoint's own cap), then each
// entity's fetchFields is a cache hit: a 100-coin board's sweep pays 1 request
// instead of 100. Every path that already buys these rows warms it, so a
// browse-then-add costs nothing either.
const quotes = createQuoteCache();
const warmQuotes = quotes.warm;

// `extra` carries an already-encoded query fragment (the category filter);
// the browse path is its only caller — refresh/prefetch never narrows.
async function marketRowsByIds(ids, { apiKey, pace } = {}, extra = "") {
  const out = [];
  for (let i = 0; i < ids.length; i += 250) {
    const chunk = ids.slice(i, i + 250);
    await pace?.();
    const r = await fetch(
      `${BASE}/coins/markets?vs_currency=usd&price_change_percentage=${CHANGE_WINDOWS}${extra}` +
        `&per_page=250&ids=${chunk.map(encodeURIComponent).join(",")}`,
      { headers: cgHeaders(apiKey), signal: providerSignal() }
    );
    if (!r.ok) throw cgFail(r, "markets");
    out.push(...(await r.json()));
  }
  warmQuotes(out);
  return out;
}

// Batch-warm the quote cache for a refresh sweep's due ids (see the worker's
// prefetch leg). Best-effort by contract: a failure here just means the
// per-entity path pays retail.
export async function prefetch(ids, ctx = {}) {
  const missing = quotes.missing(ids);
  if (missing.length) await marketRowsByIds(missing, ctx);
}

// One coin's market row: the warm one, or the one request that buys it.
const quoteFor = async (id, ctx) => quotes.fresh(id) || (await marketRowsByIds([id], ctx))[0];

// One coin's canonical crypto fields. Returns the provider id + symbol +
// display name and per-field { v, kind }; the connector adds identity and the
// `src` provenance tag. Served from the markets shape — same request class as
// a one-coin browse page, ~2% of the /coins/{id} payload it used to buy.
export async function fetchEntity(id, ctx = {}) {
  const row = await quoteFor(id, ctx);
  if (!row) throw new Error(`CoinGecko: no market data for "${id}"`);
  return {
    id: row.id,
    symbol: row.symbol?.toUpperCase() || "",
    display_name: row.name,
    fields: marketFields(row),
  };
}

// Field-aware refresh (runtime.refresh sends the DUE keys): every canonical
// field lives on the cached markets row, so a prefetched sweep serves whole
// boards from memory and a cold single entity pays one batched-shape request.
// `url` is derivable from the id alone — a url-only refresh never spends HTTP.
export async function fetchFields(id, keys, ctx = {}) {
  const want = [...new Set(keys || [])];
  if (want.length === 1 && want[0] === "url")
    return { fields: { url: { v: `https://www.coingecko.com/en/coins/${id}`, kind: "url" } } };
  const row = await quoteFor(id, ctx);
  // Unknown/inactive id → no keys served, and runtime.refresh falls back to
  // fetchEntity's error path rather than writing nulls over live values.
  return { fields: row ? pickFields(marketFields(row), want) : {} };
}

// Price history for the chart face (slice 5d): the market_chart endpoint, whose
// granularity CoinGecko picks from the day span (≤1d = 5-min, ≤90d = hourly,
// else daily). Returns [{ t, price }]; the crypto connector's chart producer
// downsamples + renders. CoinMarketCap has no free equivalent, so it omits this
// export and the face falls back to the tile while CMC is active.
// The free/demo tier caps historical range at 365 days (366+ → 401), so only
// these periods are offered and the day count is clamped defensively.
const DEMO_MAX_DAYS = 365;
const PERIOD_DAYS = { "24h": 1, "7d": 7, "30d": 30, "90d": 90, "1y": 365 };
export const periods = Object.keys(PERIOD_DAYS);

export async function history(id, period, { apiKey, pace } = {}) {
  const days = Math.min(PERIOD_DAYS[period] ?? 365, DEMO_MAX_DAYS);
  await pace?.();
  const r = await fetch(
    `${BASE}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=${days}`,
    { headers: cgHeaders(apiKey), signal: providerSignal() }
  );
  if (!r.ok) throw cgFail(r, "history");
  const d = await r.json();
  return (d.prices || []).map(([t, price]) => ({ t, price }));
}

// Browse-and-add (the ingestion modal): a sorted, paginated page of coins with
// the domain's canonical columns. The /coins/markets endpoint returns market
// data already sorted by the `order` param; a text query bridges through /search
// (ids only) then re-fetches those ids' market rows so the columns match. Each
// row is { id, symbol, label, values: {<column key>: value} }.
const SORT_ORDER = {
  market_cap: (desc) => (desc ? "market_cap_desc" : "market_cap_asc"),
  volume:     (desc) => (desc ? "volume_desc" : "volume_asc"),
  name:       (desc) => (desc ? "id_desc" : "id_asc"), // no name sort; id ≈ alphabetical
  // `price` isn't a /coins/markets order → falls through to the default below.
};

function marketRow(c) {
  return {
    id: c.id,
    symbol: (c.symbol || "").toUpperCase(),
    label: c.name,
    values: {
      rank:       c.market_cap_rank ?? null,
      name:       c.name,
      price:      c.current_price ?? null,
      change_24h: c.price_change_percentage_24h ?? null,
      change_7d:  c.price_change_percentage_7d_in_currency ?? null,
      market_cap: c.market_cap ?? null,
      volume:     c.total_volume ?? null,
    },
  };
}

export async function list({ sort, order, page = 1, pageSize = 50, query, category } = {}, { apiKey, pace } = {}) {
  const desc = order !== "asc";
  const common = `vs_currency=usd&price_change_percentage=${CHANGE_WINDOWS}`;
  // Category narrows server-side, and it composes with an id list rather than
  // overriding it — verified live 2026-08-13: category=meme-token with
  // ids=bitcoin,dogecoin returned dogecoin ALONE, i.e. the intersection, not
  // the category's own top rows. So the same param serves both paths and a
  // filtered search stays a real search.
  const cat = category ? `&category=${encodeURIComponent(category)}` : "";

  if (query && query.trim()) {
    await pace?.();
    const sr = await fetch(`${BASE}/search?query=${encodeURIComponent(query.trim())}`, { headers: cgHeaders(apiKey), signal: providerSignal() });
    if (!sr.ok) throw cgFail(sr, "search");
    // Page the hit list like the plain browse pages the catalog — page 2 must
    // be the NEXT slice, not the first one again (the modal appends pages, so
    // repeating the slice rendered duplicate rows and a "Load more" that
    // never ran dry).
    const pageNo = Math.max(1, Number(page) || 1);
    const ids = ((await sr.json()).coins || [])
      .slice((pageNo - 1) * pageSize, pageNo * pageSize)
      .map((c) => c.id);
    if (!ids.length) return [];
    // marketRowsByIds warms the quote cache in passing, and its rows come back
    // in the endpoint's market-cap order — re-emit in ids (relevance) order so
    // paging is stable and the CMC path's behavior matches.
    const byId = new Map((await marketRowsByIds(ids, { apiKey, pace }, cat)).map((c) => [c.id, c]));
    return ids.map((id) => byId.get(id)).filter(Boolean).map(marketRow);
  }

  const orderParam = (SORT_ORDER[sort] || SORT_ORDER.market_cap)(desc);
  await pace?.();
  const r = await fetch(
    `${BASE}/coins/markets?${common}${cat}&order=${orderParam}&per_page=${pageSize}&page=${page}`,
    { headers: cgHeaders(apiKey), signal: providerSignal() }
  );
  if (!r.ok) throw cgFail(r, "list");
  const rows = await r.json();
  // These ARE quote rows — same endpoint, same `price_change_percentage`
  // windows the refresh path asks for — so keep them. Without this, browsing a
  // page and adding what you see re-bought every row one at a time
  // (`fetchEntity` → cache miss → a 250-id endpoint used for one id): 100
  // metered requests for a 100-row bulk add, and 25 per feed drain tick, all
  // for data already in hand. The query branch warms via marketRowsByIds and
  // the CMC sibling warms its listings page; this was the one path that didn't.
  warmQuotes(rows);
  return rows.map(marketRow);
}

// Browse filter vocabularies (runtime.browseFilters). CoinGecko's category
// taxonomy is ~857 entries and moves with the market, so it's fetched rather
// than frozen — one request a day, and the endpoint is a plain id/name list
// (the market-data flavour costs more bytes for data a dropdown can't use).
const CATEGORY_TTL = 24 * 60 * 60 * 1000;
let categoryCache = { at: 0, options: null };

export async function filterOptions({ apiKey, pace } = {}) {
  if (categoryCache.options && Date.now() - categoryCache.at < CATEGORY_TTL)
    return { category: categoryCache.options };
  await pace?.();
  const r = await fetch(`${BASE}/coins/categories/list`, { headers: cgHeaders(apiKey), signal: providerSignal() });
  if (!r.ok) throw cgFail(r, "categories");
  // Ordering is browseFilters' job; the only thing to do here is name the
  // options. Some names carry stray whitespace (" DN-404" sorted above
  // everything until this trim) — a display artifact of their data, not a name.
  const options = (await r.json())
    .filter((c) => c?.category_id)
    .map((c) => ({ value: c.category_id, label: String(c.name || c.category_id).trim() }));
  categoryCache = { at: Date.now(), options };
  return { category: options };
}

// Cheap liveness ping for the admin Test button. With a key present this also
// validates it (an invalid demo key is rejected by the API).
export async function testConnection({ apiKey, pace } = {}) {
  await pace?.();
  const r = await fetch(`${BASE}/ping`, { headers: cgHeaders(apiKey), signal: providerSignal() });
  if (!r.ok) throw cgFail(r, "unreachable");
  return true;
}

// Test seam only (house convention: provider-pacing's _resetBuckets).
export function _resetQuoteCache() {
  quotes.reset();
  categoryCache = { at: 0, options: null };
}
