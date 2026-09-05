// The odds lens (planning/pattern-surfaces-plan.md, stage 1a), the pure
// pieces: oddsLabel's salience gates and rounding, chipOdds' leave-one-out
// denominator over computeFacetStats' counters, and the per-board
// persistence. The board-sort pattern — shared browser stub, then dynamic
// import of the public modules.
import { localStore as store } from "./browser-stub.js";
import { test } from "node:test";
import assert from "node:assert/strict";

const { state } = await import("../public/state.js");
const { toItem } = await import("../public/utils.js");
const { oddsLabel, chipOdds, saveOdds, restoreOdds } = await import("../public/patterns.js");
const { computeFacetStats } = await import("../public/filters.js");

// ── oddsLabel: gates and rounding ────────────────────────────────────────────

test("oddsLabel: the gates, the rounding, and the step each ratio lands on", () => {
  for (const [want, args, why] of [
    // The flagship, from the real board: select dilution-grind (36 of 503)
    // and lottery-like holds 13 of them against an expectation of 1.4. A flat
    // "expected >= N" floor would hide the strongest signal on the board.
    [{ text: "×9.6", tone: "up-2" }, { obs: 13, ctx: 36, total: 19, n: 503 }, "strong signal on a tiny expected count"],
    [{ text: "×18", tone: "up-3" }, { obs: 24, ctx: 36, total: 19, n: 503 }, "past ×10 the decimal is noise"],
    // A single decimal would round this to a flat ×0.1 — three times the truth.
    [{ text: "×0.05", tone: "down-3" }, { obs: 2, ctx: 100, total: 200, n: 500 }, "near zero keeps the second decimal"],
    [{ text: "×0.2", tone: "down-2" }, { obs: 4, ctx: 100, total: 100, n: 500 }, "one decimal is enough at this magnitude"],
    [null, { obs: 20, ctx: 100, total: 100, n: 500 }, "exactly ×1.0 — inside the band"],
    [null, { obs: 35, ctx: 100, total: 100, n: 500 }, "×1.75 — inside the band"],
    [null, { obs: 9, ctx: 9, total: 10, n: 500 }, "a jumpy context, whatever the ratio"],
    [null, { obs: 1, ctx: 30, total: 5, n: 500 }, "×3.3 off one item — fails the deviation gate"],
    [null, { obs: 0, ctx: 50, total: 10, n: 500 }, "nobody in context holds it"],
    [null, { obs: 5, ctx: 50, total: 0, n: 500 }, "no board-wide count — null, not NaN"],
    [null, { obs: 5, ctx: 50, total: 10, n: 0 }, "no board — null, not Infinity"],
  ]) assert.deepEqual(oddsLabel(args), want, why);
});

test("oddsLabel: the arms step at the same three distances from parity", () => {
  // ×2/×4/×10 out and ×0.5/×0.25/×0.1 back — symmetric in log space, so a
  // badge's weight means the same thing whichever way the chip leans. Each
  // pair below sits just inside its step's edge.
  const at = (m, ctx = 400) => oddsLabel({ obs: Math.round(m * ctx * 0.1), ctx, total: 40, n: 400 })?.tone;
  assert.equal(at(2.5), "up-1");
  assert.equal(at(5), "up-2");
  assert.equal(at(12), "up-3");
  assert.equal(at(0.4), "down-1");
  assert.equal(at(0.2), "down-2");
  assert.equal(at(0.08), "down-3");
});

// ── chipOdds over computeFacetStats: the leave-one-out denominator ───────────

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

test("chipOdds: chips under the only selected facet read against the whole board, so ×1", () => {
  seedBoard();
  state.selected = new Map([["color", new Set(["red"])]]);
  const s = computeFacetStats();
  // color's leave-one-out context IS the board, so blue's share can only
  // equal its board share — the lens self-silences with no special case.
  assert.equal(s.ctxAll + s.ctxFail.get("color"), state.items.length);
  assert.equal(chipOdds(s, "color", "color/blue"), null);
});

test("chipOdds: with nothing selected every chip is exactly ×1", () => {
  // What lets the render path gate on state.showOdds alone: no selection
  // means no item fails anything, so counts equal totals for every chip.
  seedBoard();
  state.selected = new Map();
  const s = computeFacetStats();
  for (const t of ["color/red", "color/blue", "size/big", "size/small"]) {
    assert.equal(chipOdds(s, t.slice(0, t.indexOf("/")), t), null, t);
  }
});

test("chipOdds: a cross-facet skew reads its multiplier; the context floor outranks it", () => {
  // The shape the lens exists for, at board scale: red is rare (10 of 100)
  // but concentrated in big (8 of the 20) — expectation 2, observed 8.
  state.items = [];
  for (let i = 0; i < 8; i++) state.items.push(item(i, ["color/red", "size/big"]));
  for (let i = 8; i < 20; i++) state.items.push(item(i, ["color/blue", "size/big"]));
  for (let i = 20; i < 22; i++) state.items.push(item(i, ["color/red", "size/small"]));
  for (let i = 22; i < 100; i++) state.items.push(item(i, ["color/blue", "size/small"]));
  state.selected = new Map([["size", new Set(["big"])]]);
  const s = computeFacetStats();
  assert.equal(s.ctxAll, 20);
  assert.deepEqual(chipOdds(s, "color", "color/red"), { text: "×4.0", tone: "up-2" }, "8 of 20 big are red vs 10 of 100 board-wide");
  // Blue's complement barely moves: a rare chip's concentration cannot deplete
  // a chip that holds most of the board. Inside the band, so silent.
  assert.equal(chipOdds(s, "color", "color/blue"), null);

  // The same proportions on a small board say nothing at all — with 6 items
  // in context the floor speaks before any ratio does.
  seedBoard();
  state.selected = new Map([["size", new Set(["big"])]]);
  const small = computeFacetStats();
  assert.equal(small.ctxAll, 6);
  assert.equal(chipOdds(small, "color", "color/red"), null, "under the context floor");
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
