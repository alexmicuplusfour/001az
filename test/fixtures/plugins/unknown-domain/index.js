// Fixture: a valid provider whose target domain isn't registered. The loader
// must fail cleanly (register-last), leaving nothing behind.
export default function (ctx) {
  return {
    label: "Orphan", description: "test", needsKey: false, rpm: 30, burst: 15,
    async search() { return []; },
    async fetchEntity(id) { return { id, symbol: id, display_name: id, fields: {} }; },
  };
}
