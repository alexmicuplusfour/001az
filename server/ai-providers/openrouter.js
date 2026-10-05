// OpenRouter — an OpenAI-compatible aggregator: one key, many models. Fits the
// compat wire with no new fields (bearer auth, /chat/completions, max_tokens).
// strictTools is off because the backend models vary in strict-schema support,
// and the key test is a one-token completion — OpenRouter has no per-model GET
// and its ids carry a slash. Free vision models exist (`:free`), so tagging can
// be verified at zero cost; the default is a cheap dedicated vision model.
export default ({ wires }) => ({
  label: "OpenRouter",
  description: "Many model backends behind one key",
  wire: wires.compat,
  base: "https://openrouter.ai/api/v1",
  // Rate limit: OpenRouter has no fixed per-minute cap for paid models (credit/DDoS
  // gated); free (:free) models are 20 RPM. Not a provider figure for the paid path:
  // a conservative default; raise it freely.
  rpm: 60, burst: 10,
  // Image input ceiling for the tag rendition (ai-image.js clamp; surveyed
  // 2026-08-11): pass-through to hundreds of backends, so the generic
  // conservative ceiling stated explicitly — the backend applies its own
  // downscaling past whatever its true limit is.
  images: { maxEdge: 2048, maxBytes: 4e6 },
  // PDF files: OpenRouter takes them for any model and hands them to the
  // model's own vendor, documenting no limit of its own, so the smallest of
  // those holds — Anthropic's (pdf-conversion-plan.md, Stage 5). A model that
  // can't read files is refused it (see withDocuments below) and gets the text.
  documents: { maxBytes: 20e6, maxPages: 100 },
  defaultModel: "qwen/qwen3-vl-32b-instruct",
  models: [
    { id: "google/gemma-4-31b-it:free", note: "free" },
    { id: "qwen/qwen3-vl-32b-instruct", note: "balanced" },
    { id: "google/gemini-3.5-flash", note: "sharpest, most expensive" },
  ],
  research: false,
  // LiteLLM community-map namespace (verified live 2026-08-31) — but it only
  // covers ~100 of OpenRouter's 300+ models, so the real answer here is the
  // rung ABOVE it: /models carries a `pricing` object on every row, which the
  // compat wire's listPrices reads. Community is the fallback, as designed.
  priceNamespace: "openrouter",
  // No `temperature` knob, deliberately. One backend (qwen/qwen3-vl-32b-instruct)
  // accepted 0 in the 2026-08-06 probe, but this descriptor fronts hundreds of
  // models from every vendor — including the o-series ids that hard-400 on it
  // under the `openai/` namespace — and one passing probe does not generalise
  // across that surface. Tag stability is worth less than a permanently failing
  // board. Revisit with a per-model guard if a user asks for it.
  // priceFields: OpenRouter puts a `pricing` object on every /models row —
  // not part of the compat protocol, so which keys it uses is this
  // descriptor's business (the wire reads whatever is declared here and
  // answers null for a provider that declares nothing). Left → OpenRouter's
  // field name, right → our meter unit. Verified live 2026-08-31: values are
  // dollars-per-unit strings; "-1" means variable pricing and the wire drops
  // it. `image` and `internal_reasoning` exist too — unmapped until we meter
  // those units (Stage 5), because a rate we can't attribute is noise.
  // withDocuments: a request carrying a PDF asks for the model's own reading.
  // Left unasked, a model that can't read files (the default above is one)
  // has the file parsed by Mistral OCR at $2 per 1,000 pages, billed on the
  // user's own key too and invisible to the meter; the free parser turns every
  // PDF into text first, even for a model that reads files. Asked, a model
  // that can't refuses it — measured 2026-10-05: qwen3-vl answered 400
  // "Invalid value: file" — and the step sends the PDF's text instead.
  compat: {
    maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "completion",
    priceFields: { prompt: "input_tokens", completion: "output_tokens", input_cache_read: "cache_read_tokens", web_search: "web_searches", request: "requests" },
    withDocuments: { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] },
  },
  embeds: null,
});
