import { state } from './state.js';
import { nudgeBoardIngest } from './data.js';
import { ICONS, formatTokens, fmtDuration, fmtCost, fmtUnpriced, fmtUnit, unitDefs } from './utils.js';
import { jobsUnseen } from './jobs-state.js';
// The modals this toolbar opens fetch their own code — none is reachable
// without a click, and together they were about half of what the board page
// downloaded before it could draw. These read as ordinary functions; only the
// alert menu below needs the raw door, and there is a comment there saying why.
import {
  openIngestModal, openBoardModal, openConnectorBrowse, openJobsModal,
  openDiagnosticsModal, withModals,
} from './modal-door.js';
import { Odometer } from './odometer.js';
import { openDropdown, ddRow, ddAction, ddHead } from './dropdown.js';
import { userMenuButton } from './user-menu.js';
import { activeCount, clearAll, favoritesInContext, toggleFiltersOrDrawer, selectedAsConfig, reconcileSelection } from './filters.js';
import { openCratePop, CrateLabel } from './crates.js';
import { openFilterConfigPop } from './filterconfigs.js';
import { runSearch, clearSearch } from './search.js';
import { triggerFilePicker } from './upload.js';
import { presentIngest } from './ingest-present.js';
import { alertsUnseen } from './alerts-state.js';
import { diagnosticsUnseen, ensureFacetStats, canSeeDiagnostics } from './facet-diagnosis.js';
import { clearAlertEvent } from './alert-event.js';
import { sortCatalog, defaultDir, saveSort, restoreSort } from './sort.js';
import { effectiveView, toggleView, rowsRelevant } from './view.js';
import { html, render, useState, useEffect, useLayoutEffect, useRef, useErrorBoundary } from './vendor/preact.mjs';
import { batch } from './vendor/signals.mjs';
import { Icon } from './icon.js';
import { Count } from './pill.js';

// Both rows are drawn with Preact (planning/ui-updates-plan.md, Stage 2): each
// repaint compares what should be there with what it drew last time and
// changes only the difference, so a button, the search box and the chips keep
// their elements, and with them the focus, the caret, an open menu's hold on
// its button, and the animations running on them.
const elToolbar = document.getElementById("toolbar");
const elToolbarSub = document.getElementById("toolbar-sub");

// The corner dot: the pair attachBtnDot (utils.js) puts on hand-built buttons,
// drawn here with the button instead. Preact rewrites a button's whole class
// list whenever the classes it draws there change, which would erase one set
// from outside (the plan's D6). `hasDot` is the button's half.
const hasDot = (on) => (on ? " has-dot" : "");
const Dot = ({ on }) => (on ? html`<span class="btn-dot"></span>` : null);

// The toolbar button: .tool-btn and its variant, then an icon, a label, a count
// and the corner dot, each only when given. Nothing here sizes the glyph or
// sets the gap: .tool-btn owns both, which is what lets a caller pass any icon
// and get the same button. A label beside an icon comes as a <span>, which is
// what makes it one flex item for the button's own 5px gap to space.
function ToolBtn({ cls, icon, label, count, dot, title, ariaLabel, ariaPressed, onClick }) {
  return html`<button class=${"tool-btn" + (cls ? " " + cls : "") + hasDot(dot)} title=${title} aria-label=${ariaLabel} aria-pressed=${ariaPressed} onClick=${onClick}>${icon ? html`<${Icon} svg=${icon} />` : null}${label}<${Count} n=${count} /><${Dot} on=${dot} /></button>`;
}

// ── ingestion chip: countdown to the board's next automatic run ──
// The board payload carries ingest_next_run_at once; after each run the stamp
// moves server-side, so when the countdown expires the chip re-learns the
// schedule via data.js's nudgeBoardIngest — the one throttle+backoff per tab,
// shared with the ingest modal's header tick. The chip's own timer redraws it
// every second, and stops when the chip goes.
function IngestChip() {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => {
      tick((k) => k + 1);
      // Expired (or run-now fired): the sweep claims within a worker tick, so
      // shortly after "now" the server holds a fresh next_run_at. The re-learn
      // itself — throttle, backoff, the one clock per tab — is data.js's.
      nudgeBoardIngest();
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Precedence, classification, and the words come from the presenter — the
  // same verdict the ingest modal's header chip and the boards-page chip
  // read, so the three surfaces cannot drift (the rules used to live here as
  // a private copy: "a pending run outranks the mode", "failing tints, it
  // doesn't replace — the countdown is real, it's the retry"). What stays
  // local is compact FORM — the bare countdown off p.left/p.due, the word
  // "paused" — and the click affordance only this surface has.
  const p = presentIngest({
    mode: state.boardIngestMode,
    nextRunAt: state.boardIngestNextRun,
    error: state.boardIngestError,
    now: Date.now(),
  });
  const title = `Automatic ingestion: ${p.title} Click to ${p.tone === "error" ? "see the error" : "configure"}.`;
  let face;
  if (p.left != null) face = { eta: p.due ? "now" : fmtDuration(p.left), paused: false, title };
  else if (p.state === "paused" || p.state === "held-failed") face = { eta: "paused", paused: true, title };
  // No countdown and no hold: a schedule armed but not yet stamped (the sweep
  // stamps it within a tick). The chip shows just its icon until then.
  else face = { eta: "", paused: false, title: undefined };
  // The error tint is the state signal the jobs dot deliberately isn't (it
  // fires once at onset; this holds while the failure does, and clears the
  // moment a run succeeds).
  return html`<button type="button" class=${"mapping-chip ingest-chip" + (p.tone === "error" ? " error" : "") + (face.paused ? " paused" : "")} title=${face.title} onClick=${() => openIngestModal()}><span class="ingest-chip-icon"><${Icon} svg=${ICONS.redo} /></span><span>${face.eta}</span></button>`;
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
// can edit facets. (JobsChip is deliberately ungated — the log is
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
// Both of these fetch the modal chunk themselves, and it is the same chunk, so
// the hand-off from the survey to the editor cannot stall on a second load.
export const openDiagnosticsDoor = () => openDiagnosticsModal({
  onEdit: () => openBoardModal(state.boardId, {
    canEditAI: !!state.me?.is_admin,
  }),
});

function DiagnosticsBtn() {
  if (!canSeeDiagnostics(state)) return null;
  // The roll-up is board-manager data on its own endpoint, so it is not in the
  // gallery's board payload. Fetched once per board and re-rendered on arrival,
  // the ingest-chip pattern: the button is drawn immediately either way, and
  // only the dot waits.
  ensureFacetStats();
  // The dot is the ambient "a finding landed while you were away" signal,
  // exactly the plus-caret's unseen-alert precedent.
  return html`<${ToolBtn} cls="board-diag-btn" icon=${ICONS.doubleCheck} title="Tagging consistency" ariaLabel="Tagging consistency"
    dot=${diagnosticsUnseen(state.boardId, state.facetStats, state.facetGates)} onClick=${openDiagnosticsDoor} />`;
}

// ── jobs chip: ambient "work is happening" signal + the door to the job log ──
// The count is the `work` payload, whole: every claimed instance and every
// waiting one, the running sweep rows and the lane backlogs — composed
// server-side with the one-unit-one-count rule already applied, and streamed
// by every carrier that can carry it (instance-work-plan.md). The cards' own
// statuses are the grid's business; the chip never reads them, so it cannot
// disagree with the modal or with History about what a job is. No extra
// requests either way.
//
// The dot is the other half, and says the opposite thing: the count is work
// HAPPENING and goes away on its own, the dot is work that went WRONG and
// doesn't. Same corner treatment as the plus-caret's unseen alerts and the
// Tagging-consistency finding — three signals, one vocabulary.
const JOBS_EDGE_MS = 450; // matches the jobs-ignite/jobs-cool duration in styles.css
// The glow's noise wobble is SMIL (the <animate> inside #jobs-dune), out of
// CSS's reach — honor reduced motion by removing it once at boot.
if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) document.querySelector("#jobs-dune animate")?.remove();

// Exported for its test (jobs-chip.test.js), the way jobs-modal.js exports
// its pure pieces: the count is a claim about the payload, and the claim is
// worth pinning.
export function JobsChip() {
  // The lanes, tallied by their served labels — the tooltip's sentences and
  // the pill number both read from this. A leg (Extraction, Tagging) is a
  // lane like Transcription is; the server named them all, and it already
  // counted each unit of work once. A running row that holds a batch says how
  // many items (`n`, an embed batch), and counts as that many, since the
  // waiting counts beside it count items too.
  const lanes = new Map();
  const lane = (key) => { if (!lanes.has(key)) lanes.set(key, { run: 0, wait: 0 }); return lanes.get(key); };
  for (const j of state.work.running) lane(j.label).run += j.n ?? 1;
  for (const q of state.work.queued) lane(q.label).wait += q.n;
  const n = [...lanes.values()].reduce((k, l) => k + l.run + l.wait, 0);
  const busy = n > 0;

  // The idle↔busy edge. The chip stays the same element, so crossing the edge
  // wears a one-shot class (igniting, cooling) for as long as its CSS animation
  // runs, and a timer drops it rather than the animation's end: with reduced
  // motion the animations are off and no end would ever come. Cooling shows
  // the ghost of the final count so the pill narrows with the fade instead of
  // snapping the moment the queue drains.
  const [, redraw] = useState(0);
  const seen = useRef({ busy: null, count: 0, edge: "" }).current;
  if (seen.busy !== null && seen.busy !== busy) seen.edge = busy ? "igniting" : "cooling";
  const { edge } = seen;
  const shown = busy ? n : seen.count;
  seen.busy = busy;
  if (busy) seen.count = n;
  useEffect(() => {
    if (!edge) return;
    const t = setTimeout(() => { seen.edge = ""; redraw((k) => k + 1); }, JOBS_EDGE_MS);
    return () => clearTimeout(t);
  }, [edge]);

  const failed = jobsUnseen();
  // Every fact that holds, in one list — a queue draining while an earlier item
  // failed is the ordinary case, and the tooltip is the only place any of them
  // is named. Paused keeps the count (the queue is intact, which is the point)
  // but stops the note claiming motion; .paused freezes the glow to match.
  // The lanes speak their served labels ("Transcription: 1 running, 3
  // waiting") — the vocabulary arrives with the payload, never from a
  // client-side list.
  const notes = [
    ...[...lanes].map(([label, { run, wait }]) =>
      `${label}: ${[run ? `${run} running` : "", wait ? `${wait} waiting` : ""].filter(Boolean).join(", ")}`),
    state.boardPaused ? "board paused" : "",
    failed ? "something failed since you last looked" : "",
  ].filter(Boolean);
  const title = (notes.join(" — ") || "Job log") + (notes.length ? " — click for the job log" : "");
  const cls = "mapping-chip jobs-chip" + (busy ? " busy" : "") + (edge ? ` ${edge}` : "") + (state.boardPaused ? " paused" : "") + hasDot(failed);
  return html`<button type="button" class=${cls} title=${title} aria-label=${failed ? "Job log — new errors" : "Job log"} onClick=${() => openJobsModal()}><span class="jobs-chip-icon"><${Icon} svg=${ICONS.activity} /></span>${busy || edge === "cooling" ? html`<span class="jobs-chip-count">${shown}</span>` : null}<${Dot} on=${failed} /></button>`;
}

// The token chip. Input and output bill at very different rates, so it never
// sums them: "in / out", each bucket rolling on its own (the odometer renders
// the non-digit " / " as static cells). The Odometer fills the counter this
// draws empty (the plan's D7) and lives as long as the chip does, so a total
// that grew since the last repaint rolls its changed digits.
function TokenChip({ text, title }) {
  const counter = useRef(null);
  const odo = useRef(null);
  useLayoutEffect(() => {
    if (!odo.current) odo.current = new Odometer(counter.current, text);
    else odo.current.set(text);
  }, [text]);
  return html`<span class="token-chip" title=${title}><${Icon} svg=${ICONS.coin} /><span class="odo" ref=${counter}></span></span>`;
}

// A mode chip: the inert labeled pill announcing what derived set the
// gallery is showing, plus the × that ends the mode. The pair IS the
// grammar, so the helper places both. `tail` is a short marker that must
// SURVIVE the clipping (the CSS ellipsis lives on the text span alone — an
// anchor's name can be a whole filename, and end-clipping one string would
// eat exactly the part that tells the modes apart).
function ModeChip({ icon, text, onClear, tail = "" }) {
  return html`<span class="tool-btn mode-chip active" title=${tail ? `${text} ${tail}` : text}><span class="mode-chip-icon"><${Icon} svg=${icon} /></span><span class="mode-chip-label">${text}</span>${tail ? html`<span>${tail}</span>` : null}</span><${ToolBtn} cls="crates-clear" icon=${ICONS.x} title="Show all items" onClick=${onClear} />`;
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
          // &created=1: the arrival page says the toast — this one dies with
          // the navigation (app.js consumes it).
          openBoardModal(null, { canEditAI: true, onSaved: (saved) => { location.href = `/?board=${saved.id}&created=1`; } });
        },
      }));
    },
  });
}

// Board admins (global or per-board) get an inline "edit board" pencil that
// opens the same board editor as the admin page (content-only + read-only
// Mapping view for non-admin board-admins).
const openBoardEditor = () => openBoardModal(state.boardId, {
  canEditAI: !!state.me?.is_admin,
  // One batch: the page draws the save once, whole.
  onSaved: (payload) => batch(() => {
    state.boardName = payload.name;
    state.facets = payload.facets;
    // The save that just removed a value may have removed one this reader
    // is standing on — no reload separates the two, so the filter goes
    // dead in the same breath as the edit. Straight after the facets land
    // and before anything reads them back.
    reconcileSelection();
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
    state.boards = state.boards.map((x) => (x.id === state.boardId ? { ...x, name: payload.name } : x));
  }),
});

// The board selector, its edit pencil and the board's chips — one unit, kept
// tight.
function BoardGroup() {
  // A connector-backed board carries a mapping template; surface its name as a
  // chip beside the edit pencil. The data source is a board-config detail, so
  // it belongs with the board controls, not the ingest (+) cluster.
  const connectorName = state.boardMapping?.input?.connector;
  const templateChip = connectorName
    ? html`<span class="mapping-chip" title=${`Entity mapping template: ${connectorName}`}>${connectorName.charAt(0).toUpperCase() + connectorName.slice(1)}</span>`
    : null;

  // The pill, ALWAYS — reverted from a one-board plain label whose reasoning
  // was "a member with one board has nothing to open". That stopped being
  // true when the dropdown's footer grew "All boards" and the admin's "New
  // board": a sole board still has somewhere to go, so the caret is an
  // affordance every reader can honour. Glyph, label, caret — the crates
  // selector's shape; `grid` is this app's word for the boards domain (the
  // logo's destination, the All-boards row in the dropdown).
  const boardBtn = html`<${ToolBtn} cls="board-btn" icon=${ICONS.grid}
    label=${html`<span>${state.boardName}</span><span class="dd-caret"><${Icon} svg=${ICONS.chevron} /></span>`}
    onClick=${(e) => openBoardPop(e.currentTarget)} />`;

  // Jobs chip for every member (the log is transparency, not management).
  const jobs = state.me ? html`<${JobsChip} />` : null;
  if (!state.boardManage) {
    // No edit pencil (non-manager) — still show the data-source chip.
    return html`<div class="board-group">${boardBtn}${templateChip}${jobs}</div>`;
  }

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
  let tokenChip = null;
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
    // No capability list here either (see admin-boards.js): the totals sum
    // whatever is metered on this board, which is a set that grows. Same
    // rule for the unit LABELS, here and in the unpriced remainder — they
    // come from the server (server/units.js), because a client that turns
    // a unit id into English is making a claim about a vocabulary it
    // doesn't own.
    const unpriced = fmtUnpriced(cost?.unpriced);
    const detail = Object.entries(units).filter(([, n]) => n > 0)
      .map(([u, n]) => fmtUnit(n, defs[u] ?? { unit: u })).join(" · ");
    const title = `${detail} — AI usage`
      + (cost ? `\n${fmtCost(cost)} at the rates known when each call ran` : "")
      + (unpriced ? `\nnot in the figure: ${unpriced}` : "");
    tokenChip = html`<${TokenChip} text=${tokenText + (cost ? ` · ${fmtCost(cost)}` : "")} title=${title} />`;
  }
  return html`<div class="board-group">${boardBtn}<${ToolBtn} cls="board-edit-btn" icon=${ICONS.pencil} title="Edit board" ariaLabel="Edit board" onClick=${openBoardEditor} /><${DiagnosticsBtn} />${templateChip}${tokenChip}${jobs}</div>`;
}

// The ingestion menu behind the + button's caret. Its modules are resolved
// before openDropdown, not inside build(): dropdown.js calls build and footer
// synchronously, so the module has to be in hand by the time the menu opens.
// Awaiting out here is what lets dropdown.js stay exactly as it is rather than
// learning to accept a promise for one caller.
const openPlusMenu = withModals((m, anchor) => openDropdown(anchor, {
  align: "end",
  minWidth: 200,
  build: (body, { close }) => {
    body.appendChild(ddRow({
      label: "Automatic ingestion…",
      onClick: () => { close(); m.openIngestModal(); },
    }));
    m.appendAlertMenu(body, close);
  },
  // The create door needs a selection to watch — no pills, no footer
  // (the body's empty-state hint teaches the flow instead).
  footer: Object.keys(selectedAsConfig()).length
    ? (foot, { close }) => m.appendAlertFooter(foot, close)
    : undefined,
}));

// The user menu is user-menu.js's, shared with the boards and welcome pages.
// This draws its button empty and hands it over to be filled, once, so it
// keeps its place as the row around it redraws (the plan's D7). Sign-out
// reloads rather than redirects: this page's own gate (app.js) sends a
// signed-out reader to login, so the one true answer is "ask again".
function UserMenu() {
  const btn = useRef(null);
  useLayoutEffect(() => {
    userMenuButton({ me: state.me, afterSignOut: () => location.reload(), el: btn.current });
  }, []);
  return html`<button class="tool-btn user-menu-btn" ref=${btn}></button>`;
}

function Auth() {
  if (!state.me) return html`<div class="auth"></div>`;
  // Ingestion chip: a live countdown to the next run, or "paused" for a
  // held schedule. Shown for any configured board EXCEPT an idle manual
  // one — nothing to count down to and nothing being held, so a permanent
  // badge would just be noise. A hand-fired run pending on that manual
  // board is a run, so it gets the chip back. Clicking opens the modal.
  const mode = state.boardIngestMode;
  const ingest = state.boardName && mode && !(mode === "manual" && state.boardIngestNextRun == null);
  // Add button + its ingestion menu — two separate rounded buttons with a
  // small gap, mirroring the board selector / edit-pencil pairing. A
  // connector board's + browses its source; everything else opens the file
  // picker. The ambient "an alert fired while you were away" dot rides the
  // caret — without it a record-only alert is invisible until you think to
  // look.
  const connectorName = state.boardMapping?.input?.connector;
  const plus = state.boardName
    ? html`<div class="board-group"><${ToolBtn} cls="upload" icon=${ICONS.plus} onClick=${connectorName ? () => openConnectorBrowse(connectorName) : triggerFilePicker} /><${ToolBtn} cls="plus-caret dd-caret" icon=${ICONS.chevron} title="Ingestion & alerts" ariaLabel="Ingestion & alerts" dot=${alertsUnseen() > 0} onClick=${(e) => openPlusMenu(e.currentTarget)} /></div>`
    : null;
  return html`<div class="auth">${ingest ? html`<${IngestChip} />` : null}${plus}<${UserMenu} /></div>`;
}

// Row 1: identity + upload + auth. The logo is the conventional "home" —
// here that's the boards index. The switcher's All-boards footer is the
// signed way there; this is the quiet one.
function ToolbarTop() {
  return html`<a class="toolbar-logo" href="/boards" title="All boards">001az/</a>${state.boardName ? html`<${BoardGroup} />` : null}<${Auth} />`;
}

// Semantic search (only when the server has embeddings configured). Submits on
// Enter — every query is one paid embedding call server-side.
//
// The box keeps its element across repaints, so the focus and the caret stay
// where they are, and Preact writes its value only when state says something
// other than what's in it. That holds because every keystroke goes straight to
// state.searchDraft: never delay that write, or each repaint would put the
// older text back under the cursor.
function SearchBox() {
  // While the Find-similar mode is up, the box stays quiet even though
  // searchResults is set — the mode chip below owns the display and the
  // one clear affordance; a lit box would offer a second ×.
  const typedSearch = state.searchResults && !state.searchSimilarTo;
  // Clearing takes the × away, and with it the focus a click gave it, so the
  // caret goes to the box instead, ready for the next search.
  const input = useRef(null);
  const clear = () => { clearSearch(); input.current.focus(); };
  return html`<div class=${"search-box" + (typedSearch ? " active" : "")}><input type="search" placeholder="Search by meaning…" aria-label="Semantic search" value=${state.searchDraft} ref=${input}
    onInput=${(e) => { state.searchDraft = e.currentTarget.value; }}
    onKeyDown=${(e) => {
      if (e.key === "Enter") runSearch(e.currentTarget.value);
      else if (e.key === "Escape") { e.stopPropagation(); clearSearch(); e.currentTarget.blur(); }
    }} />${state.searchLoading
      ? html`<span class="search-spinner" aria-label="Searching…"></span>`
      : typedSearch ? html`<button class="search-clear" title="Clear search" aria-label="Clear search" onClick=${clear}><${Icon} svg=${ICONS.x} /></button>` : null}</div>`;
}

function Crates() {
  const activeCrate = state.crates.find((c) => c.id === state.selectedCrateId) || null;
  return html`<${ToolBtn} cls=${"crates-btn" + (activeCrate ? " active" : "")} icon=${ICONS.crate}
    label=${html`<span>${activeCrate ? html`<${CrateLabel} crate=${activeCrate} />` : "Crates"}</span><span class="dd-caret"><${Icon} svg=${ICONS.chevron} /></span>`}
    onClick=${(e) => openCratePop(e.currentTarget)} />${activeCrate
      ? html`<${ToolBtn} cls="crates-clear" icon=${ICONS.x} title="Clear crate filter" onClick=${() => {
          state.selectedCrateId = null;
        }} />`
      : null}`;
}

// Row 2: filters / sort / count.
function ToolbarSub({ resultCount }) {
  const ac = activeCount();
  // Filters is a split button: the label toggles the facet panel, the
  // chevron opens saved filter configs (logged-in only — they're per-user).
  // The chevron passes itself as the pop's anchor: the pop's lens toggles
  // repaint this row with the pop still open, and the chevron stays the same
  // element through it.
  const filters = html`<div class="split-btn"><${ToolBtn} cls=${ac > 0 ? "active" : ""} label=${ac > 0 ? `Filters (${ac})` : "Filters"} onClick=${toggleFiltersOrDrawer} />${state.me
    ? html`<${ToolBtn} cls=${"split-arrow dd-caret" + (ac > 0 ? " active" : "")} icon=${ICONS.chevron} title="Filter options" ariaLabel="Filter options" onClick=${(e) => openFilterConfigPop(e.currentTarget)} />`
    : null}</div>`;

  const favorites = state.me ? html`<${ToolBtn} cls=${"fav" + (state.showFavorites ? " active" : "")} icon=${ICONS.heart} label=${html`<span>Your favorites</span>`}
    count=${favoritesInContext()} onClick=${() => {
      state.showFavorites = !state.showFavorites;
    }} />` : null;

  // The mode chips: the gallery is showing a derived result set, and the
  // chip says which one — one item's similars (plan stage 1b; rendered
  // whether or not the search box is, since similarity needs no
  // embeddings), or an alert firing's entities.
  const similar = state.searchSimilarTo
    ? html`<${ModeChip} icon=${ICONS.search} text=${`Similar to ${state.searchSimilarTo}`} onClear=${clearSearch} tail=${state.searchQuery.startsWith("similar-meaning:") ? "· meaning" : ""} />`
    : null;
  const alertMode = state.alertEvent
    ? html`<${ModeChip} icon=${ICONS.bell} text=${`${state.alertEvent.name} — ${state.alertEvent.count} new`} onClear=${clearAlertEvent} />`
    : null;

  // The × names the undo before the words do, which is what tells this
  // borderless button apart from the labels beside it.
  const clear = ac > 0 ? html`<${ToolBtn} cls="clear" icon=${ICONS.x} label=${html`<span>${`Clear filters (${ac})`}</span>`} onClick=${clearAll} />` : null;

  // Rows-view toggle — a single button, shown only where rows can matter
  // (rowsRelevant: derived boards, multi-instance data, or rows currently
  // effective). Grid is the unmarked default; the button highlights when
  // rows is the EFFECTIVE mode, so a filter-engaged auto flip is visible
  // where the user's hand already is. The flip itself is session-scoped
  // while filters are active and persistent otherwise (view.js toggleView).
  const rowsOn = effectiveView() === "rows";
  const view = rowsRelevant()
    ? html`<${ToolBtn} cls=${"view-btn" + (rowsOn ? " active" : "")} icon=${ICONS.viewRows} title=${rowsOn ? "Back to grid view" : "Rows view — every instance visible"}
        ariaLabel="Toggle rows view" ariaPressed=${String(rowsOn)} onClick=${() => {
          toggleView();
        }} />`
    : null;
  // One sort control: a dropdown over the board's sortable attributes —
  // sort.js assembles the sections from the identity mode and the catalogs.
  // Wrapped so only the group gets margin-left:auto.
  const sort = html`<${ToolBtn} cls=${"sort-btn" + (state.sort ? " active" : "")} label=${state.sort ? `${state.sort.label} ${state.sort.dir === "asc" ? "↑" : "↓"}` : "Newest"}
    title="Sort" onClick=${async (e) => {
      const anchor = e.currentTarget;
      openSortMenu(anchor, await sortCatalog());
    }} />`;

  return html`${filters}${state.searchAvailable ? html`<${SearchBox} />` : null}${favorites}${state.me && state.crates.length > 0 ? html`<${Crates} />` : null}${similar}${alertMode}<span class="result-count">${`${resultCount} item${resultCount === 1 ? "" : "s"}`}</span>${clear}<div class="sort-group">${view}${sort}</div>`;
}

// A row that throws while it draws would leave Preact's record of it half
// updated, and the next repaint would draw on top of that (measured: a second
// user menu and + button beside the first, there until a reload). The old
// rebuild started from nothing each time, so it was back on the next repaint.
// So each row sits under an error boundary: what threw keeps what it last
// drew, the rest of the row still draws, the error is reported as if nothing
// had caught it, and the next repaint tries again. Preact settles a catch a
// moment later and can't catch another before then, so a second repaint in
// the same moment (a click can repaint twice) leaves the row as it is.
function Row({ at, children }) {
  useErrorBoundary((e) => { at.settling = true; reportError(e); });
  at.settling = false;
  return children;
}
const top = { settling: false };
const sub = { settling: false };
const draw = (vnode, el, at) => {
  if (!at.settling) render(vnode && html`<${Row} at=${at}>${vnode}</${Row}>`, el);
};

export function renderToolbar(resultCount) {
  document.title = state.boardName ? `001az - ${state.boardName}` : "001az";
  draw(html`<${ToolbarTop} />`, elToolbar, top);
  draw(state.boardName ? html`<${ToolbarSub} resultCount=${resultCount} />` : null, elToolbarSub, sub);
}

// The sort menu: "Newest first" (the null default) on top, then the catalog's
// sections. Picking an entry sorts by it (its kind's natural direction);
// re-picking the active one flips direction. Persisted per board (sort.js).
function openSortMenu(anchorEl, sections) {
  const commit = (sort, close) => {
    state.sort = sort;
    saveSort();
    close();
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
