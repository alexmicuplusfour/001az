// Provider plumbing for the AI tagger: the tagging call itself and key
// validation, per provider. Prompt building, the queue, and tag validation
// are provider-agnostic and live in worker.js.
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = ["anthropic", "openai", "gemini", "glm"];
export const PROVIDER_DEFAULT_MODEL = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
  gemini: "gemini-2.5-flash",
  // Text and vision are separate families at Z.ai (glm-5.x is text-only), so
  // the default must be a V model or image boards break.
  glm: "glm-4.6v",
};

// Gemini and GLM (Z.ai) speak OpenAI's wire format through compatibility
// endpoints, so all three providers share the fetch code below; only base
// URL, label, and the request quirks in compatRequest differ.
const COMPAT = {
  openai: { base: "https://api.openai.com/v1", label: "OpenAI" },
  gemini: { base: "https://generativelanguage.googleapis.com/v1beta/openai", label: "Gemini" },
  glm: { base: "https://api.z.ai/api/paas/v4", label: "GLM" },
};

const TOOL_NAME = "record_tags";
const TOOL_DESC = "Record the applicable taxonomy tags for this item.";

// Cached Anthropic clients, keyed by API key — multiple keys can be active at
// once (per-board overrides), and the registry holds at most a handful.
const anthropicClients = new Map();
function anthropicClient(apiKey) {
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  return anthropicClients.get(apiKey);
}

// Run one tagging call. `parts` is the provider-neutral user content the
// board type built ({ kind: "image", mediaType, b64 } | { kind: "text", text });
// each provider maps it to its own wire format here. `research` lets the
// model use the provider's web-search tool before tagging — Anthropic only;
// the compat providers ignore the flag and tag from the given input (OpenAI's
// web search lives on its Responses API, not chat completions; Gemini's
// compat layer exposes no grounding; GLM has a chat-completions web_search
// tool that could support this later). Returns { input, usage }: the tool-call
// input object (facet key -> selection, plus "fit") and the token usage the
// provider reported, normalized to { input, output, cacheRead, searches }
// — cache reads are kept out of `input` because they bill at a fraction of
// the input rate. Throws with a readable message on any failure.
export async function callTagger({ provider, apiKey, model, systemText, schema, parts, research = false, tool = { name: TOOL_NAME, description: TOOL_DESC } }) {
  if (COMPAT[provider]) return compatTag({ provider, apiKey, model, systemText, schema, parts, tool });
  return anthropicTag({ apiKey, model, systemText, schema, parts, research, tool });
}

// Per-item bound on web searches; each one bills on top of tokens.
const MAX_SEARCHES = 5;

// Request construction, split out pure so tests can assert the shape.
// Research relaxes tool_choice to auto — a forced tool call would block the
// server-side web_search tool — so the model must be trusted (and validated)
// to finish with record_tags.
export function anthropicRequest({ model, systemText, schema, parts, research = false, tool = { name: TOOL_NAME, description: TOOL_DESC } }) {
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

async function anthropicTag({ apiKey, model, systemText, schema, parts, research = false, tool = { name: TOOL_NAME, description: TOOL_DESC } }) {
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
  // back and let the model continue (bounded — beyond that, the missing
  // tool call below turns it into a retryable failure).
  for (let i = 0; i < 3 && msg.stop_reason === "pause_turn"; i++) {
    request.messages.push({ role: "assistant", content: msg.content });
    msg = await anthropicClient(apiKey).messages.create(request);
    addUsage(msg.usage);
  }
  const block = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
  if (!block) throw new Error(`model did not call ${tool.name}`);
  return { input: block.input, usage };
}

// Request construction for the OpenAI-compatible providers, split out pure so
// tests can assert the shape. A forced function call mirrors the Anthropic
// tool shape and the same strict JSON schema works everywhere — except GLM,
// which diverges in three places (live-verified 2026-07): its docs allow only
// "auto" for tool_choice (the user-turn instruction plus the missing-call
// throw below carry the forcing), `strict` isn't in its function schema, and
// thinking defaults ON and must be disabled explicitly or it spends output
// tokens reasoning before the call.
export function compatRequest({ provider, model, systemText, schema, parts, tool = { name: TOOL_NAME, description: TOOL_DESC } }) {
  const content = parts.map((p) =>
    p.kind === "image"
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.b64}` } }
      : { type: "text", text: p.text }
  );
  const glm = provider === "glm";
  return {
    model,
    // Only OpenAI takes the new name for this cap; Gemini's compat layer and
    // GLM both want the legacy one.
    ...(provider === "openai" ? { max_completion_tokens: 2048 } : { max_tokens: 2048 }),
    ...(glm ? { thinking: { type: "disabled" } } : {}),
    messages: [
      { role: "system", content: systemText },
      { role: "user", content },
    ],
    tools: [{ type: "function", function: { name: tool.name, description: tool.description, parameters: schema, ...(glm ? {} : { strict: true }) } }],
    tool_choice: glm ? "auto" : { type: "function", function: { name: tool.name } },
  };
}

// OpenAI-compatible providers via plain fetch — one endpoint, not worth a
// dependency.
async function compatTag({ provider, apiKey, model, systemText, schema, parts, tool = { name: TOOL_NAME, description: TOOL_DESC } }) {
  const { base, label } = COMPAT[provider];
  // Document blocks are Anthropic-only: the chat-completions compat path has
  // no PDF input. Fail loud with the fix, rather than degrading silently.
  if (parts.some((p) => p.kind === "document"))
    throw new Error(`${label} taggers can't read PDF documents — use an Anthropic tagger for this board`);
  const r = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(compatRequest({ provider, model, systemText, schema, parts, tool })),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || `${label} HTTP ${r.status}`);
  }
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
}

// --- embeddings (semantic search) ---
// Anthropic has no embeddings API, and neither does GLM (Z.ai's international
// platform doesn't offer one), so only OpenAI and Gemini qualify. Each
// model's native dimension count is kept as-is; comparability
// is guaranteed by only ever searching vectors from the current model.
export const EMBED_PROVIDERS = ["openai", "gemini"];
export const PROVIDER_EMBED_MODELS = {
  openai: ["text-embedding-3-small", "text-embedding-3-large"],
  gemini: ["gemini-embedding-001"],
};
export const PROVIDER_DEFAULT_EMBED_MODEL = {
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-001",
};

// Embed a batch of texts. Returns { vectors: Float32Array[], usage } with
// every vector L2-normalized, so similarity is a plain dot product.
export async function embedTexts({ provider, apiKey, model, texts }) {
  const { base, label } = COMPAT[provider];
  const r = await fetch(`${base}/embeddings`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || `${label} HTTP ${r.status}`);
  }
  const data = await r.json();
  const rows = (data.data || []).slice().sort((a, b) => a.index - b.index);
  if (rows.length !== texts.length) throw new Error(`${label} returned ${rows.length} embeddings for ${texts.length} inputs`);
  const vectors = rows.map((d) => {
    const v = Float32Array.from(d.embedding);
    let norm = 0;
    for (const x of v) norm += x * x;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= norm;
    return v;
  });
  return { vectors, usage: { input: data.usage?.prompt_tokens || 0, output: 0, cacheRead: 0 } };
}

// Cheap key/model validation for the admin "Test" buttons. Throws with the
// provider's error message on failure.
export async function testKey({ provider, apiKey, model }) {
  if (provider === "glm") {
    // Z.ai has no models endpoint; the cheapest real probe is a one-token
    // completion on the configured model — it validates key, model id, and
    // account balance in one shot, with a readable message for each ("Unknown
    // Model", "Insufficient balance… Please recharge", "Authentication Failed").
    const { base, label } = COMPAT.glm;
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model || PROVIDER_DEFAULT_MODEL.glm,
        max_tokens: 1,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error?.message || `${label} HTTP ${r.status}`);
    }
    return;
  }
  if (COMPAT[provider]) {
    const { base, label } = COMPAT[provider];
    const id = model || PROVIDER_DEFAULT_MODEL[provider];
    const r = await fetch(`${base}/models/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error?.message || `${label} HTTP ${r.status}`);
    }
    return;
  }
  await anthropicClient(apiKey).messages.countTokens({
    model: model || PROVIDER_DEFAULT_MODEL.anthropic,
    messages: [{ role: "user", content: "hi" }],
  });
}
