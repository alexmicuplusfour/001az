// patterns.js — derived pattern numbers over the board's tags
// (planning/pattern-surfaces-plan.md). Stage 1a: the odds lens — a chip's
// count already says how many items you'd have after clicking it; the odds
// say whether that number is a lot or a little FOR THIS CHIP, given what's
// selected. The rail's leave-one-out counts are the co-occurrence numbers;
// this module only normalizes them and decides when the result is worth ink.

import { state } from "./state.js";

// The salience gates. Ink is the scarce resource: at ~80 chips a number on
// every pill is noise, so a multiplier renders only when all three pass.
// Guesses off one 503-item board — small boards may need these scaled
// (plan's open question) — env-of-the-client equivalent: just constants.
const MIN_RATIO = 2;     // meaningful distance from ×1, either direction
const MIN_DEVIATION = 4; // (obs−exp)²/exp — χ²-ish, ≈ p<.05 at 1 dof
const MIN_CONTEXT = 10;  // below this many matching items every ratio is jumpy

// The display string for one chip, or null when the number isn't worth
// showing. obs = the chip's leave-one-out count, ctx = the size of that
// leave-one-out context (items matching every OTHER selected facet), total =
// the chip's board-wide count, n = the board size. Pure — the gates and the
// rounding are the behavior worth pinning in tests.
export function oddsLabel({ obs, ctx, total, n }) {
  if (!ctx || !total || !n || ctx < MIN_CONTEXT) return null;
  const exp = (ctx * total) / n;
  const m = obs / exp;
  if (m < MIN_RATIO && m > 1 / MIN_RATIO) return null;
  if ((obs - exp) ** 2 / exp < MIN_DEVIATION) return null;
  // Rounding keeps the honesty of the extreme ends: big ratios don't need a
  // decimal, tiny ones would round to a flat lie at one ("×0.0").
  if (m >= 10) return `×${Math.round(m)}`;
  if (m >= 0.1) return `×${m.toFixed(1)}`;
  return `×${m.toFixed(2)}`;
}

// The lens is on only while it can condition on something: a facet selection
// (system facets included — they sit in state.selected like any other).
export function oddsActive() {
  if (!state.showOdds) return false;
  for (const values of state.selected.values()) if (values.size) return true;
  return false;
}

// --- persistence: per viewer, per board (the boardSort pattern) ---

const storeKey = () => `boardOdds:${state.boardId}`;

export function saveOdds() {
  try {
    if (state.showOdds) localStorage.setItem(storeKey(), "1");
    else localStorage.removeItem(storeKey());
  } catch { /* private mode / quota — the lens just won't stick */ }
}

export function restoreOdds() {
  try {
    state.showOdds = localStorage.getItem(storeKey()) === "1";
  } catch {
    state.showOdds = false;
  }
}
