// Provider plumbing for the AI tagger: the tagging call, embeddings, and key
// validation, per provider. Prompt building, the queue, and tag validation are
// provider-agnostic and live in worker.js.
//
// Each provider is one descriptor in the PROVIDERS registry below: its quirks
// are data (base URL, which max-tokens field it wants, whether it forces the
// tool call, …), and it points at one of two `wire` families — `anthropic`
// (SDK, tool_use blocks, server-side web_search) or `openai-compat` (plain
// fetch to /chat/completions). The generic code reads descriptor fields; it
// never branches on a provider name. Adding a provider is one descriptor.
import Anthropic from "@anthropic-ai/sdk";

// Local embedding via @huggingface/transformers (ONNX, in-process). The
// pipeline is lazy-loaded on first call and the Promise is cached so concurrent
// callers all await the same initialisation without double-loading.
const LOCAL_EMBED_MODEL = "Xenova/bge-small-en-v1.5";
let _localPipeline = null;
async function localEmbed({ texts }) {
  if (!_localPipeline) {
    const { pipeline } = await import("@huggingface/transformers");
    _localPipeline = pipeline("feature-extraction", LOCAL_EMBED_MODEL, { dtype: "q8" });
  }
  const pipe = await _localPipeline;
  const vectors = [];
  for (const text of texts) {
    const out = await pipe(text, { pooling: "mean", normalize: true });
    vectors.push(new Float32Array(out.data));
  }
  return { vectors, usage: { input: 0, output: 0, cacheRead: 0 } };
}

const TOOL_NAME = "record_tags";
const TOOL_DESC = "Record the applicable taxonomy tags for this item.";
const DEFAULT_TOOL = { name: TOOL_NAME, description: TOOL_DESC };
// Per-item bound on web searches; each one bills on top of tokens.
const MAX_SEARCHES = 5;

// Cached Anthropic clients, keyed by API key — multiple keys can be active at
// once (per-board overrides), and the registry holds at most a handful.
const anthropicClients = new Map();
function anthropicClient(apiKey) {
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  return anthropicClients.get(apiKey);
}

const compatHeaders = (apiKey) => ({ Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" });
// Outbound deadlines for the compat wire — raw fetch has no total bound
// (undici caps response headers at ~5 min; a trickling body never times out),
// and a hung call wedges the worker's single-flight tick. The Anthropic wire
// needs none of this: the SDK defaults to a 10-min per-try timeout, and
// research tagging legitimately runs minutes. Env-tunable, read per call.
const chatSignal = () => AbortSignal.timeout(Number(process.env.AI_CHAT_TIMEOUT_MS) || 180000);
const embedSignal = () => AbortSignal.timeout(Number(process.env.AI_EMBED_TIMEOUT_MS) || 60000);
const keyTestSignal = () => AbortSignal.timeout(30000); // admin Test button — interactive, fail fast
// A failed compat response, turned into a readable error. OpenRouter buries
// the useful upstream detail under error.metadata.raw and leaves error.message
// as a generic "Provider returned error", so prefer the raw when present; other
// providers only have message. The HTTP status (and Retry-After, when sent)
// ride on the error so the queue can tell a rate limit from a bad request —
// the Anthropic SDK's errors carry .status already; this brings the compat
// wire up to par.
async function compatError(r, label) {
  const body = await r.json().catch(() => ({}));
  const msg = body.error?.metadata?.raw || body.error?.message;
  const err = new Error(msg || `${label} HTTP ${r.status}`);
  err.status = r.status;
  const ra = r.headers?.get?.("retry-after");
  if (ra != null) err.retryAfter = ra;
  return err;
}

// --- pure request builders (the test seam) ---

// Anthropic tool-use request. Research relaxes tool_choice to auto — a forced
// tool call would block the server-side web_search tool — so the model must be
// trusted (and validated downstream) to finish with record_tags.
export function anthropicRequest({ model, systemText, schema, parts, research = false, tool = DEFAULT_TOOL }) {
  const content = parts.map((p) => {
    if (p.kind === "image") return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.b64 } };
    if (p.kind === "document") return { type: "document", source: { type: "base64", media_type: p.mediaType, data: p.b64 } };
    return { type: "text", text: p.text };
  });
  const toolDef = { name: tool.name, description: tool.description, strict: true, input_schema: schema };
  return {
    model,
    // searching + digesting results eats output budget
    max_tokens: research ? 4096 : 2048,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    tools: research
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }, toolDef]
      : [toolDef],
    tool_choice: research ? { type: "auto" } : { type: "tool", name: tool.name },
    messages: [{ role: "user", content }],
  };
}

// OpenAI-compatible chat-completions request. A forced function call mirrors
// the Anthropic tool shape and the same strict JSON schema works — but the
// per-provider quirks (which max-tokens field, whether the tool call is forced
// or left auto, whether `strict` is accepted, whether thinking must be turned
// off) are read as data from the descriptor's `compat` block, not branched on
// the provider name. See the GLM descriptor for why each knob exists.
export function compatRequest({ provider, model, systemText, schema, parts, tool = DEFAULT_TOOL }) {
  const { compat } = PROVIDERS[provider];
  const content = parts.map((p) =>
    p.kind === "image"
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.b64}` } }
      : { type: "text", text: p.text }
  );
  return {
    model,
    [compat.maxTokensField]: 2048,
    ...(compat.disableThinking ? { thinking: { type: "disabled" } } : {}),
    messages: [
      { role: "system", content: systemText },
      { role: "user", content },
    ],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: schema, ...(compat.strictTools ? { strict: true } : {}) } }],
    tool_choice: compat.forceToolChoice ? { type: "function", function: { name: tool.name } } : "auto",
  };
}

// --- wire families ---
// Each owns tag/testKey/embed and reads the descriptor for base URL, label,
// and its `compat`/`research` data. `embed: null` marks a family (or provider)
// with no embeddings API.

const anthropicWire = {
  async tag(desc, { apiKey, model, systemText, schema, parts, research = false, tool = DEFAULT_TOOL }) {
    const request = anthropicRequest({ model, systemText, schema, parts, research, tool });
    let msg = await anthropicClient(apiKey).messages.create(request);
    const usage = { input: 0, output: 0, cacheRead: 0, searches: 0 };
    const addUsage = (u = {}) => {
      // cache writes bill as (slightly dearer) input, so fold them in
      usage.input += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      usage.output += u.output_tokens || 0;
      usage.cacheRead += u.cache_read_input_tokens || 0;
      usage.searches += u.server_tool_use?.web_search_requests || 0;
    };
    addUsage(msg.usage);
    // A search-heavy turn can come back paused mid-work; hand the partial turn
    // back and let the model continue (bounded — beyond that, the missing tool
    // call below turns it into a retryable failure).
    for (let i = 0; i < 3 && msg.stop_reason === "pause_turn"; i++) {
      request.messages.push({ role: "assistant", content: msg.content });
      msg = await anthropicClient(apiKey).messages.create(request);
      addUsage(msg.usage);
    }
    const block = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
    if (!block) throw new Error(`model did not call ${tool.name}`);
    return { input: block.input, usage };
  },

  async testKey(desc, { apiKey, model }) {
    // Same 30 s bound as the compat keyTest — interactive admin button; the
    // SDK's 10-min default is for the tagging path, not for a click.
    await anthropicClient(apiKey).messages.countTokens({
      model: model || desc.defaultModel,
      messages: [{ role: "user", content: "hi" }],
    }, { timeout: 30000 });
  },

  embed: null, // Anthropic has no embeddings API
};

const compatWire = {
  async tag(desc, { apiKey, model, systemText, schema, parts, tool = DEFAULT_TOOL }) {
    // Document blocks are Anthropic-only: the chat-completions path has no PDF
    // input. Fail loud with the fix, rather than degrading silently.
    if (parts.some((p) => p.kind === "document"))
      throw new Error(`${desc.label} taggers can't read PDF documents — use an Anthropic tagger for this board`);
    const r = await fetch(`${desc.base}/chat/completions`, {
      method: "POST",
      headers: compatHeaders(apiKey),
      body: JSON.stringify(compatRequest({ provider: desc.name, model, systemText, schema, parts, tool })),
      signal: chatSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    const call = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!call) throw new Error("no tool call in response");
    const u = data.usage || {};
    const cached = u.prompt_tokens_details?.cached_tokens || 0;
    return {
      input: JSON.parse(call.function.arguments),
      usage: {
        // prompt_tokens includes cached ones; pull those out to match Anthropic
        input: Math.max((u.prompt_tokens || 0) - cached, 0),
        output: u.completion_tokens || 0,
        cacheRead: cached,
      },
    };
  },

  async testKey(desc, { apiKey, model }) {
    const id = model || desc.defaultModel;
    // "completion": a one-token chat call (for providers with no models
    // endpoint — GLM). "models": a cheap GET on the model id. Both validate the
    // key and surface the provider's own error message.
    if (desc.compat.keyTest === "completion") {
      const r = await fetch(`${desc.base}/chat/completions`, {
        method: "POST",
        headers: compatHeaders(apiKey),
        body: JSON.stringify({
          model: id,
          [desc.compat.maxTokensField]: 1,
          ...(desc.compat.disableThinking ? { thinking: { type: "disabled" } } : {}),
          messages: [{ role: "user", content: "hi" }],
        }),
        signal: keyTestSignal(),
      });
      if (!r.ok) throw await compatError(r, desc.label);
      return;
    }
    const r = await fetch(`${desc.base}/models/${encodeURIComponent(id)}`, { headers: compatHeaders(apiKey), signal: keyTestSignal() });
    if (!r.ok) throw await compatError(r, desc.label);
  },

  // Embed a batch of texts. Returns { vectors: Float32Array[], usage } with
  // every vector L2-normalized, so similarity is a plain dot product.
  async embed(desc, { apiKey, model, texts }) {
    const r = await fetch(`${desc.base}/embeddings`, {
      method: "POST",
      headers: compatHeaders(apiKey),
      body: JSON.stringify({ model, input: texts }),
      signal: embedSignal(),
    });
    if (!r.ok) throw await compatError(r, desc.label);
    const data = await r.json();
    const rows = (data.data || []).slice().sort((a, b) => a.index - b.index);
    if (rows.length !== texts.length) throw new Error(`${desc.label} returned ${rows.length} embeddings for ${texts.length} inputs`);
    const vectors = rows.map((d) => {
      const v = Float32Array.from(d.embedding);
      let norm = 0;
      for (const x of v) norm += x * x;
      norm = Math.sqrt(norm) || 1;
      for (let i = 0; i < v.length; i++) v[i] /= norm;
      return v;
    });
    return { vectors, usage: { input: data.usage?.prompt_tokens || 0, output: 0, cacheRead: 0 } };
  },
};

// --- the registry ---
// One descriptor per provider. `models`/`embeds.models` carry the admin catalog
// (id + note) as the single source of truth — the admin UI is served from here.

const anthropic = {
  label: "Anthropic",
  description: "Claude models for tagging & descriptions — bring a key",
  wire: anthropicWire,
  defaultModel: "claude-haiku-4-5",
  models: [
    { id: "claude-haiku-4-5", note: "fast, cheapest" },
    { id: "claude-sonnet-4-6", note: "balanced" },
    { id: "claude-opus-4-8", note: "sharpest, most expensive" },
  ],
  research: true, // server-side web_search before tagging
  embeds: null,
};

const openai = {
  label: "OpenAI",
  description: "GPT models for tagging + embeddings — bring a key",
  wire: compatWire,
  base: "https://api.openai.com/v1",
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
};

const gemini = {
  label: "Gemini",
  description: "Google models for tagging + embeddings — bring a key",
  wire: compatWire,
  base: "https://generativelanguage.googleapis.com/v1beta/openai",
  defaultModel: "gemini-2.5-flash",
  models: [
    { id: "gemini-2.5-flash-lite", note: "fast, cheapest" },
    { id: "gemini-2.5-flash", note: "balanced" },
    { id: "gemini-2.5-pro", note: "sharpest, most expensive" },
  ],
  research: false, // the compat layer exposes no grounding
  compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: true, disableThinking: false, keyTest: "models" },
  embeds: {
    default: "gemini-embedding-001",
    models: [{ id: "gemini-embedding-001", note: "Gemini's embedder" }],
  },
};

// Z.ai. Text and vision are separate families (glm-5.x is text-only), so the
// default must be a V model or image boards break; glm-5.2 is offered but
// marked text-only. Quirks below are live-verified (2026-07): tool_choice
// accepts only "auto" (forceToolChoice false — the user-turn instruction plus
// the missing-call throw carry the forcing), `strict` isn't in its function
// schema, thinking defaults ON and must be disabled or it burns output tokens,
// and there is no /models endpoint (keyTest is a one-token completion). No
// embeddings API on the international platform.
const glm = {
  label: "GLM",
  description: "Z.ai GLM models for tagging — bring a key",
  wire: compatWire,
  base: "https://api.z.ai/api/paas/v4",
  defaultModel: "glm-4.6v",
  models: [
    { id: "glm-4.6v-flash", note: "free" },
    { id: "glm-4.6v", note: "balanced" },
    { id: "glm-5.2", note: "sharpest, text boards only" },
  ],
  research: false, // has a chat-completions web_search tool — future work
  compat: { maxTokensField: "max_tokens", forceToolChoice: false, strictTools: false, disableThinking: true, keyTest: "completion" },
  embeds: null,
};

// Local embedding-only provider: no API key, no tagger capability. The wire
// and models fields are intentionally empty; `keyless` marks it as something
// that must never appear in the API key registration form.
const local = {
  label: "Xenova",
  description: "On-device embeddings for search — no API key (transformers.js)",
  wire: null,
  defaultModel: null,
  models: [],
  research: false,
  keyless: true,
  embeds: {
    default: LOCAL_EMBED_MODEL,
    models: [{ id: LOCAL_EMBED_MODEL, note: "runs on-server · no API key" }],
  },
};

// OpenRouter — an OpenAI-compatible aggregator: one key, many models. Fits the
// compat family with no new fields (bearer auth, /chat/completions, max_tokens).
// strictTools is off because the backend models vary in strict-schema support,
// and the key test is a one-token completion — OpenRouter has no per-model GET
// and its ids carry a slash. Free vision models exist (`:free`), so tagging can
// be verified at zero cost; the default is a cheap dedicated vision model.
const openrouter = {
  label: "OpenRouter",
  description: "Many model backends behind one key",
  wire: compatWire,
  base: "https://openrouter.ai/api/v1",
  defaultModel: "qwen/qwen3-vl-32b-instruct",
  models: [
    { id: "google/gemma-4-31b-it:free", note: "free" },
    { id: "qwen/qwen3-vl-32b-instruct", note: "balanced" },
    { id: "google/gemini-3.5-flash", note: "sharpest, most expensive" },
  ],
  research: false,
  compat: { maxTokensField: "max_tokens", forceToolChoice: true, strictTools: false, disableThinking: false, keyTest: "completion" },
  embeds: null,
};

export const PROVIDERS = { local, anthropic, openai, gemini, glm, openrouter };
for (const [name, desc] of Object.entries(PROVIDERS)) desc.name = name; // self-reference for dispatch

// Callers reach through the registry directly: PROVIDERS[p].defaultModel for
// the default, PROVIDERS[p]?.embeds as the "does this provider embed" check.
// The one place a plain list is needed (validation error messages) derives it
// inline from Object.keys(PROVIDERS).

// --- public dispatchers ---

// Run one tagging call. `parts` is the provider-neutral user content the source
// built ({ kind: "image", mediaType, b64 } | { kind: "text", text } |
// { kind: "document", … }); the wire family maps it to its own format. Research
// (server-side web search before tagging) is honored only by providers that
// declare it — the rest tag from the given input. Returns { input, usage }: the
// tool-call input object (facet key -> selection, plus "fit") and token usage
// normalized to { input, output, cacheRead, searches } — cache reads are kept
// out of `input` because they bill at a fraction of the input rate. Throws with
// a readable message on any failure.
export function callTagger({ provider, research = false, ...rest }) {
  const desc = PROVIDERS[provider];
  return desc.wire.tag(desc, { ...rest, research: research && desc.research });
}

// Embed a batch of texts (semantic search). Only embeddings-capable providers
// qualify — callers gate on PROVIDERS[provider].embeds before reaching here.
export function embedTexts({ provider, ...rest }) {
  if (provider === "local") return localEmbed(rest);
  const desc = PROVIDERS[provider];
  return desc.wire.embed(desc, rest);
}

// Cheap key/model validation for the admin "Test" buttons. Throws with the
// provider's error message on failure.
export function testKey({ provider, ...rest }) {
  const desc = PROVIDERS[provider];
  return desc.wire.testKey(desc, rest);
}

// Public catalog for the admin UI — labels, model lists (with notes), defaults,
// and capability flags. No secrets, safe to serve. The client renders its
// provider/model pickers from this so the catalog isn't mirrored in two places.
export function providerCatalog() {
  return Object.keys(PROVIDERS).map((name) => {
    const p = PROVIDERS[name];
    return {
      name,
      label: p.label,
      description: p.description || "",
      defaultModel: p.defaultModel,
      models: p.models,
      research: p.research,
      keyless: !!p.keyless,
      embeds: p.embeds ? { default: p.embeds.default, models: p.embeds.models } : null,
    };
  });
}
