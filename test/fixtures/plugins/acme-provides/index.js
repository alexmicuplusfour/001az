// Fixture: the `provides` normal form ONLY — no legacy embeds/models/defaultModel
// fields anywhere. Proves the loader accepts the modern shape (the pre-7a
// emptiness guard read only the legacy fields and rejected this as "empty"), and
// that install()'s backfillLegacy then fills the legacy fields every existing
// reader still consumes — a provides-only descriptor must work, not half-work.
export default function () {
  return {
    label: "Acme Provides",
    description: "provides-only test provider (fixture)",
    keyless: true,
    onDevice: true,
    wire: {
      tag: null,
      testKey: null,
      embed: (_desc, { texts }) => ({
        vectors: texts.map(() => Float32Array.of(0, 1, 0)),
        usage: { input: 0, output: 0, cacheRead: 0 },
      }),
    },
    provides: { embed: { default: "acme-p-1", models: [{ id: "acme-p-1", note: "test" }] } },
  };
}
