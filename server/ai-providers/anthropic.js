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
  // Author-time price data (metering-plan.md, the descriptor rung): micro-
  // dollars per unit, which is numerically the $-per-million a pricing page
  // states. Anthropic list prices, surveyed 2026-08-31; cache reads bill at
  // 0.1× input. Web searches bill per search on top of tokens but their rate
  // isn't stated machine-readably — left unpriced rather than guessed.
  // Models absent from this map (a typed-in id) meter unpriced; an admin
  // price row overrides any entry here.
  prices: {
    // The '*' entry is what this provider charges for EVERY model it serves:
    // Anthropic bills tokens, not calls, so a request costs $0 — known-free,
    // said once here rather than inferred elsewhere. Per-model entries below
    // override it unit by unit.
    "*":                 { requests: 0 },
    "claude-haiku-4-5":  { input_tokens: 1, output_tokens: 5,  cache_read_tokens: 0.1 },
    "claude-sonnet-4-6": { input_tokens: 3, output_tokens: 15, cache_read_tokens: 0.3 },
    "claude-opus-4-8":   { input_tokens: 5, output_tokens: 25, cache_read_tokens: 0.5 },
  },
  // Models beyond the map above (a typed-in id) may be priced from the LiteLLM
  // community map under this litellm_provider value (verified live 2026-08-31).
  // Only a descriptor that names its namespace is ever looked up there — the
  // self-hosted trap (metering-plan.md).
  priceNamespace: "anthropic",
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
