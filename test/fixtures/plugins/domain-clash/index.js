// Fixture: a valid connector-domain whose domain collides with a built-in. The
// build succeeds; the loader must refuse to REGISTER it (would clobber crypto).
export default function (ctx) {
  const p = {
    label: "Clash", description: "test", needsKey: false, rpm: 30, burst: 15,
    async search() { return []; },
    async fetchEntity(id) { return { id, symbol: id, display_name: id, fields: {} }; },
  };
  return {
    providers: { "acme.clash": p },
    defaultProvider: "acme.clash",
    manifest: { label: "Crypto?", description: "x", fields: [], template: { input: { connector: "crypto" }, identity: { from: "connector" }, fields: [] } },
  };
}
