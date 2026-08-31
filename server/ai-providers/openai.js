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
  // Image input ceiling for the tag rendition (ai-image.js clamp; surveyed
  // 2026-08-11): 2048px is the gpt-5 family's dimension cap at `high` detail —
  // the minis additionally patch-cap at 1,536 32×32 patches, but the backend
  // trims that itself, so the provider-wide ceiling is the dimension. Payload
  // headroom is generous (512MB request cap).
  images: { maxEdge: 2048, maxBytes: 15e6 },
  defaultModel: "gpt-5-mini",
  models: [
    { id: "gpt-5-nano", note: "fast, cheapest" },
    { id: "gpt-5-mini", note: "balanced" },
    { id: "gpt-5.1", note: "sharpest, most expensive" },
  ],
  research: false, // web search lives on the Responses API, not chat completions
  priceNamespace: "openai", // LiteLLM community-map namespace (verified live 2026-08-31)
  // Live-list carving (OpenAI's /models is bare ids, no capability metadata):
  // tagging keeps the chat families (gpt-*/o3/chatgpt-*) minus the non-chat
  // suffixes that share the gpt- prefix (transcribe/tts/audio/realtime/image…).
  // Responses-API-only ids (o1-pro, *-deep-research) and instruct-era ids
  // still pass — a name pattern can't see which API serves a model; a wrong
  // pick fails at call time with the provider's own readable error.
  modelFilter: "^(?!.*(embedding|tts|transcribe|realtime|audio|moderation|image|dall-e))(gpt-|o\\d|chatgpt-)",
  // forceToolChoice "required" (not the named force): from 2026-07-29 the
  // gpt-5 family rejects tool_choice:{function:{name}} as invalid_prompt
  // ("flagged as potentially violating our usage policy") — live-bisected;
  // "required" and "auto" pass, and with one tool defined "required" is the
  // same guarantee.
  // temperature 0 for the tagging path (see compatRequest for the measurement).
  // noTemperature lists the families that 400 on any non-default value — all of
  // whose ids pass the modelFilter above, so they'd otherwise be offered and
  // then fail every item:
  //   o-series          o3, o4-mini …
  //   gpt-5 BASE family gpt-5, gpt-5-mini, gpt-5-nano, gpt-5-chat-latest,
  //                     gpt-5-2025-08-07 — reasoning models with sampling
  //                     locked to the default. Hyphen-or-end anchored so the
  //                     dot-versioned successors (gpt-5.1, gpt-5.4-mini), which
  //                     accept 0, keep sending it. Added 2026-08-09 after
  //                     gpt-5-mini — this descriptor's OWN defaultModel — failed
  //                     a real board with "Unsupported value: 'temperature' does
  //                     not support 0.0 with this model."
  // The list is the fast path, not the safety net: an id nobody has tried yet is
  // caught by the wire's rejection recovery instead.
  // Live-probed 2026-08-06: gpt-5.4-mini and gpt-5.1 accept 0, o3 rejects it.
  compat: { maxTokensField: "max_completion_tokens", forceToolChoice: "required", strictTools: true, disableThinking: false, keyTest: "models", temperature: 0, noTemperature: "^(o\\d|gpt-5(-|$))" },
  embeds: {
    default: "text-embedding-3-small",
    models: [
      { id: "text-embedding-3-small", note: "cheapest, plenty here" },
      { id: "text-embedding-3-large", note: "sharper, ~6× cost" },
    ],
    filter: "^text-embedding-",
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
    filter: "transcribe|^whisper-",
  },
});
