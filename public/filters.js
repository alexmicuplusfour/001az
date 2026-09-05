import { state } from './state.js';
import { tag, pill, appendCount, ICONS } from './utils.js';
import { ACTIVE, QUEUED } from './data.js';
import { applyBoardSort } from './sort.js';
import { chipOdds, clusterSet, clusterValues } from './patterns.js';

const elFilters = document.getElementById("filters");
const elFilterDrawer = document.getElementById("filter-drawer");
const elFiltersMobile = document.getElementById("filters-mobile");

export function filterKey() {
  const sel = [...state.selected.entries()]
    .map(([k, v]) => [k, [...v].sort()])
    .filter(([, v]) => v.length)
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
  "~clusters": { label: "CLUSTERS", entity: (x) => clusterSet(x), instance: null },
  "~objects": { label: "OBJECTS", entity: (x) => x.objectSet, instance: (x) => x.objectSet },
  // Uploaders were the original separate-slot filter (selectedUploaderIds +
  // ?u=); folded here so saved configs stop dropping them and every consumer
  // shares one model. Values are STRING user ids. Entity-level only.
  "~uploaders": { label: "UPLOADED BY", entity: (x) => x.uploaderIdSet, instance: null },
};
const SYSTEM_FACET_ENTRIES = Object.entries(SYSTEM_FACETS);

// Does the entity carry `value` under facet `key`? Tag strings for regular
// facets, the system facet's own set otherwise.
function entityHasValue(img, key, value) {
  const sys = SYSTEM_FACETS[key];
  if (sys) { const set = sys.entity(img); return !!set && set.has(value); }
  return img.tagSet.has(tag(key, value));
}

function instanceHasValue(inst, key, value) {
  const sys = SYSTEM_FACETS[key];
  if (sys) { const set = sys.instance?.(inst); return !!set && set.has(value); }
  return inst.tagSet.has(tag(key, value));
}

function matchesExcept(img, exceptKey) {
  for (const [key, values] of state.selected) {
    if (key === exceptKey || values.size === 0) continue;
    let ok = false;
    for (const v of values) {
      if (entityHasValue(img, key, v)) { ok = true; break; }
    }
    if (!ok) return false;
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
    if (values.size === 0) continue;
    const sys = SYSTEM_FACETS[key];
    if (sys && !sys.instance) continue; // entity-level dimension — every tile passes
    let ok = false;
    for (const v of values) {
      if (instanceHasValue(inst, key, v)) { ok = true; break; }
    }
    if (!ok) return false;
  }
  return true;
}

// "Done" as far as the grid is concerned — held items (waiting for the
// board's auto-tagging to come back on) show up like any other untagged item.
export function isTagged(img) {
  if (img.tags.length > 0) return true;
  return img.status === "tagged" || img.status === "failed" || img.status === "held" || !img.status;
}

export function isUntagged(img) {
  return img.tags.length === 0;
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
export function needsTags(img) {
  return boardHasTaxonomy() && (img.undecided || img.status === "held" || isUntagged(img));
}

// Status pills OR together (an item has exactly one status), the same way
// values within a facet do. With none active, the usual isTagged gate keeps
// in-flight items out of the grid — the progress lane is their home.
function statusFilter() {
  const sets = [];
  if (state.showProcessing) sets.push(ACTIVE);
  if (state.showUnprocessed) sets.push(QUEUED);
  if (!sets.length) return isTagged;
  return (img) => sets.some((s) => s.has(img.status));
}

export function taggedFiltered() {
  const statusOk = statusFilter();
  const list = state.items.filter(
    (img) =>
      statusOk(img) &&
      (state.searchResults == null || state.searchResults.has(img.id)) &&
      (!state.showUntagged || isUntagged(img)) &&
      (!state.showFavorites || img.favoritedByMe) &&
      (state.selectedCrateId == null || img.crateIds.has(state.selectedCrateId)) &&
      (state.alertEvent == null || state.alertEvent.ids.has(img.id)) &&
      matchesExcept(img, null)
  );
  // While a search is active its similarity order wins outright — the chosen
  // board sort resumes when the search clears. Otherwise the attribute sort
  // (sort.js) over the server order (newest first).
  if (state.searchResults) list.sort((a, b) => state.searchResults.get(b.id) - state.searchResults.get(a.id));
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
  const activeSel = [...state.selected].filter(([, v]) => v.size);
  const totals = new Map(); // "facet/value" -> count over all items
  const counts = new Map(); // "facet/value" -> count in the current filter context
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

  for (const img of state.items) {
    for (const t of img.tags) {
      totals.set(t, (totals.get(t) || 0) + 1);
      const slash = t.indexOf("/");
      if (slash > 0) facetsWithData.add(t.slice(0, slash));
    }
    // System-facet memberships project into the same maps as tags
    // ("~objects/car"), so the chip totals/counts machinery is shared verbatim.
    for (const [sk, sys] of SYSTEM_FACET_ENTRIES) {
      for (const v of sys.entity(img) || []) {
        const t = tag(sk, v);
        totals.set(t, (totals.get(t) || 0) + 1);
      }
    }

    if (img.uploadedBy) {
      uploaderTotals.set(img.uploadedBy.id, (uploaderTotals.get(img.uploadedBy.id) || 0) + 1);
    }

    // How many active facets does this item fail? It counts toward a
    // facet's values when it matches all the others: fails none, or
    // fails only that facet itself.
    let fails = 0;
    let failKey = null;
    for (const [key, values] of activeSel) {
      let ok = false;
      for (const v of values) {
        if (entityHasValue(img, key, v)) { ok = true; break; }
      }
      if (!ok) { fails++; failKey = key; if (fails > 1) break; }
    }

    // An uploader selection rides `fails` like any facet (the `~uploaders`
    // system key sits in activeSel), so no separate uploader gate.
    const inContext = fails === 0 && (!state.showFavorites || img.favoritedByMe) && (state.selectedCrateId == null || img.crateIds.has(state.selectedCrateId));

    if (isTagged(img) && isUntagged(img)) {
      totalUntagged++;
      if (inContext) untaggedInContext++;
    }
    if (ACTIVE.has(img.status)) {
      totalActive++;
      if (inContext) activeInContext++;
    } else if (QUEUED.has(img.status)) {
      totalQueued++;
      if (inContext) queuedInContext++;
    }

    if (fails > 1) continue;
    // Riding the early-out above: an item counts toward the context its chips
    // count in — everything's, or only the one facet it fails.
    if (fails) ctxFail.set(failKey, (ctxFail.get(failKey) || 0) + 1);
    else ctxAll++;
    for (const t of img.tags) {
      const slash = t.indexOf("/");
      if (slash <= 0) continue;
      if (fails === 1 && t.slice(0, slash) !== failKey) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    for (const [sk, sys] of SYSTEM_FACET_ENTRIES) {
      if (fails === 1 && sk !== failKey) continue;
      for (const v of sys.entity(img) || []) {
        const t = tag(sk, v);
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
  }
  return {
    totals, counts, ctxAll, ctxFail, facetsWithData,
    totalUntagged, untaggedInContext,
    totalActive, activeInContext,
    totalQueued, queuedInContext,
    uploaderTotals,
  };
}

export function activeCount() {
  let n = 0;
  for (const values of state.selected.values()) n += values.size;
  if (state.showUntagged) n++;
  if (state.showProcessing) n++;
  if (state.showUnprocessed) n++;
  return n;
}

// Favorites in the current filter context — reuses taggedFiltered so the
// count stays in sync with facet chips, search, crate, and untagged filters.
export function favoritesInContext() {
  return taggedFiltered().filter((img) => img.favoritedByMe).length;
}

export function toggle(facetKey, value) {
  const set = state.selected.get(facetKey) || new Set();
  if (set.has(value)) set.delete(value);
  else set.add(value);
  state.selected.set(facetKey, set);
  document.dispatchEvent(new Event('app:render'));
}

export function clearAll() {
  state.selected = new Map();
  state.showUntagged = false;
  state.showProcessing = false;
  state.showUnprocessed = false;
  document.dispatchEvent(new Event('app:render'));
}

function toggleFlag(flag) {
  state[flag] = !state[flag];
  document.dispatchEvent(new Event('app:render'));
}

// --- saved filter configs + URL encoding ---
// A config is the facet selection as a plain object: { facetKey: [values] }.
// Loading one is one-shot — it just sets the pills, nothing stays "applied".

export function selectedAsConfig() {
  const out = {};
  for (const [key, values] of state.selected) {
    if (values.size) out[key] = [...values].sort();
  }
  return out;
}

export function applyFilterConfig(config) {
  state.selected = new Map(
    Object.entries(config || {}).map(([k, v]) => [k, new Set(v)])
  );
  document.dispatchEvent(new Event('app:render'));
}

// True when a config matches the current pills exactly — pure feedback for
// highlighting, not a mode. Compared canonically (sorted keys/values):
// JSONB reorders object keys, so plain stringify comparison would lie.
function canonConfig(config) {
  return JSON.stringify(
    Object.keys(config).sort().map((k) => [k, [...config[k]].sort()])
  );
}

export function configMatchesCurrent(config) {
  return canonConfig(config) === canonConfig(selectedAsConfig());
}

// Compact query-param form: "key:v1,v2;key2:v3" (parts URI-encoded so the
// separators can't collide with facet names/values).
export function encodeSelected() {
  const parts = [];
  for (const [key, values] of [...state.selected.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (!values.size) continue;
    parts.push(
      encodeURIComponent(key) + ":" + [...values].sort().map(encodeURIComponent).join(",")
    );
  }
  return parts.join(";");
}

export function decodeSelected(str) {
  const map = new Map();
  if (!str) return map;
  for (const part of str.split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = decodeURIComponent(part.slice(0, i));
    const values = part.slice(i + 1).split(",").filter(Boolean).map(decodeURIComponent);
    if (values.length) map.set(key, new Set(values));
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
  // Uploaders ride ?f= as the ~uploaders facet now; drop the legacy ?u= so an
  // old link's param migrates away on the first filter change.
  url.searchParams.delete("u");
  const next = url.pathname + url.search;
  if (next !== location.pathname + location.search) history.replaceState(null, "", next);
}

export function renderFacetsInto(container, stats = computeFacetStats()) {
  container.replaceChildren();
  const {
    totals, counts, ctxAll, ctxFail, facetsWithData,
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
  const chip = (facetKey, value, label = value) => {
    const t = tag(facetKey, value);
    const ctxCount = counts.get(t) || 0;
    const active = state.selected.get(facetKey)?.has(value) || false;
    const el = pill(label, ctxCount, active, !active && ctxCount === 0, () => toggle(facetKey, value));
    const odds = state.showOdds && !active && chipOdds(stats, facetKey, t);
    if (odds) appendCount(el, odds.text, `mult mult-${odds.tone}`);
    return el;
  };
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
    const row = document.createElement("div");
    row.className = "facet facet-untagged";
    const spacer = document.createElement("div");
    spacer.className = "facet-label facet-label-empty";
    spacer.setAttribute("aria-hidden", "true");
    row.appendChild(spacer);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const [label, , ctx, flag] of statusPills) {
      pills.appendChild(
        pill(label, ctx, state[flag], !state[flag] && ctx === 0, () => toggleFlag(flag))
      );
    }
    row.appendChild(pills);
    container.appendChild(row);
  }
  // The CLUSTERS row — the `~clusters` lens, first of the labeled band when
  // it's on: it is the most compressed view of the board, so it reads first.
  // A chip is a found group wearing its own signature (its highest-lift
  // majority chips) as the label — value and label differ, the uploader-row
  // pattern. The second loop is the escape hatch for a selection whose
  // cluster no longer exists (a URL from an older partition): a click-off
  // chip, same as a gone uploader.
  {
    const sel = state.selected.get("~clusters") || new Set();
    const values = clusterValues();
    if (values.length || sel.size) {
      const row = document.createElement("div");
      row.className = "facet";
      const label = document.createElement("div");
      label.className = "facet-label";
      label.textContent = SYSTEM_FACETS["~clusters"].label;
      row.appendChild(label);
      const pills = document.createElement("div");
      pills.className = "pills";
      const shown = new Set();
      for (const v of values) {
        shown.add(v.value);
        const el = chip("~clusters", v.value, v.label);
        if (v.title) el.title = v.title;
        pills.appendChild(el);
      }
      for (const value of sel) {
        if (!shown.has(value)) pills.appendChild(chip("~clusters", value));
      }
      row.appendChild(pills);
      container.appendChild(row);
    }
  }
  // The OBJECTS row — the `~objects` system facet, heading the labeled band
  // (planning/objects-filter-row-plan.md). Chip universe is the mapping's
  // DECLARED object fields (so a removed field's lingering data can't grow
  // chips — the state.facets discipline), plus any selected-but-gone key so an
  // active chip always has a click-off. Chips are the field keys (the user's
  // declared name for the object type; hint synonyms demux into one field).
  // Same visibility rule as facet values — data or active, else hidden — and
  // the row vanishes when no chip is visible.
  {
    const sel = state.selected.get("~objects") || new Set();
    const declared = (state.boardMapping?.fields || [])
      .filter((f) => f.source === "detect")
      .map((f) => f.key);
    const chips = [...new Set([...declared, ...sel])].filter(
      (key) => (totals.get(tag("~objects", key)) || 0) > 0 || sel.has(key)
    );
    if (chips.length) {
      const row = document.createElement("div");
      row.className = "facet";
      const label = document.createElement("div");
      label.className = "facet-label";
      label.textContent = SYSTEM_FACETS["~objects"].label;
      row.appendChild(label);
      const pills = document.createElement("div");
      pills.className = "pills";
      for (const key of chips) pills.appendChild(chip("~objects", key));
      row.appendChild(pills);
      container.appendChild(row);
    }
  }
  // Uploader row — the `~uploaders` system facet (entity-level: never dims
  // rows tiles). Universe = distinct uploaders in the board (2+ to show, the
  // original rule) plus any selected-but-gone id, so an active chip always
  // has a click-off; names resolve from items, falling back to the raw id.
  {
    const sel = state.selected.get("~uploaders") || new Set();
    if (uploaderTotals.size >= 2 || sel.size > 0) {
      const uploaderItems = [...uploaderTotals.entries()].sort((a, b) => b[1] - a[1]);
      const row = document.createElement("div");
      row.className = "facet";
      const label = document.createElement("div");
      label.className = "facet-label";
      label.textContent = SYSTEM_FACETS["~uploaders"].label;
      row.appendChild(label);
      const pills = document.createElement("div");
      pills.className = "pills";
      const shown = new Set();
      for (const [uid, total] of uploaderItems) {
        const key = String(uid);
        if (total === 0 && !sel.has(key)) continue;
        shown.add(key);
        const uploader = state.items.find((img) => img.uploadedBy?.id === uid)?.uploadedBy;
        pills.appendChild(chip("~uploaders", key, uploader ? (uploader.name || uploader.email) : key));
      }
      // Selected but gone from the board — chip() lands the same pill by
      // arithmetic (no items means no context count, so: active, unmuted).
      for (const key of sel) {
        if (!shown.has(key)) pills.appendChild(chip("~uploaders", key));
      }
      row.appendChild(pills);
      container.appendChild(row);
    }
  }

  for (const facet of state.facets) {
    const sel = state.selected.get(facet.key) || new Set();
    if (!facetsWithData.has(facet.key) && sel.size === 0) continue;
    const row = document.createElement("div");
    row.className = "facet";
    const label = document.createElement("div");
    label.className = "facet-label";
    label.textContent = facet.label;
    row.appendChild(label);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const value of facet.values) {
      const total = totals.get(tag(facet.key, value)) || 0;
      if (total === 0 && !sel.has(value)) continue;
      pills.appendChild(chip(facet.key, value));
    }
    row.appendChild(pills);
    container.appendChild(row);
  }
}

export function renderFacets() {
  elFilters.classList.toggle("is-hidden", state.filtersHidden);
  const stats = computeFacetStats();
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
    document.dispatchEvent(new Event('app:render'));
    return;
  }
  elFilters.style.transition = "none";
  const before = elFilters.offsetHeight;
  state.filtersHidden = !state.filtersHidden;
  document.dispatchEvent(new Event('app:render'));
  const after = elFilters.offsetHeight;
  window.scrollBy(0, after - before);
  void elFilters.offsetHeight; // flush before re-enabling transition
  elFilters.style.transition = "";
}

export function openFilterDrawer() {
  elFilterDrawer.classList.add("is-open");
  document.body.style.overflow = "hidden";
}

export function closeFilterDrawer() {
  elFilterDrawer.classList.remove("is-open");
  document.body.style.overflow = "";
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
