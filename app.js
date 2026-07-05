import { state } from './state.js';
import { toItem } from './utils.js';
import { toast } from './toast.js';
import { filterKey, taggedFiltered, renderFacets, initFilters } from './filters.js';
import { inProgress, reconcile, ensurePolling } from './data.js';
import { renderGrid, layoutGrid, pokeSentinel, initGrid } from './grid.js';
import { renderToolbar } from './toolbar.js';
import { registerType, getType } from './types/index.js';
import imageType from './types/image/index.js';

registerType(imageType);

function render() {
  const key = filterKey();
  const tagged = taggedFiltered();
  renderToolbar(tagged.length);
  renderFacets();
  renderGrid(key, inProgress(), tagged);
  requestAnimationFrame(() => {
    layoutGrid();
    pokeSentinel();
  });
}

document.addEventListener('app:render', render);

async function main() {
  initGrid();
  initFilters();

  const params = new URLSearchParams(location.search);
  state.boardId = params.get("board");

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

  const [boardData, itemsData, meData, cratesData, boardsData] = await Promise.all([
    state.boardId
      ? fetch(`/api/boards/${state.boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : null).catch(() => null)
      : Promise.resolve(null),
    state.boardId
      ? fetch(`/api/items?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.json()).catch(() => [])
      : Promise.resolve([]),
    fetch("/api/me", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    state.boardId
      ? fetch(`/api/crates?board=${state.boardId}`, { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => [])
      : Promise.resolve([]),
    fetch("/api/boards", { cache: "no-store" }).then((r) => r.ok ? r.json() : []).catch(() => []),
  ]);

  if (boardData) localStorage.setItem("lastBoard", String(state.boardId));

  state.facets = boardData ? boardData.facets : [];
  state.boardName = boardData ? boardData.name : null;
  state.aiReasoning = boardData ? boardData.ai_reasoning !== false : true;
  state.adapter = getType(boardData?.type);
  state.adapter.init?.();
  state.me = meData;
  state.items = itemsData.map(toItem);
  state.crates = Array.isArray(cratesData) ? cratesData : [];
  state.boards = Array.isArray(boardsData) ? boardsData : [];
  render();
  ensurePolling();

  const loginErr = params.get("login");
  if (loginErr === "invalid") {
    toast.warn("Login link has expired or already been used — ask for a new one.");
    history.replaceState(null, "", state.boardId ? `/?board=${state.boardId}` : "/");
  }
}

main();
