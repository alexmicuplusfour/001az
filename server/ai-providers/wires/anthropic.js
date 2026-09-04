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
import { DEFAULT_TOOL, OUTPUT_BUDGET, clippedError, wholeCall } from "./tool.js";
import { askFor, refusedFeature, refusalKey, learnRefusal } from "./refusals.js";

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
// `temperature` follows compat's convention (the value to send, undefined
// omits the field) and `strict` is the tool-def flag by the same rule: the
// WIRE decides per model/schema — no id list in the builder, because no
// static list stays right (the compat wire learned that on gpt-5-mini, this
// wire on fable-5.1; provenance in refusals.js).
export function anthropicRequest({ model, systemText, schema, parts, research = false, tool = DEFAULT_TOOL, temperature, strict = true }) {
  const content = parts.map((p) => {
    if (p.kind === "image") return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.b64 } };
    if (p.kind === "document") return { type: "document", source: { type: "base64", media_type: p.mediaType, data: p.b64 } };
    return { type: "text", text: p.text };
  });
  const toolDef = { name: tool.name, description: tool.description, ...(strict ? { strict: true } : {}), input_schema: schema };
  return {
    model,
    // A runaway guard, not a size estimate — see OUTPUT_BUDGET. Flat across
    // research too: searching and digesting results eats output, and the old
    // research floor was the same guess one rung higher.
    max_tokens: OUTPUT_BUDGET,
    // Closed-vocabulary classification wants the mode, not a sample — see the
    // measurement in compatRequest. Unconditional 0 until 2026-09-03, when
    // fable-5.1 refused the field and failed a whole board first-attempt;
    // provenance and the shared recovery vocabulary live in refusals.js.
    ...(temperature !== undefined ? { temperature } : {}),
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
    // The refusal negotiation (see refusals.js): ask for everything not yet
    // refused; when the model 400s naming a feature this request carried,
    // drop it, re-send, remember. Each refusal costs one unbilled round trip
    // per learned key per process — cheaper than any attempt to know the
    // catalog in advance. The loop is bounded by the feature count: every
    // pass turns one sent flag off, and refusedFeature only matches sent
    // ones, so an unrelated (or repeat) 400 throws.
    const client = anthropicClient(apiKey, desc.base);
    const endpoint = desc.base || "";
    let sent = askFor(endpoint, model, { schema });
    const build = () => anthropicRequest({ model, systemText, schema, parts, research, tool, temperature: sent.temperature ? 0 : undefined, strict: sent.strict });
    let request = build();
    let msg;
    for (;;) {
      try {
        msg = await client.messages.create(request);
        break;
      } catch (e) {
        const feature = refusedFeature(e, sent);
        if (!feature) throw e;
        learnRefusal(feature, refusalKey(feature, endpoint, model, { schema }), desc.label, model);
        sent = { ...sent, [feature]: false };
        request = build();
      }
    }
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
      msg = await client.messages.create(request);
      addUsage(msg.usage);
    }
    const block = msg.content.find((b) => b.type === "tool_use" && b.name === tool.name);
    // Checked after the pause_turn loop, so a continued-then-clipped turn is
    // caught too — but only when the clip actually cost us the answer: a turn
    // can stop at max_tokens with the tool call already whole, and failing
    // that item would discard a usable result (why wholeness is the required
    // keys lives on wholeCall in tool.js).
    if (!wholeCall(block?.input, schema) && msg.stop_reason === "max_tokens") throw clippedError(request.max_tokens);
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

  listPrices: null, // models.list carries no pricing — the descriptor + community rungs answer instead

  embed: null, // Anthropic has no embeddings API
};
