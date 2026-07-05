import { state } from './state.js';
import { ICONS } from './utils.js';
import { openDropdown, ddRow, ddSep, ddInput } from './dropdown.js';
import { toast } from './toast.js';
import { ensurePolling } from './data.js';

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
    barBtn("redo", "reprocess", "Reprocess selected (re-tag with AI)", doBulkReprocess),
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

export function toggleBulkSelect(img, card) {
  const on = !state.bulkSelected.has(img.id);
  if (on) state.bulkSelected.add(img.id);
  else state.bulkSelected.delete(img.id);
  card.classList.toggle("selected", on);
  card.querySelector(".sel-cb")?.setAttribute("aria-pressed", on);
  updateBulkBar();
}

export function clearBulk() {
  state.bulkSelected.clear();
  for (const card of document.querySelectorAll(".card.selected")) {
    card.classList.remove("selected");
    card.querySelector(".sel-cb")?.setAttribute("aria-pressed", "false");
  }
  updateBulkBar();
}

export function selectAllVisible(items) {
  state.bulkSelected.clear();
  for (const img of items) state.bulkSelected.add(img.id);
  for (const card of document.querySelectorAll(".card[data-id]")) {
    const id = Number(card.dataset.id);
    const on = state.bulkSelected.has(id);
    card.classList.toggle("selected", on);
    card.querySelector(".sel-cb")?.setAttribute("aria-pressed", String(on));
  }
  updateBulkBar();
}

async function doBulkReprocess() {
  const imgs = selectedItems();
  const results = await Promise.allSettled(imgs.map(async (img) => {
    const r = await fetch(`/api/items/${img.id}/reprocess`, { method: "POST" });
    if (!r.ok) throw new Error();
    img.status = "pending";
    if (!img.tags.length) img.tagSet = new Set();
  }));
  const failed = results.filter((r) => r.status === "rejected").length;
  clearBulk();
  document.dispatchEvent(new Event('app:render'));
  ensurePolling();
  if (failed) toast.error(`Reprocess failed for ${failed} of ${imgs.length}`);
  else toast(`Reprocessing ${imgs.length} item${imgs.length === 1 ? "" : "s"}…`, { duration: "short" });
}

async function doBulkDelete() {
  const imgs = selectedItems();
  if (!confirm(`Delete ${imgs.length} item${imgs.length === 1 ? "" : "s"}?`)) return;
  const deleted = new Set();
  await Promise.allSettled(imgs.map(async (img) => {
    const r = await fetch(`/api/items/${img.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    deleted.add(img.id);
  }));
  state.items = state.items.filter((i) => !deleted.has(i.id));
  const failed = imgs.length - deleted.size;
  clearBulk();
  document.dispatchEvent(new Event('app:render'));
  if (failed) toast.error(`Couldn't delete ${failed} of ${imgs.length}`);
}

async function addAllToCrate(crateId) {
  const crate = state.crates.find((c) => c.id === crateId);
  // The API toggles membership, so skip items already in the crate.
  const imgs = selectedItems().filter((i) => !i.crateIds.has(crateId));
  if (!imgs.length) {
    toast.info(`Already in "${crate ? crate.name : "crate"}"`);
    return;
  }
  let counts = [];
  await Promise.allSettled(imgs.map(async (img) => {
    const r = await fetch(`/api/crates/${crateId}/items/${img.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    if (added) img.crateIds.add(crateId);
    counts.push(count);
  }));
  if (crate && counts.length) crate.item_count = Math.max(crate.item_count || 0, ...counts);
  const failed = imgs.length - counts.length;
  document.dispatchEvent(new Event('app:render'));
  if (failed) toast.error(`Couldn't add ${failed} of ${imgs.length} to crate`);
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
            if (!state.crates.find((c) => c.id === crate.id)) state.crates.push(crate);
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

// Drop selections for items that no longer exist (deleted elsewhere, board change).
document.addEventListener('app:render', () => {
  if (!state.bulkSelected.size) return;
  const ids = new Set(state.items.map((i) => i.id));
  for (const id of [...state.bulkSelected]) {
    if (!ids.has(id)) state.bulkSelected.delete(id);
  }
  updateBulkBar();
});

