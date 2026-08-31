// Gemini — Google's models through their OpenAI-compatible endpoint, so it rides
// the shared compat wire with its own base + quirks. Tags and embeds; no grounding
// exposed on the compat layer (research false).
export default (wires) => ({
  label: "Gemini",
  description: "Google models for tagging + embeddings — bring a key",
  wire: wires.compat,
  base: "https://generativelanguage.googleapis.com/v1beta/openai",
  // Rate limit: Free tier — 10 RPM for flash-class models (Google AI docs, 2026-07).
  // Paid Tier 1 is far higher (~1,000+ RPM) — raise per key once billing is on.
  rpm: 10, burst: 5,
  // Image input ceiling for the tag rendition (ai-image.js clamp; surveyed
  // 2026-08-11): Gemini tiles at 768×768 with no hard dimension cap the compat
  // layer exposes, so this is the generic ceiling stated explicitly — 2048px
  // is 4–6 tiles, past which more pixels buy little; inline payloads cap
  // around 20MB so 4MB keeps clear headroom.
  images: { maxEdge: 2048, maxBytes: 4e6 },
  // Curated set live-verified 2026-07-29: the 2.5 family curated here before
  // was RETIRED for new users (gemini-2.5-flash 404s "no longer available to
  // new users" while still APPEARING in /models — listing presence is not
  // usability, so verify with a chat call when refreshing this list). No
  // stable pro tier currently exists past 2.5; the preview id is offered
  // with that caveat in its note, and the live-list merge drops it the day
  // it retires.
  defaultModel: "gemini-3.5-flash",
  models: [
    { id: "gemini-3.5-flash-lite", note: "fast, cheapest" },
    { id: "gemini-3.5-flash", note: "balanced" },
    { id: "gemini-3.1-pro-preview", note: "sharpest, most expensive · preview id" },
  ],
  research: false, // the compat layer exposes no grounding
  // LiteLLM community-map namespace (verified live 2026-08-31). Its gemini
  // entries are keyed "gemini/<model>" — the learner's ns-prefixed match.
  priceNamespace: "gemini",
  // Live-list carving (the compat /models dump has no capability metadata):
  // tagging keeps gemini-* chat models (embedding/imagen/veo/tts drop out;
  // gemma-* too, deliberately — tool-calling is spotty there and the wire
  // hard-requires the tool call);
  // stripListPrefix normalizes the "models/gemini-…" ids the compat layer
  // lists to the bare ids its chat endpoint takes.
  modelFilter: "^gemini-(?!.*(embedding|image|tts|audio|live))",
  // temperature 0 for tagging (see compatRequest). Live-probed 2026-08-06 on
  // gemini-3.5-flash; no Gemini family rejects the parameter, so no guard.
  compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models", stripListPrefix: "models/", temperature: 0 },
  embeds: {
    // 001 stays the default on purpose: flipping it would mark every stored
    // vector stale and re-embed the whole corpus. Both live-verified 2026-07-29.
    default: "gemini-embedding-001",
    models: [
      { id: "gemini-embedding-001", note: "Gemini's embedder" },
      { id: "gemini-embedding-2", note: "newer; switching re-embeds everything" },
    ],
    filter: "embedding", // gemini-embedding-001, gemini-embedding-2, …
  },
});
