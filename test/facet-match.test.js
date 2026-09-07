// The one membership rule (public/facet-match.js): OR within `any`, AND with
// "no `not` value held". The `not` rows are the exclusion arc's Stage 2/3
// contract written a stage early (planning/chip-exclusion-plan.md) — nothing
// produces a `not` yet, but the semantics are locked here before anything
// can. Pure module, plain import, no browser stub needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { facetPass } from "../public/facet-match.js";

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
