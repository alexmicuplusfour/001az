// Fixture: an embed-only ai-provider — wire carries only embed, no defaultModel.
// The same shape as the built-in `local` provider; proves the loader accepts a
// descriptor that can embed but not tag. Since slice 7a the embed wire is
// REQUIRED (advertising `embeds` with wire null used to load and then throw at
// the first embedTexts call — that shape now lives in ../embed-no-wire, asserted
// to be rejected).
export default function (ctx) {
  return {
    label: "Acme Embed",
    description: "embeddings-only test provider (fixture)",
    // The embed wire's contract ({ vectors: Float32Array[], usage }, unit-norm),
    // honored so the fixture stays honest if anything ever calls it.
    wire: {
      tag: null,
      testKey: null,
      embed: (_desc, { texts }) => ({
        vectors: texts.map(() => Float32Array.of(1, 0, 0)),
        usage: { input: 0, output: 0, cacheRead: 0 },
      }),
    },
    defaultModel: null,
    models: [],
    research: false,
    keyless: true,
    onDevice: true, // mirrors the built-in local embedder: in-process, no connections, no pacing
    embeds: { default: "acme-embed-1", models: [{ id: "acme-embed-1", note: "test" }] },
  };
}
