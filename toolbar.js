import { state } from './state.js';
import { ICONS, toolBtn } from './utils.js';
import { openDropdown, ddRow, ddSep } from './dropdown.js';
import { activeCount, clearAll, toggleFiltersOrDrawer } from './filters.js';
import { openCratePop } from './crates.js';

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
  elToolbar.replaceChildren();
  elToolbarSub.replaceChildren();

  // Row 1: identity + upload + auth
  const logo = document.createElement("span");
  logo.className = "toolbar-logo";
  logo.textContent = "001/";
  elToolbar.appendChild(logo);

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
    if (state.boardName && state.adapter?.triggerIngest) {
      auth.appendChild(toolBtn(ICONS.plus, "upload", () => state.adapter.triggerIngest()));
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

  const ac = activeCount();
  elToolbarSub.appendChild(toolBtn(
    ac > 0 ? `Filters (${ac})` : "Filters",
    ac > 0 ? "active" : "",
    toggleFiltersOrDrawer
  ));

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
      lbl.textContent = activeCrate ? activeCrate.name : "Crates";
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

  elToolbarSub.appendChild(toolBtn(
    `${ICONS.heart} Top`,
    "sort" + (state.sortByHearts ? " active" : ""),
    () => { state.sortByHearts = !state.sortByHearts; document.dispatchEvent(new Event('app:render')); }
  ));
}
