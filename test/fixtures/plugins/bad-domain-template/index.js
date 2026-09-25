// Fixture: a connector-domain whose template binds a field its own catalog
// doesn't declare (`humidity`). A board saved from that template would be
// refused, so the plugin is refused at install, with the board save's own
// sentence. It also ships a face producer, so the refusal proves register-last:
// nothing it brings may be left registered.
export default function () {
  const acme = {
    label: "Acme Bad Template",
    needsKey: false,
    rpm: 30,
    burst: 15,
    async search() { return []; },
    async fetchEntity(id) { return { id, symbol: id, display_name: id, fields: {} }; },
    async history() { return []; },
  };
  return {
    providers: { "acme.badtemplate": acme },
    defaultProvider: "acme.badtemplate",
    manifest: {
      label: "Bad template",
      fields: [{ key: "temp", kind: "number", fn: "temp", label: "Temperature" }],
      faces: [{ name: "tile", label: "Tile", periods: ["1y"], requires: "history" }],
      template: {
        input: { connector: "badtemplate" },
        fields: [
          { key: "temp", kind: "number", source: "connector", fn: "temp" },
          { key: "humidity", kind: "number", source: "connector", fn: "humidity" },
        ],
      },
    },
    faces: { tile: "acme.badtemplate.tile" },
    faceProducers: {
      "acme.badtemplate.tile": async () => ({ webp: Buffer.from([1]), w: 1, h: 1 }),
    },
  };
}
