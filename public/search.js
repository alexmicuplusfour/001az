// Semantic search against /api/search: the query is embedded server-side and
// items come back ranked by similarity. Results land in state.searchResults
// (Map id -> score); taggedFiltered() intersects them with the tag filters.
import { state } from './state.js';
import { toast } from './toast.js';
import { similarTo } from './patterns.js';

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
const anchorLabel = (img) => img.symbol || img.displayLabel || img.identity;

export function runSimilar(img) {
  const results = similarTo(img);
  if (!results) return; // the action is gated on MIN_TAGS, so only a degenerate board lands here
  searchReq++; // supersedes any in-flight typed search
  state.searchLoading = false;
  state.searchQuery = `similar:${img.identity}`; // feeds filterKey; never displayed
  state.searchResults = results;
  state.searchSimilarTo = anchorLabel(img);
  document.dispatchEvent(new Event('app:render'));
}

// The meaning flavor (plan 1b-meaning): same mode, different scorer. The
// server ranks the board against this item's stored search vectors — the
// free half of /api/search, nothing embedded and nothing metered — and
// bounds by rank, since item-anchored scores have no honest cutoff. The
// mode chip carries the flavor in its label, so the two similars stay
// tellable apart after the fact.
export async function runSimilarMeaning(img) {
  const token = ++searchReq;
  try {
    const r = await fetch(`/api/search/similar?board=${state.boardId}&item=${img.id}`);
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(body.error || "Search failed");
    }
    const { results } = await r.json();
    if (token !== searchReq) return; // superseded
    state.searchLoading = false;
    state.searchQuery = `similar-meaning:${img.id}`;
    state.searchResults = new Map(results.map((x) => [x.id, x.score]));
    state.searchSimilarTo = `${anchorLabel(img)} · meaning`;
    document.dispatchEvent(new Event('app:render'));
  } catch (err) {
    if (token !== searchReq) return;
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
