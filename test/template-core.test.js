// The AI-extracted fields document and its Paste (public/template-core.js,
// planning/templates-plan.md C2 and Stage 1). Pure module, plain import, no
// browser stub. guidance-json.test.js covers the other document.
//
// Paste replaces the board's AI-extracted fields and nothing else: live data,
// file metadata and detection are the board's own, and a paste that disturbed
// them would wreck a board to set up one section of it. Refusals change
// nothing at all, so what the reader sees afterwards is either the paste or
// the board as it was, never half of each.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFields, mergeExtracted, facetOut, extractedFieldOut, checkTemplate } from "../public/template-core.js";

const extract = (key, over = {}) => ({ key, source: "extract", kind: "text", ...over });
const file = (key) => ({ key, source: "file", kind: "number", fn: "file_size" });
const connector = (key) => ({ key, source: "connector", kind: "number", fn: key });
const CAP = 12;

// ── normalizeFields: the document's shape ──────────────────────────────────

test("a list of extracted fields comes back as written", () => {
  const doc = [
    extract("brand", { instruction: "the maker's name", options: [{ value: "Acme", hint: "the red logo" }, { value: "Globex" }] }),
    extract("year", { kind: "number" }),
  ];
  assert.deepEqual(normalizeFields(JSON.parse(JSON.stringify(doc))), doc);
});

// The shape a hand-written or AI-drafted list leaves out, filled in the way
// guidance Paste fills in a facet's key.
test("a field that arrived without a source is an extracted one", () => {
  assert.deepEqual(normalizeFields([{ key: "brand", kind: "text" }]), [extract("brand")]);
});

// Live data, file metadata and detection belong to the board they're on: a
// field list that carries one is not a document another board can take.
test("a field of any other source is refused", () => {
  for (const f of [file("size"), connector("price"), { key: "cat", source: "detect", instruction: "cat" }]) {
    assert.throws(() => normalizeFields([f]), /isn't an AI-extracted field/, `should have refused ${f.source}`);
  }
});

// Tagging Guidance's taxonomy is a bare list of keyed objects too, and a
// facet read as a field would land as an extracted field nobody asked for.
test("a taxonomy isn't a list of fields: its values give it away", () => {
  assert.throws(() => normalizeFields([{ key: "season", label: "Season", values: ["summer"] }]), /a taxonomy, not a list of fields/);
  assert.throws(() => normalizeFields([{ label: "Season", values: [] }]), /a taxonomy, not a list of fields/, "a facet with no key yet, too");
});

// Only what an extracted field carries survives; a stray `fn` or `refresh`
// copied from elsewhere doesn't ride into the draft.
test("what an extracted field doesn't carry is left behind", () => {
  const [f] = normalizeFields([{ key: "brand", kind: "text", fn: "price", refresh: { every: 5 }, label: "Brand" }]);
  assert.deepEqual(f, extract("brand"));
});

// Types, not values: each of these would throw somewhere after the paste
// (an instruction that isn't text throws in collect() at Save). A key that is
// text but misspelled, or a kind nobody offers, passes here: Save names those.
test("a field whose parts have the wrong types is refused", () => {
  for (const bad of [
    null, 42, "brand", [], { kind: "text" }, { key: "" }, { key: 7 },
    { key: "brand", kind: 3 },
    { key: "brand", instruction: 5 },
    { key: "brand", options: "Acme" },
    { key: "brand", options: [null] },
    { key: "brand", options: ["Acme"] },
    { key: "brand", options: [{ value: 1 }] },
    { key: "brand", options: [{ value: "Acme", hint: 2 }] },
  ]) {
    assert.throws(() => normalizeFields([bad]), `should have refused ${JSON.stringify(bad)}`);
  }
  for (const bad of [null, {}, { fields: [] }, "[]"]) {
    assert.throws(() => normalizeFields(bad), /not a list of fields/, `should have refused ${JSON.stringify(bad)}`);
  }
});

test("a misspelled key or an unknown kind is Save's to judge, not Paste's", () => {
  assert.deepEqual(normalizeFields([{ key: "Brand Name", kind: "colour" }]), [{ key: "Brand Name", source: "extract", kind: "colour" }]);
});

// ── mergeExtracted: the paste itself ───────────────────────────────────────

test("the paste replaces the extracted fields and keeps every other one, in order", () => {
  const board = [file("size"), extract("old"), connector("price"), extract("older")];
  const r = mergeExtracted(board, [extract("brand"), extract("year")], { cap: CAP });
  assert.deepEqual(r.fields.map((f) => f.key), ["size", "price", "brand", "year"]);
  assert.equal(r.fields[0], board[0], "a kept field is the board's own object, untouched");
});

test("an empty paste clears the extracted fields and nothing else", () => {
  const r = mergeExtracted([file("size"), extract("old")], [], { cap: CAP });
  assert.deepEqual(r.fields.map((f) => f.key), ["size"]);
});

// A key the board keeps belongs to a field the paste can't touch, so two
// fields would answer to one name; the save would refuse it anyway, but only
// after the reader had lost the board they were looking at.
test("a pasted key that a kept field already has refuses the paste", () => {
  const r = mergeExtracted([file("size"), extract("old")], [extract("size")], { cap: CAP });
  assert.deepEqual(r, { refused: "key", key: "size" });
});

test("a key the paste names twice refuses it", () => {
  const r = mergeExtracted([], [extract("brand"), extract("brand", { kind: "url" })], { cap: CAP });
  assert.deepEqual(r, { refused: "key", key: "brand" });
});

// An extracted key the board had is no clash: the paste replaces that field.
test("a pasted key the board's old extracted field had is a replacement, not a clash", () => {
  const r = mergeExtracted([extract("brand", { kind: "url" })], [extract("brand")], { cap: CAP });
  assert.deepEqual(r.fields, [extract("brand")]);
});

test("more extracted fields than the cap refuses the paste", () => {
  const many = Array.from({ length: CAP + 1 }, (_, i) => extract(`f${i}`));
  assert.deepEqual(mergeExtracted([], many, { cap: CAP }), { refused: "cap" });
  assert.equal(mergeExtracted([], many.slice(0, CAP), { cap: CAP }).fields.length, CAP);
});

// The card key names one of the extracted fields. A paste without that field
// takes the board back to one card per file, which is what removing the field
// by hand does too; `cleared` names it for the toast.
test("the card key clears when its field isn't in the paste", () => {
  const r = mergeExtracted([extract("person")], [extract("brand")], { cardBy: "person", cap: CAP });
  assert.equal(r.cardBy, null);
  assert.equal(r.cleared, "person");
});

test("the card key stays when its field is in the paste", () => {
  const r = mergeExtracted([extract("person")], [extract("brand"), extract("person")], { cardBy: "person", cap: CAP });
  assert.equal(r.cardBy, "person");
  assert.equal(r.cleared, null);
});

// A data board has no card key: its cards are the domain's entries.
test("with no card key there's nothing to clear", () => {
  const r = mergeExtracted([connector("price")], [extract("thesis")], { cap: CAP });
  assert.equal(r.cardBy, null);
  assert.equal(r.cleared, null);
});

// ── The write-outs: how a board stores a facet and an extracted field ──────
// Compared as JSON text, not deepEqual, since key order is what a Copy writes.

test("a facet is written as the board editor writes it: key, label, values, then single and description only when there", () => {
  assert.equal(
    JSON.stringify(facetOut({ description: "  Why it's held.  ", single: true, values: ["growth"], label: "Thesis", key: "thesis", _new: true })),
    JSON.stringify({ key: "thesis", label: "Thesis", values: ["growth"], single: true, description: "Why it's held." }),
  );
  assert.equal(
    JSON.stringify(facetOut({ key: "size", label: "Size", values: [], single: false, description: "  " })),
    JSON.stringify({ key: "size", label: "Size", values: [] }),
  );
});

test("an extracted field is written as a save sends it: its instruction trimmed, its options cleaned, either left out when empty", () => {
  assert.equal(
    JSON.stringify(extractedFieldOut({ options: [{ hint: " the red logo ", value: " Acme " }, { value: "  " }], instruction: "  the maker's name ", kind: "text", source: "extract", key: "brand" })),
    JSON.stringify({ key: "brand", source: "extract", kind: "text", instruction: "the maker's name", options: [{ value: "Acme", hint: "the red logo" }] }),
  );
  assert.equal(
    JSON.stringify(extractedFieldOut({ key: "year", source: "extract", kind: "number", instruction: " ", options: [] })),
    JSON.stringify({ key: "year", source: "extract", kind: "number" }),
  );
});

// The templates page shows and copies a template's sections as they come back
// from its check, and its Copy has to write what the board editor's Copy
// writes for a board made from it (templates-plan.md, Stage 3b close look,
// finding 1). So the check gives them back as that board would store them.
test("a template's sections come back as a board made from it stores them", () => {
  const t = checkTemplate({
    name: "Holdings",
    description: "Companies.",
    guidance: {
      facets: [{ single: false, description: "  Why it's held.  ", values: ["growth"], label: "Thesis", key: "thesis" }],
      context: "  Listed companies.  ",
    },
    fields: [{ instruction: " the maker's name ", kind: "text", key: "brand", options: [{ value: " Acme " }, { value: "" }] }],
  }, "holdings");
  assert.equal(JSON.stringify(t.guidance), JSON.stringify({
    context: "Listed companies.",
    facets: [{ key: "thesis", label: "Thesis", values: ["growth"], description: "Why it's held." }],
  }));
  assert.equal(JSON.stringify(t.fields), JSON.stringify([
    { key: "brand", source: "extract", kind: "text", instruction: "the maker's name", options: [{ value: "Acme" }] },
  ]));
  // A taxonomy on its own still comes back as a whole guidance document, the
  // way the board editor's Copy writes one: its context empty.
  const bare = checkTemplate({ name: "N", description: "D", guidance: [{ key: "shade", label: "Shade", values: ["light"] }] }, "n");
  assert.equal(JSON.stringify(bare.guidance), JSON.stringify({ context: "", facets: [{ key: "shade", label: "Shade", values: ["light"] }] }));
});
