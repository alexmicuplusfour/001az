import { state } from './state.js';
import { ICONS, toolBtn } from './utils.js';
import { openDropdown, ddRow, ddSep } from './dropdown.js';
import { activeCount, clearAll, toggleFiltersOrDrawer } from './filters.js';
import { openCratePop, appendCrateLabel } from './crates.js';
import { openFilterConfigPop } from './filterconfigs.js';
import { runSearch, clearSearch } from './search.js';
import { triggerFilePicker } from './upload.js';
import { openMappingModal } from './mapping-modal.js';

const elToolbar = document.getElementById("toolbar");
const elToolbarSub = document.getElementById("toolbar-sub");

function openUserMenu(anchorEl) {
  openDropdown(anchorEl, {
    className: "user-menu-pop",
    build: (body, { close }) => {
      if (state.me && state.me.is_admin) {
        body.appendChild(ddRow({ label: "Admin", href: "/admin.html" }));
        body.appendChild(ddSep());
      }
      body.appendChild(ddRow({
        label: "Sign out",
        onClick: async () => {
          close();
          await fetch("/api/logout", { method: "POST" });
          location.reload();
        },
      }));
    },
  });
}

function openBoardPop(anchorEl) {
  openDropdown(anchorEl, {
    className: "board-pop",
    align: "start",
    minWidth: 160,
    build: (body) => {
      for (const b of state.boards) {
        body.appendChild(ddRow({
          label: b.name,
          active: b.id === state.boardId,
          onClick: () => { location.href = `/?board=${b.id}`; },
        }));
      }
    },
  });
}

export function renderToolbar(resultCount) {
  // Re-rendering replaces the search input; remember focus to restore it.
  const searchHadFocus = !!document.activeElement?.closest?.(".search-box");
  elToolbar.replaceChildren();
  elToolbarSub.replaceChildren();

  // Row 1: identity + upload + auth
  const logo = document.createElement("span");
  logo.className = "toolbar-logo";
  logo.textContent = "001az/";
  elToolbar.appendChild(logo);

  document.title = state.boardName ? `001az - ${state.boardName}` : "001az";

  if (state.boardName) {
    if (state.me && state.boards.length > 1) {
      const boardBtn = document.createElement("button");
      boardBtn.className = "tool-btn board-btn";
      const nameEl = document.createElement("span");
      nameEl.textContent = state.boardName;
      const chev = document.createElement("span");
      chev.className = "board-chevron";
      chev.innerHTML = ICONS.chevron;
      boardBtn.append(nameEl, chev);
      boardBtn.addEventListener("click", () => openBoardPop(boardBtn));
      elToolbar.appendChild(boardBtn);
    } else {
      const name = document.createElement("span");
      name.className = "board-name";
      name.textContent = state.boardName;
      elToolbar.appendChild(name);
    }
  }

  const auth = document.createElement("div");
  auth.className = "auth";
  if (state.me) {
    if (state.boardName) {
      // Split button: plus keeps the file picker; chevron opens the ingestion menu.
      const plusWrap = document.createElement("div");
      plusWrap.className = "split-btn";
      plusWrap.appendChild(toolBtn(ICONS.plus, "upload", () => triggerFilePicker()));
      const plusMenu = document.createElement("button");
      plusMenu.className = "tool-btn split-arrow";
      plusMenu.title = "More ingestion options";
      plusMenu.setAttribute("aria-label", "More ingestion options");
      plusMenu.innerHTML = ICONS.chevron;
      plusMenu.addEventListener("click", () => openDropdown(plusMenu, {
        align: "end",
        minWidth: 180,
        build: (body, { close }) => {
          body.appendChild(ddRow({
            label: "Entity mapping…",
            onClick: () => { close(); openMappingModal(); },
          }));
        },
      }));
      plusWrap.appendChild(plusMenu);
      auth.appendChild(plusWrap);
    }
    const userBtn = document.createElement("button");
    userBtn.className = "tool-btn user-menu-btn";
    const nameSpan = document.createElement("span");
    nameSpan.className = "user-menu-name";
    nameSpan.textContent = state.me.name || state.me.email;
    const chev = document.createElement("span");
    chev.className = "user-menu-chev";
    chev.innerHTML = ICONS.chevron;
    userBtn.append(nameSpan, chev);
    userBtn.addEventListener("click", () => openUserMenu(userBtn));
    auth.appendChild(userBtn);
  }
  elToolbar.appendChild(auth);

  // Row 2: filters / sort / count
  if (!state.boardName) return;

  // Filters is a split button: the label toggles the facet panel, the
  // chevron opens saved filter configs (logged-in only — they're per-user).
  const ac = activeCount();
  const filtersWrap = document.createElement("div");
  filtersWrap.className = "split-btn";
  filtersWrap.appendChild(toolBtn(
    ac > 0 ? `Filters (${ac})` : "Filters",
    ac > 0 ? "active" : "",
    toggleFiltersOrDrawer
  ));
  if (state.me) {
    const arrow = document.createElement("button");
    arrow.className = "tool-btn split-arrow" + (ac > 0 ? " active" : "");
    arrow.title = "Saved filters";
    arrow.setAttribute("aria-label", "Saved filters");
    arrow.innerHTML = ICONS.chevron;
    arrow.addEventListener("click", () => openFilterConfigPop(arrow));
    filtersWrap.appendChild(arrow);
  }
  elToolbarSub.appendChild(filtersWrap);

  // Semantic search (only when the server has embeddings configured).
  // Submits on Enter — every query is one paid embedding call server-side.
  if (state.searchAvailable) {
    const box = document.createElement("div");
    box.className = "search-box" + (state.searchResults ? " active" : "");
    const input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search by meaning…";
    input.setAttribute("aria-label", "Semantic search");
    input.value = state.searchDraft;
    input.addEventListener("input", () => { state.searchDraft = input.value; });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") runSearch(input.value);
      else if (e.key === "Escape") { e.stopPropagation(); clearSearch(); input.blur(); }
    });
    box.appendChild(input);
    if (state.searchLoading) {
      const spin = document.createElement("span");
      spin.className = "search-spinner";
      spin.setAttribute("aria-label", "Searching…");
      box.appendChild(spin);
    } else if (state.searchResults) {
      const clearBtn = document.createElement("button");
      clearBtn.className = "search-clear";
      clearBtn.title = "Clear search";
      clearBtn.setAttribute("aria-label", "Clear search");
      clearBtn.textContent = "×";
      clearBtn.addEventListener("click", clearSearch);
      box.appendChild(clearBtn);
    }
    elToolbarSub.appendChild(box);
    if (searchHadFocus) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  if (state.me) {
    elToolbarSub.appendChild(toolBtn(
      `${ICONS.heart} Your favorites`,
      "fav" + (state.showFavorites ? " active" : ""),
      () => { state.showFavorites = !state.showFavorites; document.dispatchEvent(new Event('app:render')); }
    ));

    if (state.crates.length > 0) {
      const activeCrate = state.crates.find((c) => c.id === state.selectedCrateId) || null;
      const cratesBtn = document.createElement("button");
      cratesBtn.className = "tool-btn crates-btn" + (activeCrate ? " active" : "");
      cratesBtn.innerHTML = ICONS.crate;
      const lbl = document.createElement("span");
      lbl.replaceChildren();
      if (activeCrate) appendCrateLabel(lbl, activeCrate);
      else lbl.textContent = "Crates";
      cratesBtn.appendChild(lbl);
      const chev = document.createElement("span");
      chev.className = "crates-chevron";
      chev.innerHTML = ICONS.chevron;
      cratesBtn.appendChild(chev);
      cratesBtn.addEventListener("click", () => openCratePop(cratesBtn));
      elToolbarSub.appendChild(cratesBtn);

      if (activeCrate) {
        const clearCrateBtn = toolBtn("×", "crates-clear", () => {
          state.selectedCrateId = null;
          document.dispatchEvent(new Event('app:render'));
        });
        clearCrateBtn.title = "Clear crate filter";
        elToolbarSub.appendChild(clearCrateBtn);
      }
    }
  }

  const count = document.createElement("span");
  count.className = "result-count";
  count.textContent = `${resultCount} item${resultCount === 1 ? "" : "s"}`;
  elToolbarSub.appendChild(count);

  const active = activeCount();
  if (active > 0) {
    elToolbarSub.appendChild(toolBtn(`Clear filters (${active})`, "clear", clearAll));
  }

  // Wrap sort buttons so only the group gets margin-left:auto, not each individually.
  const sortWrap = document.createElement("div");
  sortWrap.className = "sort-group";
  sortWrap.appendChild(toolBtn(
    "A–Z",
    "sort-btn" + (state.sortAlpha ? " active" : ""),
    () => { state.sortAlpha = !state.sortAlpha; document.dispatchEvent(new Event('app:render')); }
  ));
  sortWrap.appendChild(toolBtn(
    `${ICONS.heart} Top`,
    "sort-btn" + (state.sortByHearts ? " active" : ""),
    () => { state.sortByHearts = !state.sortByHearts; document.dispatchEvent(new Event('app:render')); }
  ));
  elToolbarSub.appendChild(sortWrap);
}
