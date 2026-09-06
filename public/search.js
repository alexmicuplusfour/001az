// Semantic search against /api/search: the query is embedded server-side and
// items come back ranked by similarity. Results land in state.searchResults
// (Map id -> score); taggedFiltered() intersects them with the tag filters.
import { state } from './state.js';
import { toast } from './toast.js';
import { similarTo } from './patterns.js';

let searchReq = 0; // stale-response guard, same pattern as the lightbox reasoning fetch

// One results fetch for both server-ranked modes: error body → message,
// ranked rows → the Map the grid consumes.
async function fetchResults(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body.error || "Search failed");
  }
  const { results } = await r.json();
  return new Map(results.map((x) => [x.id, x.score]));
}

export async function runSearch(q) {
  q = String(q || "").trim();
  if (!q) return clearSearch();
  const token = ++searchReq;
  state.searchLoading = true;
  document.dispatchEvent(new Event('app:render'));
  try {
    const results = await fetchResults(`/api/search?board=${state.boardId}&q=${encodeURIComponent(q)}`);
    if (token !== searchReq) return; // superseded by a newer search/clear
    state.searchLoading = false;
    state.searchQuery = q;
    state.searchDraft = q;
    state.searchResults = results;
    state.searchSimilarTo = null; // a typed search gracefully replaces the similar mode
    document.dispatchEvent(new Event('app:render'));
  } catch (err) {
    if (token !== searchReq) return;
    state.searchLoading = false;
    document.dispatchEvent(new Event('app:render'));
    toast.error(err.message || "Search failed");
  }
}

// "Find similar" (plan stage 1b): a search the user didn't type. Chip
// similarity (patterns.js) produces the same ranked map a typed query does,
// so the mode rides this file's plumbing wholesale — searchResults filters
// and orders the grid, searchQuery keys the render caches. Differences:
// synchronous (no fetch, no spinner), needs no embeddings (works where the
// search box itself is hidden), and it leaves searchDraft alone — the
// input stays the user's; the toolbar's mode chip announces this mode and
// its × lands back in clearSearch.
const anchorLabel = (item) => item.symbol || item.displayLabel || item.identity;

export function runSimilar(item) {
  const results = similarTo(item);
  if (!results) return; // the action is gated on MIN_TAGS, so only a degenerate board lands here
  searchReq++; // supersedes any in-flight typed search
  state.searchLoading = false;
  state.searchQuery = `similar:${item.identity}`; // feeds filterKey; never displayed
  state.searchResults = results;
  state.searchSimilarTo = anchorLabel(item);
  document.dispatchEvent(new Event('app:render'));
}

// The meaning flavor (plan 1b-meaning): same mode, different scorer. The
// server ranks the board against this item's stored search vectors — the
// free half of /api/search, nothing embedded and nothing metered — and
// bounds by rank, since item-anchored scores have no honest cutoff. The
// flavor rides searchQuery's prefix; the toolbar chip reads it from there
// and wears it as an unclippable tail, so the two similars stay tellable
// apart even when the anchor's name is a whole filename.
export async function runSimilarMeaning(item) {
  const token = ++searchReq; // supersedes any in-flight typed search…
  state.searchLoading = false; // …spinner included, or a failure here would leave it spinning forever
  try {
    const results = await fetchResults(`/api/search/similar?board=${state.boardId}&item=${item.id}`);
    if (token !== searchReq) return; // superseded
    state.searchQuery = `similar-meaning:${item.id}`;
    state.searchResults = results;
    state.searchSimilarTo = anchorLabel(item);
    document.dispatchEvent(new Event('app:render'));
  } catch (err) {
    if (token !== searchReq) return;
    document.dispatchEvent(new Event('app:render')); // repaint the spinner cleared above
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
  state.searchSimilarTo = null;
  document.dispatchEvent(new Event('app:render'));
}
