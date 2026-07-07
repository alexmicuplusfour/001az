// OpenAI-compatible tagger request shape (compatRequest). The three providers
// share one code path but GLM (Z.ai) diverges in three live-verified ways, so
// these pin both the common shape and each GLM quirk against the others.
import { test } from "node:test";
import assert from "node:assert/strict";
import { compatRequest } from "../server/providers.js";

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
    assert.deepEqual(r.tool_choice, { type: "function", function: { name: "record_tags" } });
    assert.equal(r.tools[0].function.strict, true);
  }
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
  for (const provider of ["openai", "gemini", "glm"]) {
    const r = compatRequest({ provider, model: "m", systemText: "s", schema, parts, tool });
    assert.equal(r.tools[0].function.name, "record_fields");
    // GLM forces auto regardless of tool; the others force the named function
    if (provider === "glm") assert.equal(r.tool_choice, "auto");
    else assert.deepEqual(r.tool_choice, { type: "function", function: { name: "record_fields" } });
  }
});
