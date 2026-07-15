// Fixture: a valid ai-provider plugin. Returns the same descriptor shape a
// built-in AI provider is — `wire` is the dispatch object the tagger/testKey
// paths call. (A real compat provider would reuse a shared wire via ctx; slice 4.)
export default function (ctx) {
  return {
    label: "Acme AI",
    description: "a test AI tagging provider (fixture)",
    defaultModel: "acme-1",
    models: [{ id: "acme-1", label: "Acme 1" }],
    research: false,
    keyless: false,
    embeds: null,
    wire: {
      async tag() { return { tags: {} }; },
      async testKey() { return true; },
    },
  };
}
