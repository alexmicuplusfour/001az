// Provider plumbing for the AI tagger: the tagging call itself and key
// validation, per provider. Prompt building, the queue, and tag validation
// are provider-agnostic and live in worker.js.
import Anthropic from "@anthropic-ai/sdk";

export const PROVIDERS = ["anthropic", "openai"];
export const PROVIDER_DEFAULT_MODEL = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-5-mini",
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
// each provider maps it to its own wire format here. Returns { input, usage }:
// the tool-call input object (facet key -> selection, plus "fit") and the
// token usage the provider reported, normalized to { input, output, cacheRead }
// — cache reads are kept out of `input` because they bill at a fraction of
// the input rate. Throws with a readable message on any failure.
export async function callTagger({ provider, apiKey, model, systemText, schema, parts }) {
  if (provider === "openai") return openaiTag({ apiKey, model, systemText, schema, parts });
  return anthropicTag({ apiKey, model, systemText, schema, parts });
}

async function anthropicTag({ apiKey, model, systemText, schema, parts }) {
  const content = parts.map((p) =>
    p.kind === "image"
      ? { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.b64 } }
      : { type: "text", text: p.text }
  );
  const msg = await anthropicClient(apiKey).messages.create({
    model,
    max_tokens: 2048,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    tools: [{ name: TOOL_NAME, description: TOOL_DESC, strict: true, input_schema: schema }],
    tool_choice: { type: "tool", name: TOOL_NAME },
    messages: [{ role: "user", content }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block) throw new Error("no tool_use block in response");
  const u = msg.usage || {};
  return {
    input: block.input,
    usage: {
      // cache writes bill as (slightly dearer) input, so fold them in
      input: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
    },
  };
}

// OpenAI via plain fetch — one endpoint, not worth a dependency. Chat
// completions with a forced function call mirrors the Anthropic tool shape;
// the same strict JSON schema works for both.
async function openaiTag({ apiKey, model, systemText, schema, parts }) {
  const content = parts.map((p) =>
    p.kind === "image"
      ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.b64}` } }
      : { type: "text", text: p.text }
  );
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemText },
        { role: "user", content },
      ],
      tools: [{ type: "function", function: { name: TOOL_NAME, description: TOOL_DESC, parameters: schema, strict: true } }],
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    }),
  });
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error?.message || `OpenAI HTTP ${r.status}`);
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

// Cheap key/model validation for the admin "Test" buttons. Throws with the
// provider's error message on failure.
export async function testKey({ provider, apiKey, model }) {
  if (provider === "openai") {
    const id = model || PROVIDER_DEFAULT_MODEL.openai;
    const r = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(id)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error?.message || `OpenAI HTTP ${r.status}`);
    }
    return;
  }
  await anthropicClient(apiKey).messages.countTokens({
    model: model || PROVIDER_DEFAULT_MODEL.anthropic,
    messages: [{ role: "user", content: "hi" }],
  });
}
