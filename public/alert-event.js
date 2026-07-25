// The ?event= view: the gallery showing exactly one firing's entities — the
// delta that triggered an alert, as opposed to ?f='s living view of everything
// currently matching. The id set rides state.alertEvent and filters the grid
// like a crate does; the URL param makes webhook links land here directly.
import { state } from './state.js';
import { toast } from './toast.js';
import { clearSearch } from './search.js';

// An alert view replaces the current view: pills, status toggles, favorites,
// uploader picks, crate and search would otherwise silently intersect with
// the firing's entities and show fewer items than the chip claims.
export function resetListFilters() {
  clearSearch(); // owns its in-flight invalidation
  state.selected = new Map();
  state.showFavorites = false;
  state.showUntagged = false;
  state.showProcessing = false;
  state.showUnprocessed = false;
  state.selectedUploaderIds = new Set();
  state.selectedCrateId = null;
}

function setEventParam(id) {
  const url = new URL(location.href);
  if (id != null) url.searchParams.set("event", String(id));
  else url.searchParams.delete("event");
  const next = url.pathname + url.search;
  if (next !== location.pathname + location.search) history.replaceState(null, "", next);
}

export async function openAlertEvent(firingId) {
  try {
    const r = await fetch(`/api/alert-firings/${firingId}`, { cache: "no-store" });
    if (!r.ok) throw new Error();
    const { firing, entityIds } = await r.json();
    // A link whose board doesn't match the open one would show an empty grid
    // under a confusing chip — follow the firing to its own board instead.
    if (state.boardId && firing.board_id !== state.boardId) {
      location.href = `/?board=${encodeURIComponent(firing.board_id)}&event=${firing.id}`;
      return;
    }
    // count states the original truth — entities deleted since simply don't
    // render, and the chip's number says how many the firing was.
    resetListFilters();
    state.alertEvent = { id: firing.id, name: firing.name, count: firing.entity_count, ids: new Set(entityIds) };
    setEventParam(firing.id);
    document.dispatchEvent(new Event('app:render'));
  } catch {
    toast.error("Couldn't load the alert view");
    setEventParam(null);
  }
}

export function clearAlertEvent() {
  state.alertEvent = null;
  setEventParam(null);
  document.dispatchEvent(new Event('app:render'));
}
