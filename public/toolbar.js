import { state } from './state.js';
import { refreshBoardIngest } from './data.js';
import { ICONS, toolBtn, formatTokens, fmtDuration } from './utils.js';
import { Odometer } from './odometer.js';
import { openDropdown, ddRow, ddSep } from './dropdown.js';
import { activeCount, clearAll, favoritesInContext, toggleFiltersOrDrawer } from './filters.js';
import { openCratePop, appendCrateLabel } from './crates.js';
import { openFilterConfigPop } from './filterconfigs.js';
import { runSearch, clearSearch } from './search.js';
import { triggerFilePicker } from './upload.js';
import { openIngestModal } from './ingest-modal.js';
import { openBoardModal } from './board-modal.js';
import { openConnectorBrowse } from './connector-browse.js';

const elToolbar = document.getElementById("toolbar");
const elToolbarSub = document.getElementById("toolbar-sub");

// The live token counter persists across toolbar rebuilds so it can roll from
// the previous value to the new one as tagging ticks the total up.
let tokenOdo = null;

// ── ingestion chip: countdown to the board's next automatic run ──
// The board payload carries ingest_next_run_at once; after each run the stamp
// moves server-side, so when the countdown expires the chip re-learns the
// schedule via refreshBoardIngest (throttled). A rebuilt toolbar strands the
// old chip's interval, which self-clears on its next tick via isConnected —
// which is why the throttle and backoff live at module level, not per chip.
let ingestEtaFetchAt = 0;
let ingestEtaBackoff = 5000;

function ingestChip() {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "mapping-chip ingest-chip";
  chip.title = "Automatic ingestion — next run countdown. Click to configure.";
  const icon = document.createElement("span");
  icon.className = "ingest-chip-icon";
  icon.innerHTML = ICONS.redo;
  const eta = document.createElement("span");
  chip.append(icon, eta);
  chip.addEventListener("click", () => openIngestModal());

  const render = () => {
    const at = state.boardIngestNextRun;
    if (!at) {
      eta.textContent = "manual";
      return false;
    }
    const left = at - Date.now();
    eta.textContent = left <= 0 ? "now" : fmtDuration(left);
    return left <= 0;
  };
  render();
  const t = setInterval(async () => {
    if (!chip.isConnected) return clearInterval(t);
    const due = render();
    if (!due) {
      ingestEtaBackoff = 5000; // fresh countdown — next expiry probes eagerly
      return;
    }
    // Expired (or run-now fired): the sweep claims within a worker tick, so
    // shortly after "now" the server holds a fresh next_run_at — re-learn it.
    if (Date.now() - ingestEtaFetchAt > ingestEtaBackoff) {
      ingestEtaFetchAt = Date.now();
      await refreshBoardIngest();
      // A refresh that leaves the stamp in the past means it isn't advancing
      // (worker down, or a long run draining at "now") — back off instead of
      // hammering the board endpoint from every open tab.
      const at = state.boardIngestNextRun;
      if (!(at && at > Date.now())) ingestEtaBackoff = Math.min(ingestEtaBackoff * 2, 60000);
    }
  }, 1000);
  return chip;
}

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
    footer: state.me?.is_admin ? (foot, { close }) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tp-edit";
      btn.innerHTML = ICONS.plus + "<span>New board</span>";
      btn.addEventListener("click", () => {
        close();
        openBoardModal(null, { canEditAI: true, onSaved: (saved) => { location.href = `/?board=${saved.id}`; } });
      });
      foot.appendChild(btn);
    } : undefined,
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
    // The board selector and its edit pencil are one unit — keep them tight.
    const boardGroup = document.createElement("div");
    boardGroup.className = "board-group";

    // A connector-backed board carries a mapping template; surface its name as a
    // chip beside the edit pencil. The data source is a board-config detail, so
    // it belongs with the board controls, not the ingest (+) cluster.
    const connectorName = state.boardMapping?.input?.connector;
    let templateChip = null;
    if (connectorName) {
      templateChip = document.createElement("span");
      templateChip.className = "mapping-chip";
      templateChip.textContent = connectorName.charAt(0).toUpperCase() + connectorName.slice(1);
      templateChip.title = `Entity mapping template: ${connectorName}`;
    }

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
      boardGroup.appendChild(boardBtn);
    } else {
      const name = document.createElement("span");
      name.className = "board-name";
      name.textContent = state.boardName;
      boardGroup.appendChild(name);
    }

    // Board admins (global or per-board) get an inline "edit board" pencil that
    // opens the same board editor as the admin page, content-only.
    if (state.boardManage) {
      const editBtn = toolBtn(ICONS.pencil, "board-edit-btn", () => openBoardModal(null, {
        canEditAI: !!state.me?.is_admin,
        boardId: state.boardId,
        withMapping: true,
        onSaved: (payload) => {
          state.boardName = payload.name;
          state.facets = payload.facets;
          state.aiReasoning = payload.ai_reasoning !== false;
          const b = state.boards.find((x) => x.id === state.boardId);
          if (b) b.name = payload.name;
          document.dispatchEvent(new Event('app:render'));
        },
      }));
      editBtn.title = "Edit board";
      editBtn.setAttribute("aria-label", "Edit board");
      boardGroup.appendChild(editBtn);
      if (templateChip) boardGroup.appendChild(templateChip);

      if (state.boardTokens > 0) {
        if (!tokenOdo) tokenOdo = new Odometer(formatTokens(state.boardTokens));
        const tokenChip = document.createElement("span");
        tokenChip.className = "token-chip";
        tokenChip.innerHTML = ICONS.coin;
        tokenChip.appendChild(tokenOdo.el);
        tokenChip.title = `${state.boardTokens.toLocaleString()} tokens used (AI tagging)`;
        boardGroup.appendChild(tokenChip);
        // Re-append then set: if the value grew since the last render, the
        // changed digits roll; if not, this is a no-op.
        tokenOdo.set(formatTokens(state.boardTokens));
      }
    } else if (templateChip) {
      // No edit pencil (non-manager) — still show the data-source chip.
      boardGroup.appendChild(templateChip);
    }
    elToolbar.appendChild(boardGroup);
  }

  const auth = document.createElement("div");
  auth.className = "auth";
  if (state.me) {
    if (state.boardName) {
      // Split button: plus = file picker OR connector search (based on mapping.input);
      // chevron always opens the ingestion menu.
      // The + button's behaviour depends on the board's input source (file
      // picker vs connector browse); the template chip itself now renders in the
      // board-group beside the edit pencil.
      const connectorName = state.boardMapping?.input?.connector;

      // Ingestion chip: a live countdown to the next automatic run. Clicking
      // opens the ingestion modal.
      if (state.boardIngest) {
        auth.appendChild(ingestChip());
      }

      // Add button + its ingestion menu — two separate rounded buttons with a
      // small gap, mirroring the board selector / edit-pencil pairing.
      const plusWrap = document.createElement("div");
      plusWrap.className = "board-group";
      const plusBtn = toolBtn(ICONS.plus, "upload", null); // onClick set below
      plusBtn.addEventListener("click", () => {
        if (connectorName) openConnectorBrowse(connectorName);
        else triggerFilePicker();
      });
      plusWrap.appendChild(plusBtn);
      const plusMenu = document.createElement("button");
      plusMenu.className = "tool-btn plus-caret";
      plusMenu.title = "More ingestion options";
      plusMenu.setAttribute("aria-label", "More ingestion options");
      plusMenu.innerHTML = ICONS.chevron;
      plusMenu.addEventListener("click", () => openDropdown(plusMenu, {
        align: "end",
        minWidth: 180,
        build: (body, { close }) => {
          body.appendChild(ddRow({
            label: "Automatic ingestion…",
            onClick: () => { close(); openIngestModal(); },
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
      () => {
        state.showFavorites = !state.showFavorites;
        document.dispatchEvent(new Event('app:render'));
      },
      favoritesInContext()
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
