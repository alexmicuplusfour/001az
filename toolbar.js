import { state } from './state.js';
import { ICONS, toolBtn, onOutsideClick, positionPop } from './utils.js';
import { activeCount, clearAll, toggleFiltersOrDrawer } from './filters.js';
import { openCratePop } from './crates.js';
import { triggerFilePicker } from './upload.js';

const elToolbar = document.getElementById("toolbar");
const elToolbarSub = document.getElementById("toolbar-sub");

let userMenuState = null;

function closeUserMenu() {
  if (!userMenuState) return;
  userMenuState.pop.remove();
  document.removeEventListener("click", userMenuState.outside, true);
  userMenuState = null;
}

function openUserMenu(anchorEl) {
  if (userMenuState && userMenuState.anchor === anchorEl) { closeUserMenu(); return; }
  closeUserMenu();
  const pop = document.createElement("div");
  pop.className = "float-menu user-menu-pop";
  if (state.me && state.me.is_admin) {
    const row = document.createElement("a");
    row.href = "/admin.html";
    row.className = "cp-row";
    row.textContent = "Admin";
    pop.appendChild(row);
    const sep = document.createElement("div");
    sep.className = "cp-sep";
    pop.appendChild(sep);
  }
  const signOut = document.createElement("div");
  signOut.className = "cp-row";
  signOut.textContent = "Sign out";
  signOut.addEventListener("click", async () => {
    closeUserMenu();
    await fetch("/api/logout", { method: "POST" });
    location.reload();
  });
  pop.appendChild(signOut);
  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  const outside = onOutsideClick(pop, anchorEl, closeUserMenu);
  userMenuState = { pop, outside, anchor: anchorEl };
}

let boardPopState = null;

function closeBoardPop() {
  if (!boardPopState) return;
  boardPopState.pop.remove();
  document.removeEventListener("click", boardPopState.outside, true);
  boardPopState = null;
}

function openBoardPop(anchorEl) {
  if (boardPopState && boardPopState.anchor === anchorEl) { closeBoardPop(); return; }
  closeBoardPop();
  const pop = document.createElement("div");
  pop.className = "float-menu board-pop";
  for (const b of state.boards) {
    const row = document.createElement("div");
    row.className = "cp-row" + (b.id === state.boardId ? " active" : "");
    const name = document.createElement("span");
    name.className = "cp-name";
    name.textContent = b.name;
    row.appendChild(name);
    row.addEventListener("click", () => { location.href = `/?board=${b.id}`; });
    pop.appendChild(row);
  }
  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  const outside = onOutsideClick(pop, anchorEl, closeBoardPop);
  boardPopState = { pop, outside, anchor: anchorEl };
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
    if (state.boardName) {
      auth.appendChild(toolBtn(ICONS.plus, "upload", triggerFilePicker));
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

  elToolbarSub.appendChild(toolBtn(
    `${ICONS.heart} Top`,
    "sort" + (state.sortByHearts ? " active" : ""),
    () => { state.sortByHearts = !state.sortByHearts; document.dispatchEvent(new Event('app:render')); }
  ));

  const count = document.createElement("span");
  count.className = "result-count";
  count.textContent = `${resultCount} image${resultCount === 1 ? "" : "s"}`;
  elToolbarSub.appendChild(count);

  const active = activeCount();
  if (active > 0) {
    elToolbarSub.appendChild(toolBtn(`Clear filters (${active})`, "clear", clearAll));
  }
}
