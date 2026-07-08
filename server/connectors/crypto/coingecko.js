// CoinGecko provider for the crypto connector — the default data backend.
// Works keyless on the public tier (~30 req/min); an optional CoinGecko demo
// key raises those limits (sent as the x-cg-demo-api-key header). A provider
// answers the domain's search/fetch contract and returns raw values; the
// connector (crypto/index.js) derives identity and stamps provenance, so the
// provider stays agnostic about its own registry name.
const BASE = "https://api.coingecko.com/api/v3";

export const label = "CoinGecko";
export const needsKey = false;

// Optional demo key raises the rate limit; omitted → keyless public tier.
function cgHeaders(apiKey) {
  const h = { Accept: "application/json" };
  if (apiKey) h["x-cg-demo-api-key"] = apiKey;
  return h;
}

// Up to 10 matching coins, normalised to the connector's search-hit shape.
export async function search(query, { apiKey } = {}) {
  const r = await fetch(`${BASE}/search?query=${encodeURIComponent(query)}`, {
    headers: cgHeaders(apiKey),
  });
  if (!r.ok) throw new Error(`CoinGecko search failed: HTTP ${r.status}`);
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
export async function fetchEntity(id, { apiKey } = {}) {
  const url =
    `${BASE}/coins/${encodeURIComponent(id)}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  const r = await fetch(url, { headers: cgHeaders(apiKey) });
  if (!r.ok) throw new Error(`CoinGecko fetch failed: HTTP ${r.status}`);
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

// Cheap liveness ping for the admin Test button. With a key present this also
// validates it (an invalid demo key is rejected by the API).
export async function testConnection({ apiKey } = {}) {
  const r = await fetch(`${BASE}/ping`, { headers: cgHeaders(apiKey) });
  if (!r.ok) throw new Error(`CoinGecko unreachable: HTTP ${r.status}`);
  return true;
}
