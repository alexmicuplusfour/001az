// The { any, not } selection shape (planning/chip-exclusion-plan.md, Stage
// 2): entry canonicals, the two-param URL codec, both stored config forms,
// and the each-clears-the-other toggle rule. All inert in the UI until Stage
// 3 ships the gesture — these lock the plumbing while nothing can produce an
// exclusion yet. The board-sort pattern: shared browser stub, then dynamic
// import of the public modules.
import "./browser-stub.js";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

const { state } = await import("../public/state.js");
const { selEntry } = await import("../public/facet-match.js");
const { toItem } = await import("../public/utils.js");
const {
  filterKey, toggle, toggleNeg, activeCount, taggedFiltered,
  encodeSelected, encodeExcluded, decodeSelection,
  selectedAsConfig, applyFilterConfig, configMatchesCurrent,
} = await import("../public/filters.js");

afterEach(() => {
  state.selected = new Map();
  state.items = [];
});

test("codec: both halves round-trip through ?f= / ?fx=", () => {
  state.selected = new Map([
    ["color", selEntry(["red", "blue"], ["green"])],
    ["size", selEntry([], ["big"])],
    ["mood", selEntry(["calm"])],
  ]);
  const f = encodeSelected();
  const fx = encodeExcluded();
  assert.equal(f, "color:blue,red;mood:calm", "includes only — ?f= keeps its old meaning");
  assert.equal(fx, "color:green;size:big", "excludes ride the sibling param");
  const back = decodeSelection(f, fx);
  assert.deepEqual([...back.get("color").any].sort(), ["blue", "red"]);
  assert.deepEqual([...back.get("color").not], ["green"]);
  assert.deepEqual([...back.get("size").any], [], "fx-only key decodes with an empty include half");
  assert.deepEqual([...back.get("size").not], ["big"]);
  assert.deepEqual([...back.get("mood").any], ["calm"]);
});

test("codec: a legacy ?f=-only link decodes unchanged", () => {
  const back = decodeSelection("color:red", null);
  assert.deepEqual([...back.get("color").any], ["red"]);
  assert.equal(back.get("color").not.size, 0);
});

test("filterKey: including and excluding the same value are different keys", () => {
  state.selected = new Map([["color", selEntry(["dark"])]]);
  const included = filterKey();
  state.selected = new Map([["color", selEntry([], ["dark"])]]);
  const excluded = filterKey();
  assert.notEqual(included, excluded, "the render cache must not serve one for the other");
});

test("config: legacy array out when exclusion-free, { any, not } when not", () => {
  state.selected = new Map([
    ["color", selEntry(["red"])],
    ["size", selEntry(["big"], ["huge"])],
    ["mood", selEntry()],
  ]);
  assert.deepEqual(selectedAsConfig(), {
    color: ["red"],
    size: { any: ["big"], not: ["huge"] },
  }, "empty entries dropped, exclusion-free entries stay byte-identical to the old shape");
});

test("config: both stored forms apply, and array equals its { any } spelling", () => {
  applyFilterConfig({ color: ["red"], size: { any: ["big"], not: ["huge"] } });
  assert.deepEqual([...state.selected.get("color").any], ["red"]);
  assert.deepEqual([...state.selected.get("size").not], ["huge"]);
  assert.ok(configMatchesCurrent({ color: { any: ["red"], not: [] }, size: { any: ["big"], not: ["huge"] } }),
    "the two spellings of the same selection compare equal");
});

test("toggle: adding an include clears the same value's exclusion", () => {
  state.selected = new Map([["color", selEntry([], ["red"])]]);
  toggle("color", "red");
  const entry = state.selected.get("color");
  assert.ok(entry.any.has("red"), "included now");
  assert.equal(entry.not.size, 0, "the exclusion is gone — each state clears the other");
});

test("activeCount: an exclusion is an active filter", () => {
  state.selected = new Map([["color", selEntry(["red"], ["blue", "green"])]]);
  assert.equal(activeCount(), 3);
});

test("toggleNeg: the exclusion twin, sibling-clearing both directions", () => {
  state.selected = new Map();
  toggleNeg("color", "red");
  assert.ok(state.selected.get("color").not.has("red"), "excluded from nothing");
  toggleNeg("color", "red");
  assert.equal(state.selected.get("color").not.size, 0, "toggles back off");
  toggle("color", "red");
  toggleNeg("color", "red");
  const entry = state.selected.get("color");
  assert.ok(entry.not.has("red") && !entry.any.has("red"), "excluding an included value moves it");
});

test("an exclusion filters the grid: NOT holds back holders, keeps the unset", () => {
  state.items = [
    { id: 1, name: "a", status: "tagged", tags: ["color/red"] },
    { id: 2, name: "b", status: "tagged", tags: ["color/blue"] },
    { id: 3, name: "c", status: "tagged", tags: [] },            // unset — absence stays absence
  ].map(toItem);
  state.selected = new Map([["color", selEntry([], ["red"])]]);
  assert.deepEqual(taggedFiltered().map((x) => x.id).sort(), [2, 3], "holder gone, unset kept");
  state.selected = new Map([["color", selEntry(["red", "blue"], ["blue"])]]);
  assert.deepEqual(taggedFiltered().map((x) => x.id), [1], "any and not compose in one facet");
});
