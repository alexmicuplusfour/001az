// columns.js — the columns List shows (planning/list-view-plan.md, D5 and D6):
// the viewer's own pick for the board, or the board's defaults. The pick is
// kept per viewer, per board, in localStorage (`boardColumns:<boardId>`, the
// boardSort pattern) as column keys in catalog order: "created",
// "field:price", "media:duration". The Columns menu sets it.
import { state } from './state.js';
import { columnCatalog, sortCatalog } from './sort.js';
import { openDropdown, ddHead, ddCheckRow, ddAction } from './dropdown.js';

const storeKey = () => `boardColumns:${state.boardId}`;

export function restoreColumns() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(storeKey()) || "null");
  } catch { /* corrupted entry — the defaults */ }
  state.columns = Array.isArray(stored) && stored.every((k) => typeof k === "string") ? stored : null;
}

// null goes back to the board's defaults.
function setColumns(keys) {
  state.columns = keys;
  try {
    if (keys) localStorage.setItem(storeKey(), JSON.stringify(keys));
    else localStorage.removeItem(storeKey());
  } catch { /* private mode / quota — the choice just won't stick */ }
}

// The columns List draws, in catalog order: the viewer's pick, or the board's
// defaults. A saved key the board can't show (a field unbound since, a catalog
// still on its way) is left out here, and left in storage (D6). The same array
// until the pick or the catalog changes, so a row's props compare.
let shownMemo = null;
export function shownColumns() {
  const all = columnCatalog();
  const pick = state.columns;
  if (shownMemo?.all === all && shownMemo.pick === pick) return shownMemo.cols;
  const cols = pick ? all.filter((e) => pick.includes(e.by)) : all.filter((e) => e.byDefault);
  shownMemo = { all, pick, cols };
  return cols;
}

// The Columns menu: the board's catalog in the sort menu's sections ("Audio · 3"
// on a mixed board), a check row per column, and the way back to the defaults.
// A shown column keeps its section even before an item of its kind has
// loaded, so it can always be turned off. The name and the hearts are the
// table's own. It stays open for the next flip; each one redraws List.
export async function openColumnsMenu(anchor) {
  const shown = new Set(shownColumns().map((e) => e.by));
  const sections = await sortCatalog({ keep: shown });
  const flip = (by, on) => {
    const next = new Set(shownColumns().map((e) => e.by));
    if (on) next.add(by);
    else next.delete(by);
    setColumns(columnCatalog().map((e) => e.by).filter((k) => next.has(k)));
  };
  openDropdown(anchor, {
    className: "columns-pop",
    build: (body, { variant }) => {
      for (const section of sections) {
        const entries = section.entries.filter((e) => e.by !== "name" && e.by !== "hearts");
        if (!entries.length) continue;
        body.appendChild(ddHead(section.count != null ? `${section.label} · ${section.count}` : section.label));
        for (const e of entries) {
          const row = ddCheckRow({ variant, label: e.label, checked: shown.has(e.by), onChange: (ev) => flip(e.by, ev.target.checked) });
          body.appendChild(row.el);
        }
      }
    },
    footer: (foot, { close }) => {
      foot.appendChild(ddAction({ label: "Reset to the board's defaults", onClick: () => { setColumns(null); close(); } }));
    },
  });
}
