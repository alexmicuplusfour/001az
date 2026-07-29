// OpenAI-compatible tagger request shape (compatRequest). The three providers
// share one code path but GLM (Z.ai) diverges in three live-verified ways, so
// these pin both the common shape and each GLM quirk against the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PROVIDERS } from "../server/providers.js";
import { compatRequest as buildRequest } from "../server/ai-providers/wires/compat.js";

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
  assert.equal(openai.max_completion_tokens, 2048);
  assert.equal(openai.max_tokens, undefined);
  for (const provider of ["gemini", "glm"]) {
    const r = compatRequest({ provider, model: "m", systemText: "s", schema, parts });
    assert.equal(r.max_tokens, 2048);
    assert.equal(r.max_completion_tokens, undefined);
  }
});

test("output budget scales with schema size past the 2048 floor", () => {
  const bigSchema = {
    type: "object",
    properties: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: "object" }])),
    required: [],
  };
  const r = compatRequest({ provider: "openai", model: "m", systemText: "s", schema: bigSchema, parts });
  assert.equal(r.max_completion_tokens, 1024 + 128 * 40);
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
  assert.equal(r.max_tokens, 2048);
  // non-GLM providers never carry a thinking field
  const gem = compatRequest({ provider: "gemini", model: "m", systemText: "s", schema, parts });
  assert.equal(gem.thinking, undefined);
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
