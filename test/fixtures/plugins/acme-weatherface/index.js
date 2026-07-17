// A connector-domain plugin that brings its OWN card face — not the built-in
// price chart, but a custom "tile" producer it ships and registers into the face
// registry at install (the slice-3 bridge). The producer just returns bytes; a
// real one would rasterize an SVG/canvas to webp (like server/faces/price-chart).
export default function (ctx) {
  const acme = {
    label: "Acme WF",
    async search() { return [{ id: "wf-1", symbol: "WF", name: "Weatherville" }]; },
    async fetchEntity(id) { return { id, symbol: "WF", name: "Weatherville", fields: {} }; },
    async history() { return [{ t: 0, price: 1 }, { t: 1, price: 2 }]; },
  };
  return {
    providers: { "acme.weatherface": acme },
    defaultProvider: "acme.weatherface",
    manifest: { label: "Acme Weather (custom face)", faces: [{ name: "tile", requires: "history" }] },
    // The domain's face slot names the plugin's own producer (resolved against the
    // shared registry) instead of "price-chart".
    faces: { tile: "acme.weatherface.tile" },
    faceProducers: {
      "acme.weatherface.tile": async (series) => ({ webp: Buffer.from(`tile:${series.length}`), w: 120, h: 90 }),
    },
  };
}
