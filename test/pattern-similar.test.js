// The similarity scorer (planning/pattern-surfaces-plan.md, stage 1b), the
// pure piece: rarity-weighted shared chips as a fraction of the target's own
// weight, the floor, the cap, and the too-little-identity gate. The mode's
// lifecycle (search.js) is a thin state write over this map — the scoring is
// where the behavior lives. The board-sort pattern — shared browser stub,
// then dynamic import of the public modules.
import "./browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");
const { similarTo } = await import("../public/patterns.js");

const item = (id, tags) => toItem({ id, name: `${id}.webp`, status: "tagged", tags });

test("similar: shared rarity over self — a chip everyone holds says nothing", () => {
  // n=8. r and s are each held by 2 (weight log2(8/2)=2); all by all 8
  // (weight 0). Target self-weight = 2+2+0 = 4. Item 1 shares r AND all yet
  // scores exactly 2/4 — the universal chip contributed nothing. Items
  // sharing only the universal chip score 0 and fall under the floor.
  state.items = [
    item(0, ["f/r", "g/s", "c/all"]),
    item(1, ["f/r", "c/all"]),
    item(2, ["g/s", "c/all"]),
    ...[3, 4, 5, 6, 7].map((i) => item(i, ["c/all"])),
  ];
  const m = similarTo(state.items[0]);
  // target first at 1; the 0.5 tie breaks on identity ("1.webp" < "2.webp")
  assert.deepEqual([...m.entries()], [[0, 1], [1, 0.5], [2, 0.5]]);
});

test("similar: the floor keeps a sliver of shared identity out", () => {
  // n=16, four rare chips on the target, each held by exactly one other item
  // (weight log2(16/2)=3 each; self=12). Sharing one chip is 3/12=0.25 —
  // under the ⅓ floor, out; sharing two is 0.5 — in.
  state.items = [
    item(0, ["a/p", "b/q", "c/s", "d/t"]),
    item(1, ["a/p"]),
    item(2, ["b/q", "c/s"]),
    item(3, ["d/t"]),
    ...Array.from({ length: 12 }, (_, i) => item(i + 4, ["e/other"])),
  ];
  const m = similarTo(state.items[0]);
  assert.deepEqual([...m.entries()], [[0, 1], [2, 0.5]]);
});

test("similar: the cap bounds a typical target, and the anchor survives it", () => {
  // 60 identical clones (each chip held by 60 of 120 → weight 1, every clone
  // scores a perfect 1) — an unbounded 60 results; the cap cuts to 50, and
  // the target outranks its ties so the search's own anchor is never cut.
  state.items = [
    ...Array.from({ length: 60 }, (_, i) => item(i, ["a/p", "b/q", "c/r"])),
    ...Array.from({ length: 60 }, (_, i) => item(i + 60, [`u/u${i}`])),
  ];
  const target = state.items[59]; // identity "59.webp" sorts late — only the anchor rule keeps it
  const m = similarTo(target);
  assert.equal(m.size, 50);
  assert.equal([...m.keys()][0], 59, "the target leads its own results");
  for (const s of m.values()) assert.equal(s, 1);
});

test("similar: too little identity to match on — the MIN_TAGS gate", () => {
  state.items = [item(0, ["f/r", "g/s"]), item(1, ["f/r", "g/s"]), item(2, ["f/r"])];
  assert.equal(similarTo(state.items[0]), null, "two chips is not an identity");
});

test("similar: a target made entirely of universal chips has no one to be unlike", () => {
  // every chip held by every item → every weight 0 → self 0: null, not NaN
  state.items = Array.from({ length: 8 }, (_, i) => item(i, ["a/p", "b/q", "c/r"]));
  assert.equal(similarTo(state.items[0]), null);
});
