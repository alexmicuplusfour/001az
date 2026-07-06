// buildPrompt turns a board's facets into the tagger's system text + strict
// tool schema. Pure function, no DB — this is what makes an invalid tag
// structurally impossible, so it's worth pinning precisely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, embedTextFor } from "../server/worker.js";

const facets = [
  { key: "kind", label: "Kind", single: true, values: ["a", "b"] },
  { key: "mood", label: "Mood", values: ["x", "y", "z"] },
];

test("reasoning schema: each facet is reason-then-values, plus a fit verdict", () => {
  const { schema } = buildPrompt(facets, "", true);
  const kind = schema.properties.kind;
  assert.equal(kind.type, "object");
  assert.deepEqual(kind.required, ["reasoning", "values"]);
  assert.deepEqual(kind.properties.values.items.enum, ["a", "b"]);
  assert.equal(kind.additionalProperties, false);

  assert.equal(schema.properties.fit.properties.verdict.enum.join(","), "match,undecided");
  assert.ok(schema.required.includes("kind") && schema.required.includes("mood") && schema.required.includes("fit"));
  assert.equal(schema.additionalProperties, false);
});

test("no-reasoning schema: each facet is a bare enum array, fit is a bare enum", () => {
  const { schema } = buildPrompt(facets, "", false);
  assert.equal(schema.properties.mood.type, "array");
  assert.deepEqual(schema.properties.mood.items.enum, ["x", "y", "z"]);
  assert.equal(schema.properties.fit.type, "string");
  assert.deepEqual(schema.properties.fit.enum, ["match", "undecided"]);
});

test("single facets are told to pick exactly one", () => {
  const { systemText, schema } = buildPrompt(facets, "", true);
  assert.match(systemText, /kind .*— pick exactly one/);
  assert.match(schema.properties.kind.description, /pick exactly one/);
  assert.doesNotMatch(schema.properties.mood.description || "", /pick exactly one/);
});

test("reasoning schema asks for a whole-item description, declared first", () => {
  const { schema, systemText } = buildPrompt(facets, "", true);
  assert.equal(schema.properties.description.type, "string");
  assert.ok(schema.required.includes("description"));
  assert.equal(Object.keys(schema.properties)[0], "description");
  assert.match(systemText, /description of the item as a whole/);
});

test("no-reasoning schema has no description field", () => {
  const { schema, systemText } = buildPrompt(facets, "", false);
  assert.equal(schema.properties.description, undefined);
  assert.ok(!schema.required.includes("description"));
  assert.doesNotMatch(systemText, /description of the item as a whole/);
});

test("a facet named 'description' wins; required stays duplicate-free", () => {
  const { schema } = buildPrompt([{ key: "description", label: "Description", values: ["p", "q"] }], "", true);
  // The facet keeps its reason-then-values shape…
  assert.deepEqual(schema.properties.description.required, ["reasoning", "values"]);
  // …and "description" appears in required exactly once (strict mode rejects dupes).
  assert.equal(schema.required.filter((k) => k === "description").length, 1);
});

test("a facet named 'fit' cannot clobber the reserved fit verdict", () => {
  const { schema } = buildPrompt([{ key: "fit", label: "Fit", values: ["p", "q"] }], "", true);
  // fit stays the verdict object, defined after the facet loop.
  assert.ok(schema.properties.fit.properties.verdict);
  assert.deepEqual(schema.properties.fit.properties.verdict.enum, ["match", "undecided"]);
});

test("embedTextFor: description leads, tags flatten to words, never empty", () => {
  const text = embedTextFor(
    ["theme/light", "density/roomy"],
    { description: "A calm dashboard.", theme: "White background with green accents.", fit: "Board material." }
  );
  assert.ok(text.startsWith("A calm dashboard."));
  assert.match(text, /White background/);
  assert.match(text, /theme: light; density: roomy/);
  // Nothing to embed → falls back to a name, never an empty string.
  assert.equal(embedTextFor([], {}, { identity: "y.png", files: [{ name: "y.png", original_name: "x.png" }] }), "x.png");
  assert.equal(embedTextFor([], {}, { identity: "y.png", files: [{ name: "y.png" }] }), "y.png");
  assert.equal(embedTextFor(), "untitled item");
});

test("subject and context flow into the system text", () => {
  const { systemText } = buildPrompt(facets, "Only tag blue things.", true, "widgets");
  assert.match(systemText, /You tag widgets for a private research gallery/);
  assert.match(systemText, /Only tag blue things\./);
});

test("nothing image-specific leaks into a non-image board's prompt", () => {
  for (const withReasoning of [true, false]) {
    const { systemText, schema } = buildPrompt(facets, "", withReasoning, "stocks");
    assert.doesNotMatch(systemText, /image/i);
    assert.doesNotMatch(schema.properties.fit.description, /image/i);
  }
});
