import { state } from './state.js';
import { getJson } from './api.js';
import { toItem } from './utils.js';
import { filterKey, taggedFiltered, renderFacets, initFilters, decodeSelection, syncFiltersToUrl, activeCount } from './filters.js';
import { selEntry } from './facet-match.js';
import { inProgress, reconcile, ensurePolling, drainItems, stampBoard } from './data.js';
import { renderGrid, layoutGrid, pokeSentinel, initGrid, dropAllCards } from './grid.js';
import { renderRows, dropAllRows, pokeRowsSentinel } from './rows.js';
import { resolveView, restoreView } from './view.js';
import { initShortcuts } from './shortcuts.js';
import { renderToolbar } from './toolbar.js';
import { initFilterConfigsUI } from './filterconfigs.js';
import { initUpload } from './upload.js';
import { initLightbox, openLightbox } from './lightbox.js';
import { openAlertEvent } from './alert-event.js';
import { openJobsModal } from './jobs-modal.js';
import { startSignals, refreshAlerts, refreshJobErrors } from './signals.js';
import { startAnnouncing } from './announce.js';
import { restoreSort } from './sort.js';
import { restoreOdds, restoreClusters, restoreMeaningClusters, refreshClusters } from './patterns.js';
import { initHeaderScroll } from './header-scroll.js';
import { toast } from './toast.js';

const elGridRoot = document.getElementById("grid");

function render() {
  // Before anything reads the board: taggedFiltered and the rail both go
  // through the ~clusters membership map, so it refreshes first (a no-op
  // unless the lens is on AND the tag data moved — see patterns.js). This
  // one line is also what keeps the map fresh for taggedFiltered's callers
  // OUTSIDE render (lightbox, rows): every data mutation dispatches
  // app:render synchronously, so nothing reads between a mutation and this.
  refreshClusters();
  const key = filterKey();
  const tagged = taggedFiltered();
  // Resolve the gallery mode before the toolbar renders — its toggle
  // highlights the EFFECTIVE mode, including an auto-engaged rows (filters
  // active + a multi-instance entity in the filtered result).
  const mode = resolveView(tagged, activeCount() > 0);
  renderToolbar(tagged.length);
  renderFacets();
  // With a status pill on, the grid *is* the queue — a lane on top would
  // just duplicate the same items.
  const laneHidden = state.showProcessing || state.showUnprocessed;
  const progress = laneHidden ? [] : inProgress();
  // Each renderer owns a cache and a batch limit; rendering one drops the
  // other's cache (releasing its cards from the stage observer) and resets
  // its key, so a flip never strands observed elements and the return trip
  // re-enters at a fresh first batch. The mode suffix on the key is the
  // belt to that suspender: the caches can never serve each other.
  elGridRoot.classList.toggle("rows-mode", mode === "rows");
  if (mode === "rows") {
    dropAllCards();
    renderRows(`${key}|rows`, progress, tagged);
  } else {
    dropAllRows();
    renderGrid(`${key}|grid`, progress, tagged);
  }
  syncFiltersToUrl();
  requestAnimationFrame(() => {
    layoutGrid(); // self-gates in rows mode
    pokeSentinel();
    pokeRowsSentinel();
  });
}

document.addEventListener('app:render', render);

async function main() {
  initGrid();
  initShortcuts();
  initFilters();
  initUpload();
  initLightbox();
  initHeaderScroll();

  const params = new URLSearchParams(location.search);
  state.boardId = params.get("board");
  state.selected = decodeSelection(params.get("f"), params.get("fx")); // shareable filtered links
  // Legacy shareable links: ?u=5,7 predates the ~uploaders system facet.
  // Fold it into the selection (writes stopped — syncFiltersToUrl drops the
  // param); an ?f= that already carries ~uploaders wins over the stale ?u=.
  const uParam = params.get("u");
  if (uParam && !state.selected.has("~uploaders")) {
    const ids = uParam.split(",").filter(Boolean);
    if (ids.length) state.selected.set("~uploaders", selEntry(ids));
  }

  if (!state.boardId) {
    // null, not [], when the question couldn't be asked — the two answers lead
    // opposite ways below, and a failed fetch that reads as "zero boards" would
    // send an anonymous visitor the wrong direction.
    const accessible = await fetch("/api/boards", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null).catch(() => null);
    if (accessible?.length) {
      const last = localStorage.getItem("lastBoard");
      const target = accessible.find((b) => String(b.id) === last) || accessible[0];
      location.replace(`/?board=${target.id}`);
      return;
    }
    // Zero boards is not an empty board — it's a boardless page. Everything
    // below is item-scoped: the toolbar collapses to the logo, and the grid
    // reports "No items match these filters" about filters that aren't there
    // and a board that doesn't exist. The boards page is where nothing-to-show
    // has words for itself (and, for an admin, the button that fixes it).
    // The landing rule for a reader who HAS boards is unchanged — last board,
    // not a gate (planning/boards-page-plan.md, "Entry points" #4).
    if (Array.isArray(accessible)) {
      location.replace("/boards");
      return;
    }
    // Couldn't ask: fall through to the /api/me gate, which sends an anonymous
    // visitor to login with the interrupted URL intact.
  }

  const [boardRes, itemsData, meData, cratesData, boardsData, filterConfigsData] = await Promise.all([
    // getJson, not the `r.ok ? json : null` idiom its siblings below use: this
    // is the one fetch in the batch whose failure decides where the reader ends
    // up, so "the server said no" and "there was no answer" have to arrive
    // apart. The others only decide what renders, and null is answer enough.
    state.boardId
      ? getJson(`/api/boards/${state.boardId}`, { cache: "no-store" })
      : Promise.resolve({}),
    state.boardId
      ? fetch(`/api/items?board=${state.boardId}&limit=200`, { cache: "no-store" }).then((r) => r.json()).catch(() => [])
      : Promise.resolve([]),
    fetch("/api/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    state.boardId
      ? fetch(`/api/crates?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => [])
      : Promise.resolve([]),
    fetch("/api/boards", { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => []),
    state.boardId
      ? fetch(`/api/filter-configs?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => [])
      : Promise.resolve([]),
    // The header's dots, filled by the same functions that keep them fresh
    // afterwards (signals.js) — they write state themselves, so they ride the
    // boot batch for the parallelism rather than for a return value.
    refreshAlerts(),
    refreshJobErrors(),
  ]);

  const boardData = boardRes.data || null;
  // The server refused it. Which of the two reasons applies — deleted, or
  // access revoked — it deliberately does not say: a 403 for the second would
  // confirm to someone who can't see a board that it exists, so server.js
  // (~1039) answers 404 to both. 404 ONLY, though: a 401 is an expired
  // session, and the /api/me gate below reaches login in one hop where this
  // would take two.
  const boardGone = boardRes.status === 404;

  if (boardData) localStorage.setItem("lastBoard", String(state.boardId));
  // …and the reverse. A board the server just refused has no business being
  // where we land next time. Only when it IS the remembered one: following a
  // dead link to somebody else's board must not evict the reader's own.
  else if (boardGone && localStorage.getItem("lastBoard") === state.boardId) {
    localStorage.removeItem("lastBoard");
  }

  state.facets = boardData ? boardData.facets : [];
  state.boardName = boardData ? boardData.name : null;
  state.boardManage = boardData ? !!boardData.manage : false;
  state.aiReasoning = boardData ? boardData.ai_reasoning !== false : true;
  state.boardVotes = Number(boardData?.ai_votes) || 1;
  // Cleared, not carried: the toolbar re-fetches per board, and showing the
  // previous board's stability numbers under this board's name would be worse
  // than showing none.
  state.facetStats = null;
  state.boardMapping = boardData?.mapping || null;
  stampBoard(boardData || {});
  state.boardUnits = boardData?.units ?? null;
  state.boardUnitDefs = boardData?.unitDefs ?? null;
  state.boardCost = boardData?.cost ?? null; // manager-only key; absent = nothing priced or not ours to see
  state.searchAvailable = !!boardData?.search;
  state.me = meData;
  // No session → login page (preserving the interrupted URL); a session that
  // hasn't set a password yet (fresh invite) → set-password screen.
  if (!state.me) {
    location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
    return;
  }
  if (state.me.needs_password) {
    location.replace("/login.html");
    return;
  }
  // Signed in, and the board isn't ours. Everything below this line is about
  // rendering a board — without one it draws the boardless shell the zero-board
  // landing above exists to avoid, and here it would do it to someone who asked
  // for a specific board and was told nothing.
  //
  // The boards page shows what IS ours, and `gone` is the note it needs to say
  // why the address changed. A silent redirect is the part that would read as
  // the app losing your place.
  if (boardGone) {
    location.replace("/boards?gone=1");
    return;
  }
  // First page ({ items, nextCursor, now }) — or a bare array from a server
  // that predates pagination, which boots identically and skips the drain.
  const firstPage = Array.isArray(itemsData) ? { items: itemsData, nextCursor: null, now: null } : itemsData;
  state.items = (firstPage.items || []).map(toItem);
  if (typeof firstPage.now === 'number') state.itemsSince = firstPage.now;
  state.crates = Array.isArray(cratesData) ? cratesData : [];
  state.filterConfigs = Array.isArray(filterConfigsData) ? filterConfigsData : [];
  initFilterConfigsUI();
  state.boards = Array.isArray(boardsData) ? boardsData : [];
  // The viewer's per-board sort — needs boardMapping (identity mode) in place.
  restoreSort();
  restoreOdds();
  restoreClusters();
  restoreMeaningClusters();
  restoreView();
  render();
  ensurePolling();
  startSignals(); // the header's dots, on their own cadence from here on
  // …and their voice. After the first render, so whatever is ALREADY lit when
  // the page opens becomes the baseline instead of three toasts on arrival.
  startAnnouncing();
  // Rest of the board streams in behind the first paint.
  drainItems(firstPage.nextCursor);

  // Alert deep links: ?event= swings the grid into one firing's entities
  // (openAlertEvent renders when the fetch lands); ?item= opens the lightbox
  // on an entity — which may still be draining in, so keep looking as pages
  // append until it shows up (or the board is done streaming without it).
  // Arrival from "New board" (toolbar.js): the modal's own created toast can
  // never outlive the navigation that follows it, so the confirmation rides
  // the URL and is said HERE, on the page the reader is actually looking at.
  // One-shot like ?item= and the boards page's ?gone= — consumed, so a reload
  // or a shared link doesn't congratulate twice.
  if (params.has("created")) {
    toast(`Board "${state.boardName}" created`);
    const url = new URL(location.href);
    url.searchParams.delete("created");
    history.replaceState(null, "", url.pathname + url.search);
  }

  const eventId = Number(params.get("event"));
  if (eventId) openAlertEvent(eventId);
  const itemId = Number(params.get("item"));
  if (itemId) {
    const tryOpen = () => {
      const item = state.items.find((i) => i.id === itemId);
      if (!item) return false;
      openLightbox(item);
      // Consumed — strip the param so browsing on (and a later reload)
      // doesn't keep re-opening the same lightbox.
      const url = new URL(location.href);
      url.searchParams.delete("item");
      history.replaceState(null, "", url.pathname + url.search);
      return true;
    };
    if (!tryOpen()) {
      const onRender = () => { if (tryOpen()) document.removeEventListener('app:render', onRender); };
      document.addEventListener('app:render', onRender);
      setTimeout(() => document.removeEventListener('app:render', onRender), 60000);
    }
  }

  // Jobs deep link: #jobs (optionally #jobs/<kind>) opens this board's jobs
  // modal — the Usage tab's drill-down lands here rather than on a second
  // admin job viewer (metering-plan.md, Stage 4c). Consumed like ?item=: the
  // modal is a destination, not an address worth keeping.
  //
  // Bound to the ADDRESS, not to page load: a hash is the one part of a URL
  // that changes without a navigation, so a boot-only read would work purely
  // by the grace of the one link that happens to open a new tab, and go inert
  // for a bookmark followed in place or any in-app link added later. Same
  // arrangement, for the same reason, as admin-capabilities.js's deep link.
  const openJobsFromHash = () => {
    const m = location.hash.match(/^#jobs(?:\/([\w-]+))?$/);
    if (!m || !state.boardId) return;
    openJobsModal({ kind: m[1] });
    history.replaceState(null, "", location.pathname + location.search);
  };
  addEventListener("hashchange", openJobsFromHash);
  openJobsFromHash();
}

main();
