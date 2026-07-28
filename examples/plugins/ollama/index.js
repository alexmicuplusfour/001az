// Ollama as an ai-provider plugin: tagging + embeddings against a self-hosted
// Ollama server through its OpenAI-compatible API (/v1). No protocol code here
// — the descriptor rides the shared compat wire (ctx.wires.compat), exactly
// like the built-in OpenAI/Gemini providers.
//
// `keyless: true` — connections register without a secret (Ollama has no API
// keys) and the wire sends no Authorization header. If your server sits behind
// an authenticating reverse proxy, store its token on the connection and it is
// sent as a Bearer header. NOT `onDevice`: it's a real server on your network,
// so the rate-limit contract and per-call pacing apply.
//
// `needsBase: true` — each connection carries its own server URL, set in the
// admin UI when you add it (two connections = two Ollama boxes). The `base`
// below is only the suggested default; OLLAMA_BASE_URL overrides that default
// without editing the file. The app runs in Docker, so "localhost" would be
// the app container itself — use host.docker.internal or a LAN IP.
//
// The model picker lists what your server has actually `ollama pull`ed — the
// app asks /v1/models per connection (the shared compat wire's listModels).
// The `models` below are only the offline fallback + suggested starting
// points; no need to edit this file when you pull something new.
const base = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434/v1";

export default function (ctx) {
  return {
    label: "Ollama",
    description: "Self-hosted models via Ollama's OpenAI-compatible API — keyless",
    base,
    // Tagging needs a tool-calling-capable model (the wire hard-fails without a
    // tool call in the response) — llama3.1+, qwen2.5/3, mistral-nemo, etc.
    // These two are recommendations pinned atop the live list, and the fallback
    // when the server can't be reached; any pulled model can be typed/picked.
    defaultModel: "llama3.1:8b",
    models: [
      { id: "llama3.1:8b", note: "solid tool calling · ~8 GB" },
      { id: "qwen2.5:14b", note: "stronger tagging · ~9 GB" },
    ],
    // The tagger picker excludes what the embeds filter below claims (the
    // wire hard-fails on a model that can't tool-call, and an embedder never
    // can) — keep the two patterns mirror images when editing either.
    modelFilter: "^(?!.*(embed|bge))",
    research: false,
    keyless: true,
    needsBase: true,
    // Pace to what your box can serve, not an account tier — this mostly guards
    // the GPU against a big backlog sweep. Adjustable on the plugin card.
    rpm: 120, burst: 5,
    // Ollama ignores unknown OpenAI fields (tool_choice among them, on older
    // versions), so forcing the tool call is safe and helps where supported.
    // keyTest "list" probes /v1/models (the index): Test answers "is the box
    // up", not "is one particular model pulled" — a fresh box with nothing
    // pulled tests green, and the picker shows what's actually there.
    compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "list" },
    // Embeddings via /v1/embeddings — pull the model first (`ollama pull nomic-embed-text`).
    // The filter carves embedding models out of the live /v1/models dump by
    // name (Ollama reports no capabilities there): nomic-embed-text,
    // mxbai-embed-large, snowflake-arctic-embed, bge-m3, …
    embeds: {
      default: "nomic-embed-text",
      models: [{ id: "nomic-embed-text", note: "768-dim · runs on your Ollama box" }],
      filter: "embed|bge",
    },
    wire: ctx.wires.compat,
  };
}
