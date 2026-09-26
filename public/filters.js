import { itemsVersion } from './state-signals.js';
import { state } from './state.js';
import { tag, ICONS } from './utils.js';
import { html, render } from './vendor/preact.mjs';
import { computed, batch } from './vendor/signals.mjs';
import { Pill } from './pill.js';
import { facetPass, selEntry, halvesOf, wireEntry, canonEntry, selSize, selHas, selValues, encodePairs, decodePairs, pruneToDeclared } from './facet-match.js';
import { ACTIVE, QUEUED } from './data.js';
import { applyBoardSort } from './sort.js';
import { chipOdds, clusterSet, clusterValues, clusterLevel, stepClusters } from './patterns.js';
import { LEVEL_MAX } from './cluster-core.js';
import { lockScroll, unlockScroll } from './modal.js';
import { toast } from './toast.js';

const elFilters = document.getElementById("filters");
const elFilterDrawer = document.getElementById("filter-drawer");
const elFiltersMobile = document.getElementById("filters-mobile");

export function filterKey() {
  // The triple keeps include and exclude apart — ["dark"] selected and
  // ["dark"] excluded must never share a render-cache key.
  const sel = [...state.selected.entries()]
    .map(([k, v]) => [k, [...v.any].sort(), [...v.not].sort()])
    .filter(([, any, not]) => any.length || not.length)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([sel, state.showFavorites, state.showUntagged, state.showProcessing, state.showUnprocessed, state.sort, state.selectedCrateId, state.alertEvent?.id ?? null, state.boardId, state.searchResults ? state.searchQuery : ""]);
}

// ── System facets ────────────────────────────────────────────────────────────
// Reserved `~`-prefixed keys in state.selected whose membership comes from a
// capability's own set instead of tags — detections today (`~objects`: the
// object field keys with ≥1 box, distilled onto the list payload); uploaders
// and persons to follow (planning/objects-filter-row-plan.md). Living inside
// state.selected means saved configs, ?f= URLs, filterKey/activeCount/clearAll
// and the rows walk-in all work unchanged — MEMBERSHIP is the only seam, routed
// here. Each entry names an entity-level source and an instance-level one
// (null = an entity-level dimension: instanceMatches skips it rather than
// dimming every tile). The `~` prefix can't collide with real facets: mapping
// field keys match /^[a-z][a-z0-9_]*$/ and the admin facet UI produces
// word-like keys.
export const SYSTEM_FACETS = {
  // The clusters lens (patterns.js): membership is a per-render computed map
  // rather than a field on the item — the one entry here that closes over
  // module state instead of reading its argument. refreshClusters() runs at
  // the top of render(), so by the time anything asks, the map is current.
  // Entity-level (a cluster is a judgment about the whole entity's answers).
  "~clusters": { label: "CLUSTERS", entity: clusterSet, instance: null },
  "~objects": { label: "OBJECTS", entity: (x) => x.objectSet, instance: (x) => x.objectSet },
  // Uploaders were the original separate-slot filter (selectedUploaderIds +
  // ?u=); folded here so saved configs stop dropping them and every consumer
  // shares one model. Values are STRING user ids. Entity-level only.
  "~uploaders": { label: "UPLOADED BY", entity: (x) => x.uploaderIdSet, instance: null },
};
const SYSTEM_FACET_ENTRIES = Object.entries(SYSTEM_FACETS);

// Does the entity carry `value` under facet `key`? Tag strings for regular
// facets, the system facet's own set otherwise.
function entityHasValue(item, key, value) {
  const sys = SYSTEM_FACETS[key];
  if (sys) { const set = sys.entity(item); return !!set && set.has(value); }
  return item.tagSet.has(tag(key, value));
}

function instanceHasValue(inst, key, value) {
  const sys = SYSTEM_FACETS[key];
  if (sys) { const set = sys.instance?.(inst); return !!set && set.has(value); }
  return inst.tagSet.has(tag(key, value));
}

function matchesExcept(item, exceptKey, selected) {
  for (const [key, values] of selected) {
    // Toggled-empty entries linger in the map; skip them before paying the
    // closure + facetPass call per item — this loop runs per render pass.
    if (key === exceptKey || !selSize(values)) continue;
    if (!facetPass((v) => entityHasValue(item, key, v), values.any, values.not)) return false;
  }
  return true;
}

// Does ONE instance satisfy the active facet selections on its own? Entity
// matching above is per-facet-any-instance (over the union tagSet), so an
// entity can match while no single instance does — short from one photo,
// emma-roberts from another. Rows mode dims tiles that fail this rather than
// hiding them; such an entity renders as an all-dim strip ("matches only in
// aggregate"), never an empty one. Facet pills only — search scores,
// favorites, crates and status are entity-level concerns with no per-instance
// counterpart — and likewise a system facet with no instance source is
// skipped, while one that has one (`~objects`: which photo holds the car)
// dims like any facet.
export function instanceMatches(inst) {
  for (const [key, values] of state.selected) {
    if (!selSize(values)) continue;
    const sys = SYSTEM_FACETS[key];
    if (sys && !sys.instance) continue; // entity-level dimension — every tile passes
    if (!facetPass((v) => instanceHasValue(inst, key, v), values.any, values.not)) return false;
  }
  return true;
}

// "Done" as far as the grid is concerned — held items (waiting for the
// board's auto-tagging to come back on) show up like any other untagged item.
export function isTagged(item) {
  if (item.tags.length > 0) return true;
  return item.status === "tagged" || item.status === "failed" || item.status === "held" || !item.status;
}

export function isUntagged(item) {
  return item.tags.length === 0;
}

// Does this board tag its items at all? No taxonomy means nothing to tag
// against, so "untagged" isn't a meaningful state here — it's just how every
// item looks. Manual tagging is gated on the same fact (the grid/rows/lightbox
// tag-editor footers), so a board with no facets has no path to tags at all.
export function boardHasTaxonomy() {
  return state.facets.length > 0;
}

// The grid's dotted "needs a human" treatment: an item with no usable tags on a
// board that actually tags. AI-undecided (looked, couldn't decide), held
// (waiting for auto-tagging to resume), or plain untagged (failed / hand-cleared
// / never run) all qualify — but only where there's a taxonomy to tag against.
export function needsTags(item) {
  return boardHasTaxonomy() && (item.undecided || item.status === "held" || isUntagged(item));
}

// Status pills OR together (an item has exactly one status), the same way
// values within a facet do. With none active, the usual isTagged gate keeps
// in-flight items out of the grid — the progress lane is their home.
function statusFilter() {
  const sets = [];
  if (state.showProcessing) sets.push(ACTIVE);
  if (state.showUnprocessed) sets.push(QUEUED);
  if (!sets.length) return isTagged;
  return (item) => sets.some((s) => s.has(item.status));
}

// The filtered, sorted list, worked out from scratch. The page reads the cached
// copy (taggedFiltered, below); this is for that cache, the tests' check and
// the bench.
export function filterItems() {
  const statusOk = statusFilter();
  // Each field is read once, not once per item: every `state.x` is a signal
  // read through a getter (state-signals.js), and 5000 items × five fields cost
  // ~2ms at 4x-slowed CPU (planning/ui-updates-plan.md, Stage 3).
  const { searchResults, showUntagged, showFavorites, selectedCrateId, alertEvent, selected } = state;
  const list = state.items.filter(
    (item) =>
      statusOk(item) &&
      (searchResults == null || searchResults.has(item.id)) &&
      (!showUntagged || isUntagged(item)) &&
      (!showFavorites || item.favoritedByMe) &&
      (selectedCrateId == null || item.crateIds.has(selectedCrateId)) &&
      (alertEvent == null || alertEvent.ids.has(item.id)) &&
      matchesExcept(item, null, selected)
  );
  // While a search is active its similarity order wins outright — the chosen
  // board sort resumes when the search clears. Otherwise the attribute sort
  // (sort.js) over the server order (newest first).
  if (searchResults) list.sort((a, b) => searchResults.get(b.id) - searchResults.get(a.id));
  else applyBoardSort(list);
  return list;
}

// One pass over the items computing every number the pills need; replaces
// per-pill rescans, which cost items × pills on every render. Counts keep
// the matchesExcept semantics: a value counts items that match every OTHER
// active facet, but not necessarily its own. Tags are split at the first
// "/" to find their facet, so facet keys must not contain slashes (the
// facet/value tag convention already requires this).
export function computeFacetStats() {
  const activeSel = [...state.selected].filter(([, v]) => selSize(v));
  const { showFavorites, selectedCrateId } = state; // read once, as filterItems does
  const totals = new Map(); // "facet/value" -> count over all items
  const counts = new Map(); // "facet/value" -> count in the current filter context
  // An EXCLUDED chip answers a different question than an included one.
  // `counts` (leave the whole facet out) is right for includes — "add this
  // to the OR and N items appear" — but an exclusion's honest number is the
  // marginal: "un-strike this and N items come back", which must respect the
  // facet's OWN include half. With comfortable included, striking roomy on a
  // single-valued facet removes nothing — the chip must say 0, not −29.
  const negCounts = new Map(); // "facet/value" -> items restored by un-striking
  const negFacets = new Map(activeSel.filter(([, v]) => v.not.size));
  const restoredBy = (has, entry, value) => {
    if (!facetPass(has, entry.any)) return false;
    for (const w of entry.not) if (w !== value && has(w)) return false;
    return true;
  };
  // The sizes of the leave-one-out contexts `counts` live in: a chip under
  // facet F counts items that match every OTHER active facet, so its context
  // holds ctxAll (items failing no facet) plus ctxFail[F] (items failing only
  // F). The odds lens divides by these; nothing else reads them.
  let ctxAll = 0;
  const ctxFail = new Map();
  const facetsWithData = new Set();
  let totalUntagged = 0;
  let untaggedInContext = 0;
  let totalActive = 0;
  let activeInContext = 0;
  let totalQueued = 0;
  let queuedInContext = 0;
  // The uploader row's universe (uid -> total). Chip CONTEXT counts come from
  // the shared `counts` map via the `~uploaders` system-facet projection.
  const uploaderTotals = new Map();

  for (const item of state.items) {
    for (const t of item.tags) {
      totals.set(t, (totals.get(t) || 0) + 1);
      const slash = t.indexOf("/");
      if (slash > 0) facetsWithData.add(t.slice(0, slash));
    }
    // System-facet memberships project into the same maps as tags
    // ("~objects/car"), so the chip totals/counts machinery is shared verbatim.
    for (const [sk, sys] of SYSTEM_FACET_ENTRIES) {
      for (const v of sys.entity(item) || []) {
        const t = tag(sk, v);
        totals.set(t, (totals.get(t) || 0) + 1);
      }
    }

    if (item.uploadedBy) {
      uploaderTotals.set(item.uploadedBy.id, (uploaderTotals.get(item.uploadedBy.id) || 0) + 1);
    }

    // How many active facets does this item fail? It counts toward a
    // facet's values when it matches all the others: fails none, or
    // fails only that facet itself.
    let fails = 0;
    let failKey = null;
    for (const [key, values] of activeSel) {
      if (!facetPass((v) => entityHasValue(item, key, v), values.any, values.not)) {
        fails++; failKey = key;
        if (fails > 1) break;
      }
    }

    // An uploader selection rides `fails` like any facet (the `~uploaders`
    // system key sits in activeSel), so no separate uploader gate.
    const inContext = fails === 0 && (!showFavorites || item.favoritedByMe) && (selectedCrateId == null || item.crateIds.has(selectedCrateId));

    if (isTagged(item) && isUntagged(item)) {
      totalUntagged++;
      if (inContext) untaggedInContext++;
    }
    if (ACTIVE.has(item.status)) {
      totalActive++;
      if (inContext) activeInContext++;
    } else if (QUEUED.has(item.status)) {
      totalQueued++;
      if (inContext) queuedInContext++;
    }

    if (fails > 1) continue;
    // Riding the early-out above: an item counts toward the context its chips
    // count in — everything's, or only the one facet it fails.
    if (fails) ctxFail.set(failKey, (ctxFail.get(failKey) || 0) + 1);
    else ctxAll++;
    for (const t of item.tags) {
      const slash = t.indexOf("/");
      if (slash <= 0) continue;
      const fk = t.slice(0, slash);
      if (fails === 1 && fk !== failKey) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
      const entry = negFacets.get(fk);
      const value = entry?.not.has(t.slice(slash + 1)) ? t.slice(slash + 1) : null;
      if (value != null && restoredBy((x) => entityHasValue(item, fk, x), entry, value)) {
        negCounts.set(t, (negCounts.get(t) || 0) + 1);
      }
    }
    for (const [sk, sys] of SYSTEM_FACET_ENTRIES) {
      if (fails === 1 && sk !== failKey) continue;
      const entry = negFacets.get(sk);
      for (const v of sys.entity(item) || []) {
        const t = tag(sk, v);
        counts.set(t, (counts.get(t) || 0) + 1);
        if (entry?.not.has(v) && restoredBy((x) => entityHasValue(item, sk, x), entry, v)) {
          negCounts.set(t, (negCounts.get(t) || 0) + 1);
        }
      }
    }
  }
  return {
    totals, counts, negCounts, ctxAll, ctxFail, facetsWithData,
    totalUntagged, untaggedInContext,
    totalActive, activeInContext,
    totalQueued, queuedInContext,
    uploaderTotals,
  };
}

export function activeCount() {
  let n = 0;
  for (const values of state.selected.values()) n += selSize(values);
  if (state.showUntagged) n++;
  if (state.showProcessing) n++;
  if (state.showUnprocessed) n++;
  return n;
}

// ── Cached (planning/ui-updates-plan.md, Stage 3) ──────────────────────────
// The chip counts and the filtered list are worked out again only when
// something they read has changed, not on every repaint: a poll tick that
// brought nothing costs no recount. Each `computed` notices the `state` fields
// it read (they're signals, state-signals.js), the clusters grouping
// (patterns.js), and the items version, which stands in for the items' own
// fields since those change in place (itemsChanged).
const cachedStats = computed(() => { itemsVersion.value; return computeFacetStats(); });
const cachedList = computed(() => { itemsVersion.value; return filterItems(); });
const cachedFavorites = computed(() => cachedList.value.filter((item) => item.favoritedByMe).length);

// The filtered list the page shows: the grid, the rows view, the lightbox and
// render() all read this one copy, and none of them edits it.
export const taggedFiltered = () => cachedList.value;

// Favorites in the current filter context — counted over the filtered list,
// so it stays in sync with facet chips, search, crate, and untagged filters.
export const favoritesInContext = () => cachedFavorites.value;

// The check the tests switch on: the cached values against a fresh
// computation, once a repaint (app.js). A writer that changes an item without
// itemsChanged(), or edits the selection in place, would leave the rail
// showing old numbers without a sound; with the flag set it throws instead.
// The browser harness sets it on every page it opens.
export function checkCached() {
  const same = (a, b) => {
    if (a === b) return true;
    if (a instanceof Map) return b instanceof Map && a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k)));
    if (a instanceof Set) return b instanceof Set && a.size === b.size && [...a].every((v) => b.has(v));
    if (a && b && typeof a === "object") return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => same(a[k], b[k]));
    return false;
  };
  const fresh = filterItems();
  const list = cachedList.value;
  if (list.length !== fresh.length || list.some((item, i) => item !== fresh[i])) {
    throw new Error("checkCached: the cached filtered list differs from a fresh one. Something changed an item without itemsChanged(), or edited state in place.");
  }
  if (cachedFavorites.value !== fresh.filter((item) => item.favoritedByMe).length) {
    throw new Error("checkCached: the cached favorites count differs from a fresh one. Something changed an item without itemsChanged().");
  }
  if (!same(cachedStats.value, computeFacetStats())) {
    throw new Error("checkCached: the cached chip counts differ from fresh ones. Something changed an item without itemsChanged(), or edited state in place.");
  }
}

// One body for both verbs, so the each-state-clears-the-other rule can't
// drift between them: toggling a value into one half removes it from the
// sibling. The entry is copied into a new map rather than edited: the cached
// counts notice only a new value.
function toggleHalf(facetKey, value, mine, other) {
  const was = state.selected.get(facetKey);
  const entry = selEntry(was?.any, was?.not);
  if (entry[mine].has(value)) entry[mine].delete(value);
  else { entry[mine].add(value); entry[other].delete(value); }
  state.selected = new Map(state.selected).set(facetKey, entry);
}

export const toggle = (facetKey, value) => toggleHalf(facetKey, value, "any", "not");
// The exclusion twin — right-click / Alt+click / long-press land here.
export const toggleNeg = (facetKey, value) => toggleHalf(facetKey, value, "not", "any");

// The exclusion gesture, wired ONCE per rail container (the containers are
// fixed; only what's drawn in them changes): one contextmenu listener covers
// desktop right-click and Android's native long-press alike. iOS never fires
// contextmenu for touches, so iOS has NO exclusion gesture yet — deliberately:
// the timer-and-click-swallow rig that stood here was speculative complexity
// for an untested platform, and its swallow flag ate real clicks on
// desktop. Build the iOS path from a device, not a guess. Chips carry
// their address in data-facet/data-value; pills without one (status, the
// clusters row's fewer/more steps) are ignored.
const excludeWired = new WeakSet();
function wireExclusion(container) {
  if (excludeWired.has(container)) return;
  excludeWired.add(container);
  container.addEventListener("contextmenu", (e) => {
    const el = e.target.closest?.(".pill");
    if (el?.dataset.facet == null) return;
    e.preventDefault();
    toggleNeg(el.dataset.facet, el.dataset.value);
  });
}

export function clearAll() {
  batch(() => {
    state.selected = new Map();
    state.showUntagged = false;
    state.showProcessing = false;
    state.showUnprocessed = false;
  });
}

function toggleFlag(flag) {
  state[flag] = !state[flag];
}

// --- saved filter configs + URL encoding ---
// A config is the facet selection as a plain object; entry shapes and the
// legacy-array rule live in facet-match.js (halvesOf/wireEntry). Loading one
// is one-shot — it just sets the pills, nothing stays "applied".

export function selectedAsConfig() {
  const out = {};
  for (const [key, values] of state.selected) {
    const wire = wireEntry(values.any, values.not);
    if (wire) out[key] = wire;
  }
  return out;
}

// One batch: the selection lands already trimmed, so the view's rows choice
// (a ratchet, view.js) never sees the half-applied one.
export function applyFilterConfig(config) {
  batch(() => {
    state.selected = new Map(
      Object.entries(config || {}).map(([k, v]) => {
        const { any, not } = halvesOf(v);
        return [k, selEntry(any, not)];
      })
    );
    reconcileSelection();
  });
}

// THE gate for a selection that came from outside the rail — a saved config, a
// ?f= link, an alert's condition, and the sentence-to-selection search being
// built (conversational-search-plan.md), which is an AI naming facet values and
// so the one caller certain to name one that never existed. Every one of them
// writes state.selected and then lands here rather than carrying its own check;
// a fifth road to this Map is a matter of time, and the check it would have
// copied is the drift this replaces.
//
// Also the half a door can't see: a selection that was VALID when it arrived
// and stopped being valid while it sat there, which is what the board modal
// does to its own reader (toolbar.js re-stamps state.facets on save). That is
// the likeliest way anyone reaches this state at all — you delete the value you
// are standing on — so the modal calls this too.
//
// Silent when there is nothing to say. Otherwise a plain toast: the pills that
// vanish are the only other evidence, and the rail draws no chip for a value
// the board stopped declaring, so without this the filter count just changes on
// its own. Names the value while there is one to name — "red" is the whole
// explanation; a count is all that's left past that.
export function reconcileSelection() {
  const { selected, dropped } = pruneToDeclared(state.selected, state.facets);
  if (!dropped.length) return 0;
  state.selected = selected;
  toast(dropped.length === 1
    ? `Skipped "${dropped[0].value}" — this board doesn't have it any more`
    : `Skipped ${dropped.length} filters — this board doesn't have them any more`);
  return dropped.length;
}

// True when a config matches the current pills exactly — pure feedback for
// highlighting, not a mode. Compared canonically (canonEntry: sorted, both
// entry forms alike): JSONB reorders object keys, so plain stringify
// comparison would lie.
function canonConfig(config) {
  return JSON.stringify(
    Object.keys(config).sort().map((k) => [k, canonEntry(config[k])])
  );
}

export function configMatchesCurrent(config) {
  return canonConfig(config) === canonConfig(selectedAsConfig());
}

// The wire codec itself (encodePairs/decodePairs) lives in facet-match.js —
// alert firing links encode the same format server-side, so the two sides
// share one implementation. ?f= carries the include halves (its meaning
// since day one, so old links decode unchanged), ?fx= the exclude halves;
// an old build ignores ?fx= and shows the less-filtered view.
const encodeHalf = (half) =>
  encodePairs([...state.selected.entries()].map(([k, v]) => [k, v[half]]));

export const encodeSelected = () => encodeHalf("any");
export const encodeExcluded = () => encodeHalf("not");

// Both params into entries; an fx-only key is a valid selection with an
// empty include half.
export function decodeSelection(fStr, fxStr) {
  const map = new Map();
  for (const [key, values] of decodePairs(fStr)) map.set(key, selEntry(values));
  for (const [key, values] of decodePairs(fxStr)) {
    const entry = map.get(key) || selEntry();
    for (const v of values) entry.not.add(v);
    map.set(key, entry);
  }
  return map;
}

// Mirror the current selection into ?f= so filtered views are shareable
// links. replaceState keeps Back/Forward out of it.
export function syncFiltersToUrl() {
  const url = new URL(location.href);
  const f = encodeSelected();
  if (f) url.searchParams.set("f", f);
  else url.searchParams.delete("f");
  const fx = encodeExcluded();
  if (fx) url.searchParams.set("fx", fx);
  else url.searchParams.delete("fx");
  // Uploaders ride ?f= as the ~uploaders facet now; drop the legacy ?u= so an
  // old link's param migrates away on the first filter change.
  url.searchParams.delete("u");
  const next = url.pathname + url.search;
  if (next !== location.pathname + location.search) history.replaceState(null, "", next);
}

// Draws the rail into `container` with Preact (planning/ui-updates-plan.md,
// Stage 1), which compares what should be there with what is and changes only
// the difference. A chip stays the same element for as long as it's in the
// rail, whatever changes on it, so the keyboard focus on it survives the
// poll's repaints and the chip's own toggle.
// Everything below keys its rows and chips so the comparison can find them
// again: see `row` for why rows need it too.
export function renderFacetsInto(container, stats = computeFacetStats()) {
  wireExclusion(container);
  const {
    totals, counts, negCounts, ctxAll, ctxFail, facetsWithData,
    totalUntagged, untaggedInContext,
    totalActive, activeInContext,
    totalQueued, queuedInContext,
    uploaderTotals,
  } = stats;
  // ONE chip, wherever it comes from. A facet value, an object key and an
  // uploader differ only in where the universe and the label come from —
  // the tag string, the context count, the active/muted rules, the toggle and
  // the odds mark are the same three lines each time, and were written out
  // three times until the lens needed a fourth thing said in all three places
  // (planning/objects-filter-row-plan.md folded MEMBERSHIP and COUNTING into
  // the system-facet registry and stopped short of construction; this is the
  // rest of that fold).
  //
  // The odds (patterns.js) ride here for the same reason: active chips are
  // chosen and muted ones impossible, so neither carries a number — one rule,
  // one place.
  const chip = (facetKey, value, label = value, title) => {
    const t = tag(facetKey, value);
    const ctxCount = counts.get(t) || 0;
    const entry = state.selected.get(facetKey);
    const active = entry?.any.has(value) || false;
    const negated = entry?.not.has(value) || false;
    // A negated chip's count is what un-striking would restore (negCounts —
    // it respects the facet's own include half), signed so the pill explains
    // itself; plain 0 when the strike removes nothing, never "−0". Negated
    // is a CHOSEN state: never muted, no odds badge, same as active.
    const removed = negated ? negCounts.get(t) || 0 : 0;
    const count = negated ? (removed ? `−${removed}` : 0) : ctxCount;
    const odds = state.showOdds && !active && !negated && chipOdds(stats, facetKey, t);
    // Keyed by value: its row is keyed by facet, so within the row the value
    // alone finds the same chip again when the chips around it come and go.
    // facet/value are also the address the container-level exclusion gesture
    // reads (wireExclusion). `title` is only ever a cluster's signature.
    return html`<${Pill} key=${value} label=${label} count=${count} active=${active}
      muted=${!active && !negated && ctxCount === 0} neg=${negated} title=${title}
      facet=${facetKey} value=${value}
      onClick=${(e) => (e.altKey ? toggleNeg : toggle)(facetKey, value)}
    >${odds ? html`<span class=${`mult mult-${odds.tone}`}>${odds.text}</span>` : null}</${Pill}>`;
  };
  // ...and ONE labeled row: the scaffold every band row shares. Filling it —
  // the universe rules — is the only thing that actually differs per row.
  // The status row keeps its own spacer variant.
  //
  // Keyed by facet, not left to position. When a row appears above another
  // (the status row does, as soon as anything starts processing), rows matched
  // by position would each be redrawn as the row above them, and a chip with
  // keyboard focus would be replaced and lose it. Measured in the plan's
  // Stage 1 close look; the keys test in test/browser/ui-updates.test.js
  // holds it.
  const row = (key, labelText, pills) =>
    html`<div class="facet" key=${key}><div class="facet-label">${labelText}</div><div class="pills">${pills}</div></div>`;
  // An ACTION riding a pill row — the clusters row's "more"/"fewer" steps. It
  // borrows the pill's shape so the row reads as one line, but not the white
  // fill: in the rail, the filled capsule means "a value you can select", and
  // an action is not one. `title` is required — with no count and no active
  // state, the one line of hover help is all the explanation these get.
  const stepPill = (label, title, step) =>
    html`<button class="pill pill-action" key=${label} title=${title} onClick=${() => stepClusters(step)}>${label}</button>`;
  const rows = [];
  // The status row: Untagged plus the two queue pills (Processing = actively
  // worked, Unprocessed = waiting in line). Each shows only while it has items
  // or is switched on, so the row disappears entirely on a quiet board.
  const statusPills = [
    // Untagged only where there's a taxonomy to tag against (the needsTags
    // discipline) — on a facet-less board every item is "untagged" forever and
    // the pill just filters to everything. The active-flag escape keeps an
    // already-on pill clearable if the facets are deleted mid-session.
    ...(boardHasTaxonomy() || state.showUntagged
      ? [["Untagged", totalUntagged, untaggedInContext, "showUntagged"]]
      : []),
    ["Processing", totalActive, activeInContext, "showProcessing"],
    ["Unprocessed", totalQueued, queuedInContext, "showUnprocessed"],
  ].filter(([, total, , flag]) => total > 0 || state[flag]);
  if (statusPills.length) {
    rows.push(html`<div class="facet facet-untagged" key="~status"><div class="facet-label facet-label-empty" aria-hidden="true"></div><div class="pills">${
      statusPills.map(([label, , ctx, flag]) => html`<${Pill} key=${flag} label=${label} count=${ctx}
        active=${state[flag]} muted=${!state[flag] && ctx === 0} onClick=${() => toggleFlag(flag)} />`)
    }</div></div>`);
  }
  // The CLUSTERS row — the `~clusters` lens, first of the labeled band when
  // it's on: it is the most compressed view of the board, so it reads first.
  // A chip is a found group wearing its own signature (its highest-lift
  // majority chips) as the label — value and label differ, the uploader-row
  // pattern. The second loop is the escape hatch for a selection whose
  // cluster no longer exists (a URL from an older partition): a click-off
  // chip, same as a gone uploader. The tail chips are the granularity knob
  // (stepClusters): plain steps, offered whenever there's room to step —
  // whether another carving finds more structure is the viewer's to see,
  // and an overshoot is one "fewer" away.
  {
    const sel = state.selected.get("~clusters") || selEntry();
    const values = clusterValues();
    if (values.length || selSize(sel)) {
      const shown = new Set(values.map((v) => v.value));
      const pills = [
        ...values.map((v) => chip("~clusters", v.value, v.label, v.title || undefined)),
        ...selValues(sel).filter((value) => !shown.has(value)).map((value) => chip("~clusters", value)),
      ];
      if (clusterLevel() > 1) pills.push(stepPill("fewer", "Carve the board into fewer groups", -1));
      if (clusterLevel() < LEVEL_MAX && values.length) pills.push(stepPill("more", "Carve the board into more groups", 1));
      rows.push(row("~clusters", SYSTEM_FACETS["~clusters"].label, pills));
    }
  }
  // The OBJECTS row — the `~objects` system facet
  // (planning/objects-filter-row-plan.md). Chip universe is the mapping's
  // DECLARED object fields (so a removed field's lingering data can't grow
  // chips — the state.facets discipline), plus any selected-but-gone key so an
  // active chip always has a click-off. Chips are the field keys (the user's
  // declared name for the object type; hint synonyms demux into one field).
  // Same visibility rule as facet values — data or active, else hidden — and
  // the row vanishes when no chip is visible.
  {
    const sel = state.selected.get("~objects") || selEntry();
    const declared = (state.boardMapping?.fields || [])
      .filter((f) => f.source === "detect")
      .map((f) => f.key);
    const chips = [...new Set([...declared, ...selValues(sel)])].filter(
      (key) => (totals.get(tag("~objects", key)) || 0) > 0 || selHas(sel, key)
    );
    if (chips.length) rows.push(row("~objects", SYSTEM_FACETS["~objects"].label, chips.map((key) => chip("~objects", key))));
  }
  // Uploader row — the `~uploaders` system facet (entity-level: never dims
  // rows tiles). Universe = distinct uploaders in the board (2+ to show, the
  // original rule) plus any selected-but-gone id, so an active chip always
  // has a click-off; names resolve from items, falling back to the raw id.
  {
    const sel = state.selected.get("~uploaders") || selEntry();
    if (uploaderTotals.size >= 2 || selSize(sel) > 0) {
      // Sorted by count, so a poll can re-sort this row, and Chromium drops
      // focus from a chip that moves even when it's the same element: a known
      // limit (the plan's Stage 1). The clusters row, sorted by size, has it
      // too; facet and object rows keep their declared order and never move a
      // chip.
      const uploaderItems = [...uploaderTotals.entries()].sort((a, b) => b[1] - a[1]);
      const pills = [];
      const shown = new Set();
      for (const [uid, total] of uploaderItems) {
        const key = String(uid);
        if (total === 0 && !selHas(sel, key)) continue;
        shown.add(key);
        const uploader = state.items.find((item) => item.uploadedBy?.id === uid)?.uploadedBy;
        pills.push(chip("~uploaders", key, uploader ? (uploader.name || uploader.email) : key));
      }
      // Selected but gone from the board — chip() lands the same pill by
      // arithmetic (no items means no context count, so: active, unmuted).
      for (const key of selValues(sel)) {
        if (!shown.has(key)) pills.push(chip("~uploaders", key));
      }
      rows.push(row("~uploaders", SYSTEM_FACETS["~uploaders"].label, pills));
    }
  }

  for (const facet of state.facets) {
    const sel = state.selected.get(facet.key) || selEntry();
    if (!facetsWithData.has(facet.key) && selSize(sel) === 0) continue;
    const pills = [];
    for (const value of facet.values) {
      const total = totals.get(tag(facet.key, value)) || 0;
      if (total === 0 && !selHas(sel, value)) continue;
      pills.push(chip(facet.key, value));
    }
    rows.push(row(facet.key, facet.label, pills));
  }
  render(rows, container);
}

export function renderFacets() {
  elFilters.classList.toggle("is-hidden", state.filtersHidden);
  const stats = cachedStats.value;
  if (!state.filtersHidden) renderFacetsInto(elFilters, stats);
  renderFacetsInto(elFiltersMobile, stats);
  // drawer header: mirror the toolbar's "Clear filters (n)" button
  const clear = document.getElementById("filter-drawer-clear");
  const n = activeCount();
  clear.hidden = n === 0;
  clear.innerHTML = ICONS.x + `<span>Clear filters (${n})</span>`;
}

function toggleFiltersDesktop() {
  // When at the top, animate naturally. When scrolled, compensate scroll so
  // the grid doesn't jump under the sticky header.
  if (window.scrollY <= 4) {
    state.filtersHidden = !state.filtersHidden;
    return;
  }
  elFilters.style.transition = "none";
  const before = elFilters.offsetHeight;
  state.filtersHidden = !state.filtersHidden; // draws at once, so the height below is the new one
  const after = elFilters.offsetHeight;
  window.scrollBy(0, after - before);
  void elFilters.offsetHeight; // flush before re-enabling transition
  elFilters.style.transition = "";
}

// The shared lock is ref-counted, so open/close must stay balanced — the
// is-open class is the drawer's own record of holding a count.
export function openFilterDrawer() {
  if (elFilterDrawer.classList.contains("is-open")) return;
  elFilterDrawer.classList.add("is-open");
  lockScroll();
}

export function closeFilterDrawer() {
  if (!elFilterDrawer.classList.contains("is-open")) return;
  elFilterDrawer.classList.remove("is-open");
  unlockScroll();
}

// Called by the toolbar Filters button — decides inline vs drawer based on scroll + viewport.
export function toggleFiltersOrDrawer() {
  const headerH = document.querySelector("header").offsetHeight;
  const inlineInView = elFilters.getBoundingClientRect().top >= headerH - 2;
  if (window.innerWidth <= 640 || !inlineInView) openFilterDrawer();
  else toggleFiltersDesktop();
}

export function initFilters() {
  document.getElementById("filter-drawer-scrim").addEventListener("click", closeFilterDrawer);
  document.getElementById("filter-drawer-close").addEventListener("click", closeFilterDrawer);
  document.getElementById("filter-drawer-clear").addEventListener("click", clearAll);
}
