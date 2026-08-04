import { state } from './state.js';
import { refreshBoardIngest, ACTIVE, QUEUED } from './data.js';
import { ICONS, toolBtn, formatTokens, fmtDuration, attachBtnDot } from './utils.js';
import { openJobsModal } from './jobs-modal.js';
import { Odometer } from './odometer.js';
import { openDropdown, ddRow, ddSep } from './dropdown.js';
import { activeCount, clearAll, favoritesInContext, toggleFiltersOrDrawer, selectedAsConfig } from './filters.js';
import { openCratePop, appendCrateLabel } from './crates.js';
import { openFilterConfigPop } from './filterconfigs.js';
import { runSearch, clearSearch } from './search.js';
import { triggerFilePicker } from './upload.js';
import { openIngestModal } from './ingest-modal.js';
import { openBoardModal } from './board-modal.js';
import { openConnectorBrowse } from './connector-browse.js';
import { appendAlertMenu, appendAlertFooter, alertsUnseen } from './alerts-modal.js';
import { clearAlertEvent } from './alert-event.js';
import { sortCatalog, defaultDir, saveSort, restoreSort } from './sort.js';
import { effectiveView, toggleView, rowsRelevant } from './view.js';

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

// ── jobs chip: ambient "work is happening" signal + the door to the job log ──
// The count is the client's own in-flight items (the statuses the delta poll
// already streams), so it refreshes for free on every toolbar rebuild — no
// extra requests. Sweep jobs the client can't see (a transcription, an ingest
// run) live inside the modal, which does its own fetching.
function jobsChip() {
  const n = state.items.reduce((k, i) => k + (ACTIVE.has(i.status) || QUEUED.has(i.status) ? 1 : 0), 0);
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "mapping-chip jobs-chip" + (n > 0 ? " busy" : "");
  chip.title = n > 0 ? `${n} item${n === 1 ? "" : "s"} in the pipeline — click for the job log` : "Job log";
  chip.setAttribute("aria-label", "Job log");
  const icon = document.createElement("span");
  icon.className = "jobs-chip-icon";
  icon.innerHTML = ICONS.activity;
  chip.appendChild(icon);
  if (n > 0) {
    const count = document.createElement("span");
    count.textContent = n;
    chip.appendChild(count);
  }
  chip.addEventListener("click", () => openJobsModal());
  return chip;
}

function openUserMenu(anchorEl) {
  openDropdown(anchorEl, {
    className: "user-menu-pop",
    build: (body, { close }) => {
      if (state.me && state.me.is_admin) {
        body.appendChild(ddRow({ label: "Admin", href: "/admin.html" }));
      }
      body.appendChild(ddRow({ label: "Profile", href: "/profile.html" }));
      body.appendChild(ddSep());
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
    // The footer is always built now: "All boards" is every member's way to
    // the boards page (planning/boards-page-plan.md), while CREATING one stays
    // a global-admin power. A real <a>, so middle-click opens it in a tab.
    footer: (foot, { close }) => {
      const all = document.createElement("a");
      all.className = "tp-edit";
      all.href = "/boards.html";
      all.innerHTML = ICONS.grid + "<span>All boards</span>";
      foot.appendChild(all);

      if (!state.me?.is_admin) return;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tp-edit";
      btn.innerHTML = ICONS.plus + "<span>New board</span>";
      btn.addEventListener("click", () => {
        close();
        openBoardModal(null, { canEditAI: true, onSaved: (saved) => { location.href = `/?board=${saved.id}`; } });
      });
      foot.appendChild(btn);
    },
  });
}

export function renderToolbar(resultCount) {
  // Re-rendering replaces the search input; remember focus to restore it.
  const searchHadFocus = !!document.activeElement?.closest?.(".search-box");
  elToolbar.replaceChildren();
  elToolbarSub.replaceChildren();

  // Row 1: identity + upload + auth
  // The logo is the conventional "home" — here that's the boards index, and
  // it's the ONLY route there for a one-board member (the board switcher, and
  // so its All-boards footer, only renders when there's more than one).
  const logo = document.createElement("a");
  logo.className = "toolbar-logo";
  logo.href = "/boards.html";
  logo.title = "All boards";
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
    // opens the same board editor as the admin page (content-only + read-only
    // Mapping view for non-admin board-admins).
    if (state.boardManage) {
      const editBtn = toolBtn(ICONS.pencil, "board-edit-btn", () => openBoardModal(state.boardId, {
        canEditAI: !!state.me?.is_admin,
        onSaved: (payload) => {
          state.boardName = payload.name;
          state.facets = payload.facets;
          state.aiReasoning = payload.ai_reasoning !== false;
          // `mapping` is present only when the Mapping pane was touched — sync
          // it so the toolbar's connector chip re-reads mapping.input, and
          // re-validate the sort: the edit may have unbound the sorted field
          // or changed the identity mode out from under it.
          if (payload.mapping !== undefined) {
            state.boardMapping = payload.mapping;
            restoreSort();
          }
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
    // Jobs chip for every member (the log is transparency, not management).
    if (state.me) boardGroup.appendChild(jobsChip());
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
      plusMenu.title = "Ingestion & alerts";
      plusMenu.setAttribute("aria-label", "Ingestion & alerts");
      plusMenu.innerHTML = ICONS.chevron;
      // The ambient "an alert fired while you were away" signal — without it
      // a record-only alert is invisible until you think to look.
      if (alertsUnseen() > 0) attachBtnDot(plusMenu);
      plusMenu.addEventListener("click", () => openDropdown(plusMenu, {
        align: "end",
        minWidth: 200,
        build: (body, { close }) => {
          body.appendChild(ddRow({
            label: "Automatic ingestion…",
            onClick: () => { close(); openIngestModal(); },
          }));
          appendAlertMenu(body, close);
        },
        // The create door needs a selection to watch — no pills, no footer
        // (the body's empty-state hint teaches the flow instead).
        footer: Object.keys(selectedAsConfig()).length
          ? (foot, { close }) => appendAlertFooter(foot, close)
          : undefined,
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
      clearBtn.innerHTML = ICONS.x;
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
        const clearCrateBtn = toolBtn(ICONS.x, "crates-clear", () => {
          state.selectedCrateId = null;
          document.dispatchEvent(new Event('app:render'));
        });
        clearCrateBtn.title = "Clear crate filter";
        elToolbarSub.appendChild(clearCrateBtn);
      }
    }
  }

  // The ?event= view chip: the gallery is showing one alert firing's entities.
  if (state.alertEvent) {
    const ev = document.createElement("span");
    ev.className = "tool-btn alert-event-chip active";
    const icon = document.createElement("span");
    icon.className = "alert-event-icon";
    icon.innerHTML = ICONS.bell;
    const lbl = document.createElement("span");
    lbl.textContent = `${state.alertEvent.name} — ${state.alertEvent.count} new`;
    ev.append(icon, lbl);
    elToolbarSub.appendChild(ev);
    const clearEvBtn = toolBtn(ICONS.x, "crates-clear", clearAlertEvent);
    clearEvBtn.title = "Show all items";
    elToolbarSub.appendChild(clearEvBtn);
  }

  const count = document.createElement("span");
  count.className = "result-count";
  count.textContent = `${resultCount} item${resultCount === 1 ? "" : "s"}`;
  elToolbarSub.appendChild(count);

  const active = activeCount();
  if (active > 0) {
    elToolbarSub.appendChild(toolBtn(`Clear filters (${active})`, "clear", clearAll));
  }

  // One sort control: a dropdown over the board's sortable attributes —
  // sort.js assembles the sections from the identity mode and the catalogs.
  // Wrapped so only the group gets margin-left:auto.
  const sortWrap = document.createElement("div");
  sortWrap.className = "sort-group";
  // Rows-view toggle — a single button, shown only where rows can matter
  // (rowsRelevant: derived boards, multi-instance data, or rows currently
  // effective). Grid is the unmarked default; the button highlights when
  // rows is the EFFECTIVE mode, so a filter-engaged auto flip is visible
  // where the user's hand already is. The flip itself is session-scoped
  // while filters are active and persistent otherwise (view.js toggleView).
  if (rowsRelevant()) {
    const rowsOn = effectiveView() === "rows";
    const b = document.createElement("button");
    b.className = "tool-btn view-btn" + (rowsOn ? " active" : "");
    b.title = rowsOn ? "Back to grid view" : "Rows view — every instance visible";
    b.setAttribute("aria-label", "Toggle rows view");
    b.setAttribute("aria-pressed", String(rowsOn));
    b.innerHTML = ICONS.viewRows;
    b.addEventListener("click", () => {
      toggleView();
      document.dispatchEvent(new Event('app:render'));
    });
    sortWrap.appendChild(b);
  }
  const sortBtn = toolBtn(
    state.sort ? `${state.sort.label} ${state.sort.dir === "asc" ? "↑" : "↓"}` : "Newest",
    "sort-btn" + (state.sort ? " active" : ""),
    async () => openSortMenu(sortBtn, await sortCatalog())
  );
  sortBtn.title = "Sort";
  sortWrap.appendChild(sortBtn);
  elToolbarSub.appendChild(sortWrap);
}

// The sort menu: "Newest first" (the null default) on top, then the catalog's
// sections. Picking an entry sorts by it (its kind's natural direction);
// re-picking the active one flips direction. Persisted per board (sort.js).
function openSortMenu(anchorEl, sections) {
  const commit = (sort, close) => {
    state.sort = sort;
    saveSort();
    close();
    document.dispatchEvent(new Event('app:render'));
  };
  openDropdown(anchorEl, {
    className: "sort-pop",
    build: (body, { close }) => {
      body.appendChild(ddRow({
        label: "Newest first",
        active: !state.sort,
        onClick: () => commit(null, close),
      }));
      for (const section of sections) {
        const head = document.createElement("div");
        head.className = "dd-head";
        head.textContent = section.count != null ? `${section.label} · ${section.count}` : section.label;
        body.appendChild(head);
        for (const entry of section.entries) {
          const active = state.sort?.by === entry.by;
          body.appendChild(ddRow({
            // the active row shows its direction; ddRow's trailing slot eats
            // clicks, so the arrow rides in the label text instead
            label: active ? `${entry.label} ${state.sort.dir === "asc" ? "↑" : "↓"}` : entry.label,
            active,
            onClick: () => commit({
              by: entry.by,
              dir: active ? (state.sort.dir === "asc" ? "desc" : "asc") : defaultDir(entry.kind),
              label: entry.label,
            }, close),
          }));
        }
      }
    },
  });
}
