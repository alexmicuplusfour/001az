// patterns.js — derived pattern numbers over the board's tags
// (planning/pattern-surfaces-plan.md): both lenses. The ODDS lens (stage 1a)
// — a chip's count already says how many items you'd have after clicking it;
// the odds say whether that number is a lot or a little FOR THIS CHIP, given
// what's selected. The CLUSTERS lens (stage 3) — found groups of items that
// keep answering alike, worn as a rail row. Same species: computed from the
// tags in memory, nothing persisted but a per-viewer number each (the odds
// lens an on/off, the clusters lens its granularity level).

import { state } from "./state.js";
import { ACTIVE, QUEUED } from "./data.js";
import { toast } from "./toast.js";
import { clusterVectors, medoidOf, kFor, floorFor, MIN_GROUP, LEVEL_MAX } from "./cluster-core.js";

export { LEVEL_MAX }; // filters.js gates the "more" chip on it

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
// Both lenses need the same three actions over the same shape (a small
// number under `prefix:<boardId>`; 0 = off), so the trio is written once —
// the clusters copy was already the file's second and the app's fourth
// (sort.js, view.js; sparkline.js records where a fourth copy of a block
// leads). Sort and view keep their own blocks on purpose: they persist
// richer shapes (validated JSON, an enum) behind the same key convention.
// A number rather than a boolean because a lens can have DEPTH: the odds
// lens only ever stores 1, the clusters lens stores its granularity level
// (stepClusters below) — and "1" is exactly what the boolean era stored, so
// old keys restore unchanged. Toggle callers pass the new state (a
// checkbox's own `checked`) rather than asking it to derive one — the
// view.js toggleView shape, so no caller assembles the steps itself.
function boardLens(prefix, field, onOff) {
  const key = () => `${prefix}:${state.boardId}`;
  const save = () => {
    try {
      if (state[field]) localStorage.setItem(key(), String(+state[field]));
      else localStorage.removeItem(key());
    } catch { /* private mode / quota — the lens just won't stick */ }
  };
  return {
    toggle(on) {
      state[field] = +on;
      if (!on) onOff?.();
      save();
      document.dispatchEvent(new Event("app:render"));
    },
    save,
    restore() {
      try {
        state[field] = +localStorage.getItem(key()) || 0;
      } catch {
        state[field] = 0;
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

// How many groups to carve: cluster-core.js owns K and the floors now that
// two flavors share them. Auto-picking k was measured and rejected (see the
// core's seeding comment and the plan); instead the viewer holds the knob:
// the rail's "more"/"fewer" chips step the LEVEL (stepClusters), and each
// level buys K_STEP more centers.
export const MIN_TAGS = 3; // fewer and an item has too little signal to place or match — absent, not "unclassified"; also gates the Find-similar action (grid.js)
const MIN_SIGNATURE = 1.5; // a group whose best majority-held chip is weaker has nothing to say
const SIG_CHIPS = 3;

// Chip vectors into the shared k-means (cluster-core.js — the seeding and
// its THE-SAME-BOARD-ALWAYS-GIVES-THE-SAME-PARTITION requirement live
// there; state.items grows by unshift/push on every delta, which is exactly
// why the core refuses array-position seeding. pattern-clusters.test.js
// pins reversed-input equality.)
function computeClusters(level) {
  const participants = state.items.filter((i) => i.tags.length >= MIN_TAGS);
  const N = participants.length;
  if (N < MIN_GROUP * 2) return null;
  const chips = [...new Set(participants.flatMap((i) => i.tags))].sort();
  const D = chips.length;
  const idx = new Map(chips.map((c, i) => [c, i]));
  const k = kFor(level, N);

  const vecs = new Float64Array(N * D);
  for (let i = 0; i < N; i++) {
    const inv = 1 / Math.sqrt(participants[i].tags.length);
    for (const t of participants[i].tags) vecs[i * D + idx.get(t)] = inv;
  }
  const key = participants.map((p) => p.identity);
  const { assign, dotSeed } = clusterVectors(vecs, N, D, key, k);

  // The floors decide how many clusters are SHOWN — never how many were
  // computed. Auto-picking k was measured and rejected (separation falls
  // monotonically with k, so "best k" always degenerates to two useless
  // halves — see the plan); instead every group must earn its chip: enough
  // members, and a majority-held signature meaningfully above base rate.
  // Members of groups that don't make it land in an honest "unclassified".
  const base = new Map();
  for (const p of participants) for (const t of p.tags) base.set(t, (base.get(t) || 0) + 1);
  const floor = floorFor(N);
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
    const medoid = medoidOf(mem, dotSeed, c, key);
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
let cache = null; // { level, refs: [tags arrays], result: { values, sets } | null }

// ── the meaning flavor's cache (plan 3-meaning) ─────────────────────────────
// The server carves and ships the carving (a route with its own
// per-fingerprint cache); the client holds one served result per
// (board, level) and asks again only when the key changes — lens-on and
// level steps refetch, poll ticks never do, items embedded later join on
// the next ask. A failed key toasts once and stays failed until the key
// moves (a poll-tick retry loop would toast every four seconds).
let mServed = null;  // { key, result: { values, sets: Map } }
let mPending = null; // key in flight
let mFailed = null;  // key that errored

function refreshMeaning(level) {
  const key = `${state.boardId}|${level}`;
  if (mServed?.key === key || mPending === key || mFailed === key) return;
  mPending = key;
  fetch(`/api/boards/${state.boardId}/meaning-clusters?level=${level}`)
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((body) => {
      if (mPending !== key) return; // superseded by a level step or toggle
      mPending = null;
      // The membership contract is id -> SET (entityHasValue calls .has, the
      // rail counts through it) — one shared Set per group, the chip
      // flavor's own economy.
      const group = new Map();
      const sets = new Map(body.sets.map(([id, v]) => {
        let s = group.get(v);
        if (!s) group.set(v, s = new Set([v]));
        return [id, s];
      }));
      mServed = { key, result: { values: body.values, sets } };
      document.dispatchEvent(new Event("app:render"));
    })
    .catch(() => {
      if (mPending !== key) return;
      mPending = null;
      mFailed = key;
      toast.error("Couldn't load meaning clusters");
    });
}

export function refreshClusters() {
  if (state.showMeaningClusters) {
    cache = null;
    refreshMeaning(clusterLevel());
    return;
  }
  mServed = mPending = mFailed = null;
  const level = clusterLevel();
  if (!level) { cache = null; return; }
  const items = state.items;
  // The stale-serve gates apply only within a level: a level change is the
  // viewer asking for a different carving right now, so it recomputes even
  // mid-churn.
  if (cache && cache.level === level) {
    if (cache.refs.length === items.length && cache.refs.every((r, i) => r === items[i].tags)) return;
    if (items.some((i) => ACTIVE.has(i.status) || QUEUED.has(i.status))) return;
  }
  cache = { level, refs: items.map((i) => i.tags), result: computeClusters(level) };
}

// One row, two carvings: the accessors answer for whichever flavor is on.
const activeResult = () => (state.showMeaningClusters ? mServed?.result : cache?.result);
export const clusterValues = () => activeResult()?.values || [];
export const clusterSet = (item) => activeResult()?.sets.get(item.id);

// The granularity knob, clamped: the ACTIVE flavor's field holds the level
// (0 = off), and out-of-range stored values just pin to the nearest end.
const activeField = () => (state.showMeaningClusters ? "showMeaningClusters" : "showClusters");
export const clusterLevel = () => Math.min(state[activeField()], LEVEL_MAX);

// One step up or down the levels — the rail's "more"/"fewer" chips, for
// whichever flavor is on. A step re-carves the WHOLE row (more centers is a
// different partition, not the old one plus extras), so the lens's own
// selection clears like it does on toggle-off: the old names no longer name
// those groups.
export function stepClusters(delta) {
  const field = activeField();
  const cur = Math.min(state[field], LEVEL_MAX);
  const next = Math.max(1, Math.min(LEVEL_MAX, cur + delta));
  if (!cur || next === cur) return;
  state[field] = next;
  state.selected.delete("~clusters");
  (field === "showClusters" ? saveClusters : saveMeaningClusters)();
  document.dispatchEvent(new Event("app:render"));
}

// Off also clears the lens's own selection: a left-behind ~clusters chip can
// never match once the lens stops computing — it would silently filter the
// board to nothing. The two flavors are MUTUALLY EXCLUSIVE, and the rule
// lives here rather than in the menu: turning one on turns the other off
// (which also clears the selection — the other carving's values can't
// match). On a restore where both boards somehow stored a level (two tabs,
// two toggles), meaning wins, arbitrarily but stated.
const tagsLens = boardLens("boardClusters", "showClusters", () => state.selected.delete("~clusters"));
const meaningLens = boardLens("boardClustersM", "showMeaningClusters", () => state.selected.delete("~clusters"));
export const saveClusters = tagsLens.save;
export const restoreClusters = tagsLens.restore;
export const saveMeaningClusters = meaningLens.save;
export function toggleClusters(on) {
  if (on && state.showMeaningClusters) meaningLens.toggle(false);
  tagsLens.toggle(on);
}
export function toggleMeaningClusters(on) {
  if (on && state.showClusters) tagsLens.toggle(false);
  meaningLens.toggle(on);
}
export function restoreMeaningClusters() {
  meaningLens.restore();
  if (state.showMeaningClusters && state.showClusters) state.showClusters = 0;
}

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

export function similarTo(item) {
  if (item.tags.length < MIN_TAGS) return null; // too little identity to match on (the clusters rule)
  const n = state.items.length;
  const totals = new Map();
  for (const it of state.items) for (const t of it.tags) totals.set(t, (totals.get(t) || 0) + 1);
  const want = new Map();
  let self = 0;
  for (const t of item.tags) {
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
    b[1] - a[1] || (b[0] === item) - (a[0] === item) || (a[0].identity < b[0].identity ? -1 : 1));
  return new Map(scored.slice(0, SIM_CAP).map(([it, s]) => [it.id, s]));
}
