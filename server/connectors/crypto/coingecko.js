// CoinGecko provider for the crypto connector — the default data backend.
// Works keyless on the public tier (~30 req/min); an optional CoinGecko demo
// key raises those limits (sent as the x-cg-demo-api-key header). A provider
// answers the domain's search/fetch contract and returns raw values; the
// connector (crypto/index.js) derives identity and stamps provenance, so the
// provider stays agnostic about its own registry name.
import { providerSignal } from "../runtime.js";

const BASE = "https://api.coingecko.com/api/v3";

export const label = "CoinGecko";
export const description = "Live crypto prices & market data — keyless";
export const needsKey = false;
// Calls/min the runtime paces to (demo key ~30/min; keyless is stricter — the
// 429/401-under-load backoff covers the residual). A small burst keeps the
// sweep from spiking over the short-window limit (a rapid spike gets a transient
// 401 from the demo tier, not just a 429). Truthful request pacing: each raw
// fetch awaits ctx.pace() (pacesRequests — see runtime.callProvider), so the
// query-path list() honestly pays 2 and nothing pays for cache hits.
export const pacesRequests = true;
export const rpm = 25;
export const burst = 3;

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

// One coin's canonical crypto fields. Returns the provider id + symbol +
// display name and per-field { v, kind }; the connector adds identity and the
// `src` provenance tag.
export async function fetchEntity(id, { apiKey, pace } = {}) {
  const url =
    `${BASE}/coins/${encodeURIComponent(id)}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  await pace?.();
  const r = await fetch(url, { headers: cgHeaders(apiKey), signal: providerSignal() });
  if (!r.ok) throw cgFail(r, "fetch");
  const d = await r.json();
  const md = d.market_data || {};
  return {
    id: d.id,
    symbol: d.symbol?.toUpperCase() || "",
    display_name: d.name,
    fields: {
      price:      { v: md.current_price?.usd ?? null,                kind: "number" },
      market_cap: { v: md.market_cap?.usd ?? null,                   kind: "number" },
      change_24h: { v: md.price_change_percentage_24h ?? null,       kind: "number" },
      url:        { v: `https://www.coingecko.com/en/coins/${d.id}`, kind: "url"    },
    },
  };
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
      market_cap: c.market_cap ?? null,
      volume:     c.total_volume ?? null,
    },
  };
}

export async function list({ sort, order, page = 1, pageSize = 50, query } = {}, { apiKey, pace } = {}) {
  const desc = order !== "asc";
  const common = `vs_currency=usd&price_change_percentage=24h`;

  if (query && query.trim()) {
    await pace?.();
    const sr = await fetch(`${BASE}/search?query=${encodeURIComponent(query.trim())}`, { headers: cgHeaders(apiKey), signal: providerSignal() });
    if (!sr.ok) throw cgFail(sr, "search");
    const ids = ((await sr.json()).coins || []).slice(0, pageSize).map((c) => c.id);
    if (!ids.length) return [];
    await pace?.();
    const r = await fetch(`${BASE}/coins/markets?${common}&ids=${ids.map(encodeURIComponent).join(",")}`, { headers: cgHeaders(apiKey), signal: providerSignal() });
    if (!r.ok) throw cgFail(r, "list");
    return (await r.json()).map(marketRow);
  }

  const orderParam = (SORT_ORDER[sort] || SORT_ORDER.market_cap)(desc);
  await pace?.();
  const r = await fetch(
    `${BASE}/coins/markets?${common}&order=${orderParam}&per_page=${pageSize}&page=${page}`,
    { headers: cgHeaders(apiKey), signal: providerSignal() }
  );
  if (!r.ok) throw cgFail(r, "list");
  return (await r.json()).map(marketRow);
}

// Cheap liveness ping for the admin Test button. With a key present this also
// validates it (an invalid demo key is rejected by the API).
export async function testConnection({ apiKey, pace } = {}) {
  await pace?.();
  const r = await fetch(`${BASE}/ping`, { headers: cgHeaders(apiKey), signal: providerSignal() });
  if (!r.ok) throw cgFail(r, "unreachable");
  return true;
}
