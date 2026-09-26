import { state } from './state.js';
import { getJson } from './api.js';
import { toItem } from './utils.js';
import { filterKey, taggedFiltered, renderFacets, initFilters, decodeSelection, syncFiltersToUrl, activeCount, reconcileSelection, checkCached } from './filters.js';
import { selEntry } from './facet-match.js';
import { inProgress, reconcile, ensurePolling, drainItems, stampBoard, setWork } from './data.js';
import { renderGrid, layoutGrid, pokeSentinel, initGrid } from './grid.js';
import { renderRows, pokeRowsSentinel } from './rows.js';
import { pruneSelection } from './bulk.js';
import { itemsVersion } from './state-signals.js';
import { effect } from './vendor/signals.mjs';
import { resolveView, restoreView } from './view.js';
import { initShortcuts } from './shortcuts.js';
import { renderToolbar } from './toolbar.js';
import { initFilterConfigsUI, loadFilterConfigs } from './filterconfigs.js';
import { initUpload } from './upload.js';
import { openDetail, preloadDetail } from './detail-open.js';
import { openAlertEvent } from './alert-event.js';
import { startSignals, refreshAlerts, refreshJobErrors } from './signals.js';
import { startAnnouncing } from './announce.js';
import { startEvents } from './events.js';
import { loadCrates } from './crates.js';
import { restoreSort } from './sort.js';
import { restoreOdds, restoreClusters, restoreMeaningClusters, refreshClusters } from './patterns.js';
import { initHeaderScroll } from './header-scroll.js';
import { toast } from './toast.js';
import { openJobsModal, preloadModals } from './modal-door.js';

const elGridRoot = document.getElementById("grid");

// The page, drawn from state. It runs in an effect (main, below), so a write
// to anything it reads draws it again, at once (planning/ui-updates-plan.md,
// Stage 5); a handler that writes several fields batches them into one draw.
function render() {
  // A selection of items that are gone (deleted elsewhere) is pruned before
  // anything draws it.
  pruneSelection();
  // Before anything reads the board: taggedFiltered and the rail both go
  // through the ~clusters grouping, so it refreshes first (a no-op unless
  // the lens is on AND the tag data moved — see patterns.js). Callers of
  // taggedFiltered outside render (the lightbox, the rows view, the grid's
  // next batch) see the grouping the last repaint published.
  refreshClusters();
  const key = filterKey();
  const tagged = taggedFiltered();
  if (globalThis.__checkCached) checkCached(); // the tests' check (filters.js)
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
  // Each renderer draws its own tree into #grid and owns a batch limit. Both
  // go by one key for #grid (grid.js freshKey), and it ends in the mode, so a
  // flip always draws the other tree, from its first batch.
  elGridRoot.classList.toggle("rows-mode", mode === "rows");
  if (mode === "rows") renderRows(`${key}|rows`, progress, tagged);
  else renderGrid(`${key}|grid`, progress, tagged);
  syncFiltersToUrl();
  requestAnimationFrame(() => {
    layoutGrid(); // self-gates in rows mode
    pokeSentinel();
    pokeRowsSentinel();
  });
}

async function main() {
  initGrid();
  initShortcuts();
  initFilters();
  initUpload();
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
    if (ids.length) state.selected = new Map(state.selected).set("~uploaders", selEntry(ids));
  }

  // Set when the landing rule below has already asked which boards are ours,
  // so the boot batch doesn't ask a second time.
  let landed = null;

  if (!state.boardId) {
    // null, not [], when the question couldn't be asked — the two answers lead
    // opposite ways below, and a failed fetch that reads as "zero boards" would
    // send an anonymous visitor the wrong direction.
    const accessible = await fetch("/api/boards", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null).catch(() => null);
    if (accessible?.length) {
      const last = localStorage.getItem("lastBoard");
      const target = accessible.find((b) => String(b.id) === last) || accessible[0];
      // Adopt it here rather than navigating to it. At this point nothing has
      // rendered and nothing below reads the board back out of the address:
      // `params` was captured above, and syncFiltersToUrl only ever writes
      // f/fx/u, so it preserves ?board= rather than deriving from it. A
      // navigation would therefore spend a second document fetch, and a second
      // parse and evaluation of the whole bundle, to arrive at the state this
      // function is already holding — measured at ~100ms, and more on a slow
      // machine (planning/app-loading-plan.md, Stage 3).
      //
      // replaceState, matching the location.replace it replaces: the current
      // history entry is overwritten either way, so Back still returns to
      // wherever the reader came from rather than to a bare /.
      state.boardId = String(target.id);
      landed = accessible;
      const url = new URL(location.href);
      url.searchParams.set("board", state.boardId);
      history.replaceState(null, "", url.pathname + url.search);
    }
    // Zero boards is not an empty board — it's a boardless page. Everything
    // below is item-scoped: the toolbar collapses to the logo, and the grid
    // reports "No items match these filters" about filters that aren't there
    // and a board that doesn't exist. The boards page is where nothing-to-show
    // has words for itself (and, for an admin, the button that fixes it).
    // The landing rule for a reader who HAS boards is unchanged — last board,
    // not a gate (planning/boards-page-plan.md, "Entry points" #4).
    //
    // `else if`, not a second `if`: the branch above no longer returns, so a
    // bare `if` here would send every reader who just adopted a board to the
    // boards page — a non-empty array is still an array.
    else if (Array.isArray(accessible)) {
      location.replace("/boards");
      return;
    }
    // Couldn't ask: fall through to the /api/me gate, which sends an anonymous
    // visitor to login with the interrupted URL intact.
  }

  const [boardRes, itemsData, meData, , boardsData] = await Promise.all([
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
    // Crates and saved filters ride this batch for the parallelism, not for a
    // return value: they write state themselves, so boot and the event channel
    // share one implementation apiece instead of two that can drift. Same shape
    // as refreshAlerts/refreshJobErrors below.
    state.boardId ? loadCrates() : Promise.resolve(),
    // The landing rule above already asked this when it had to pick a board;
    // asking again would be the same answer, one round trip later.
    landed || fetch("/api/boards", { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => []),
    state.boardId ? loadFilterConfigs() : Promise.resolve(),
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
  // The lane half of in-flight work rides the first page: opening a board
  // mid-transcription lights the chip on arrival, not a signals tick later.
  setWork(firstPage.work);
  // state.crates / state.filterConfigs were written by their loaders above.
  initFilterConfigsUI();
  // ?f=/?fx= were decoded at the top of boot, ~100 lines before this board's
  // vocabulary existed to check them against — a link can name values the board
  // has since dropped, and an exclude half that can't match is invisible.
  // Gated on `boardData`: an empty facet list is also what a board fetch that
  // FAILED leaves behind, and taking someone's filters away over a 500 is worse
  // than the stale ones. After the two redirects above, so a board that isn't
  // ours doesn't toast on its way off the page.
  if (boardData) reconcileSelection();
  state.boards = Array.isArray(boardsData) ? boardsData : [];
  // The viewer's per-board sort — needs boardMapping (identity mode) in place.
  restoreSort();
  restoreOdds();
  restoreClusters();
  restoreMeaningClusters();
  restoreView();
  // From here the page draws itself: whenever something render() read
  // changes, it runs again. An error in it is reported, not thrown back into
  // whatever wrote the signal.
  effect(() => {
    try { render(); } catch (e) { reportError(e); }
  });
  ensurePolling();
  startSignals(); // the header's dots, on their own cadence from here on
  // …and their voice. After the first render, so whatever is ALREADY lit when
  // the page opens becomes the baseline instead of three toasts on arrival.
  startAnnouncing();
  // What other people did while you were looking (planning/board-events-stage-1.md).
  // After the first paint for the same reason as the two above: its `onopen`
  // refetches, and that is wasted work while boot's own fetches are still landing.
  startEvents();
  // Rest of the board streams in behind the first paint.
  //
  // …and only once it has, warm what the reader is most likely to reach for
  // next: the toolbar's modals and the detail view. This is what keeps the lazy
  // split from being a trade — the bytes leave the critical path but still
  // arrive before anyone asks for them, and because they are content-hashed and
  // immutable it costs one fetch ever rather than one per visit.
  //
  // AFTER the drain, not beside it. These two chunks are about as large as the
  // whole boot payload, and an import() is a high-priority script fetch while
  // the grid's thumbnails are low-priority images — warming them while the
  // board is still streaming puts them in front of the pictures the reader is
  // actually looking at. drainItems resolves immediately when there is no
  // cursor, so a board that fits in one page still warms at once. A click that
  // lands first just awaits the same in-flight promise, which the door handles.
  const warmChunks = () => { preloadModals(); preloadDetail(); };
  drainItems(firstPage.nextCursor).finally(() => {
    if (typeof requestIdleCallback === "function") requestIdleCallback(warmChunks, { timeout: 3000 });
    else setTimeout(warmChunks, 1500);
  });

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
    const find = () => state.items.find((i) => i.id === itemId);
    const open = (item) => {
      openDetail(item);
      // Consumed — strip the param so browsing on (and a later reload)
      // doesn't keep re-opening the same lightbox.
      const url = new URL(location.href);
      url.searchParams.delete("item");
      history.replaceState(null, "", url.pathname + url.search);
    };
    const item = find();
    if (item) open(item);
    else {
      // Still draining in, maybe: look again as the items change (the drain
      // appends in place and announces each page), for a minute. Opened
      // outside the effect, so the lightbox's own reads don't become its.
      let done = false;
      const stop = effect(() => {
        void itemsVersion.value;
        const found = find();
        if (!found || done) return;
        done = true;
        queueMicrotask(() => { stop(); open(found); });
      });
      setTimeout(() => stop(), 60000);
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
