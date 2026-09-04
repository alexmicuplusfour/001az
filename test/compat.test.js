// OpenAI-compatible tagger request shape (compatRequest). The three providers
// share one code path but GLM (Z.ai) diverges in three live-verified ways, so
// these pin both the common shape and each GLM quirk against the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../server/providers.js";
import { compatRequest as buildRequest } from "../server/ai-providers/wires/compat.js";
import { OUTPUT_BUDGET } from "../server/ai-providers/wires/tool.js";
import { refused, refusedFeature } from "../server/ai-providers/wires/refusals.js";
import { withFetch, recorder } from "./helpers.js";

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
// it — the o-series and the gpt-5 base family both 400 ("Unsupported value:
// 'temperature' does not support 0 with this model"), and both pass OpenAI's
// tagging modelFilter, so an unguarded send costs a round trip on every item.
test("temperature: 0 rides the quirk block, and the refusing families are exempt", () => {
  for (const [provider, model] of [["openai", "gpt-5.4-mini"], ["openai", "gpt-5.1"], ["gemini", "gemini-3.5-flash"]]) {
    const r = compatRequest({ provider, model, systemText: "s", schema, parts });
    assert.equal(r.temperature, 0, `${provider}/${model} should send temperature 0`);
  }
  // The guard must drop the field entirely, not send a different value.
  // gpt-5-mini is the id that broke a live board (2026-08-09) — and it is this
  // descriptor's own defaultModel, so an unguarded send is the DEFAULT path.
  for (const model of ["o3", "o4-mini", "gpt-5", "gpt-5-mini", "gpt-5-nano", "gpt-5-chat-latest", "gpt-5-2025-08-07"]) {
    const r = compatRequest({ provider: "openai", model, systemText: "s", schema, parts });
    assert.equal(r.temperature, undefined, `${model} must not carry a temperature`);
    assert.ok(!("temperature" in r), `${model} must omit the key, not send undefined`);
  }
  // Anchored and hyphen-delimited: a model that merely CONTAINS an o-digit still
  // gets it, and the dot-versioned gpt-5 successors (which accept 0) are not
  // swept up by the base-family guard.
  for (const model of ["gpt-4o-2024", "gpt-5.1", "gpt-5.4-mini", "gpt-51"]) {
    assert.equal(compatRequest({ provider: "openai", model, systemText: "s", schema, parts }).temperature, 0,
      `${model} should still send temperature 0`);
  }
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

// ─── temperature refusal: recovered at call time, never fatal ────────────────
// The descriptor's noTemperature regex saves the doomed first call for families
// we already know about, but OpenAI's tagging model comes from a LIVE /models
// list — any id can turn up. When gpt-5-mini started refusing the parameter it
// 400'd, and a 400 is permanent-shaped: failOrRequeue failed every item on its
// FIRST attempt. The wire must drop the field and re-send instead.

// The exact body OpenAI returns (verified against the upstream bug reports):
// HTTP 400, param names the field, code says why.
const tempRefusal = () => new Response(JSON.stringify({
  error: {
    message: "Unsupported value: 'temperature' does not support 0.0 with this model. Only the default (1) value is supported.",
    type: "invalid_request_error", param: "temperature", code: "unsupported_value",
  },
}), { status: 400 });
const tagOk = () => new Response(JSON.stringify({
  choices: [{ message: { tool_calls: [{ function: { name: "record_tags", arguments: '{"kind":["a"]}' } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
}), { status: 200 });

test("compat wire: a refused temperature is dropped and re-sent, not failed", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  // gpt-5.4-mini passes the noTemperature regex, so the first call really does
  // carry temperature 0 — this is the unknown-id path the regex can't cover.
  const { fetch, bodies } = recorder((n) => (n === 1 ? tempRefusal() : tagOk()));
  const result = await withFetch(fetch, () =>
    compatWire.tag(PROVIDERS.openai, { ...tagOpts({ name: "record_tags", description: "d" }), model: "gpt-5.4-mini" }));
  // The item is tagged — the whole point. Failing here killed real boards.
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0);
  assert.ok(!("temperature" in bodies[1]), "the retry must omit the field, not send another value");
  // Everything else about the request is unchanged by the retry
  assert.equal(bodies[1].model, "gpt-5.4-mini");
  assert.equal(bodies[1].tool_choice, "required");
  assert.deepEqual(bodies[1].messages, bodies[0].messages);
  refused.clear();
});

test("compat wire: the refusal is learned, so only the first item pays for it", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const { fetch, bodies } = recorder((_n, body) => ("temperature" in body ? tempRefusal() : tagOk()));
  const tag = () => compatWire.tag(PROVIDERS.openai, { ...tagOpts({ name: "record_tags", description: "d" }), model: "gpt-5.4-mini" });
  await withFetch(fetch, async () => { await tag(); await tag(); await tag(); });
  // 2 calls for the first item (discovery), then 1 each — not 2 forever.
  assert.equal(bodies.length, 4);
  assert.ok(bodies.slice(1).every((b) => !("temperature" in b)), "later items must omit the field up front");
  refused.clear();
});

test("compat wire: an unrelated 400 still fails, and fails once", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const { fetch, bodies } = recorder(() => new Response(JSON.stringify({
    error: { message: "Invalid API key provided", code: "invalid_api_key" },
  }), { status: 401 }));
  await withFetch(fetch, () => assert.rejects(
    compatWire.tag(PROVIDERS.openai, { ...tagOpts({ name: "record_tags", description: "d" }), model: "gpt-5.4-mini" }),
    (e) => /Invalid API key/.test(e.message) && e.status === 401
  ));
  assert.equal(bodies.length, 1, "a non-temperature failure must not be re-paid");
  refused.clear();
});

// The loop guard: if we sent no temperature (the regex already exempted the
// model) a 400 that happens to mention the word is somebody else's fault, and
// re-sending the identical request would just buy the same rejection twice.
test("compat wire: no retry when the request carried no temperature", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const { fetch, bodies } = recorder(() => tempRefusal());
  await withFetch(fetch, () => assert.rejects(
    compatWire.tag(PROVIDERS.openai, { ...tagOpts({ name: "record_tags", description: "d" }), model: "gpt-5-mini" }),
    (e) => e.status === 400
  ));
  assert.ok(!("temperature" in bodies[0]), "gpt-5-mini is exempt by regex — nothing to drop");
  assert.equal(bodies.length, 1);
  refused.clear();
});

// Vendors other than OpenAI have no structured `param`, only prose — the
// recovery must read either. (Any compat plugin can hit this.)
test("compat wire: a prose-only refusal is recognised too", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const proseOnly = () => new Response(JSON.stringify({
    error: { message: "temperature is not supported for this model" },
  }), { status: 400 });
  const { fetch, bodies } = recorder((n) => (n === 1 ? proseOnly() : tagOk()));
  const result = await withFetch(fetch, () =>
    compatWire.tag(PROVIDERS.gemini, { ...tagOpts({ name: "record_tags", description: "d" }), model: "gemini-3.5-flash" }));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  refused.clear();
});

// ─── the Anthropic twin ──────────────────────────────────────────────────────
// Anthropic deprecated non-default sampling from Opus 4.7 onward, and this
// wire used to send temperature 0 unconditionally — on 2026-09-03 a fable-5.1
// tagging board failed every item first-attempt on it (400 is permanent-
// shaped). Same recovery as compat, exercised through the real SDK against
// the stubbed fetch; the refusal body is Anthropic's real error shape.
const anthropicRefusal = () => new Response(JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." },
  request_id: "req_test",
}), { status: 400, headers: { "content-type": "application/json" } });
const anthropicTagOk = () => new Response(JSON.stringify({
  id: "msg_1", type: "message", role: "assistant", model: "claude-fable-5-1",
  content: [{ type: "tool_use", id: "tu_1", name: "record_tags", input: { kind: ["a"] } }],
  stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 },
}), { status: 200, headers: { "content-type": "application/json" } });

test("anthropic wire: a refused temperature is dropped, re-sent and learned", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  refused.clear();
  const { fetch, bodies } = recorder((_n, body) => ("temperature" in body ? anthropicRefusal() : anthropicTagOk()));
  // A key this test alone uses: the wire caches SDK clients per (base, key)
  // and the SDK captures globalThis.fetch at CONSTRUCTION — a fresh key means
  // the client is built inside withFetch and holds the stub.
  const opts = { ...tagOpts({ name: "record_tags", description: "d" }), apiKey: "k-anthropic-temp-recovery", model: "claude-fable-5-1" };
  const result = await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, opts));
  // The item is tagged — the whole point. Failing here killed a real board.
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0);
  assert.ok(!("temperature" in bodies[1]), "the retry must omit the field, not send another value");
  assert.deepEqual(bodies[1].messages, bodies[0].messages);
  // …and the refusal is learned: the next item omits the field up front
  await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, opts));
  assert.equal(bodies.length, 3);
  assert.ok(!("temperature" in bodies[2]), "later items must omit the field up front");
  refused.clear();
});

test("anthropic wire: an unrelated 400 still fails, and fails once", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  refused.clear();
  const { fetch, bodies } = recorder(() => new Response(JSON.stringify({
    type: "error",
    error: { type: "invalid_request_error", message: "max_tokens: field required" },
  }), { status: 400, headers: { "content-type": "application/json" } }));
  const opts = { ...tagOpts({ name: "record_tags", description: "d" }), apiKey: "k-anthropic-unrelated-400", model: "claude-fable-5-1" };
  await withFetch(fetch, () => assert.rejects(
    anthropicWire.tag(PROVIDERS.anthropic, opts),
    (e) => Number(e.status) === 400 && /max_tokens/.test(e.message)
  ));
  assert.equal(bodies.length, 1, "a non-temperature failure must not be re-paid");
  refused.clear();
});

// The SECOND refusable parameter, hours after the first (fable-5.1,
// 2026-09-03): a facet-heavy board's schema compiles to a grammar the server
// deems too large, and strict: true 400s. Safe to drop — parseRun filters
// answers against the vocabulary downstream (it always did, for the
// strictTools:false providers).
const grammarRefusal = () => new Response(JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." },
  request_id: "req_test",
}), { status: 400, headers: { "content-type": "application/json" } });

test("anthropic wire: a too-large grammar drops strict — learned per SCHEMA, not per model", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  refused.clear();
  const { fetch, bodies } = recorder((_n, body) => (body.tools[0].strict ? grammarRefusal() : anthropicTagOk()));
  const opts = { ...tagOpts({ name: "record_tags", description: "d" }), apiKey: "k-anthropic-strict-recovery", model: "claude-fable-5-1" };
  const result = await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, opts));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools[0].strict, true);
  assert.ok(!("strict" in bodies[1].tools[0]), "the retry must omit the flag entirely");
  assert.equal(bodies[1].temperature, 0, "dropping strict must not also drop temperature");
  // Learned, so the next item on the SAME board skips the doomed call…
  await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, opts));
  assert.equal(bodies.length, 3);
  assert.ok(!("strict" in bodies[2].tools[0]));
  // …but the grammar is a property of the schema, not the model: a leaner
  // board on the very same model still asks for strict (and pays its own
  // discovery when the stub refuses again).
  const leaner = { ...opts, schema: { type: "object", properties: {}, required: [] } };
  await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, leaner));
  assert.equal(bodies.length, 5, "a different schema pays its own discovery round trip");
  assert.equal(bodies[3].tools[0].strict, true, "the leaner schema must still ask for strict");
  assert.ok(!("strict" in bodies[4].tools[0]));
  refused.clear();
});

test("compat wire: the grammar refusal drops strict for compat providers too", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const compatGrammar = () => new Response(JSON.stringify({
    error: { message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." },
  }), { status: 400 });
  const { fetch, bodies } = recorder((_n, body) => (body.tools[0].function.strict ? compatGrammar() : tagOk()));
  const result = await withFetch(fetch, () =>
    compatWire.tag(PROVIDERS.gemini, { ...tagOpts({ name: "record_tags", description: "d" }), model: "gemini-3.5-flash" }));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].tools[0].function.strict, true);
  assert.ok(!("strict" in bodies[1].tools[0].function), "the retry must omit the flag entirely");
  assert.equal(bodies[1].temperature, 0, "strict alone is dropped, temperature rides on");
  refused.clear();
});

// The shared vocabulary, pinned pure: rejection verbs against a SENT feature,
// not mere mention. Each vendor phrases each refusal its own way (OpenAI:
// structured param + prose "Unsupported value"; Anthropic since 5.1:
// "deprecated" for temperature, "compiled grammar is too large … strict
// tools" for strict) — and a 400 that merely quotes a word, a non-400, or a
// refusal of a feature the request never carried, all stay fatal.
test("refusal vocabulary: rejection verbs against a sent feature, not mere mention", () => {
  const sentBoth = { temperature: true, strict: true };
  const f = (e, sent = sentBoth) => refusedFeature(e, sent);
  assert.equal(f({ status: 400, message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}' }), "temperature");
  assert.equal(f({ status: 400, param: "temperature" }), "temperature");
  assert.equal(f({ status: 400, message: "temperature is not supported for this model" }), "temperature");
  assert.equal(f({ status: 400, message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." }), "strict");
  assert.equal(f({ status: 400, message: "schema property `temperature` must be a number" }), null);
  assert.equal(f({ status: 401, message: "temperature is not supported" }), null);
  // a word that merely CONTAINS "strict" is not the strict refusal
  assert.equal(f({ status: 400, message: "access to restricted tool denied" }), null);
  // refusing what we never sent is somebody else's fault — must surface
  assert.equal(f({ status: 400, param: "temperature" }, { temperature: false, strict: true }), null);
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
