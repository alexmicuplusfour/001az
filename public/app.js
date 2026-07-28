import { state } from './state.js';
import { toItem } from './utils.js';
import { filterKey, taggedFiltered, renderFacets, initFilters, decodeSelected, syncFiltersToUrl } from './filters.js';
import { inProgress, reconcile, ensurePolling, drainItems, stampBoardIngest } from './data.js';
import { renderGrid, layoutGrid, pokeSentinel, initGrid } from './grid.js';
import { initShortcuts } from './shortcuts.js';
import { renderToolbar } from './toolbar.js';
import { initFilterConfigsUI } from './filterconfigs.js';
import { initUpload } from './upload.js';
import { initLightbox, openLightbox } from './lightbox.js';
import { openAlertEvent } from './alert-event.js';
import { restoreSort } from './sort.js';

function render() {
  const key = filterKey();
  const tagged = taggedFiltered();
  renderToolbar(tagged.length);
  renderFacets();
  // With a status pill on, the grid *is* the queue — a lane on top would
  // just duplicate the same items.
  const laneHidden = state.showProcessing || state.showUnprocessed;
  renderGrid(key, laneHidden ? [] : inProgress(), tagged);
  syncFiltersToUrl();
  requestAnimationFrame(() => {
    layoutGrid();
    pokeSentinel();
  });
}

document.addEventListener('app:render', render);

async function main() {
  initGrid();
  initShortcuts();
  initFilters();
  initUpload();
  initLightbox();

  const params = new URLSearchParams(location.search);
  state.boardId = params.get("board");
  state.selected = decodeSelected(params.get("f")); // shareable filtered links
  const uParam = params.get("u");
  state.selectedUploaderIds = new Set(uParam ? uParam.split(",").map(Number).filter(Boolean) : []);

  if (!state.boardId) {
    const accessible = await fetch("/api/boards", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : []).catch(() => []);
    if (accessible.length > 0) {
      const last = localStorage.getItem("lastBoard");
      const target = accessible.find((b) => String(b.id) === last) || accessible[0];
      location.replace(`/?board=${target.id}`);
      return;
    }
  }

  const [boardData, itemsData, meData, cratesData, boardsData, filterConfigsData, alertsData] = await Promise.all([
    state.boardId
      ? fetch(`/api/boards/${state.boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
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
    state.boardId
      ? fetch(`/api/alerts?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => [])
      : Promise.resolve([]),
  ]);

  if (boardData) localStorage.setItem("lastBoard", String(state.boardId));

  state.facets = boardData ? boardData.facets : [];
  state.boardName = boardData ? boardData.name : null;
  state.boardManage = boardData ? !!boardData.manage : false;
  state.aiReasoning = boardData ? boardData.ai_reasoning !== false : true;
  state.boardMapping = boardData?.mapping || null;
  stampBoardIngest(boardData || {});
  state.boardTokens = boardData?.token_total ?? null;
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
  // First page ({ items, nextCursor, now }) — or a bare array from a server
  // that predates pagination, which boots identically and skips the drain.
  const firstPage = Array.isArray(itemsData) ? { items: itemsData, nextCursor: null, now: null } : itemsData;
  state.items = (firstPage.items || []).map(toItem);
  if (typeof firstPage.now === 'number') state.itemsSince = firstPage.now;
  state.crates = Array.isArray(cratesData) ? cratesData : [];
  state.filterConfigs = Array.isArray(filterConfigsData) ? filterConfigsData : [];
  state.alerts = Array.isArray(alertsData) ? alertsData : [];
  initFilterConfigsUI();
  state.boards = Array.isArray(boardsData) ? boardsData : [];
  // The viewer's per-board sort — needs boardMapping (identity mode) in place.
  restoreSort();
  render();
  ensurePolling();
  // Rest of the board streams in behind the first paint.
  drainItems(firstPage.nextCursor);

  // Alert deep links: ?event= swings the grid into one firing's entities
  // (openAlertEvent renders when the fetch lands); ?item= opens the lightbox
  // on an entity — which may still be draining in, so keep looking as pages
  // append until it shows up (or the board is done streaming without it).
  const eventId = Number(params.get("event"));
  if (eventId) openAlertEvent(eventId);
  const itemId = Number(params.get("item"));
  if (itemId) {
    const tryOpen = () => {
      const img = state.items.find((i) => i.id === itemId);
      if (!img) return false;
      openLightbox(img);
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
}

main();
