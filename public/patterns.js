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
// (plan's open question).
const MIN_RATIO = 2;     // meaningful distance from ×1, either direction
const MIN_DEVIATION = 4; // (obs−exp)²/exp — χ²-ish, ≈ p<.05 at 1 dof
const MIN_CONTEXT = 10;  // below this many matching items every ratio is jumpy

// Which of the six buckets a surviving ratio lands in: direction, then
// strength in octaves. The arms are symmetric in log space — ×2/×4/×10 out
// and ×0.5/×0.25/×0.1 back are the same three distances from parity — so a
// badge's weight means the same thing whichever way it leans.
//
// The thresholds are FIXED, not scaled to whatever is on screen. A ratio
// re-anchored to the current set would repaint every chip when the selection
// changes and would paint a mild ×2.1 as loudly as a ×40 on a quiet board —
// the color would be describing the board instead of the chip. Fixed steps
// are learnable: ×4 looks the same everywhere.
function oddsTone(m) {
  if (m >= 1) return `up-${m >= 10 ? 3 : m >= 4 ? 2 : 1}`;
  return `down-${m <= 0.1 ? 3 : m <= 0.25 ? 2 : 1}`;
}

// The mark for one chip — `{ text, tone }` — or null when the number isn't
// worth showing. obs = the chip's leave-one-out count, ctx = the size of that
// leave-one-out context (items matching every OTHER selected facet), total =
// the chip's board-wide count, n = the board size. Pure — the gates, the
// rounding and the bucketing are the behavior worth pinning in tests.
export function oddsLabel({ obs, ctx, total, n }) {
  // A chip nobody in context holds, or nobody holds at all, has no ratio to
  // report; `n` keeps the function total over its own inputs rather than
  // trusting every future caller to have items. ctx's floor subsumes ctx=0.
  if (!obs || !total || !n || ctx < MIN_CONTEXT) return null;
  const exp = (ctx * total) / n;
  const m = obs / exp;
  if (m < MIN_RATIO && m > 1 / MIN_RATIO) return null;
  if ((obs - exp) ** 2 / exp < MIN_DEVIATION) return null;
  // Two significant figures, which at the extremes means dropping the decimal
  // a big ratio doesn't need and keeping the second one a tiny ratio would
  // round into a flat lie ("×0.0").
  return { text: `×${m.toFixed(m >= 10 ? 0 : m >= 0.1 ? 1 : 2)}`, tone: oddsTone(m) };
}

// The lens applied to one chip, off the rail's own stats. The leave-one-out
// denominator — "facet F's context is everything that fails no facet, plus
// what fails only F" — lives HERE and nowhere else: filters.js counts, this
// assembles, oddsLabel judges.
//
// With nothing selected this is self-silencing rather than special-cased:
// every item fails nothing, so ctx is the whole board and counts equal
// totals, making m exactly 1 — inside the band, so null. Same reason a chip
// under the only selected facet reads ×1.
export function chipOdds(stats, facetKey, t) {
  return oddsLabel({
    obs: stats.counts.get(t) || 0,
    ctx: stats.ctxAll + (stats.ctxFail.get(facetKey) || 0),
    total: stats.totals.get(t) || 0,
    n: state.items.length,
  });
}

// The lens's one action: flip, persist, repaint. Callers pass the new state
// (a checkbox's own `checked`) rather than asking this to derive it — the
// view.js toggleView shape, so no caller assembles the three steps itself.
export function toggleOdds(on) {
  state.showOdds = on;
  saveOdds();
  document.dispatchEvent(new Event("app:render"));
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
