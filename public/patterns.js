// patterns.js — derived pattern numbers over the board's tags
// (planning/pattern-surfaces-plan.md): both lenses. The ODDS lens (stage 1a)
// — a chip's count already says how many items you'd have after clicking it;
// the odds say whether that number is a lot or a little FOR THIS CHIP, given
// what's selected. The CLUSTERS lens (stage 3) — found groups of items that
// keep answering alike, worn as a rail row. Same species: computed from the
// tags in memory, nothing persisted but a per-viewer boolean each.

import { state } from "./state.js";
import { ACTIVE, QUEUED } from "./data.js";

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

// --- the lens trio: flip/persist/restore, per viewer per board -------------
// Both lenses need the same three actions over the same shape (a boolean
// under `prefix:<boardId>`), so the trio is written once — the clusters copy
// was already the file's second and the app's fourth (sort.js, view.js;
// sparkline.js records where a fourth copy of a block leads). Sort and view
// keep their own blocks on purpose: they persist richer shapes (validated
// JSON, an enum) behind the same key convention. Toggle callers pass the new
// state (a checkbox's own `checked`) rather than asking it to derive one —
// the view.js toggleView shape, so no caller assembles the steps itself.
function boardLens(prefix, field, onOff) {
  const key = () => `${prefix}:${state.boardId}`;
  const save = () => {
    try {
      if (state[field]) localStorage.setItem(key(), "1");
      else localStorage.removeItem(key());
    } catch { /* private mode / quota — the lens just won't stick */ }
  };
  return {
    toggle(on) {
      state[field] = on;
      if (!on) onOff?.();
      save();
      document.dispatchEvent(new Event("app:render"));
    },
    save,
    restore() {
      try {
        state[field] = localStorage.getItem(key()) === "1";
      } catch {
        state[field] = false;
      }
    },
  };
}

export const { toggle: toggleOdds, save: saveOdds, restore: restoreOdds } =
  boardLens("boardOdds", "showOdds");

// ── clusters: the second lens (plan Stage 3) ────────────────────────────────
// Groups of items that keep answering alike, shown as a system facet row.
// No names, no storage, no AI: a cluster reads as its own signature — the
// highest-lift chips a majority of its members hold — which is truer than a
// generated label and made of words the user already wrote. Recomputed from
// state.items like every other rail number, so new arrivals classify
// themselves and a retag moves items automatically; the only persisted state
// is the toggle.

const K = 8;             // fixed; a granularity control is the plan's open question
export const MIN_TAGS = 3; // fewer and an item has too little signal to place or match — absent, not "unclassified"; also gates the Find-similar action (grid.js)
const MIN_GROUP = 8;     // a group smaller than this (or under 3% of participants)
const MIN_SHARE = 0.03;  //   is not a cluster on any board
const MIN_SIGNATURE = 1.5; // a group whose best majority-held chip is weaker has nothing to say
const SIG_CHIPS = 3;

// Spherical k-means over unit chip vectors. Everything about the seeding is
// in service of one requirement: THE SAME BOARD MUST ALWAYS GIVE THE SAME
// PARTITION, whatever order the items arrived in — state.items grows by
// unshift/push on every delta, and a partition seeded from array position
// re-shuffles under the viewer as "the clusters changed by themselves".
// So seeds come from the data: first the item farthest from the global
// centroid, then repeatedly the item farthest from every chosen seed, ties
// broken by the identity string. (Centroid sums still add in array order,
// but a 1e-16 rounding difference flipping an argmax was never observed —
// pattern-clusters.test.js pins reversed-input equality.)
function computeClusters() {
  const participants = state.items.filter((i) => i.tags.length >= MIN_TAGS);
  const N = participants.length;
  if (N < MIN_GROUP * 2) return null;
  const chips = [...new Set(participants.flatMap((i) => i.tags))].sort();
  const D = chips.length;
  const idx = new Map(chips.map((c, i) => [c, i]));
  const k = Math.min(K, N);

  const vecs = new Float64Array(N * D);
  for (let i = 0; i < N; i++) {
    const inv = 1 / Math.sqrt(participants[i].tags.length);
    for (const t of participants[i].tags) vecs[i * D + idx.get(t)] = inv;
  }
  const dot = (ao, B, bo) => {
    let s = 0;
    for (let j = 0; j < D; j++) s += vecs[ao + j] * B[bo + j];
    return s;
  };
  const key = participants.map((p) => p.identity);
  const pick = (score) => {
    let best = 0, bs = -Infinity;
    for (let i = 0; i < N; i++) {
      const s = score(i);
      if (s > bs || (s === bs && key[i] < key[best])) { bs = s; best = i; }
    }
    return best;
  };

  const centroid = new Float64Array(D);
  for (let i = 0; i < N; i++) for (let j = 0; j < D; j++) centroid[j] += vecs[i * D + j];
  {
    let n = 0;
    for (let j = 0; j < D; j++) n += centroid[j] ** 2;
    n = Math.sqrt(n) || 1;
    for (let j = 0; j < D; j++) centroid[j] /= n;
  }
  const seeds = new Float64Array(k * D);
  const s0 = pick((i) => 1 - dot(i * D, centroid, 0));
  for (let j = 0; j < D; j++) seeds[j] = vecs[s0 * D + j];
  for (let c = 1; c < k; c++) {
    const si = pick((i) => {
      let mx = -1;
      for (let s = 0; s < c; s++) { const d = dot(i * D, seeds, s * D); if (d > mx) mx = d; }
      return 1 - mx;
    });
    for (let j = 0; j < D; j++) seeds[c * D + j] = vecs[si * D + j];
  }

  const assign = new Int32Array(N);
  for (let iter = 0; iter < 30; iter++) {
    let moved = 0;
    for (let i = 0; i < N; i++) {
      let bi = 0, bs = -1;
      for (let c = 0; c < k; c++) { const s = dot(i * D, seeds, c * D); if (s > bs) { bs = s; bi = c; } }
      if (assign[i] !== bi) { assign[i] = bi; moved++; }
    }
    seeds.fill(0);
    for (let i = 0; i < N; i++) { const o = assign[i] * D; for (let j = 0; j < D; j++) seeds[o + j] += vecs[i * D + j]; }
    for (let c = 0; c < k; c++) {
      let n = 0;
      for (let j = 0; j < D; j++) n += seeds[c * D + j] ** 2;
      n = Math.sqrt(n) || 1; // an emptied group's zero centroid stays zero
      for (let j = 0; j < D; j++) seeds[c * D + j] /= n;
    }
    if (!moved) break;
  }

  // The floors decide how many clusters are SHOWN — never how many were
  // computed. Auto-picking k was measured and rejected (separation falls
  // monotonically with k, so "best k" always degenerates to two useless
  // halves — see the plan); instead every group must earn its chip: enough
  // members, and a majority-held signature meaningfully above base rate.
  // Members of groups that don't make it land in an honest "unclassified".
  const base = new Map();
  for (const p of participants) for (const t of p.tags) base.set(t, (base.get(t) || 0) + 1);
  const floor = Math.max(MIN_GROUP, N * MIN_SHARE);
  const values = [];
  const sets = new Map();
  const unclassified = new Set(["unclassified"]);
  let anyUnclassified = false;
  for (let c = 0; c < k; c++) {
    const mem = [];
    for (let i = 0; i < N; i++) if (assign[i] === c) mem.push(i);
    if (!mem.length) continue;
    let sig = null;
    if (mem.length >= floor) {
      const local = new Map();
      for (const i of mem) for (const t of participants[i].tags) local.set(t, (local.get(t) || 0) + 1);
      const top = [...local.entries()]
        .filter(([, n]) => n >= mem.length / 2)
        .map(([t, n]) => ({ t, lift: (n / mem.length) / (base.get(t) / N) }))
        .sort((a, b) => b.lift - a.lift);
      if (top.length && top[0].lift >= MIN_SIGNATURE) sig = top.slice(0, SIG_CHIPS);
    }
    if (!sig) {
      anyUnclassified = true;
      for (const i of mem) sets.set(participants[i].id, unclassified);
      continue;
    }
    // most typical member = closest to the group's converged centroid, which
    // by linearity IS the summed-similarity argmax: Σo dot(i,o) = dot(i, Σo o),
    // seeds row c holds exactly that sum after the final M-step, and its
    // normalization is a positive scalar that can't move an argmax. The
    // written-out pairwise form of this was O(|group|²·D) — measured ~1.4s
    // for a single 3.3k-member group, vs ~1ms here, same winner.
    let medoid = mem[0], bestSum = -Infinity;
    for (const i of mem) {
      const s = dot(i * D, seeds, c * D);
      if (s > bestSum || (s === bestSum && key[i] < key[medoid])) { bestSum = s; medoid = i; }
    }
    const value = `c${c}`;
    const one = new Set([value]);
    for (const i of mem) sets.set(participants[i].id, one);
    const m = participants[medoid];
    values.push({
      value,
      size: mem.length,
      label: sig.map((x) => x.t.slice(x.t.indexOf("/") + 1)).join(" · "),
      title: `most typical: ${m.symbol || m.displayLabel || m.identity}`,
    });
  }
  if (!values.length) return null;
  values.sort((a, b) => b.size - a.size || (a.value < b.value ? -1 : 1));
  if (anyUnclassified) values.push({ value: "unclassified", label: "unclassified" });
  return { values, sets };
}

// The cache. app:render fires unconditionally on every poll tick (4s while
// anything is in flight), and the compute is ~70ms on a 4.5k board — so it
// runs only when the tag data actually changed. The change signal is exact
// and allocation-free: every writer REPLACES an item's tags array rather
// than mutating it (data.js reconcile, tag-editor.js, refreshEntityTags), so
// comparing the array references per index catches every retag, insert and
// delete. And while the board is mid-churn, the stale partition is served
// rather than re-clustering data that is still moving — settle, then compute
// once (the facet-diagnosis posture). Board switches are full page
// navigations, so nothing here needs clearing.
let cache = null; // { refs: [tags arrays], result: { values, sets } | null }

export function refreshClusters() {
  if (!state.showClusters) { cache = null; return; }
  const items = state.items;
  if (cache && cache.refs.length === items.length && cache.refs.every((r, i) => r === items[i].tags)) return;
  if (cache && items.some((i) => ACTIVE.has(i.status) || QUEUED.has(i.status))) return;
  cache = { refs: items.map((i) => i.tags), result: computeClusters() };
}

export const clusterValues = () => cache?.result?.values || [];
export const clusterSet = (img) => cache?.result?.sets.get(img.id);

// Off also clears the lens's own selection: a left-behind ~clusters chip can
// never match once the lens stops computing — it would silently filter the
// board to nothing.
export const { toggle: toggleClusters, save: saveClusters, restore: restoreClusters } =
  boardLens("boardClusters", "showClusters", () => state.selected.delete("~clusters"));

// ── similar items: the third lens verb (plan stage 1b) ──────────────────────
// "Find similar" ranks the board against one item's chips — a search the
// user didn't type. Shared chips are weighted by rarity (a chip everyone
// holds says nothing about kinship, and log2(n/holders) is zero exactly
// there), and the sum is read as a fraction of the target's own weight: how
// much of THIS item's identity does the candidate share. search.js owns the
// mode's lifecycle; this is just the scorer, one shot per invocation.
//
// Two display bounds, both measured on the plan's stocks board: a ratio
// floor alone is enough for a distinctive target but unbounded for a typical
// one — the board's most average item legitimately shares a third of its
// identity with a third of the board — so the floor pairs with the
// movers-list cap. The target itself scores 1 and outranks its ties, so the
// anchor always survives the cap.
const SIM_FLOOR = 1 / 3;
const SIM_CAP = 50;

export function similarTo(img) {
  if (img.tags.length < MIN_TAGS) return null; // too little identity to match on (the clusters rule)
  const n = state.items.length;
  const totals = new Map();
  for (const it of state.items) for (const t of it.tags) totals.set(t, (totals.get(t) || 0) + 1);
  const want = new Map();
  let self = 0;
  for (const t of img.tags) {
    const w = Math.log2(n / totals.get(t));
    want.set(t, w);
    self += w;
  }
  if (!self) return null; // every chip universal — nothing distinguishes anything
  const scored = [];
  for (const it of state.items) {
    let shared = 0;
    for (const t of it.tags) shared += want.get(t) || 0;
    const score = shared / self;
    if (score >= SIM_FLOOR) scored.push([it, score]);
  }
  scored.sort((a, b) =>
    b[1] - a[1] || (b[0] === img) - (a[0] === img) || (a[0].identity < b[0].identity ? -1 : 1));
  return new Map(scored.slice(0, SIM_CAP).map(([it, s]) => [it.id, s]));
}
