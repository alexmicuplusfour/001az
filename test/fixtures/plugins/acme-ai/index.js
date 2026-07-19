// Fixture: a valid ai-provider plugin on the OpenAI-compatible protocol. It
// brings ONLY a descriptor — base URL, the `compat` quirk block, and the model
// catalog — and reuses the shared wire via ctx.wires.compat. No protocol code
// lives here: tagging/testKey/embed are core's, shared with the built-in compat
// providers. (A provider on a novel protocol would instead return its own wire
// object with tag/testKey/embed — that path is equally supported.)
export default function (ctx) {
  return {
    label: "Acme AI",
    description: "a test AI tagging provider (fixture)",
    base: "https://api.acme.test/v1",
    defaultModel: "acme-1",
    models: [{ id: "acme-1", label: "Acme 1" }],
    research: false,
    keyless: false,
    rpm: 60, burst: 10, // a networked AI provider must declare its rate limit (rate-limit contract)
    compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "models" },
    embeds: null,
    wire: ctx.wires.compat,
  };
}
