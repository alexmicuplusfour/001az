// Fixture: a keyless-NETWORKED ai-provider — the self-hosted-server shape
// (Ollama, LM Studio, vLLM, …). `keyless` is the auth half only: connections
// register with api_key NULL and the compat wire sends no Authorization
// header. It is NOT `onDevice` — it's a real server over the network, so the
// rate-limit contract (rpm/burst) and per-call pacing still apply in full.
export default function (ctx) {
  return {
    label: "Acme Self-Hosted",
    description: "a keyless networked tagging + embedding provider (fixture)",
    base: "http://127.0.0.1:9",
    defaultModel: "acme-llm",
    models: [{ id: "acme-llm", label: "Acme LLM" }],
    research: false,
    keyless: true,
    rpm: 60, burst: 10, // networked → the rate-limit contract applies, keyless or not
    compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "models" },
    embeds: { default: "acme-embedder", models: [{ id: "acme-embedder", note: "test" }] },
    wire: ctx.wires.compat,
  };
}
