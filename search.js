// Semantic search against /api/search: the query is embedded server-side and
// items come back ranked by similarity. Results land in state.searchResults
// (Map id -> score); taggedFiltered() intersects them with the tag filters.
import { state } from './state.js';
import { toast } from './toast.js';

let searchReq = 0; // stale-response guard, same pattern as the lightbox reasoning fetch

export async function runSearch(q) {
  q = String(q || "").trim();
  if (!q) return clearSearch();
  const token = ++searchReq;
  state.searchLoading = true;
  document.dispatchEvent(new Event('app:render'));
  try {
    const r = await fetch(`/api/search?board=${state.boardId}&q=${encodeURIComponent(q)}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || "Search failed");
    }
    const { results } = await r.json();
    if (token !== searchReq) return; // superseded by a newer search/clear
    state.searchLoading = false;
    state.searchQuery = q;
    state.searchDraft = q;
    state.searchResults = new Map(results.map((x) => [x.id, x.score]));
    document.dispatchEvent(new Event('app:render'));
  } catch (err) {
    if (token !== searchReq) return;
    state.searchLoading = false;
    document.dispatchEvent(new Event('app:render'));
    toast.error(err.message || "Search failed");
  }
}

export function clearSearch() {
  searchReq++; // invalidates any in-flight search
  if (!state.searchResults && !state.searchDraft && !state.searchLoading) return;
  state.searchLoading = false;
  state.searchDraft = "";
  state.searchQuery = "";
  state.searchResults = null;
  document.dispatchEvent(new Event('app:render'));
}
