// OpenAI-compatible tagger request shape (compatRequest). The three providers
// share one code path but GLM (Z.ai) diverges in three live-verified ways, so
// these pin both the common shape and each GLM quirk against the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../server/providers.js";
import { compatRequest as buildRequest } from "../server/ai-providers/wires/compat.js";
import { OUTPUT_BUDGET } from "../server/ai-providers/wires/tool.js";

// compatRequest takes the descriptor's `compat` quirk block, not a provider
// name — the wire never reaches into the registry. These tests still pin the
// shape per BUILT-IN, so resolve each named provider's block through PROVIDERS.
const compatRequest = ({ provider, ...rest }) =>
  buildRequest({ compat: PROVIDERS[provider].compat, ...rest });

const schema = { type: "object", properties: { kind: { type: "array" } }, required: ["kind"] };
const parts = [
  { kind: "image", mediaType: "image/webp", b64: "QQ==" },
  { kind: "text", text: "Tag this image using the record_tags tool." },
];

test("common shape: image → data URL, forced record_tags, strict schema", () => {
  for (const provider of ["openai", "gemini"]) {
    const r = compatRequest({ provider, model: "m", systemText: "s", schema, parts });
    assert.equal(r.messages[0].role, "system");
    assert.deepEqual(r.messages[1].content[0], {
      type: "image_url",
      image_url: { url: "data:image/webp;base64,QQ==" },
    });
    assert.equal(r.tools[0].function.strict, true);
  }
  // Gemini still forces by NAME; OpenAI moved to "required" (2026-07-29: the
  // gpt-5 family flags the named force as invalid_prompt — one tool defined,
  // so the guarantee is the same).
  assert.deepEqual(compatRequest({ provider: "gemini", model: "m", systemText: "s", schema, parts }).tool_choice,
    { type: "function", function: { name: "record_tags" } });
  assert.equal(compatRequest({ provider: "openai", model: "m", systemText: "s", schema, parts }).tool_choice, "required");
});

test("max-tokens cap: only OpenAI takes the new field name", () => {
  const openai = compatRequest({ provider: "openai", model: "m", systemText: "s", schema, parts });
  assert.equal(openai.max_completion_tokens, OUTPUT_BUDGET);
  assert.equal(openai.max_tokens, undefined);
  for (const provider of ["gemini", "glm"]) {
    const r = compatRequest({ provider, model: "m", systemText: "s", schema, parts });
    assert.equal(r.max_tokens, OUTPUT_BUDGET);
    assert.equal(r.max_completion_tokens, undefined);
  }
});

// The cap is a runaway guard, not a size estimate. It was sized per-schema
// until 2026-08-07, when measuring gemini-3.5-flash showed the visible answer
// (~300 tokens) is the smaller half of the spend and hidden thinking
// (780-1,920) the larger — so schema size predicts the wrong quantity, and a
// board of 5 facets clipped as readily as a board of 40.
test("output budget is flat: schema size does not move it", () => {
  const bigSchema = (n) => ({
    type: "object",
    properties: Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, { type: "object" }])),
    required: [],
  });
  for (const n of [1, 40, 100]) {
    const r = compatRequest({ provider: "openai", model: "m", systemText: "s", schema: bigSchema(n), parts });
    assert.equal(r.max_completion_tokens, OUTPUT_BUDGET, `${n} properties must not resize the cap`);
  }
});

test("GLM quirks: auto tool_choice, no strict, thinking disabled, legacy max_tokens", () => {
  const r = compatRequest({ provider: "glm", model: "glm-4.6v", systemText: "s", schema, parts });
  // docs allow only "auto"; the user-turn instruction + missing-call throw force it
  assert.equal(r.tool_choice, "auto");
  // strict isn't in GLM's function schema — omit it rather than risk a 400
  assert.equal(r.tools[0].function.strict, undefined);
  assert.equal(r.tools[0].function.name, "record_tags");
  // thinking defaults ON at Z.ai; off keeps output tokens on the tool call
  assert.deepEqual(r.thinking, { type: "disabled" });
  assert.equal(r.max_tokens, OUTPUT_BUDGET);
  // non-GLM providers never carry a thinking field
  const gem = compatRequest({ provider: "gemini", model: "m", systemText: "s", schema, parts });
  assert.equal(gem.thinking, undefined);
});

// Tagging is closed-vocabulary classification — sampling at the API default
// (1.0) re-judged 22.4% of facet answers on an identical rerun vs 18.3% at 0
// (measured 2026-08-06, gpt-5.4-mini). The parameter rides the `compat` quirk
// block, NOT a provider name, and `noTemperature` exempts families that reject
// it — o-series 400s ("Unsupported value: 'temperature' does not support 0
// with this model") and o-ids pass OpenAI's tagging modelFilter, so an
// unguarded send would permanently fail every item on such a board.
test("temperature: 0 rides the quirk block, and the o-series guard exempts it", () => {
  for (const [provider, model] of [["openai", "gpt-5.4-mini"], ["openai", "gpt-5.1"], ["gemini", "gemini-3.5-flash"]]) {
    const r = compatRequest({ provider, model, systemText: "s", schema, parts });
    assert.equal(r.temperature, 0, `${provider}/${model} should send temperature 0`);
  }
  // o-series: the guard must drop the field entirely, not send a different value
  for (const model of ["o3", "o4-mini"]) {
    const r = compatRequest({ provider: "openai", model, systemText: "s", schema, parts });
    assert.equal(r.temperature, undefined, `${model} must not carry a temperature`);
    assert.ok(!("temperature" in r), `${model} must omit the key, not send undefined`);
  }
  // The guard is anchored — a model that merely CONTAINS an o-digit still gets it
  assert.equal(compatRequest({ provider: "openai", model: "gpt-4o-2024", systemText: "s", schema, parts }).temperature, 0);
});

test("providers whose temperature support is unverified send none", () => {
  // GLM was unreachable in the probe pass (insufficient balance) and OpenRouter
  // fronts hundreds of backends off one descriptor — neither may guess.
  for (const provider of ["glm", "openrouter"]) {
    const r = compatRequest({ provider, model: "m", systemText: "s", schema, parts });
    assert.ok(!("temperature" in r), `${provider} must not send a temperature`);
  }
});

test("custom tool name flows into tools[] for every compat provider", () => {
  const tool = { name: "record_fields", description: "Record extracted fields." };
  for (const provider of ["openai", "gemini", "glm", "openrouter"]) {
    const r = compatRequest({ provider, model: "m", systemText: "s", schema, parts, tool });
    assert.equal(r.tools[0].function.name, "record_fields");
    // GLM stays auto; OpenAI demands some tool ("required"); the rest force
    // the named function
    if (provider === "glm") assert.equal(r.tool_choice, "auto");
    else if (provider === "openai") assert.equal(r.tool_choice, "required");
    else assert.deepEqual(r.tool_choice, { type: "function", function: { name: "record_fields" } });
  }
});

// ─── response parsing: the tool call is matched BY NAME ──────────────────────
// An un-forced model (GLM's tool_choice is auto-only) can invent a different
// function; accepting whatever came first would swallow tag-shaped args as
// extraction input — fields silently empty, logged ok. The wire must treat a
// wrong-name call exactly like a missing one: a retryable throw.

const chatResponse = (toolCalls) => async () =>
  new Response(JSON.stringify({
    choices: [{ message: { tool_calls: toolCalls } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200 });

async function withFetch(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

const tagOpts = (tool) => ({ apiKey: "k", model: "m", systemText: "s", schema, parts, tool });

test("compat wire: a call under the wrong tool name throws, not parses", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  await withFetch(
    chatResponse([{ function: { name: "record_tags", arguments: "{}" } }]),
    () => assert.rejects(
      compatWire.tag(PROVIDERS.glm, tagOpts({ name: "record_fields", description: "d" })),
      /model did not call record_fields/
    )
  );
});

test("compat wire: a length-clipped turn throws the cap error, not JSON garbage", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  // finish_reason "length" with arguments cut mid-JSON — the shape that used
  // to die inside JSON.parse with an unreadable error and 5 paid retries
  const clipped = async () => new Response(JSON.stringify({
    choices: [{ finish_reason: "length", message: { tool_calls: [{ function: { name: "record_tags", arguments: '{"kind": ["a' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 2048 },
  }), { status: 200 });
  await withFetch(clipped, () => assert.rejects(
    compatWire.tag(PROVIDERS.openai, tagOpts({ name: "record_tags", description: "d" })),
    (e) => /token cap/.test(e.message) && e.status === 422 // permanent-shaped: fail on attempt one, don't re-pay
  ));
});

// The other half of that check, and the one that cost real items: Gemini raises
// finish_reason "length" when its HIDDEN thinking overran the cap, even though
// it went on to write the whole tool call (measured 2026-08-07 — 1,807 thinking
// + 299 visible against 2,048, valid JSON, every key present). Reading the
// finish reason before the payload binned a complete answer and failed the item
// permanently, ~1 item in 6 on a 5-facet board.
test("compat wire: a complete tool call survives a length finish_reason", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  const clippedButWhole = async () => new Response(JSON.stringify({
    choices: [{
      finish_reason: "length",
      message: { tool_calls: [{ function: { name: "record_tags", arguments: JSON.stringify({ kind: ["a"] }) } }] },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 299 },
  }), { status: 200 });
  const result = await withFetch(clippedButWhole, () =>
    compatWire.tag(PROVIDERS.gemini, tagOpts({ name: "record_tags", description: "d" })));
  assert.deepEqual(result.input, { kind: ["a"] });
});

// Thinking bills as output, but Gemini reports it only inside total_tokens —
// completion_tokens counts the visible answer alone. Billing the recorded
// number under-counted Google's charge ~6x on the board that surfaced this.
test("compat wire: hidden thinking tokens are billed as output", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  const withThinking = async () => new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: "record_tags", arguments: '{"kind":["a"]}' } }] } }],
    // 299 visible + 1,807 unreported thinking, the measured shape
    usage: { prompt_tokens: 4428, completion_tokens: 299, total_tokens: 6534 },
  }), { status: 200 });
  const { usage } = await withFetch(withThinking, () =>
    compatWire.tag(PROVIDERS.gemini, tagOpts({ name: "record_tags", description: "d" })));
  assert.equal(usage.output, 2106);
  assert.equal(usage.input, 4428);
  // OpenAI folds reasoning into completion_tokens already — the total agrees
  // there, so the same arithmetic must leave it untouched
  const openaiShaped = async () => new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: "record_tags", arguments: '{"kind":["a"]}' } }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  }), { status: 200 });
  const plain = await withFetch(openaiShaped, () =>
    compatWire.tag(PROVIDERS.openai, tagOpts({ name: "record_tags", description: "d" })));
  assert.equal(plain.usage.output, 50);
});

test("compat wire: the right-name call is found past an invented one", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  const result = await withFetch(
    chatResponse([
      { function: { name: "web_search", arguments: "{}" } },
      { function: { name: "record_tags", arguments: JSON.stringify({ kind: ["a"] }) } },
    ]),
    () => compatWire.tag(PROVIDERS.openai, tagOpts({ name: "record_tags", description: "d" }))
  );
  assert.deepEqual(result.input, { kind: ["a"] });
});
