// Gemini — Google's models through their OpenAI-compatible endpoint, so it rides
// the shared compat wire with its own base + quirks. Tags and embeds; no grounding
// exposed on the compat layer (research false).
export default (wires) => ({
  label: "Gemini",
  description: "Google models for tagging + embeddings — bring a key",
  wire: wires.compat,
  base: "https://generativelanguage.googleapis.com/v1beta/openai",
  // Rate limit: Free tier — 10 RPM for gemini-2.5-flash (Google AI docs, 2026-07).
  // Paid Tier 1 is far higher (~1,000+ RPM) — raise per key once billing is on.
  rpm: 10, burst: 5,
  defaultModel: "gemini-2.5-flash",
  models: [
    { id: "gemini-2.5-flash-lite", note: "fast, cheapest" },
    { id: "gemini-2.5-flash", note: "balanced" },
    { id: "gemini-2.5-pro", note: "sharpest, most expensive" },
  ],
  research: false, // the compat layer exposes no grounding
  // Live-list carving (the compat /models dump has no capability metadata):
  // tagging keeps gemini-* chat models (embedding/imagen/veo/tts drop out);
  // stripListPrefix normalizes the "models/gemini-…" ids the compat layer
  // lists to the bare ids its chat endpoint takes.
  modelFilter: "^gemini-(?!.*(embedding|image|tts|audio|live))",
  compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models", stripListPrefix: "models/" },
  embeds: {
    default: "gemini-embedding-001",
    models: [{ id: "gemini-embedding-001", note: "Gemini's embedder" }],
    filter: "embedding", // text-embedding-004, gemini-embedding-001, …
  },
});
