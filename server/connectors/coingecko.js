// CoinGecko connector — cryptocurrency prices and market data.
// No API key required for the free tier (~30 req/min).
const BASE = "https://api.coingecko.com/api/v3";

export const manifest = {
  label: "CoinGecko",
  description: "Cryptocurrency prices and market data",
  fields: [
    { key: "price",      kind: "number", fn: "price",      label: "Price (USD)" },
    { key: "market_cap", kind: "number", fn: "market_cap", label: "Market cap (USD)" },
    { key: "change_24h", kind: "number", fn: "change_24h", label: "24h change (%)" },
    { key: "url",        kind: "url",    fn: "url",        label: "CoinGecko page" },
  ],
  template: {
    input: { connector: "coingecko" },
    identity: { from: "connector" },
    fields: [
      { key: "price",      kind: "number", from: "connector", fn: "price" },
      { key: "market_cap", kind: "number", from: "connector", fn: "market_cap" },
      { key: "change_24h", kind: "number", from: "connector", fn: "change_24h" },
      { key: "url",        kind: "url",    from: "connector", fn: "url" },
    ],
  },
};

// Returns up to 10 matching coins: { id, label, symbol, thumb }.
export async function search(query) {
  const r = await fetch(`${BASE}/search?query=${encodeURIComponent(query)}`, {
    headers: { Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`CoinGecko search failed: HTTP ${r.status}`);
  const data = await r.json();
  return (data.coins || []).slice(0, 10).map((c) => ({
    id: c.id,
    label: c.name,
    symbol: c.symbol?.toUpperCase() || "",
    thumb: c.thumb || null,
    rank: c.market_cap_rank || null,
  }));
}

// Fetches entity data for a given CoinGecko coin id.
// Returns { identity, display_name, symbol, fields } where fields carry src + kind.
export async function fetchEntity(id) {
  const url =
    `${BASE}/coins/${encodeURIComponent(id)}` +
    `?localization=false&tickers=false&market_data=true&community_data=false&developer_data=false`;
  const r = await fetch(url, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`CoinGecko fetch failed: HTTP ${r.status}`);
  const d = await r.json();
  const md = d.market_data || {};
  return {
    identity: d.id,
    display_name: d.name,
    symbol: d.symbol?.toUpperCase() || "",
    fields: {
      price:      { v: md.current_price?.usd ?? null,               src: "coingecko", kind: "number" },
      market_cap: { v: md.market_cap?.usd ?? null,                  src: "coingecko", kind: "number" },
      change_24h: { v: md.price_change_percentage_24h ?? null,      src: "coingecko", kind: "number" },
      url:        { v: `https://www.coingecko.com/en/coins/${d.id}`, src: "coingecko", kind: "url"    },
    },
  };
}
