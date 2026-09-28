// list.js — the List view (planning/list-view-plan.md): the board as a table,
// one row per card, in the filtered, sorted order every view draws. A real
// <table> (D1), so a screen reader reads it cell by cell and says the headers
// as it goes. A row carries the card's own parts (grid.js): its select
// button, its heart, its tag chip and its actions, the chrome drawn while the
// pointer is over the row and kept while a menu opened from it is up, the
// card's rule. The name is the open button (D2). Between the name and the
// heart, the board's columns (columns.js), each value printed by its field's
// format (utils.js fmtField, D4).
//
// Rows are components keyed by item, drawn from the card's props and redrawn
// only when one of them changed, the grid's way (planning/ui-updates-plan.md,
// Stage 4). Drawn a batch at a time, like the other views (batches.js).
import { state } from './state.js';
import { html, render, Component, useRef } from './vendor/preact.mjs';
import { signal } from './vendor/signals.mjs';
import { Icon } from './icon.js';
import { ICONS, fmtField, changeClass } from './utils.js';
import {
  cardProps, sameProps, registerPin, pinSetter, openOrSelect, useOnstage, EmptyNote,
  SelectButton, HeartControl, TagChip, CardActions, Act, doDelete, showQueue, gridBox, holdTextInBulk,
} from './grid.js';
import { SmallFace } from './kinds.js';
import { batchedView } from './batches.js';
import { boardEntries, columnCatalog, nextSort, setSort, shownSort, sortValue } from './sort.js';
import { shownColumns } from './columns.js';
import { keepPlace } from './modal.js';

const elGrid = document.getElementById("grid");
const elNote = document.getElementById("list-note");

// A row is a line of text and a small picture: the grid's batch size.
const RENDER_BATCH = 60;
// The upload lane's rows before the "+N processing…" tail.
const LANE_BUDGET = 5;

// Column widths, in one place: table-layout: fixed takes them from the <col>s,
// a data column's by its kind. The name takes what's left, down to NAME_MIN;
// past that the table is wider than the page, and the page scrolls sideways
// with the select, picture and name pinned at the left (styles.css), so a row
// keeps its name.
const WIDTH = { sel: 48, face: 104, smallFace: 84, heart: 76, act: 200, date: 124, number: 130, text: 150 };
const NAME_MIN = 240;
const widthOf = (c) => WIDTH[c.kind] || WIDTH.text;
// The full table's floor: every column at its width, the name at NAME_MIN.
const fullWidth = (cols, me) => (me ? WIDTH.sel + WIDTH.heart : 0) + WIDTH.face + NAME_MIN + WIDTH.act
  + cols.reduce((sum, c) => sum + widthOf(c), 0);

// The compact table (Stage 4): a phone's, and a touch screen's whenever the
// full table is wider than the room it has. A touch browser doesn't scroll a
// page that's too wide; it widens the page to the table, the fixed header
// with it (its toggles and sort off the screen), and a swipe slides the whole
// page, the pinned names too. So the compact table fits the screen: the
// picture and the name, and under the name the sorted column's value. Its
// rows have no select circle, heart or actions, which show only under a
// pointer (the lightbox has them all). A desktop window too narrow for the
// full table keeps it: a desktop page scrolls sideways, the names pinned.
const narrow = window.matchMedia?.("(max-width: 640px)");
const touch = window.matchMedia?.("(hover: none)");
// Its columns: none, one array, so a row's props still compare.
const NO_COLUMNS = [];
// Bumped when the screen changes the answer, so a draw that asked (List's,
// the toolbar's) draws again.
const screenChanged = signal(0);
export function compactList() {
  void screenChanged.value;
  if (narrow?.matches) return true;
  return !!touch?.matches && fullWidth(shownColumns(), !!state.me) > gridBox().inner;
}
// A phone's width, where no table of columns fits (the toolbar leaves its
// Columns button out there). A tablet's compact table keeps the button:
// taking columns off can make the full table fit again.
export function narrowScreen() {
  void screenChanged.value;
  return !!narrow?.matches;
}
// A rotation, a window dragged across 640px, a mouse plugged into a tablet:
// only a change of answer draws. A phone turned sideways stays compact, and
// its toolbar gains the Columns button.
let drawnCompact = false;
const onScreen = () => { if (compactList() !== drawnCompact) screenChanged.value++; };
window.addEventListener("resize", onScreen);
touch?.addEventListener("change", onScreen);
narrow?.addEventListener("change", () => { screenChanged.value++; });
// A data column's cells by its kind: numbers right and in even figures, dates
// dimmed, text cut with "…" (the whole of it in the cell's title).
const headClass = (c) => (c.kind === "number" ? "num" : c.kind === "date" ? "list-date" : "");
const cellClass = (c) => (c.kind === "number" ? "num list-num" : c.kind === "date" ? "list-date" : "list-text");

// A column header that sorts: the one sort (sort.js's rule), against the sort
// in effect — with none chosen that's Date added, newest first. While a search
// is on its relevance order is in effect, so no header is sorted and none acts.
function SortHead({ entry, shown, cls, children }) {
  const on = shown?.by === entry.by;
  const searching = !!state.searchResults;
  return html`<th scope="col" class=${cls} aria-sort=${on ? (shown.dir === "asc" ? "ascending" : "descending") : undefined}>
    <button type="button" class="list-sort" disabled=${searching}
      title=${searching ? "Sorted by relevance while searching" : `Sort by ${entry.label}`}
      onClick=${() => sortBy(entry)}>${children || entry.label}${on && html`<span class="list-arrow" aria-hidden="true">${shown.dir === "asc" ? "↑" : "↓"}</span>`}</button>
  </th>`;
}

// VoiceOver on macOS doesn't announce a table's sort changing, so the page
// says it, in a hidden polite note (the boards page's pattern).
function sortBy(entry) {
  const next = nextSort(entry, shownSort());
  setSort(next);
  elNote.textContent = `Sorted by ${next.label}, ${next.dir === "asc" ? "ascending" : "descending"}`;
}

// The small face (kinds.js), and while the item is in work the card's spinner
// over it, turning only near the screen (grid.js useOnstage).
function Face({ loading, ...face }) {
  const ref = useRef(null);
  const onstage = useOnstage(ref, loading);
  return html`<div ref=${ref} class=${"list-face-box" + (onstage ? " onstage" : "")}>
    <${SmallFace} key=${face.objURL || face.name} ...${face} />
    ${loading && html`<div class="spinner" />`}
  </div>`;
}

const Flags = ({ undecided, loading }) => html`${undecided && html`<span class="list-flag">needs tags</span>`}${loading
  && html`<span class="list-flag work">processing</span>`}`;

// What a row draws: the card's props, the columns, and each column's value as
// it is on the item (c0, c1, …), so the value-by-value redraw check sees a
// price move. A live refresh writes the item in place, not a new one. A
// compact row has no columns, and its second line's value instead (sv).
function rowProps(item, cols, sub) {
  const p = { ...cardProps(item), cols, sub };
  cols.forEach((c, i) => { p[`c${i}`] = sortValue(item, c.by); });
  if (sub) p.sv = sortValue(item, sub.by);
  return p;
}

// A data cell: its value as its field prints it, and a change's color. Keyed
// by its column, like the row's other cells.
function cell(col, v) {
  const text = fmtField(v, col);
  const tone = col.format === "percent" ? changeClass(v) : "";
  return html`<td key=${col.by} class=${cellClass(col) + (tone ? ` ${tone}` : "")}
    title=${col.kind === "text" && v != null ? text : undefined}>${text}</td>`;
}

// What a compact row says under its name: the sort's column, or Date added
// when the sort is the name (the line above) or a search's relevance. Null
// until the catalog naming a field's column has landed.
function subEntry(shown) {
  const by = !shown || shown.by === "name" ? "created" : shown.by;
  return boardEntries().find((e) => e.by === by) || columnCatalog().find((e) => e.by === by) || null;
}
const subLine = (entry, v) => html`<div class="list-sub">${entry.label} · <span
  class=${entry.format === "percent" ? changeClass(v) : undefined}>${fmtField(v, entry)}</span></div>`;

class Row extends Component {
  constructor(props) {
    super(props);
    this.state = { hover: false, pinned: false };
    this.setPinned = pinSetter(this);
    this.onEnter = () => this.setState({ hover: true });
    this.onLeave = () => this.setState({ hover: false });
    this.onOpen = (e) => { e.stopPropagation(); openOrSelect(this.props.item, e); };
    // The rest of the row passes a click through to the name, except at the
    // end of a drag that selected text, so a title can still be copied. The
    // row's own controls keep their clicks (each stops its own, as on the
    // card). In bulk mode it picks, as a card click does, a Shift+click a
    // range (grid.js pickItem).
    this.onClick = (e) => {
      if (String(window.getSelection?.() ?? "")) return;
      openOrSelect(this.props.item, e);
    };
  }

  shouldComponentUpdate(nextProps, nextState) {
    return !sameProps(nextProps, this.props) || !sameProps(nextState, this.state);
  }

  componentDidMount() {
    registerPin(this.base, this.setPinned);
  }

  render(p, s) {
    const chrome = s.hover || s.pinned;
    const cls = "list-row" + (p.loading ? " loading" : "") + (p.undecided ? " undecided" : "")
      + (p.selected ? " selected" : "") + (s.pinned ? " pop-open" : "");
    // The name is the row's open control (data-open: the lightbox gives focus
    // back to it on closing), and both it and the select button are named for
    // keepPlace (draw, below). Cells are keyed, so a column turned on or off
    // leaves the others, and the heart and actions, where they are.
    return html`<tr class=${cls} data-id=${p.id} onMouseDown=${holdTextInBulk} onClick=${this.onClick}
      onPointerEnter=${this.onEnter} onPointerLeave=${this.onLeave}>
      ${p.me && !p.compact && html`<td key="sel" class="list-sel"><${SelectButton} item=${p.item} selected=${p.selected} place=${`select-${p.id}`} /></td>`}
      <td key="face" class="list-face"><${Face} loading=${p.loading} kind=${p.kind} name=${p.name} w=${p.w} h=${p.h}
        generated=${p.generated} symbol=${p.symbol} identity=${p.identity} /></td>
      <td key="name" class="list-name"><div class="list-name-line">
        <button type="button" class="list-open" data-open data-place=${`open-${p.id}`} title=${p.label} onClick=${this.onOpen}>${p.label}</button>
        <${Flags} undecided=${p.undecided} loading=${p.loading} />
      </div>${p.sub && subLine(p.sub, p.sv)}</td>
      ${p.cols.map((c, i) => cell(c, p[`c${i}`]))}
      ${p.me && !p.compact && html`<td key="heart" class="list-heart"><${HeartControl} item=${p.item} hearts=${p.hearts} on=${p.favoritedByMe} /></td>`}
      ${!p.compact && html`<td key="act" class="list-act">${chrome && html`<${TagChip} item=${p.item} count=${p.tags.length} />${p.me && html`<${CardActions} item=${p.item} />`}`}</td>`}
    </tr>`;
  }
}

// An upload placeholder or an item still in flight, as a row: its face under
// the spinner, its name, and no data-id, so Ctrl+A and the settled counts
// don't see it (grid.js ProgressCard's rule). `after` counts the cells after
// the name: the columns, the heart and the actions (none in the compact
// table).
function LaneRow({ p, me, sel, after }) {
  return html`<tr class="list-row list-lane">
    ${sel && html`<td class="list-sel" />`}
    <td class="list-face"><${Face} loading=${true} kind=${p.kind} name=${p.name} objURL=${p.objURL} w=${p.w} h=${p.h}
      symbol=${p.symbol} identity=${p.identity} /></td>
    <td class="list-name"><div class="list-name-line">
      <span class="list-title">${p.displayLabel || p.name || "uploading"}</span>
      <span class="list-flag work">${p.id ? "processing" : "uploading"}</span>
    </div></td>
    ${after > 1 && html`<td colspan=${after - 1} />`}
    ${after > 0 && html`<td class="list-act">${p.id && me && html`<${Act} icon="trash" cls="delete" title="Delete" onClick=${() => doDelete(p.id)} />`}</td>`}
  </tr>`;
}

function List({ progress, items, limit, me, cols, shown, compact }) {
  if (!items.length && !progress.length) return html`<${EmptyNote} />`;
  const entry = Object.fromEntries(boardEntries().map((e) => [e.by, e]));
  // The member's own columns, the select circle and the heart: not in the
  // compact table (a pointer shows them), nor the actions.
  const own = me && !compact;
  const after = compact ? 0 : cols.length + (me ? 1 : 0) + 1;
  const lane = progress.slice(0, LANE_BUDGET).map((p) =>
    html`<${LaneRow} key=${p.tempId != null ? `u${p.tempId}` : `p${p.id}`} p=${p} me=${me} sel=${own} after=${after} />`);
  if (progress.length > LANE_BUDGET) {
    lane.push(html`<tr key="lane-more" class="list-row list-lane list-lane-more" title="Show the whole queue" onClick=${showQueue}>
      <td colspan=${(own ? 1 : 0) + 2 + after}>+${progress.length - LANE_BUDGET} processing…</td>
    </tr>`);
  }
  const sub = compact ? subEntry(shown) : null;
  // The pinned cells' offsets, and the full table's floor: under it the name
  // would go below NAME_MIN. The compact table has none, and fits the screen.
  const pinFace = own ? WIDTH.sel : 0;
  const face = compact ? WIDTH.smallFace : WIDTH.face;
  const px = (n) => `width:${n}px`;
  return html`<table class=${"data-table list-table" + (compact ? " list-compact" : "")} aria-label=${state.boardName || "Items"}
    style=${`${compact ? "" : `min-width:${fullWidth(cols, me)}px;`}--pin-face:${pinFace}px;--pin-name:${pinFace + face}px`}>
    <colgroup>
      ${own && html`<col key="sel" style=${px(WIDTH.sel)} />`}
      <col key="face" style=${px(face)} />
      <col key="name" />
      ${cols.map((c) => html`<col key=${c.by} style=${px(widthOf(c))} />`)}
      ${own && html`<col key="heart" style=${px(WIDTH.heart)} />`}
      ${!compact && html`<col key="act" style=${px(WIDTH.act)} />`}
    </colgroup>
    <thead><tr>
      ${own && html`<th key="sel" scope="col" class="list-sel"><span class="vis-hidden">Select</span></th>`}
      <th key="face" scope="col" class="list-face"><span class="vis-hidden">Picture</span></th>
      <${SortHead} key="name" entry=${entry.name} shown=${shown} cls="list-name" />
      ${cols.map((c) => html`<${SortHead} key=${c.by} entry=${c} shown=${shown} cls=${headClass(c)} />`)}
      ${own && html`<${SortHead} key="hearts" entry=${entry.hearts} shown=${shown} cls="list-heart"><${Icon} svg=${ICONS.heart} /><span
        class="vis-hidden">${entry.hearts.label}</span></${SortHead}>`}
      ${!compact && html`<th key="act" scope="col" class="list-act"><span class="vis-hidden">Actions</span></th>`}
    </tr></thead>
    <tbody>
      ${lane}
      ${items.slice(0, limit).map((item) => html`<${Row} key=${`r${item.id}`} ...${rowProps(item, cols, sub)} me=${me} compact=${compact} />`)}
    </tbody>
  </table>`;
}

// The draw's inputs as a stamp, the grid's way (grid.js draw): a repaint that
// moved none of them is skipped. A write to any item is a new filtered list
// (filters.js caches it on the items version), so the list itself stands for
// the items. A sort or a search changes the key, which always draws
// (batches.js), so the headers never show a stale sort. The columns are the
// same array until the viewer's pick or the catalog changes (columns.js).
let drawn = null;
const laneKey = (progress) => progress.map((p) => p.tempId ?? p.id).join(",");
function stamp() {
  const { last, limit } = batches;
  return [last.items, limit, laneKey(last.progress), state.me, state.bulkSelected, state.facets, state.boardMapping,
    shownColumns(), compactList()];
}

// Focus rides a redraw. A row that moves up the list is moved by Preact, and
// the browser takes focus off an element it moves; keepPlace (modal.js) puts
// it back on the control under the same data-place. Without scrolling: the
// page stays where the reader has it, and the next key goes on from the row.
const paint = keepPlace(elGrid, () => {
  const { last, limit } = batches;
  drawnCompact = compactList();
  render(html`<${List} progress=${last.progress} items=${last.items} limit=${limit} me=${!!state.me}
    cols=${drawnCompact ? NO_COLUMNS : shownColumns()} shown=${shownSort()} compact=${drawnCompact} />`, elGrid);
});

function draw(force = false) {
  const s = stamp();
  if (!force && drawn && s.every((v, i) => v === drawn[i])) return;
  drawn = s;
  paint();
}

const batches = batchedView("list", RENDER_BATCH, draw);

// The List counterpart of renderGrid — same contract, and the same key.
export function renderList(key, progressItems, items) {
  const fresh = batches.render(key, progressItems, items);
  elGrid.style.height = ""; // masonry's inline height from a prior grid draw
  draw(fresh);
}
