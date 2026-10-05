// Semantic search against /api/search: the query is embedded server-side and
// items come back ranked by similarity. Results land in state.searchResults
// (Map id -> score); taggedFiltered() intersects them with the tag filters.
import { state } from './state.js';
import { batch } from './vendor/signals.mjs';
import { toast } from './toast.js';
import { similarTo } from './patterns.js';
import { fetchItems } from './data.js';

let searchReq = 0; // stale-response guard, same pattern as the lightbox reasoning fetch

// One results fetch for both server-ranked modes: error body → message,
// ranked rows → the Map the grid consumes. While the board is still loading,
// the results' cards it doesn't have yet are fetched first, so they all show
// at once, in score order, instead of popping in as the load reaches them
// (planning/sorted-loading-plan.md, D11). Each caller's check for a newer
// search, right after this, covers that wait too. A card fetch that fails
// still shows the search, the query having been a paid call: its missing
// cards join as the load reaches them.
async function fetchResults(url) {
  const r = await fetch(url);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || "Search failed"), { declined: body.declined === true });
  }
  const { results } = await r.json();
  await fetchItems(results.map((x) => x.id));
  return new Map(results.map((x) => [x.id, x.score]));
}

// The server marks a search it declines because this board or card has
// nothing embedded (field-embedding-plan.md D8): nothing failed, so it reads
// as a plain note, not an error. The mark, not the 409: a provider's own
// error can arrive with that status too.
const toastFor = (err) => err.declined
  ? toast(err.message, { duration: "long" })
  : toast.error(err.message || "Search failed");

export async function runSearch(q) {
  q = String(q || "").trim();
  if (!q) return clearSearch();
  const token = ++searchReq;
  state.searchLoading = true;
  try {
    const results = await fetchResults(`/api/search?board=${state.boardId}&q=${encodeURIComponent(q)}`);
    if (token !== searchReq) return; // superseded by a newer search/clear
    batch(() => {
      state.searchLoading = false;
      state.searchQuery = q;
      state.searchDraft = q;
      state.searchResults = results;
      state.searchSimilarTo = null; // a typed search gracefully replaces the similar mode
    });
  } catch (err) {
    if (token !== searchReq) return;
    state.searchLoading = false;
    toastFor(err);
  }
}

// "Find similar" (plan stage 1b): a search the user didn't type. Chip
// similarity (patterns.js) produces the same ranked map a typed query does,
// so the mode rides this file's plumbing wholesale — searchResults filters
// and orders the grid, searchQuery keys the render caches. Differences:
// synchronous (no fetch, no spinner), needs no embeddings (works where the
// search box itself is hidden); the toolbar's mode chip announces the mode
// and its × lands back in clearSearch. The supersede is TOTAL, draft
// included — a typed query left sitting in the box would claim a search
// that is no longer the one showing.
const anchorLabel = (item) => item.symbol || item.displayLabel || item.identity;

// The similar modes answer from the WHOLE board, so the standing views that
// intersect the grid — favorites, a picked crate — clear when one takes
// over: left up, they'd strangle the ranking to whatever tiny overlap
// remains (often just the anchor). Facet pills stay on purpose — narrowing
// a similarity by chips is composition, not contradiction.
function leaveViews() {
  state.showFavorites = false;
  state.selectedCrateId = null;
}

export function runSimilar(item) {
  const results = similarTo(item);
  if (!results) return; // the action is gated on MIN_TAGS, so only a degenerate board lands here
  searchReq++; // supersedes any in-flight typed search
  batch(() => {
    state.searchLoading = false;
    state.searchDraft = "";
    state.searchQuery = `similar:${item.identity}`; // feeds filterKey; never displayed
    state.searchResults = results;
    state.searchSimilarTo = anchorLabel(item);
    leaveViews();
  });
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
    batch(() => {
      state.searchDraft = ""; // the supersede is total — see runSimilar
      state.searchQuery = `similar-meaning:${item.id}`;
      state.searchResults = results;
      state.searchSimilarTo = anchorLabel(item);
      leaveViews();
    });
  } catch (err) {
    if (token !== searchReq) return;
    toastFor(err);
  }
}

export function clearSearch() {
  searchReq++; // invalidates any in-flight search
  if (!state.searchResults && !state.searchDraft && !state.searchLoading) return;
  batch(() => {
    state.searchLoading = false;
    state.searchDraft = "";
    state.searchQuery = "";
    state.searchResults = null;
    state.searchSimilarTo = null;
  });
}
