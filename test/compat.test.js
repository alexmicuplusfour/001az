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
  // gpt-5-mini is the id that broke a live board (2026-08-09) — and it was this
  // descriptor's own defaultModel then, so an unguarded send was the DEFAULT path.
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

// The third: Opus 5.5, Sonnet 5.5 and Fable 5.1 refuse forced tool choice
// on every call (Anthropic's errors page; the body all three returned live,
// 2026-09-29). The research path already asked without forcing; the plain
// path must learn to.
const forceRefusal = () => new Response(JSON.stringify({
  type: "error",
  error: { type: "invalid_request_error", message: 'tool_choice: type "tool" and "any" are not supported for this model.' },
  request_id: "req_test",
}), { status: 400, headers: { "content-type": "application/json" } });

test("anthropic wire: a refused forced tool choice re-asks without forcing — learned per model", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  refused.clear();
  const { fetch, bodies } = recorder((_n, body) =>
    (body.tool_choice.type === "tool" && body.model === "claude-opus-5-5" ? forceRefusal() : anthropicTagOk()));
  const opts = { ...tagOpts({ name: "record_tags", description: "d" }), apiKey: "k-anthropic-force-recovery", model: "claude-opus-5-5" };
  const result = await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, opts));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].tool_choice, { type: "tool", name: "record_tags" });
  assert.deepEqual(bodies[1].tool_choice, { type: "auto" });
  assert.equal(bodies[1].temperature, 0, "dropping the force must not also drop temperature");
  assert.equal(bodies[1].tools[0].strict, true, "…or strict");
  // Learned, so the next item asks without forcing up front…
  await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, opts));
  assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[2].tool_choice, { type: "auto" });
  // …but only for that model: one that takes forcing keeps it.
  await withFetch(fetch, () => anthropicWire.tag(PROVIDERS.anthropic, { ...opts, model: "claude-haiku-4-5" }));
  assert.equal(bodies.length, 4);
  assert.deepEqual(bodies[3].tool_choice, { type: "tool", name: "record_tags" });
  refused.clear();
});

// The ACCOUNT's problems, not the item's (the 2026-09-10 lesson): an empty
// balance, a spend limit the org set (both 400s, permanent-shaped) and the
// tier's monthly cap (a 429 the queue would retry until the items failed)
// all wait on the no-attempt lane, paced at 5 minutes. Bodies as Anthropic's
// rate-limits docs give them; x-should-retry keeps the SDK's own 429 retries
// out of a test of the wire's mapping.
test("anthropic wire: credit and spend-limit refusals wait on the account, never fail items", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  const error = (type, message, details) => JSON.stringify({ type: "error", error: { type, message, ...(details ? { details } : {}) }, request_id: "req_test" });
  const cases = [
    [400, error("invalid_request_error", "Your credit balance is too low to access the Anthropic API.")],
    [400, error("invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.")],
    [400, error("invalid_request_error", "You have reached your specified workspace API usage limits. You will regain access on 2026-10-01 at 00:00 UTC.")],
    [429, error("rate_limit_error", "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.", { error_code: "enforced_spend_limit_reached" })],
  ];
  for (const [i, [status, body]] of cases.entries()) {
    const fetch = async () => new Response(body, { status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
    const opts = { ...tagOpts({ name: "record_tags", description: "d" }), apiKey: `k-anthropic-account-${i}`, model: "claude-haiku-4-5" };
    await withFetch(fetch, () => assert.rejects(anthropicWire.tag(PROVIDERS.anthropic, opts),
      (e) => e.noCount === true && e.retryAfter === 300 && Number(e.status) === status));
  }
  // An ordinary rate limit is still an ordinary rate limit.
  const limited = async () => new Response(error("rate_limit_error", "Number of request tokens has exceeded your per-minute rate limit"),
    { status: 429, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  await withFetch(limited, () => assert.rejects(
    anthropicWire.tag(PROVIDERS.anthropic, { ...tagOpts({ name: "record_tags", description: "d" }), apiKey: "k-anthropic-account-rl", model: "claude-haiku-4-5" }),
    (e) => Number(e.status) === 429 && !e.noCount));
});

// What leaves the Anthropic wire says what the provider said, as every other
// wire's error does (tool.js providerError). The SDK's message is the status and
// the whole JSON body, which a failed row, the card's last error and a refused
// PDF's job row would show, and the engine reads the message alone (worker.js
// refusedFile) — reading the SDK's body there would be one vendor's protocol in
// the engine. The account check still reads the body: its waits keep their marks.
test("anthropic wire: a failure leaves it in the provider's own words", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  const error = (type, message) => JSON.stringify({ type: "error", error: { type, message }, request_id: "req_test" });
  const json = (status, body) => new Response(body, { status, headers: { "content-type": "application/json", "x-should-retry": "false" } });
  const opts = (i) => ({ ...tagOpts({ name: "record_tags", description: "d" }), apiKey: `k-anthropic-said-${i}`, model: "claude-haiku-4-5" });
  const TOO_LONG = "prompt is too long: 215000 tokens > 200000 maximum";
  await withFetch(async () => json(400, error("invalid_request_error", TOO_LONG)), () =>
    assert.rejects(anthropicWire.tag(PROVIDERS.anthropic, opts(1)), (e) => e.message === TOO_LONG && Number(e.status) === 400));
  const BROKE = "Your credit balance is too low to access the Anthropic API.";
  await withFetch(async () => json(400, error("invalid_request_error", BROKE)), () =>
    assert.rejects(anthropicWire.tag(PROVIDERS.anthropic, opts(2)), (e) => e.message === BROKE && e.noCount === true && e.retryAfter === 300));
  // The same on the way out of a paused research turn's continuation.
  let n = 0;
  const paused = { id: "msg_1", type: "message", role: "assistant", model: "m", content: [], stop_reason: "pause_turn", usage: { input_tokens: 1, output_tokens: 1 } };
  await withFetch(async () => (n++ === 0 ? json(200, JSON.stringify(paused)) : json(400, error("invalid_request_error", TOO_LONG))), () =>
    assert.rejects(anthropicWire.tag(PROVIDERS.anthropic, opts(3)), (e) => e.message === TOO_LONG && Number(e.status) === 400));
  assert.equal(n, 2, "the continuation was the call that failed");
});

test("compat wire: a refused force is dropped for compat providers too", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  // Claude behind a compat gateway, the refusal relayed the way OpenRouter
  // relays an upstream's: a generic message, the real one under metadata.raw.
  const relayed = () => new Response(JSON.stringify({
    error: { message: "Provider returned error", metadata: { raw: 'tool_choice: type "tool" and "any" are not supported for this model.' } },
  }), { status: 400 });
  const { fetch, bodies } = recorder((_n, body) => (body.tool_choice === "auto" ? tagOk() : relayed()));
  const result = await withFetch(fetch, () =>
    compatWire.tag(PROVIDERS.openrouter, { ...tagOpts({ name: "record_tags", description: "d" }), model: "anthropic/claude-opus-5-5" }));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].tool_choice, { type: "function", function: { name: "record_tags" } });
  assert.equal(bodies[1].tool_choice, "auto");
  refused.clear();
});

// OpenAI's gpt-5.6 and gpt-6 families reason at medium by default, and take
// function tools on Chat Completions only at reasoning_effort "none". The
// body is what gpt-5.6-sol returned live (2026-09-29).
const reasoningRefusal = () => new Response(JSON.stringify({
  error: {
    message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.",
    type: "invalid_request_error", param: "reasoning_effort", code: null,
  },
}), { status: 400 });

test("compat wire: tools refused while reasoning re-send at reasoning_effort none — learned per model", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const { fetch, bodies } = recorder((_n, body) =>
    (body.model === "gpt-5.6-sol" && body.reasoning_effort !== "none" ? reasoningRefusal() : tagOk()));
  const tag = (model) => compatWire.tag(PROVIDERS.openai, { ...tagOpts({ name: "record_tags", description: "d" }), model });
  const result = await withFetch(fetch, () => tag("gpt-5.6-sol"));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.equal(bodies.length, 2);
  assert.ok(!("reasoning_effort" in bodies[0]), "nothing is pinned up front — the gpt-5 base family 400s on none");
  assert.equal(bodies[1].reasoning_effort, "none");
  assert.equal(bodies[1].tool_choice, "required", "the tool is still demanded");
  assert.equal(bodies[1].temperature, 0, "temperature rides on");
  // Learned for that model, and only that model.
  await withFetch(fetch, async () => { await tag("gpt-5.6-sol"); await tag("gpt-5.4-mini"); });
  assert.equal(bodies.length, 4);
  assert.equal(bodies[2].reasoning_effort, "none");
  assert.ok(!("reasoning_effort" in bodies[3]));
  refused.clear();
});

test("compat wire: a pinned reasoningEffort is sent, and a refusal of it surfaces", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  refused.clear();
  const desc = { label: "Pinned", base: "http://box.invalid/v1", compat: { reasoningEffort: "low" } };
  const { fetch, bodies } = recorder(() => reasoningRefusal());
  await withFetch(fetch, () => assert.rejects(
    compatWire.tag(desc, tagOpts({ name: "record_tags", description: "d" })),
    (e) => e.status === 400 && /reasoning_effort/.test(e.message)
  ));
  // The descriptor's own choice is not overruled, and not re-paid.
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning_effort, "low");
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
  const sentAll = { temperature: true, strict: true, forceTool: true, reasoning: true };
  const f = (e, sent = sentAll) => refusedFeature(e, sent);
  assert.equal(f({ status: 400, message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"`temperature` is deprecated for this model."}}' }), "temperature");
  assert.equal(f({ status: 400, param: "temperature" }), "temperature");
  assert.equal(f({ status: 400, message: "temperature is not supported for this model" }), "temperature");
  assert.equal(f({ status: 400, message: "The compiled grammar is too large, which would cause performance issues. Simplify your tool schemas or reduce the number of strict tools." }), "strict");
  // the same limit as Anthropic's docs word it
  assert.equal(f({ status: 400, message: "Schema is too complex for compilation." }), "strict");
  // the 5.5 generation's refusal, as the SDK embeds the body in its message
  assert.equal(f({ status: 400, message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"tool_choice: type \\"tool\\" and \\"any\\" are not supported for this model."}}' }), "forceTool");
  // DeepSeek's wording of the same refusal (its plugin, verified 2026-08-08)
  assert.equal(f({ status: 400, message: "Thinking mode does not support this tool_choice" }), "forceTool");
  assert.equal(f({ status: 400, message: "Function tools with reasoning_effort are not supported for gpt-5.6-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'." }), "reasoning");
  assert.equal(f({ status: 400, message: "schema property `temperature` must be a number" }), null);
  assert.equal(f({ status: 401, message: "temperature is not supported" }), null);
  // a word that merely CONTAINS "strict" is not the strict refusal
  assert.equal(f({ status: 400, message: "access to restricted tool denied" }), null);
  // naming tool_choice, or reasoning_effort without tools, is not a refusal of either
  assert.equal(f({ status: 400, message: "tool_choice.name: Field required" }), null);
  assert.equal(f({ status: 400, message: "Unsupported value: 'reasoning_effort' does not support 'none' with this model." }), null);
  // refusing what we never sent is somebody else's fault — must surface
  assert.equal(f({ status: 400, param: "temperature" }, { ...sentAll, temperature: false }), null);
  assert.equal(f({ status: 400, message: 'tool_choice: type "tool" and "any" are not supported for this model.' }, { ...sentAll, forceTool: false }), null);
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

// A plugin may leave the quirk block out, or any key of it, and a key written
// as `undefined` or `null` is one left out, as a `null` is absent everywhere
// else a plugin writes one (plugin-contract-plan.md, Stage 5 and its second
// pass). Without the defaults a missing block threw on every tag, a missing
// maxTokensField sent a field literally named "undefined" (or "null", with
// `temperature: null`), and the key test asked for /models/<defaultModel> —
// which an embed-only plugin doesn't have.
test("compat wire: a quirk left out, undefined or null keeps its default", async () => {
  const { compatWire } = await import("../server/ai-providers/wires/compat.js");
  const blank = (v) => ({ maxTokensField: v, keyTest: v, temperature: v });
  for (const [what, compat] of [["no quirk block", undefined], ["undefined", blank(undefined)], ["null", blank(null)]]) {
    const desc = { label: "Blank", base: "http://box.invalid/v1", compat };
    const rec = recorder(tagOk);
    await withFetch(rec.fetch, () => compatWire.tag(desc, tagOpts()));
    assert.equal(rec.bodies[0].max_tokens, OUTPUT_BUDGET, `${what}: the default output-cap field`);
    assert.ok(!("undefined" in rec.bodies[0]) && !("null" in rec.bodies[0]), `${what}: no field named undefined or null`);
    assert.ok(!("temperature" in rec.bodies[0]), `${what}: no temperature sent`);
    assert.equal(rec.bodies[0].tool_choice, "auto", `${what}: an absent forceToolChoice leaves the call unforced`);

    const urls = [];
    await withFetch(async (url) => { urls.push(url); return new Response("{}", { status: 200 }); },
      () => compatWire.testKey(desc, { apiKey: "k" }));
    assert.deepEqual(urls, ["http://box.invalid/v1/models"], `${what}: the index, not /models/undefined`);
  }
});

// A connection that names its own server is where every call goes, tagging
// included (plugin-contract-plan.md, Stage 5 second pass). The anthropic wire's
// Test and model list read the connection's URL while tag() went to the
// descriptor's — or, with none, to Anthropic's own API — carrying that
// connection's key.
test("anthropic wire: tag() goes to the connection's own server", async () => {
  const { anthropicWire } = await import("../server/ai-providers/wires/anthropic.js");
  const urls = [];
  // A key this test alone uses: the SDK client is cached per (base, key) and
  // captures globalThis.fetch when it's built.
  const opts = {
    ...tagOpts({ name: "record_tags", description: "d" }),
    apiKey: "k-anthropic-connection-base", model: "claude-fable-5-1", base: "http://connection.invalid",
  };
  const gateway = { label: "Gateway", base: "http://descriptor.invalid" };
  const result = await withFetch(async (url) => { urls.push(String(url)); return anthropicTagOk(); },
    () => anthropicWire.tag(gateway, opts));
  assert.deepEqual(result.input, { kind: ["a"] });
  assert.ok(urls.length && urls.every((u) => u.startsWith("http://connection.invalid/")), urls.join(", "));
});

// Gemini's compat layer wraps an error's body in a list (seen live
// 2026-10-05: `[{"error":{"code":400,"message":…}}]`), which read as no error
// at all: "Gemini HTTP 400", and no refusal retry could match.
test("an error wrapped in a list reads in the provider's words, and a refusal retry still matches it", async () => {
  const gem = PROVIDERS.gemini;
  const listed = (message) => new Response(JSON.stringify([{ error: { code: 400, message, status: "INVALID_ARGUMENT" } }]), { status: 400 });
  const opts = { apiKey: "k", model: "gemini-list-probe", systemText: "s", schema, parts };
  await withFetch(async () => listed("Invalid content part type: file"), () =>
    assert.rejects(gem.wire.tag(gem, opts), (e) => {
      assert.equal(e.status, 400);
      assert.equal(e.message, "Invalid content part type: file");
      return true;
    }));
  // A temperature refusal is re-sent without it, as on every other provider.
  const ok = () => new Response(JSON.stringify({
    choices: [{ message: { tool_calls: [{ function: { name: "record_tags", arguments: JSON.stringify({ kind: [] }) } }] } }], usage: {},
  }), { status: 200 });
  const { fetch, bodies } = recorder((n) => (n === 1 ? listed("Unsupported value: temperature is not supported with this model.") : ok()));
  await withFetch(fetch, () => gem.wire.tag(gem, opts));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].temperature, 0);
  assert.equal("temperature" in bodies[1], false);
});

// A PDF file (planning/pdf-conversion-plan.md, Stage 5): OpenAI's `file` part,
// with the file's name, which OpenAI wants, and a `data:` URL, which it
// requires (bare base64 is refused). The steps send one only to a provider
// declaring `documents`.
const pdfParts = [{ kind: "document", mediaType: "application/pdf", b64: "UERG", name: "memo.pdf" }, { kind: "text", text: "Tag it." }];

test("a PDF goes as OpenAI's file part, named, as a data: URL", () => {
  const r = compatRequest({ provider: "openai", model: "m", systemText: "s", schema, parts: pdfParts });
  assert.deepEqual(r.messages[1].content, [
    { type: "file", file: { filename: "memo.pdf", file_data: "data:application/pdf;base64,UERG" } },
    { type: "text", text: "Tag it." },
  ]);
});

test("a descriptor's withDocuments fields go with a PDF and only with one: OpenRouter asks for native reading", () => {
  // Unasked, a model that can't read files has OpenRouter parse it with paid
  // OCR; asked for native reading, it refuses, and the step sends the text.
  const native = [{ id: "file-parser", pdf: { engine: "native" } }];
  assert.deepEqual(compatRequest({ provider: "openrouter", model: "m", systemText: "s", schema, parts: pdfParts }).plugins, native);
  assert.equal("plugins" in compatRequest({ provider: "openrouter", model: "m", systemText: "s", schema, parts }), false, "no PDF, none");
  // The request's own fields stay its own.
  const r = buildRequest({ compat: { ...PROVIDERS.openrouter.compat, withDocuments: { model: "other", plugins: native } }, model: "m", systemText: "s", schema, parts: pdfParts });
  assert.equal(r.model, "m");
});
