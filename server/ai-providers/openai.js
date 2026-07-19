// OpenAI — the compat wire (chat-completions, /embeddings, /audio/transcriptions).
// Brings only its descriptor: base URL, the `compat` quirk block the generic
// request builder reads, and the model catalogs. All three capabilities (tag,
// embed, transcribe) ride the shared compat wire.
export default (wires) => ({
  label: "OpenAI",
  description: "GPT models for tagging + embeddings — bring a key",
  wire: wires.compat,
  base: "https://api.openai.com/v1",
  // Rate limit: Tier 1 ($5 spend) — 500 RPM for gpt-4o/mini-class chat (embeddings
  // are 3,000, but this shared per-key bucket holds at the chat floor). Free tier is
  // only 3 RPM; raise per key for your tier.
  rpm: 500, burst: 25,
  defaultModel: "gpt-5-mini",
  models: [
    { id: "gpt-5-nano", note: "fast, cheapest" },
    { id: "gpt-5-mini", note: "balanced" },
    { id: "gpt-5.1", note: "sharpest, most expensive" },
  ],
  research: false, // web search lives on the Responses API, not chat completions
  compat: { maxTokensField: "max_completion_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models" },
  embeds: {
    default: "text-embedding-3-small",
    models: [
      { id: "text-embedding-3-small", note: "cheapest, plenty here" },
      { id: "text-embedding-3-large", note: "sharper, ~6× cost" },
    ],
  },
  // OpenAI's /audio/transcriptions endpoint (shared compat wire's transcribe). A
  // provider advertises this only if its backend serves that endpoint — the
  // generic path reads the flag, never the provider name.
  transcribes: {
    default: "gpt-4o-transcribe",
    models: [
      { id: "gpt-4o-mini-transcribe", note: "fast, cheapest" },
      { id: "gpt-4o-transcribe", note: "balanced" },
      { id: "whisper-1", note: "the classic Whisper" },
    ],
  },
});
