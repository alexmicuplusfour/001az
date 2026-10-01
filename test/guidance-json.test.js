// The Tagging Guidance clipboard document (template-core.js `normalizeGuidance`).
//
// The button used to sit on the Taxonomy sub-title and carry a bare facets
// array, which split the guidance at the wrong seam: the context says what the
// items ARE, the facets say what may be said about them, and moving a board's
// tagging anywhere — another board, an AI asked to extend it — means moving
// both. One document now carries both, and this file pins what that document
// is allowed to be.
//
// Every failure here is silent in the same way. A paste that drops a key the
// document didn't mention wipes work the user never asked it to touch; a paste
// that lets a keyless facet through saves cleanly and then matches nothing,
// forever, because every tag the worker writes is keyed.
//
// Plain import, no fake DOM: template-core.js is pure, and loading it here,
// bare, is also the proof the server can import it (templates-plan.md,
// Stage 1, proof 1). It used to take thirty lines of stubbed document just to
// load board-modal.js, where these rules lived.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeGuidance, facetKey } from "../public/template-core.js";

const wardrobe = {
  context: "Classify these clothing items and outfits.",
  facets: [{ key: "season", label: "Season", values: ["summer", "winter"] }],
};

test("a whole document carries both halves of the guidance", () => {
  const doc = normalizeGuidance(wardrobe);
  assert.equal(doc.context, "Classify these clothing items and outfits.");
  assert.deepEqual(doc.facets.map((f) => f.key), ["season"]);
});

// What "Copy JSON" writes is what "Paste JSON" reads — the trip through another
// board (or a chat window) has to be lossless or the button is a trap.
test("the copied document round-trips", () => {
  const doc = normalizeGuidance(JSON.parse(JSON.stringify(wardrobe)));
  assert.deepEqual(doc, wardrobe);
});

// The two keys are independent. Re-wording what a board is for shouldn't oblige
// the user to carry a taxonomy they didn't touch, and a pasted taxonomy has no
// business blanking a context it says nothing about.
test("a document replaces only what it mentions", () => {
  const ctxOnly = normalizeGuidance({ context: "Only the wording changed." });
  assert.equal(ctxOnly.context, "Only the wording changed.");
  assert.equal(ctxOnly.facets, undefined);

  const facetsOnly = normalizeGuidance({ facets: wardrobe.facets });
  assert.equal(facetsOnly.context, undefined);
  assert.equal(facetsOnly.facets.length, 1);
});

// Absent leaves the context alone; empty is someone deliberately clearing it.
test("an empty context is an instruction, not an absence", () => {
  assert.equal(normalizeGuidance({ context: "" }).context, "");
});

// The shape this button emitted before the guidance became one document, and
// the shape an AI hands back when asked for "the taxonomy".
test("a bare array is read as facets, and leaves the context standing", () => {
  const doc = normalizeGuidance(wardrobe.facets);
  assert.equal(doc.context, undefined);
  assert.deepEqual(doc.facets.map((f) => f.label), ["Season"]);
});

// Keyless isn't unconventional, it's broken — it saves and then never matches.
// The editor derives a key while you type; paste never went through that path.
test("a facet that arrived without a key gets one from its label", () => {
  const doc = normalizeGuidance({ facets: [{ label: "Body Part!", values: ["torso"] }] });
  assert.equal(doc.facets[0].key, "body-part");
  assert.equal(doc.facets[0].key, facetKey("Body Part!"));
});

// Not cosmetic tidying: `for (const v of f.values)` runs unguarded in the
// tagging pass, the manual-tag route and the gallery's filter build. A facet
// pasted without a values list saves clean and then throws later, on a board
// the user has already walked away from.
test("a facet that arrived without values gets an empty list, not undefined", () => {
  const doc = normalizeGuidance({ facets: [{ key: "season", label: "Season" }] });
  assert.deepEqual(doc.facets[0].values, []);
});

// A stored key is an identity — every tag already written points at it. Editing
// the label must not silently re-key the facet and orphan them.
test("a key the document carries is never re-derived", () => {
  const doc = normalizeGuidance({ facets: [{ key: "season", label: "When To Wear", values: [] }] });
  assert.equal(doc.facets[0].key, "season");
});

// Extract Fields' Copy writes a bare list of keyed objects too. Read as
// facets, it would replace the taxonomy with labelless, valueless ones, with
// no word said and Save lit.
test("a list of fields isn't a taxonomy", () => {
  const fields = [{ key: "brand", source: "extract", kind: "text" }, { key: "year", source: "extract", kind: "number" }];
  assert.throws(() => normalizeGuidance(fields), /a list of fields, not facets/);
  assert.throws(() => normalizeGuidance({ facets: fields }), /a list of fields, not facets/);
});

// The editor trims a description as it syncs, so one that isn't text threw
// there, after the paste: the editor showed the new taxonomy and Save kept
// the old one.
test("a facet whose description isn't text is refused", () => {
  assert.throws(() => normalizeGuidance({ facets: [{ label: "Season", values: ["summer"], description: 5 }] }), /description must be text/);
  assert.equal(normalizeGuidance({ facets: [{ label: "Season", description: null }] }).facets.length, 1, "null is no description");
});

test("everything a guidance document is not is refused", () => {
  for (const bad of [
    null,
    42,
    "just some text",
    {},                                   // mentions neither key
    { context: 5 },
    { facets: { season: ["summer"] } },   // an object of facets is not the taxonomy
    { facets: ["season"] },               // nor are bare strings
    { facets: [null] },
  ]) {
    assert.throws(() => normalizeGuidance(bad), `should have refused ${JSON.stringify(bad)}`);
  }
});
