// The one membership rule (public/facet-match.js): OR within `any`, AND with
// "no `not` value held". The `not` rows are the exclusion arc's Stage 2/3
// contract written a stage early (planning/chip-exclusion-plan.md) — nothing
// produces a `not` yet, but the semantics are locked here before anything
// can. Pure module, plain import, no browser stub needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { facetPass, pruneToDeclared, selEntry } from "../public/facet-match.js";

const holds = (...vs) => { const s = new Set(vs); return (v) => s.has(v); };

test("facetPass: any-only — OR within, empty constrains nothing", () => {
  for (const [want, has, any, why] of [
    [true, holds("a"), ["a"], "single include held"],
    [true, holds("a"), ["b", "a"], "OR within — second value lands"],
    [false, holds("a"), ["b"], "include not held"],
    [false, holds(), ["a", "b"], "holder has nothing"],
    [true, holds("a"), [], "empty any is an untouched half, not unmatchable"],
    [true, holds(), [], "empty against empty still passes"],
    [true, holds("a"), undefined, "absent any, same"],
  ]) assert.equal(facetPass(has, any), want, why);
});

test("facetPass: not-only — absence stays absence", () => {
  for (const [want, has, not, why] of [
    [false, holds("a"), ["a"], "excluded value held"],
    [false, holds("a", "b"), ["c", "b"], "any one exclusion held kills it"],
    [true, holds("a"), ["b"], "exclusion not held"],
    [true, holds(), ["a"], "unset passes a NOT — never answered ≠ holds it"],
    [true, holds("a"), [], "empty not constrains nothing"],
  ]) assert.equal(facetPass(has, undefined, not), want, why);
});

test("facetPass: mixed — include satisfied AND no exclusion held", () => {
  for (const [want, has, any, not, why] of [
    [true, holds("a"), ["a"], ["b"], "include held, exclusion clear"],
    [false, holds("a", "b"), ["a"], ["b"], "include held but exclusion also held"],
    [false, holds("b"), ["a"], ["b"], "include missed — the not half never saves it"],
    [false, holds("c"), ["a"], ["b"], "neither half satisfied on the include side"],
  ]) assert.equal(facetPass(has, any, not), want, why);
});

test("facetPass: Sets and arrays are the same to it", () => {
  assert.equal(facetPass(holds("a"), new Set(["b", "a"]), new Set()), true);
  assert.equal(facetPass(holds("a"), new Set(), new Set(["a"])), false);
});

test("facetPass: any short-circuits on first hit", () => {
  let asked = 0;
  const counting = (v) => { asked++; return v === "a"; };
  facetPass(counting, ["a", "b", "c"]);
  assert.equal(asked, 1, "stops at the first held include");
});

// --- pruneToDeclared: a selection meeting a taxonomy that moved under it ---

const sel = (pairs) => new Map(pairs.map(([k, any, not]) => [k, selEntry(any, not)]));
const shown = (m) => [...m].map(([k, v]) => [k, [...v.any], [...v.not]]);
const COLOR = [{ key: "color", values: ["blue", "black"] }];

test("pruneToDeclared: keeps what the board still declares, drops what it doesn't", () => {
  const { selected, dropped } = pruneToDeclared(sel([["color", ["blue", "red"]]]), COLOR);
  assert.deepEqual(shown(selected), [["color", ["blue"], []]]);
  assert.deepEqual(dropped, [{ key: "color", value: "red" }]);
});

test("pruneToDeclared: a facet the board no longer has at all goes whole", () => {
  const { selected, dropped } = pruneToDeclared(sel([["size", ["big"]], ["color", ["blue"]]]), COLOR);
  assert.deepEqual(shown(selected), [["color", ["blue"], []]]);
  assert.deepEqual(dropped, [{ key: "size", value: "big" }]);
});

// The half with no symptom: an unmatchable exclusion excludes nothing, so a
// saved "everything except red" silently starts showing red. Pruned like an
// include, and REPORTED like one — the toast is the only tell it ever gets.
test("pruneToDeclared: the exclude half is pruned too", () => {
  const { selected, dropped } = pruneToDeclared(sel([["color", ["blue"], ["red", "black"]]]), COLOR);
  assert.deepEqual(shown(selected), [["color", ["blue"], ["black"]]]);
  assert.deepEqual(dropped, [{ key: "color", value: "red" }]);
});

test("pruneToDeclared: an entry emptied by the prune leaves no key behind", () => {
  const { selected, dropped } = pruneToDeclared(sel([["color", ["red"], ["pink"]]]), COLOR);
  assert.equal(selected.size, 0, "not an entry with two empty halves");
  assert.equal(dropped.length, 2);
});

// System facets' membership comes from a capability's own set, never the facet
// list — checking them against it would drop every one. The `~` prefix is
// reserved server-side (facetsReservedKeyError) so the test can be this exact.
test("pruneToDeclared: ~ keys pass untouched", () => {
  const { selected, dropped } = pruneToDeclared(
    sel([["~uploaders", ["7"]], ["~objects", ["cat"], ["dog"]], ["~clusters", ["3"]]]), COLOR);
  assert.equal(selected.size, 3);
  assert.deepEqual(shown(selected).find(([k]) => k === "~objects"), ["~objects", ["cat"], ["dog"]]);
  assert.deepEqual(dropped, []);
});

test("pruneToDeclared: an untouched selection is reported as untouched", () => {
  const { dropped } = pruneToDeclared(sel([["color", ["blue"], ["black"]]]), COLOR);
  assert.deepEqual(dropped, [], "no toast on the overwhelmingly common path");
});

// A board with no taxonomy declares nothing, so nothing survives — the CALLER
// is what keeps a failed board fetch from reading that way (app.js gates on
// boardData), because an empty list means the same thing to this function
// either way and guessing which it is does not belong here.
test("pruneToDeclared: an empty facet list declares nothing", () => {
  const { selected, dropped } = pruneToDeclared(sel([["color", ["blue"]], ["~uploaders", ["7"]]]), []);
  assert.deepEqual(shown(selected), [["~uploaders", ["7"], []]]);
  assert.deepEqual(dropped, [{ key: "color", value: "blue" }]);
});
