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
const base = process.env.OLLAMA_BASE_URL || "http://host.docker.internal:11434/v1";

export default function (ctx) {
  return {
    label: "Ollama",
    description: "Self-hosted models via Ollama's OpenAI-compatible API — keyless",
    base,
    // What this plugin does: tagging — which also serves field extraction, as
    // every tagger does — and embeddings. What `provides` leaves out it doesn't
    // do: no transcription, no object detection, no web research.
    //
    // NO model lists — each picker is whatever your box has actually `ollama
    // pull`ed, asked per connection via /v1/models. That answer differs per
    // box and changes every time you pull, so a curated array here could only
    // ever be wrong for someone. Ollama reports no capabilities in that
    // listing, so each capability claims its slice BY NAME: `filter` is a
    // pattern, not a list, so a model nobody has heard of yet still lands in
    // the right picker. Keep the two patterns mirror images when editing
    // either — the tagger picker excludes what the embedder claims (the wire
    // hard-fails on a model that can't tool-call, and an embedder never can).
    //
    // `default` is the one model id each names, and it is not a catalog — it
    // is the pre-selection for a picker nobody has touched yet (the contract
    // requires one of any tagging provider), and the sole option shown if the
    // server can't be reached. Tagging needs a tool-calling-capable model —
    // llama3.1+, qwen2.5/3, mistral-nemo — since the wire hard-fails without a
    // tool call in the response; if you haven't pulled the default, pick yours
    // from the picker, which lists what you actually have. Embeddings go
    // through /v1/embeddings: pull the model first (`ollama pull
    // nomic-embed-text`); the pattern also catches mxbai-embed-large,
    // snowflake-arctic-embed, bge-m3, ….
    provides: {
      tag: { default: "llama3.1:8b", filter: "^(?!.*(embed|bge))" },
      embed: { default: "nomic-embed-text", filter: "embed|bge" },
    },
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
    wire: ctx.wires.compat,
  };
}
