// Z.ai GLM — the compat wire, but the divergent one, so its `compat` block flips
// nearly every knob. Text and vision are separate families (glm-5.x is text-only),
// so the default must be a V model or image boards break; glm-5.2 is offered but
// marked text-only. Quirks are live-verified (2026-07): tool_choice accepts only
// "auto" (forceToolChoice false — the user-turn instruction plus the missing-call
// throw carry the forcing), `strict` isn't in its function schema, thinking
// defaults ON and must be disabled or it burns output tokens, and there is no
// /models endpoint (keyTest is a one-token completion). No embeddings API on the
// international platform.
export default (wires) => ({
  label: "GLM",
  description: "Z.ai GLM models for tagging — bring a key",
  wire: wires.compat,
  base: "https://api.z.ai/api/paas/v4",
  // Rate limit: Z.ai publishes no fixed RPM — it gates by CONCURRENCY (historically
  // ~1-2 in flight, undocumented). Not a provider figure: a conservative choice, low
  // burst to approximate the concurrency cap. Revisit if Z.ai publishes real limits.
  rpm: 60, burst: 2,
  // Image input ceiling for the tag rendition (ai-image.js clamp): Z.ai
  // publishes no dimension cap for the V family — the generic conservative
  // ceiling stated explicitly (2026-08-11), matching this file's
  // never-guessed policy.
  images: { maxEdge: 2048, maxBytes: 4e6 },
  defaultModel: "glm-4.6v",
  models: [
    { id: "glm-4.6v-flash", note: "free" },
    { id: "glm-4.6v", note: "balanced" },
    { id: "glm-5.2", note: "sharpest, text boards only" },
  ],
  research: false, // has a chat-completions web_search tool — future work
  // No `temperature` knob: the 2026-08-06 probe pass could not reach GLM (the
  // stored key returns 1113 "insufficient balance" with or without the
  // parameter), and this provider's quirks are live-verified by policy, never
  // guessed. Add `temperature: 0` here once a working key confirms it accepts.
  compat: { maxTokensField: "max_tokens", forceToolChoice: false, strictTools: false, disableThinking: true, keyTest: "completion", listModels: false },
  embeds: null,
});
