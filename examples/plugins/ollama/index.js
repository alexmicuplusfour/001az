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
    // NO `models` list — the picker is whatever your box has actually
    // `ollama pull`ed, asked per connection via /v1/models (the shared compat
    // wire's listModels). That answer differs per box and changes every time
    // you pull, so a curated array here could only ever be wrong for someone.
    //
    // `defaultModel` is the one model id this file names, and it is not a
    // catalog — it is the pre-selection for a picker nobody has touched yet
    // (the contract requires one of any tagging provider), and the sole option
    // shown if the server can't be reached. Tagging needs a tool-calling-capable
    // model — llama3.1+, qwen2.5/3, mistral-nemo — since the wire hard-fails
    // without a tool call in the response; if you haven't pulled this one, pick
    // yours from the picker, which lists what you actually have.
    defaultModel: "llama3.1:8b",
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
    // OPTIONAL: the image-input ceiling for tag renditions (long edge px /
    // encoded bytes). Omit it and conservative generic defaults apply; declare
    // it to let the app send what your vision models actually use. Validated
    // at registration — positive finite numbers or the plugin is rejected.
    images: { maxEdge: 2048, maxBytes: 4e6 },
    // Ollama ignores unknown OpenAI fields (tool_choice among them, on older
    // versions), so forcing the tool call is safe and helps where supported.
    // keyTest "list" probes /v1/models (the index): Test answers "is the box
    // up", not "is one particular model pulled" — a fresh box with nothing
    // pulled tests green, and the picker shows what's actually there.
    compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "list" },
    // Embeddings via /v1/embeddings — pull the model first (`ollama pull nomic-embed-text`).
    // The filter carves embedding models out of the live /v1/models dump by
    // name (Ollama reports no capabilities there): nomic-embed-text,
    // mxbai-embed-large, snowflake-arctic-embed, bge-m3, … A PATTERN, not a
    // list: it claims this catalog's slice of whatever your box reports, so
    // pulling a new embedder shows it here without touching this file.
    embeds: {
      default: "nomic-embed-text",
      // Empty for the same reason tagging has no list — the picker is your
      // box's pulled models, filtered by the pattern above. It stays an array
      // rather than being omitted because the admin modal reads `.length` on
      // the capability catalogs (only the tagging list is optional server-side).
      models: [],
      filter: "embed|bge",
    },
    wire: ctx.wires.compat,
  };
}
