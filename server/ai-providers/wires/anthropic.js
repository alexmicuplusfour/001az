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
import { DEFAULT_TOOL } from "./tool.js";

// Per-item bound on web searches; each one bills on top of tokens.
const MAX_SEARCHES = 5;

// Cached Anthropic clients, keyed by API key — multiple keys can be active at
// once (per-board overrides), and the registry holds at most a handful.
const anthropicClients = new Map();
function anthropicClient(apiKey) {
  if (!anthropicClients.has(apiKey)) anthropicClients.set(apiKey, new Anthropic({ apiKey }));
  return anthropicClients.get(apiKey);
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

export const anthropicWire = {
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
