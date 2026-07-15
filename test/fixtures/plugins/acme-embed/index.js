// Fixture: an embed-only ai-provider — wire null, embeds set, no defaultModel.
// The same shape as the built-in `local` provider; proves the loader accepts a
// descriptor that can embed but not tag.
export default function (ctx) {
  return {
    label: "Acme Embed",
    description: "embeddings-only test provider (fixture)",
    wire: null,
    defaultModel: null,
    models: [],
    research: false,
    keyless: true,
    embeds: { default: "acme-embed-1", models: [{ id: "acme-embed-1", note: "test" }] },
  };
}
