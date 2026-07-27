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
// The model list is yours to edit — Ollama's catalog is whatever you've
// `ollama pull`ed, which the app can't know.
const base = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434/v1";

export default function (ctx) {
  return {
    label: "Ollama",
    description: "Self-hosted models via Ollama's OpenAI-compatible API — keyless",
    base,
    // Tagging needs a tool-calling-capable model (the wire hard-fails without a
    // tool call in the response) — llama3.1+, qwen2.5/3, mistral-nemo, etc.
    defaultModel: "llama3.1:8b",
    models: [
      { id: "llama3.1:8b", note: "solid tool calling · ~8 GB" },
      { id: "qwen2.5:14b", note: "stronger tagging · ~9 GB" },
    ],
    research: false,
    keyless: true,
    needsBase: true,
    // Pace to what your box can serve, not an account tier — this mostly guards
    // the GPU against a big backlog sweep. Adjustable on the plugin card.
    rpm: 120, burst: 5,
    // Ollama ignores unknown OpenAI fields (tool_choice among them, on older
    // versions), so forcing the tool call is safe and helps where supported.
    compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "models" },
    // Embeddings via /v1/embeddings — pull the model first (`ollama pull nomic-embed-text`).
    embeds: {
      default: "nomic-embed-text",
      models: [{ id: "nomic-embed-text", note: "768-dim · runs on your Ollama box" }],
    },
    wire: ctx.wires.compat,
  };
}
