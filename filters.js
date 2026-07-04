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
  return JSON.stringify([sel, state.showFavorites, state.sortByHearts, state.selectedCrateId, state.boardId]);
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

// "Done" as far as the grid is concerned — held images (waiting for the
// board's auto-tagging to come back on) show up like any other untagged image.
export function isTagged(img) {
  return img.status === "tagged" || img.status === "failed" || img.status === "held" || !img.status;
}

export function taggedFiltered() {
  const list = state.images.filter(
    (img) =>
      isTagged(img) &&
      (!state.showFavorites || img.favoritedByMe) &&
      (state.selectedCrateId == null || img.crateIds.has(state.selectedCrateId)) &&
      matchesExcept(img, null)
  );
  if (state.sortByHearts) list.sort((a, b) => b.hearts - a.hearts);
  return list;
}

function valueCount(facetKey, value) {
  let n = 0;
  for (const img of state.images) {
    if (img.tagSet.has(tag(facetKey, value)) && matchesExcept(img, facetKey)) n++;
  }
  return n;
}

function facetHasData(facetKey) {
  return state.images.some((img) => img.tags.some((t) => t.startsWith(facetKey + "/")));
}

export function activeCount() {
  let n = 0;
  for (const values of state.selected.values()) n += values.size;
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
  document.dispatchEvent(new Event('app:render'));
}

export function renderFacetsInto(container) {
  container.replaceChildren();
  for (const facet of state.facets) {
    if (!facetHasData(facet.key)) continue;
    const sel = state.selected.get(facet.key) || new Set();
    const row = document.createElement("div");
    row.className = "facet";
    const label = document.createElement("div");
    label.className = "facet-label";
    label.textContent = facet.label;
    row.appendChild(label);
    const pills = document.createElement("div");
    pills.className = "pills";
    for (const value of facet.values) {
      const total = state.images.filter((img) => img.tagSet.has(tag(facet.key, value))).length;
      if (total === 0) continue;
      const ctxCount = valueCount(facet.key, value);
      const active = sel.has(value);
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
}
