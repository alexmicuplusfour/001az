import { state } from './state.js';
import { itemsChanged } from './state-signals.js';
import { batch } from './vendor/signals.mjs';
import { ICONS } from './utils.js';
import { openDropdown, ddRow, ddSep, ddInput } from './dropdown.js';
import { toast } from './toast.js';
import { requeue } from './data.js';

let bar = null;
let countEl = null;
let closeCratePop = null; // close fn while the bulk crate pop is open

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

  const crateBtn = barBtn("crate", "crate", "Add selected to crate", () => openBulkCratePop(crateBtn));

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
  if (n === 0) closeBulkCratePop();
}

// The selection is replaced, never edited: the cards read it from their props
// (planning/ui-updates-plan.md, Stage 4) and the write is the repaint (Stage
// 5), so nothing here touches a card element.
function select(next) {
  state.bulkSelected = next;
  updateBulkBar();
}

export function toggleBulkSelect(item) {
  const next = new Set(state.bulkSelected);
  if (next.has(item.id)) next.delete(item.id);
  else next.add(item.id);
  select(next);
}

export function clearBulk() {
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

async function addAllToCrate(crateId) {
  const crate = state.crates.find((c) => c.id === crateId);
  // The API toggles membership, so skip items already in the crate.
  const items = selectedItems().filter((i) => !i.crateIds.has(crateId));
  if (!items.length) {
    toast.info(`Already in "${crate ? crate.name : "crate"}"`);
    return;
  }
  let counts = [];
  await Promise.allSettled(items.map(async (item) => {
    const r = await fetch(`/api/crates/${crateId}/items/${item.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    // Announced as each answer lands, not after the last: a repaint or the
    // grid's next batch in between shows the items already in (the crate
    // filter reads membership).
    if (added) { item.crateIds.add(crateId); itemsChanged(); }
    counts.push(count);
  }));
  if (crate && counts.length) {
    crate.item_count = Math.max(crate.item_count || 0, ...counts);
    state.crates = [...state.crates]; // a count moved in place: a new list, so what reads it redraws
  }
  const failed = items.length - counts.length;
  if (failed) toast.error(`Couldn't add ${failed} of ${items.length} to crate`);
  else toast(`Added ${counts.length} to "${crate ? crate.name : "crate"}"`, { duration: "short" });
}

function closeBulkCratePop() {
  closeCratePop?.();
}

function openBulkCratePop(anchorEl) {
  const ctx = openDropdown(anchorEl, {
    className: "crate-pop",
    minWidth: 190,
    focus: ".dd-input",
    build: (body) => {
      for (const crate of state.crates.filter((c) => c.owned)) {
        body.appendChild(ddRow({
          label: crate.name,
          onClick: () => {
            closeBulkCratePop();
            addAllToCrate(crate.id);
          },
        }));
      }
    },
    footer: (foot) => {
      if (state.crates.length) foot.appendChild(ddSep());
      foot.appendChild(ddInput({
        placeholder: "New crate…",
        onSubmit: async (name) => {
          try {
            const r = await fetch("/api/crates", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ name, board_id: state.boardId }),
            });
            if (!r.ok) { toast.error("Couldn't create crate"); return; }
            const { crate } = await r.json();
            if (!state.crates.find((c) => c.id === crate.id)) state.crates = [...state.crates, crate];
            closeBulkCratePop();
            addAllToCrate(crate.id);
          } catch {
            toast.error("Couldn't create crate");
          }
        },
      }));
    },
    onClose: () => { closeCratePop = null; },
  });
  if (ctx) closeCratePop = ctx.close;
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

