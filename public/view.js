// view.js — gallery view mode (planning/instance-rows-plan.md). Grid is the
// classic masonry; rows stacks entities vertically, each as its untouched card
// plus a horizontal strip of instance tiles. This module owns which one is in
// effect and its per-board persistence; the renderers live in grid.js/rows.js.
import { state } from './state.js';

// Two layers decide the mode:
// - Base: the viewer's standing per-board preference (state.view, persisted
//   by the toggle when no filter session is active; null = grid).
// - Filter session: while filters are active, a temporary layer on top.
//   Entering flips to rows whenever the filtered result can stack; a toggle
//   made during the session is session-scoped; clearing the filters drops
//   the whole layer, restoring the base — "return to the previous mode".
// Module state on purpose: a board switch is a page load, and a reload
// mid-filter re-derives the same session from the URL's filters.
let inSession = false;
let sessionChoice = null; // an explicit toggle made during the session
let sessionAuto = "grid"; // the session's auto resolution; ratchets to rows, re-armed per session

const base = () => (state.view === "rows" ? "rows" : "grid");

// The mode to render right now. Cached session state keeps this cheap — it
// is consulted between renders by layout, sentinel and scroll callbacks, and
// the answer only changes when a render changes the inputs.
export function effectiveView() {
  if (inSession) return sessionChoice || sessionAuto;
  return base();
}

// Called once per render() with the filtered list and whether any filters are
// active (activeCount() > 0 — facet pills, system facets (objects/uploaders),
// untagged, status; favorites/crates/search deliberately don't start sessions:
// none of them increment the Filters count either). Session auto-rows requires a
// multi-instance entity in the filtered result — the raw-board guardrail: on
// classic galleries no such entity can exist, so the masonry never flips.
// Until it does, the session shows the base mode, so a standing rows
// preference survives filtering a corner with no stacks.
//
// The flip is a RATCHET: re-asked each render only until it engages — the
// board streams in behind first paint, so the stack that justifies rows can
// arrive seconds after a URL-restored filter — and then held for the
// session's life. Recomputing it both ways would yank the view back to grid
// the instant a delete removes the result's last stack, right under the
// hand that clicked. Clearing the filters drops the latch with the session.
export function resolveView(items, filtersActive) {
  if (filtersActive !== inSession) {
    inSession = filtersActive;
    sessionChoice = null;
    sessionAuto = "grid"; // re-arm the ratchet for the new session
  }
  if (inSession && sessionAuto !== "rows") {
    sessionAuto = items.some((i) => (i.instances?.length || 0) > 1) ? "rows" : base();
  }
  return effectiveView();
}

// The toggle button's action: flip against the EFFECTIVE mode (so it always
// visibly acts, including overriding session auto-rows). During a filter
// session the flip is session-scoped — the persisted preference is what you
// chose while browsing unfiltered, and clearing filters returns to it.
// Outside a session, the flip IS the persisted preference.
export function toggleView() {
  const next = effectiveView() === "rows" ? "grid" : "rows";
  if (inSession) {
    sessionChoice = next;
  } else {
    state.view = next;
    saveView();
  }
}

// Should the toolbar offer the rows toggle at all? Only where instances can
// stack: derived-identity boards (the one mapping that produces multi-
// instance entities), boards whose data already holds one (a mapping
// switched away later), and whenever rows is currently effective — an
// explicit rows choice must always have a way back.
export function rowsRelevant() {
  return (
    state.boardMapping?.identity?.source === "extract" ||
    state.items.some((i) => (i.instances?.length || 0) > 1) ||
    effectiveView() === "rows"
  );
}

// --- persistence: per viewer, per board (the boardSort pattern) ---

const storeKey = () => `boardView:${state.boardId}`;

export function saveView() {
  try {
    if (state.view) localStorage.setItem(storeKey(), state.view);
    else localStorage.removeItem(storeKey());
  } catch { /* private mode / quota — the choice just won't stick */ }
}

export function restoreView() {
  try {
    const v = localStorage.getItem(storeKey());
    state.view = v === "rows" || v === "grid" ? v : null;
  } catch {
    state.view = null;
  }
}
