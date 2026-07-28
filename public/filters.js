import { state } from './state.js';
import { tag, pill } from './utils.js';
import { ACTIVE, QUEUED } from './data.js';
import { applyBoardSort } from './sort.js';

const elFilters = document.getElementById("filters");
const elFilterDrawer = document.getElementById("filter-drawer");
const elFiltersMobile = document.getElementById("filters-mobile");

export function filterKey() {
  const sel = [...state.selected.entries()]
    .map(([k, v]) => [k, [...v].sort()])
    .filter(([, v]) => v.length)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([sel, state.showFavorites, state.showUntagged, state.showProcessing, state.showUnprocessed, state.sort, state.selectedCrateId, state.alertEvent?.id ?? null, state.boardId, state.searchResults ? state.searchQuery : "", [...state.selectedUploaderIds].sort()]);
}

function matchesExcept(img, exceptKey) {
  for (const [key, values] of state.selected) {
    if (key === exceptKey || values.size === 0) continue;
    let ok = false;
    for (const v of values) {
      if (img.tagSet.has(tag(key, v))) { ok = true; break; }
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
      (state.selectedUploaderIds.size === 0 || (img.uploadedBy && state.selectedUploaderIds.has(img.uploadedBy.id))) &&
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
function computeFacetStats() {
  const activeSel = [...state.selected].filter(([, v]) => v.size);
  const totals = new Map(); // "facet/value" -> count over all items
  const counts = new Map(); // "facet/value" -> count in the current filter context
  const facetsWithData = new Set();
  let totalUntagged = 0;
  let untaggedInContext = 0;
  let totalActive = 0;
  let activeInContext = 0;
  let totalQueued = 0;
  let queuedInContext = 0;
  const uploaderTotals = new Map(); // uploaderId -> total count
  const uploaderCounts = new Map(); // uploaderId -> context count (uploader filter excluded)

  for (const img of state.items) {
    for (const t of img.tags) {
      totals.set(t, (totals.get(t) || 0) + 1);
      const slash = t.indexOf("/");
      if (slash > 0) facetsWithData.add(t.slice(0, slash));
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
        if (img.tagSet.has(tag(key, v))) { ok = true; break; }
      }
      if (!ok) { fails++; failKey = key; if (fails > 1) break; }
    }

    const passesUploader = state.selectedUploaderIds.size === 0 || (img.uploadedBy && state.selectedUploaderIds.has(img.uploadedBy.id));
    const baseContext = fails === 0 && (!state.showFavorites || img.favoritedByMe) && (state.selectedCrateId == null || img.crateIds.has(state.selectedCrateId));

    // Uploader pill context: base context but NOT gated on uploader filter (so all uploaders stay visible)
    if (img.uploadedBy && baseContext) {
      uploaderCounts.set(img.uploadedBy.id, (uploaderCounts.get(img.uploadedBy.id) || 0) + 1);
    }

    const inContext = baseContext && passesUploader;

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
    for (const t of img.tags) {
      const slash = t.indexOf("/");
      if (slash <= 0) continue;
      if (fails === 1 && t.slice(0, slash) !== failKey) continue;
      counts.set(t, (counts.get(t) || 0) + 1);
    }
  }
  return {
    totals, counts, facetsWithData,
    totalUntagged, untaggedInContext,
    totalActive, activeInContext,
    totalQueued, queuedInContext,
    uploaderTotals, uploaderCounts,
  };
}

export function activeCount() {
  let n = 0;
  for (const values of state.selected.values()) n += values.size;
  if (state.showUntagged) n++;
  if (state.showProcessing) n++;
  if (state.showUnprocessed) n++;
  n += state.selectedUploaderIds.size;
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

export function toggleUploader(uid) {
  if (state.selectedUploaderIds.has(uid)) state.selectedUploaderIds.delete(uid);
  else state.selectedUploaderIds.add(uid);
  document.dispatchEvent(new Event('app:render'));
}

export function clearAll() {
  state.selected = new Map();
  state.showUntagged = false;
  state.showProcessing = false;
  state.showUnprocessed = false;
  state.selectedUploaderIds = new Set();
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
  const u = [...state.selectedUploaderIds].sort().join(",");
  if (u) url.searchParams.set("u", u);
  else url.searchParams.delete("u");
  const next = url.pathname + url.search;
  if (next !== location.pathname + location.search) history.replaceState(null, "", next);
}

export function renderFacetsInto(container, stats = computeFacetStats()) {
  container.replaceChildren();
  const {
    totals, counts, facetsWithData,
    totalUntagged, untaggedInContext,
    totalActive, activeInContext,
    totalQueued, queuedInContext,
    uploaderTotals, uploaderCounts,
  } = stats;
  // The status row: Untagged plus the two queue pills (Processing = actively
  // worked, Unprocessed = waiting in line). Each shows only while it has items
  // or is switched on, so the row disappears entirely on a quiet board.
  const statusPills = [
    ["Untagged", totalUntagged, untaggedInContext, "showUntagged"],
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
  // Uploader row — only when there are 2+ distinct uploaders in the board.
  if (uploaderTotals.size >= 2 || state.selectedUploaderIds.size > 0) {
    const uploaderItems = [...uploaderTotals.entries()].sort((a, b) => b[1] - a[1]);
    const row = document.createElement("div");
    row.className = "facet";
    const label = document.createElement("div");
    label.className = "facet-label";
    label.textContent = "UPLOADED BY";
    row.appendChild(label);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const [uid, total] of uploaderItems) {
      const active = state.selectedUploaderIds.has(uid);
      const ctxCount = uploaderCounts.get(uid) || 0;
      if (total === 0 && !active) continue;
      const uploader = state.items.find((img) => img.uploadedBy?.id === uid)?.uploadedBy;
      const name = uploader ? (uploader.name || uploader.email) : String(uid);
      pills.appendChild(pill(name, ctxCount, active, !active && ctxCount === 0, () => toggleUploader(uid)));
    }
    row.appendChild(pills);
    container.appendChild(row);
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
      const t = tag(facet.key, value);
      const total = totals.get(t) || 0;
      const active = sel.has(value);
      if (total === 0 && !active) continue;
      const ctxCount = counts.get(t) || 0;
      pills.appendChild(
        pill(value, ctxCount, active, !active && ctxCount === 0, () => toggle(facet.key, value))
      );
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
  clear.textContent = `Clear filters (${n})`;
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
