// The odds lens (planning/pattern-surfaces-plan.md, stage 1a), the pure
// pieces: oddsLabel's salience gates and rounding, computeFacetStats'
// leave-one-out context counters, and the per-board persistence. The
// board-sort pattern — shared browser stub, then dynamic import of the
// public modules.
import { localStore as store } from "./browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";

// filters.js grabs container elements at module level — none of it touched
// by the pure functions under test.
globalThis.document.getElementById ||= () => null;

const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");
const { oddsLabel, oddsActive, saveOdds, restoreOdds } = await import("../public/patterns.js");
const { computeFacetStats } = await import("../public/filters.js");

// ── oddsLabel: gates and rounding ────────────────────────────────────────────

test("oddsLabel: the flagship signal shows despite a tiny expected count", () => {
  // The real numbers that killed the flat expected-floor design: select
  // dilution-grind (36 of 503), lottery-like holds 19 board-wide, 13 in
  // context — expected 1.4, ratio ×9.6. A flat "expected >= 3" hides it;
  // the deviation gate must not.
  assert.equal(oddsLabel({ obs: 13, ctx: 36, total: 19, n: 503 }), "×9.6");
});

test("oddsLabel: ratios inside the ×0.5–×2 band stay silent", () => {
  assert.equal(oddsLabel({ obs: 20, ctx: 100, total: 100, n: 500 }), null); // exactly ×1.0
  assert.equal(oddsLabel({ obs: 35, ctx: 100, total: 100, n: 500 }), null); // ×1.75
});

test("oddsLabel: the depleted side shows, with honest rounding near zero", () => {
  // exp 40, obs 2 → ×0.05: one decimal would round to a flat ×0.1 lie.
  assert.equal(oddsLabel({ obs: 2, ctx: 100, total: 200, n: 500 }), "×0.05");
  // exp 20, obs 4 → ×0.2: one decimal is enough at this magnitude.
  assert.equal(oddsLabel({ obs: 4, ctx: 100, total: 100, n: 500 }), "×0.2");
});

test("oddsLabel: big ratios drop the decimal", () => {
  // exp 1.36, obs 24 → ×17.65 → ×18.
  assert.equal(oddsLabel({ obs: 24, ctx: 36, total: 19, n: 503 }), "×18");
});

test("oddsLabel: a jumpy context shows nothing regardless of ratio", () => {
  assert.equal(oddsLabel({ obs: 9, ctx: 9, total: 10, n: 500 }), null);
});

test("oddsLabel: a big ratio on thin evidence fails the deviation gate", () => {
  // exp 0.3, obs 1 → ×3.3 but (obs−exp)²/exp ≈ 1.6 < 4: one item proves nothing.
  assert.equal(oddsLabel({ obs: 1, ctx: 30, total: 5, n: 500 }), null);
});

test("oddsLabel: degenerate inputs are null, not NaN", () => {
  assert.equal(oddsLabel({ obs: 5, ctx: 50, total: 0, n: 500 }), null);
  assert.equal(oddsLabel({ obs: 5, ctx: 0, total: 10, n: 500 }), null);
  assert.equal(oddsLabel({ obs: 5, ctx: 50, total: 10, n: 0 }), null);
});

// ── computeFacetStats: the leave-one-out context counters ────────────────────

const item = (id, tags) => toItem({ id, name: `${id}.webp`, status: "tagged", tags });

// 10 items, two facets: 6 red (5 big, 1 small), 4 blue (1 big, 3 small).
function seedBoard() {
  state.items = [
    item(1, ["color/red", "size/big"]),
    item(2, ["color/red", "size/big"]),
    item(3, ["color/red", "size/big"]),
    item(4, ["color/red", "size/big"]),
    item(5, ["color/red", "size/big"]),
    item(6, ["color/red", "size/small"]),
    item(7, ["color/blue", "size/big"]),
    item(8, ["color/blue", "size/small"]),
    item(9, ["color/blue", "size/small"]),
    item(10, ["color/blue", "size/small"]),
  ];
}

test("computeFacetStats: one selected facet — ctxAll is its matches, ctxFail its refusers", () => {
  seedBoard();
  state.selected = new Map([["color", new Set(["red"])]]);
  const s = computeFacetStats();
  assert.equal(s.ctxAll, 6);
  assert.equal(s.ctxFail.get("color"), 4);
  assert.equal(s.ctxFail.get("size"), undefined);
  // counts keep the leave-one-out semantics the counters describe
  assert.equal(s.counts.get("size/big"), 5);
  assert.equal(s.counts.get("color/blue"), 4);
});

test("computeFacetStats: chips in the only-selected facet neutralize to ×1", () => {
  seedBoard();
  state.selected = new Map([["color", new Set(["red"])]]);
  const s = computeFacetStats();
  // blue's context is color's leave-one-out = the whole board, so its share
  // equals its board share exactly — the lens self-silences without a
  // special case.
  const ctx = s.ctxAll + s.ctxFail.get("color");
  const m = (s.counts.get("color/blue") / ctx) / (s.totals.get("color/blue") / state.items.length);
  assert.equal(ctx, state.items.length);
  assert.equal(m, 1);
});

test("computeFacetStats: two selected facets split the refusers by which one they fail", () => {
  seedBoard();
  state.selected = new Map([
    ["color", new Set(["red"])],
    ["size", new Set(["big"])],
  ]);
  const s = computeFacetStats();
  assert.equal(s.ctxAll, 5);                 // red+big
  assert.equal(s.ctxFail.get("size"), 1);    // red+small: fails size only
  assert.equal(s.ctxFail.get("color"), 1);   // blue+big: fails color only
  // blue+small items fail both — invisible to every context
  assert.equal(s.counts.get("size/small"), 1);
  assert.equal(s.counts.get("color/blue"), 1);
});

// ── oddsActive: flag AND a selection to condition on ─────────────────────────

test("oddsActive: needs the flag and a non-empty selection", () => {
  state.showOdds = true;
  state.selected = new Map([["color", new Set(["red"])]]);
  assert.equal(oddsActive(), true);
  state.selected = new Map([["color", new Set()]]);
  assert.equal(oddsActive(), false);
  state.selected = new Map([["color", new Set(["red"])]]);
  state.showOdds = false;
  assert.equal(oddsActive(), false);
});

// ── persistence: per viewer, per board ───────────────────────────────────────

test("odds persistence: sticks per board, absence restores to off", () => {
  store.clear();
  state.boardId = "b1";
  state.showOdds = true;
  saveOdds();
  assert.equal(store.get("boardOdds:b1"), "1");

  state.showOdds = false;
  restoreOdds();
  assert.equal(state.showOdds, true);

  state.boardId = "b2"; // nothing stored here
  restoreOdds();
  assert.equal(state.showOdds, false);

  state.boardId = "b1";
  state.showOdds = false;
  saveOdds(); // off removes the key rather than storing a falsy string
  assert.equal(store.has("boardOdds:b1"), false);
});
