import { state } from './state.js';
import { tag, pill } from './utils.js';

const elFilters = document.getElementById("filters");
const elFilterDrawer = document.getElementById("filter-drawer");
const elFiltersMobile = document.getElementById("filters-mobile");

export function filterKey() {
  const sel = [...state.selected.entries()]
    .map(([k, v]) => [k, [...v].sort()])
    .filter(([, v]) => v.length)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return JSON.stringify([sel, state.showFavorites, state.showUntagged, state.sortByHearts, state.selectedCrateId, state.boardId]);
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

export function taggedFiltered() {
  const list = state.items.filter(
    (img) =>
      isTagged(img) &&
      (!state.showUntagged || isUntagged(img)) &&
      (!state.showFavorites || img.favoritedByMe) &&
      (state.selectedCrateId == null || img.crateIds.has(state.selectedCrateId)) &&
      matchesExcept(img, null)
  );
  if (state.sortByHearts) list.sort((a, b) => b.hearts - a.hearts);
  return list;
}

function valueCount(facetKey, value) {
  let n = 0;
  for (const img of state.items) {
    if (img.tagSet.has(tag(facetKey, value)) && matchesExcept(img, facetKey)) n++;
  }
  return n;
}

function facetHasData(facetKey) {
  return state.items.some((img) => img.tags.some((t) => t.startsWith(facetKey + "/")));
}

export function activeCount() {
  let n = 0;
  for (const values of state.selected.values()) n += values.size;
  if (state.showUntagged) n++;
  return n;
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
  document.dispatchEvent(new Event('app:render'));
}

function untaggedCount() {
  let n = 0;
  for (const img of state.items) {
    if (!isTagged(img) || !isUntagged(img)) continue;
    if (state.showFavorites && !img.favoritedByMe) continue;
    if (state.selectedCrateId != null && !img.crateIds.has(state.selectedCrateId)) continue;
    if (!matchesExcept(img, null)) continue;
    n++;
  }
  return n;
}

function toggleUntagged() {
  state.showUntagged = !state.showUntagged;
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
  const next = url.pathname + url.search;
  if (next !== location.pathname + location.search) history.replaceState(null, "", next);
}

export function renderFacetsInto(container) {
  container.replaceChildren();
  const totalUntagged = state.items.filter((img) => isTagged(img) && isUntagged(img)).length;
  if (totalUntagged > 0 || state.showUntagged) {
    const row = document.createElement("div");
    row.className = "facet facet-untagged";
    const spacer = document.createElement("div");
    spacer.className = "facet-label facet-label-empty";
    spacer.setAttribute("aria-hidden", "true");
    row.appendChild(spacer);
    const pills = document.createElement("div");
    pills.className = "pills";
    const ctxCount = untaggedCount();
    pills.appendChild(
      pill("Untagged", ctxCount, state.showUntagged, !state.showUntagged && ctxCount === 0, toggleUntagged)
    );
    row.appendChild(pills);
    container.appendChild(row);
  }
  for (const facet of state.facets) {
    const sel = state.selected.get(facet.key) || new Set();
    if (!facetHasData(facet.key) && sel.size === 0) continue;
    const row = document.createElement("div");
    row.className = "facet";
    const label = document.createElement("div");
    label.className = "facet-label";
    label.textContent = facet.label;
    row.appendChild(label);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const value of facet.values) {
      const total = state.items.filter((img) => img.tagSet.has(tag(facet.key, value))).length;
      const active = sel.has(value);
      if (total === 0 && !active) continue;
      const ctxCount = valueCount(facet.key, value);
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
  if (!state.filtersHidden) renderFacetsInto(elFilters);
  renderFacetsInto(elFiltersMobile);
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
