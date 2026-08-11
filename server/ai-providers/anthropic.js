// Anthropic — Claude via the SDK wire (tool_use blocks, server-side web_search).
// The only research-capable built-in; no `compat` block (that's the openai
// family's data). A factory (wires) => descriptor, the same contract an
// ai-provider plugin's factory returns.
export default (wires) => ({
  label: "Anthropic",
  description: "Claude models for tagging & descriptions — bring a key",
  wire: wires.anthropic,
  defaultModel: "claude-haiku-4-5",
  models: [
    { id: "claude-haiku-4-5", note: "fast, cheapest" },
    { id: "claude-sonnet-4-6", note: "balanced" },
    { id: "claude-opus-4-8", note: "sharpest, most expensive" },
  ],
  research: true, // server-side web_search before tagging
  // Rate limit: "Start" (entry paid) tier — 1,000 RPM for Haiku 4.5 (Anthropic
  // docs, 2026-07). A burst guard only; the binding ceiling is ITPM (2M), which
  // this req/min bucket can't see — TPM-awareness is the worker-pools slice.
  rpm: 1000, burst: 50,
  // Image input ceiling for the tag rendition (ai-image.js clamp; surveyed
  // 2026-08-11): 1568px is the standard-tier cap — larger is downscaled
  // server-side, and on 4.7+ models it would ALSO buy into the 2576px
  // high-res tier at ~3× image tokens, which is a per-model extension, not a
  // provider-wide default. maxBytes: their 10MB limit is on the BASE64
  // (×1.33), so ~5MB encoded keeps clear headroom.
  images: { maxEdge: 1568, maxBytes: 5e6 },
  embeds: null,
});
