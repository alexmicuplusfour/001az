// Fixture: a valid connector-provider plugin. Imports NOTHING from core — it
// reaches the network only through ctx.fetchJson, exactly like a real plugin.
export default function (ctx) {
  return {
    label: "Acme Gecko",
    description: "A test crypto provider (fixture)",
    needsKey: false,
    rpm: 30,
    burst: 15,
    async search(query) {
      const data = await ctx.fetchJson(`https://acme.test/search?q=${encodeURIComponent(query)}`);
      return (data.coins || []).map((c) => ({ id: c.id, label: c.name, symbol: c.symbol, rank: null }));
    },
    async fetchEntity(id) {
      const d = await ctx.fetchJson(`https://acme.test/coin/${id}`);
      return { id: d.id, symbol: d.symbol, display_name: d.name, fields: { price: { v: d.price, kind: "number" } } };
    },
    async testConnection() {
      await ctx.fetchJson("https://acme.test/ping");
      return true;
    },
  };
}
