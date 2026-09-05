import { state } from './state.js';
import { refreshBoardIngest, ACTIVE, QUEUED } from './data.js';
import { ICONS, toolBtn, formatTokens, fmtDuration, fmtCost, fmtUnpriced, fmtUnit, unitDefs, attachBtnDot } from './utils.js';
import { openJobsModal, jobsUnseen } from './jobs-modal.js';
import { Odometer } from './odometer.js';
import { openDropdown, ddRow, ddSep, ddAction, ddHead } from './dropdown.js';
import { activeCount, clearAll, favoritesInContext, toggleFiltersOrDrawer, selectedAsConfig } from './filters.js';
import { openCratePop, appendCrateLabel } from './crates.js';
import { openFilterConfigPop } from './filterconfigs.js';
import { runSearch, clearSearch } from './search.js';
import { triggerFilePicker } from './upload.js';
import { openIngestModal } from './ingest-modal.js';
import { openBoardModal } from './board-modal.js';
import { openConnectorBrowse } from './connector-browse.js';
import { appendAlertMenu, appendAlertFooter, alertsUnseen } from './alerts-modal.js';
import { openDiagnosticsModal, diagnosticsUnseen, ensureFacetStats, canSeeDiagnostics } from './facet-diagnostics.js';
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
  const baseTitle = "Automatic ingestion — next run countdown. Click to configure.";
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "mapping-chip ingest-chip";
  chip.title = baseTitle;
  const icon = document.createElement("span");
  icon.className = "ingest-chip-icon";
  icon.innerHTML = ICONS.redo;
  const eta = document.createElement("span");
  chip.append(icon, eta);
  chip.addEventListener("click", () => openIngestModal());
  // render() runs on a 1s interval — the title only changes when the state
  // does, so skip the attribute write (and its a11y-tree churn) otherwise.
  const setTitle = (t) => { if (chip.title !== t) chip.title = t; };

  // A pending run outranks the mode: a hand-fired run on a paused board should
  // read as the run it is, not as the pause it will fall back to when it lands.
  const render = () => {
    // Failing tints, it doesn't replace: the countdown is real (it's the
    // retry), so the chip keeps counting — red. The state signal the jobs
    // dot deliberately isn't (it fires once at onset; this holds while the
    // failure does, and clears the moment a run succeeds).
    const failing = !!state.boardIngestError;
    chip.classList.toggle("error", failing);
    const at = state.boardIngestNextRun;
    if (!at) {
      // A manual board's chip is on its way out here — the run it was showing
      // just landed and the next toolbar render drops it — so leave its last
      // text alone rather than flashing "paused" at something that isn't.
      if (state.boardIngestMode !== "paused") return false;
      chip.classList.add("paused");
      eta.textContent = "paused";
      setTitle(failing
        ? "Automatic ingestion is paused — and its last run failed. Click to see the error."
        : "Automatic ingestion is paused — the schedule is held. Click to configure.");
      return false;
    }
    chip.classList.remove("paused");
    const left = at - Date.now();
    eta.textContent = left <= 0 ? "now" : fmtDuration(left);
    setTitle(failing
      ? "Automatic ingestion is failing — the countdown is its retry. Click to see the error."
      : baseTitle);
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

// The door to facet diagnosis, and its attention signal — a third icon in the
// board-group, between the edit pencil and the jobs chip.
//
// Nobody opens a board modal to find out whether something is wrong, so without
// a door a finding sits unread until the user is already suspicious — by which
// point it has told them nothing they didn't know.
//
// Both halves of the gate are load-bearing. `boardManage` because the pencil is
// and this is the same cluster: a facet suggestion is only useful to someone who
// can edit facets. (jobsChip() is deliberately ungated — the log is
// transparency, not management — and this is the opposite kind of thing.)
// `boardVotes > 1` because a single-pass board writes no confidence at all, so
// the modal would be permanently empty.
//
// ALWAYS present when the gate passes, not only when there is a finding. A
// button that appears only when something is wrong gives a user who took the
// advice no way back in to check whether it worked; it conflates "there is a
// finding" with "there is a NEW finding", which is the dot's job and it does it
// better; and the header reflows as it comes and goes.
// The door itself, exported: the toast that announces a finding has to open
// exactly what the button opens. Two doors onto one modal that differ in what
// they wire is how one of them quietly loses `onEdit` — the hand-off to the
// only surface that can act on a finding, and the reason the modal is worth
// opening at all.
export const openDiagnosticsDoor = () => openDiagnosticsModal({
  onEdit: () => openBoardModal(state.boardId, {
    canEditAI: !!state.me?.is_admin,
    onSaved: () => document.dispatchEvent(new Event('app:render')),
  }),
});

function diagnosticsBtn() {
  if (!canSeeDiagnostics(state)) return null;
  // The roll-up is board-manager data on its own endpoint, so it is not in the
  // gallery's board payload. Fetched once per board and re-rendered on arrival,
  // the ingest-chip pattern: the button is drawn immediately either way, and
  // only the dot waits.
  ensureFacetStats();
  const b = toolBtn(ICONS.doubleCheck, "board-diag-btn", openDiagnosticsDoor);
  b.title = "Tagging consistency";
  b.setAttribute("aria-label", "Tagging consistency");
  // The ambient "a finding landed while you were away" signal, exactly the
  // plus-caret's unseen-alert precedent.
  if (diagnosticsUnseen(state.boardId, state.facetStats, state.facetGates)) attachBtnDot(b);
  return b;
}

// ── jobs chip: ambient "work is happening" signal + the door to the job log ──
// The count is the client's own in-flight items (the statuses the delta poll
// already streams), so it refreshes for free on every toolbar rebuild — no
// extra requests. Sweep jobs the client can't see (a transcription, an ingest
// run) live inside the modal, which does its own fetching.
//
// The dot is the other half, and says the opposite thing: the count is work
// HAPPENING and goes away on its own, the dot is work that went WRONG and
// doesn't. Same corner treatment as the plus-caret's unseen alerts and the
// Tagging-consistency finding — three signals, one vocabulary.
function jobsChip() {
  const n = state.items.reduce((k, i) => k + (ACTIVE.has(i.status) || QUEUED.has(i.status) ? 1 : 0), 0);
  const failed = jobsUnseen();
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "mapping-chip jobs-chip" + (n > 0 ? " busy" : "") + (state.boardPaused ? " paused" : "");
  // Every fact that holds, in one list — a queue draining while an earlier item
  // failed is the ordinary case, and the tooltip is the only place any of them
  // is named. Paused keeps the count (the queue is intact, which is the point)
  // but stops the note claiming motion; .paused stops the pulse to match.
  const notes = [
    n > 0 ? `${n} item${n === 1 ? "" : "s"} ${state.boardPaused ? "waiting" : "in the pipeline"}` : "",
    state.boardPaused ? "board paused" : "",
    failed ? "something failed since you last looked" : "",
  ].filter(Boolean);
  chip.title = notes.join(" — ") || "Job log";
  if (notes.length) chip.title += " — click for the job log";
  chip.setAttribute("aria-label", failed ? "Job log — new errors" : "Job log");
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
  if (failed) attachBtnDot(chip);
  return chip;
}

// A mode chip: the inert labeled pill announcing what derived set the
// gallery is showing, plus the × that ends the mode. The pair IS the
// grammar, so the helper places both.
function modeChip(iconMarkup, text, onClear) {
  const el = document.createElement("span");
  el.className = "tool-btn mode-chip active";
  const icon = document.createElement("span");
  icon.className = "mode-chip-icon";
  icon.innerHTML = iconMarkup;
  const lbl = document.createElement("span");
  lbl.textContent = text;
  el.append(icon, lbl);
  const clear = toolBtn(ICONS.x, "crates-clear", onClear);
  clear.title = "Show all items";
  elToolbarSub.append(el, clear);
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
    // a global-admin power. The first navigates (href, so middle-click opens a
    // tab), the second acts — ddAction renders both at the same height.
    footer: (foot, { close }) => {
      foot.appendChild(ddAction({ label: "All boards", icon: ICONS.grid, href: "/boards" }));

      if (!state.me?.is_admin) return;
      foot.appendChild(ddAction({
        label: "New board",
        icon: ICONS.plus,
        onClick: () => {
          close();
          openBoardModal(null, { canEditAI: true, onSaved: (saved) => { location.href = `/?board=${saved.id}`; } });
        },
      }));
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
  logo.href = "/boards";
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

    // Both renderings lead with `grid`, this app's word for the boards domain
    // (the logo's destination, the All-boards row in the dropdown) — the name
    // of the place you are reads the same whether or not you can leave it.
    // What the pill adds is the caret, and a member with one board has nothing
    // to open: same mark, no affordance it can't honour.
    if (state.me && state.boards.length > 1) {
      const boardBtn = document.createElement("button");
      boardBtn.className = "tool-btn board-btn";
      // Glyph, label, caret — the crates selector's shape.
      boardBtn.innerHTML = ICONS.grid;
      const nameEl = document.createElement("span");
      nameEl.textContent = state.boardName;
      const chev = document.createElement("span");
      chev.className = "dd-caret";
      chev.innerHTML = ICONS.chevron;
      boardBtn.append(nameEl, chev);
      boardBtn.addEventListener("click", () => openBoardPop(boardBtn));
      boardGroup.appendChild(boardBtn);
    } else {
      const name = document.createElement("span");
      name.className = "board-name";
      name.innerHTML = ICONS.grid;
      const nameText = document.createElement("span");
      nameText.textContent = state.boardName;
      name.appendChild(nameText);
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
          // Both PATCH routes take ai_votes (buildBoardContentUpdate), so a save
          // can turn vote mode on or off from right here — sync it or anything
          // gated on confidence data reads the pre-save answer until a reload.
          state.boardVotes = Number(payload.ai_votes) || 1;
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
      const diag = diagnosticsBtn();
      if (diag) boardGroup.appendChild(diag);
      if (templateChip) boardGroup.appendChild(templateChip);

      // Input and output bill at very different rates, so the chip never sums
      // them: "in / out", each bucket rolling on its own (the odometer renders
      // the non-digit " / " as static cells).
      //
      // The GATE is "did this board spend anything", asked of every unit —
      // not of tokens. It used to add input+output, which quietly made the
      // chip a tokens-only instrument: a board whose spend was transcription
      // showed nothing at all, dollars included, while the admin table showed
      // both. The units are the server's now (state.boardUnits), so a board
      // that spends in a unit this file has never heard of still gets its
      // chip, its cost, and its remainder.
      //
      // This chip living in the manager branch is a decision, not an accident:
      // spend detail is management-visible (metering-plan.md), and the cost
      // figure rides the SAME odometer — " · ≈$" renders as static cells
      // exactly like " / ", and the cents roll as spend accrues. Cost only
      // when known (state.boardCost is null when nothing was ever priced —
      // no ≈$0.00 out of ignorance; a free on-device board's true $0 shows).
      const units = state.boardUnits;
      if (units && Object.values(units).some((n) => n > 0)) {
        const defs = unitDefs(state.boardUnitDefs);
        const q = (unit) => units[unit] || 0;
        const cost = state.boardCost;
        // Tokens lead when there are any — the phrase this chip has always
        // said. A board with none leads with whatever it did spend, named
        // from the served vocabulary rather than from a list kept here.
        const tokenText = q("input_tokens") || q("output_tokens")
          ? `${formatTokens(q("input_tokens"))} / ${formatTokens(q("output_tokens"))}`
          : Object.entries(units).filter(([, n]) => n > 0)
              .map(([u, n]) => fmtUnit(n, defs[u] ?? { unit: u })).join(" · ");
        const chipText = tokenText + (cost ? ` · ${fmtCost(cost)}` : "");
        if (!tokenOdo) tokenOdo = new Odometer(chipText);
        const tokenChip = document.createElement("span");
        tokenChip.className = "token-chip";
        tokenChip.innerHTML = ICONS.coin;
        tokenChip.appendChild(tokenOdo.el);
        // No capability list here either (see admin-boards.js): the totals sum
        // whatever is metered on this board, which is a set that grows. Same
        // rule for the unit LABELS, here and in the unpriced remainder — they
        // come from the server (server/units.js), because a client that turns
        // a unit id into English is making a claim about a vocabulary it
        // doesn't own.
        const unpriced = fmtUnpriced(cost?.unpriced);
        const detail = Object.entries(units).filter(([, n]) => n > 0)
          .map(([u, n]) => fmtUnit(n, defs[u] ?? { unit: u })).join(" · ");
        tokenChip.title = `${detail} — AI usage`
          + (cost ? `\n${fmtCost(cost)} at the rates known when each call ran` : "")
          + (unpriced ? `\nnot in the figure: ${unpriced}` : "");
        boardGroup.appendChild(tokenChip);
        // Re-append then set: if a value grew since the last render, the
        // changed digits roll; if not, this is a no-op.
        tokenOdo.set(chipText);
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

      // Ingestion chip: a live countdown to the next run, or "paused" for a
      // held schedule. Shown for any configured board EXCEPT an idle manual
      // one — nothing to count down to and nothing being held, so a permanent
      // badge would just be noise. A hand-fired run pending on that manual
      // board is a run, so it gets the chip back. Clicking opens the modal.
      const mode = state.boardIngestMode;
      if (mode && !(mode === "manual" && state.boardIngestNextRun == null)) {
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
      plusMenu.className = "tool-btn plus-caret dd-caret";
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
    chev.className = "dd-caret";
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
    arrow.className = "tool-btn split-arrow dd-caret" + (ac > 0 ? " active" : "");
    arrow.title = "Filter options";
    arrow.setAttribute("aria-label", "Filter options");
    arrow.innerHTML = ICONS.chevron;
    // Anchored by accessor, not by this element: the pop's lens toggles
    // re-render this toolbar (chevron included) with the pop still open, and
    // the accessor is how it hangs onto the chevron's replacement.
    arrow.addEventListener("click", () => openFilterConfigPop(() => elToolbarSub.querySelector(".split-arrow")));
    filtersWrap.appendChild(arrow);
  }
  elToolbarSub.appendChild(filtersWrap);

  // Semantic search (only when the server has embeddings configured).
  // Submits on Enter — every query is one paid embedding call server-side.
  if (state.searchAvailable) {
    // While the Find-similar mode is up, the box stays quiet even though
    // searchResults is set — the mode chip below owns the display and the
    // one clear affordance; a lit box would offer a second ×.
    const typedSearch = state.searchResults && !state.searchSimilarTo;
    const box = document.createElement("div");
    box.className = "search-box" + (typedSearch ? " active" : "");
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
    } else if (typedSearch) {
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
      ICONS.heart + "<span>Your favorites</span>",
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
      chev.className = "dd-caret";
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

  // The mode chips: the gallery is showing a derived result set, and the
  // chip says which one — one item's similars (plan stage 1b; rendered
  // whether or not the search box is, since similarity needs no
  // embeddings), or an alert firing's entities.
  if (state.searchSimilarTo) modeChip(ICONS.search, `Similar to ${state.searchSimilarTo}`, clearSearch);
  if (state.alertEvent) modeChip(ICONS.bell, `${state.alertEvent.name} — ${state.alertEvent.count} new`, clearAlertEvent);

  const count = document.createElement("span");
  count.className = "result-count";
  count.textContent = `${resultCount} item${resultCount === 1 ? "" : "s"}`;
  elToolbarSub.appendChild(count);

  const active = activeCount();
  if (active > 0) {
    // toolBtn takes markup: the × names the undo before the words do, which is
    // what tells this borderless button apart from the labels beside it.
    elToolbarSub.appendChild(toolBtn(ICONS.x + `<span>Clear filters (${active})</span>`, "clear", clearAll));
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
        body.appendChild(ddHead(
          section.count != null ? `${section.label} · ${section.count}` : section.label
        ));
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
