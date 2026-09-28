import { state } from './state.js';
import { batch } from './vendor/signals.mjs';
import { ICONS } from './utils.js';
import { openCratePicker, addToCrate } from './crates.js';
import { toast } from './toast.js';
import { requeue } from './data.js';

let bar = null;
let countEl = null;
let picker = null; // the crate picker, once opened (closing a closed one does nothing)

function barBtn(icon, cls, title, onClick) {
  const b = document.createElement("button");
  b.className = "bb-btn " + cls;
  b.title = title;
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

function ensureBar() {
  if (bar) return;
  bar = document.createElement("div");
  bar.id = "bulk-bar";
  bar.hidden = true;

  countEl = document.createElement("span");
  countEl.className = "bb-count";

  const sep = document.createElement("div");
  sep.className = "bb-sep";

  const crateBtn = barBtn("crate", "crate", "Add selected to crate", () => {
    picker = openCratePicker(crateBtn, { onPick: addAllToCrate });
  });

  bar.append(
    barBtn("x", "clear", "Clear selection", clearBulk),
    countEl,
    sep,
    barBtn("redo", "reprocess", "Reprocess selected — redo everything", doBulkReprocess),
    barBtn("trash", "delete", "Delete selected", doBulkDelete),
    crateBtn,
  );
  document.body.appendChild(bar);
}

function selectedItems() {
  return state.items.filter((i) => state.bulkSelected.has(i.id));
}

export function updateBulkBar() {
  ensureBar();
  const n = state.bulkSelected.size;
  bar.hidden = n === 0;
  document.body.classList.toggle("bulk-mode", n > 0);
  countEl.textContent = n;
  if (n === 0) picker?.close();
}

// The selection is replaced, never edited: the cards read it from their props
// (planning/ui-updates-plan.md, Stage 4) and the write is the repaint (Stage
// 5), so nothing here touches a card element.
function select(next) {
  state.bulkSelected = next;
  updateBulkBar();
}

// Where a Shift-click's range starts: the last item picked.
let anchor = null;

export function toggleBulkSelect(item) {
  const next = new Set(state.bulkSelected);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  anchor = item.id;
  select(next);
}

// A Shift-click (planning/list-view-plan.md, Stage 4): every item drawn from
// the last one picked to this one, in the page's order, joins the selection.
// What's drawn, as Ctrl+A takes it (`drawn`: grid.js visibleGridItems), so a
// card whose picture failed isn't taken. With nothing picked yet, or the last
// pick no longer drawn, it picks this one alone.
export function selectRange(item, drawn) {
  const ids = drawn.map((i) => i.id);
  const from = ids.indexOf(anchor);
  const to = ids.indexOf(item.id);
  if (from < 0 || to < 0) return toggleBulkSelect(item);
  const next = new Set(state.bulkSelected);
  for (const id of ids.slice(Math.min(from, to), Math.max(from, to) + 1)) next.add(id);
  select(next);
}

export function clearBulk() {
  anchor = null;
  select(new Set());
}

export function selectAllVisible(items) {
  select(new Set(items.map((item) => item.id)));
}

async function doBulkReprocess() {
  const items = selectedItems();
  // Each through requeue (data.js), the one re-queue every surface takes.
  const results = await Promise.allSettled(items.map((item) => requeue(`/api/items/${item.id}/reprocess`)));
  const failed = results.filter((r) => r.status === "rejected").length;
  clearBulk(); // repaints
  if (failed) toast.error(`Reprocess failed for ${failed} of ${items.length}`);
  else toast(`Reprocessing ${items.length} item${items.length === 1 ? "" : "s"}…`, { duration: "short" });
}

async function doBulkDelete() {
  const items = selectedItems();
  if (!confirm(`Delete ${items.length} item${items.length === 1 ? "" : "s"}?`)) return;
  const deleted = new Set();
  await Promise.allSettled(items.map(async (item) => {
    const r = await fetch(`/api/items/${item.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    deleted.add(item.id);
  }));
  const failed = items.length - deleted.size;
  batch(() => {
    state.items = state.items.filter((i) => !deleted.has(i.id));
    clearBulk();
  });
  // The error already implies the rest went through, so don't double-toast.
  if (failed) toast.error(`Couldn't delete ${failed} of ${items.length}`);
  else toast(`Deleted ${deleted.size} item${deleted.size === 1 ? "" : "s"}`);
}

// One request for the whole selection, and an add rather than a toggle: a
// card already in the crate stays in, and the answer says how many moved.
async function addAllToCrate(crate) {
  const r = await addToCrate(crate.id, selectedItems());
  if (!r) return;
  if (r.added) toast(`Added ${r.added} to "${crate.name}"`, { duration: "short" });
  else toast.info(`Already in "${crate.name}"`);
}

// Drop selections for items that no longer exist (deleted elsewhere, board
// change). app.js's render() calls this before it draws anything, so the
// cards draw the pruned selection.
export function pruneSelection() {
  if (!state.bulkSelected.size) return;
  const ids = new Set(state.items.map((i) => i.id));
  const kept = [...state.bulkSelected].filter((id) => ids.has(id));
  if (kept.length !== state.bulkSelected.size) state.bulkSelected = new Set(kept);
  updateBulkBar();
}

