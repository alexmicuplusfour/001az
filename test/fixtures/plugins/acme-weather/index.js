// Fixture: a connector-domain plugin — a brand-new data domain with one provider.
// Returns the same pure-data shape a built-in connector module exports.
export default function (ctx) {
  const acme = {
    label: "Acme Weather",
    description: "test weather provider",
    needsKey: false,
    rpm: 30,
    burst: 15,
    async search(query) {
      const d = await ctx.fetchJson(`https://acme.test/weather/search?q=${encodeURIComponent(query)}`);
      return (d.places || []).map((p) => ({ id: p.id, label: p.name, symbol: p.code, rank: null }));
    },
    async fetchEntity(id) {
      const d = await ctx.fetchJson(`https://acme.test/weather/${id}`);
      return { id: d.id, symbol: d.code, display_name: d.name, fields: { temp: { v: d.temp, kind: "number" } } };
    },
  };
  return {
    providers: { "acme.weather": acme },
    defaultProvider: "acme.weather",
    manifest: {
      label: "Weather",
      category: "test",
      description: "Live weather data",
      fields: [{ key: "temp", kind: "number", fn: "temp", label: "Temperature" }],
      template: { input: { connector: "weather" }, identity: { from: "connector" }, fields: [] },
    },
  };
}
