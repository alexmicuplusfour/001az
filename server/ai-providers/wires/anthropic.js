// The Anthropic wire family: Claude via the official SDK — tool_use blocks,
// prompt caching on the system text, server-side web_search for research
// tagging, pause_turn continuation. Everything Anthropic-specific lives HERE;
// the engine (providers.js) only composes this into WIRES and dispatches
// through descriptor.wire, never naming a vendor. anthropicRequest is exported
// as the pure request-builder test seam.
//
// No outbound-deadline plumbing here (unlike the compat wire): the SDK defaults
// to a 10-min per-try timeout, and research tagging legitimately runs minutes.
import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_TOOL, outputBudget, clippedError } from "./tool.js";

// Per-item bound on web searches; each one bills on top of tokens.
const MAX_SEARCHES = 5;

// Cached Anthropic clients, keyed by endpoint + API key — multiple keys can be
// active at once (per-board overrides), and the registry holds at most a
// handful. `base` is the descriptor's optional endpoint override: like the
// compat wire's desc.base, it lets any Messages-API-speaking backend (a proxy,
// a gateway) ride this wire as its own descriptor. Absent, the SDK's default
// endpoint applies (env-overridable via ANTHROPIC_BASE_URL) — so the built-in
// anthropic descriptor deliberately declares none.
const anthropicClients = new Map();
function anthropicClient(apiKey, base) {
  const key = `${base || ""}\0${apiKey}`;
  if (!anthropicClients.has(key))
    anthropicClients.set(key, new Anthropic({ apiKey, ...(base ? { baseURL: base } : {}) }));
  return anthropicClients.get(key);
}

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
    // sized to the schema (a floor when small); research raises the floor —
    // searching + digesting results eats output budget
    max_tokens: outputBudget(schema, research),
    // Closed-vocabulary classification wants the mode, not a sample — see the
    // measurement in compatRequest. Unconditional here: every Claude model
    // accepts it, and the app never enables extended thinking (which is the one
    // mode that forbids a non-default temperature). Live-probed 2026-08-06 on
    // claude-sonnet-4-6.
    temperature: 0,
    system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
    tools: research
      ? [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }, toolDef]
      : [toolDef],
    tool_choice: research ? { type: "auto" } : { type: "tool", name: tool.name },
    messages: [{ role: "user", content }],
  };
}

export const anthropicWire = {
  async tag(desc, { apiKey, model, systemText, schema, parts, research = false, tool = DEFAULT_TOOL }) {
    const request = anthropicRequest({ model, systemText, schema, parts, research, tool });
    let msg = await anthropicClient(apiKey, desc.base).messages.create(request);
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
      msg = await anthropicClient(apiKey, desc.base).messages.create(request);
      addUsage(msg.usage);
    }
    // After the pause_turn loop, so a continued-then-clipped turn is caught
    // too. Without this, a clipped turn reads as "model did not call X".
    if (msg.stop_reason === "max_tokens") throw clippedError(request.max_tokens);
    const block = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
    if (!block) throw new Error(`model did not call ${tool.name}`);
    return { input: block.input, usage };
  },

  async testKey(desc, { apiKey, model, base }) {
    // Same 30 s bound as the compat keyTest — interactive admin button; the
    // SDK's 10-min default is for the tagging path, not for a click. Like the
    // compat wire, the connection's own base (a gateway plugin's needsBase row)
    // outranks the descriptor default.
    await anthropicClient(apiKey, base || desc.base).messages.countTokens({
      model: model || desc.defaultModel,
      messages: [{ role: "user", content: "hi" }],
    }, { timeout: 30000 });
  },

  // List the models this key can use right now, via the SDK's paginated
  // models.list. display_name rides along as the picker note — this is the one
  // listing endpoint that returns a human label.
  async listModels(desc, { apiKey, base }) {
    const out = [];
    const pages = anthropicClient(apiKey, base || desc.base).models.list({ limit: 100 }, { timeout: 30000 });
    for await (const m of pages) out.push({ id: m.id, note: m.display_name });
    return out;
  },

  embed: null, // Anthropic has no embeddings API
};
