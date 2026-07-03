import { state } from './state.js';
import { ICONS, onOutsideClick, positionPop } from './utils.js';
import { toast } from './toast.js';
import { ensurePolling } from './data.js';

let bar = null;
let countEl = null;
let cratePopState = null;

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

function selectedImages() {
  return state.images.filter((i) => state.bulkSelected.has(i.id));
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

async function doBulkReprocess() {
  const imgs = selectedImages();
  const results = await Promise.allSettled(imgs.map(async (img) => {
    const r = await fetch(`/api/images/${img.id}/reprocess`, { method: "POST" });
    if (!r.ok) throw new Error();
    img.status = "pending";
    img.tags = [];
    img.tagSet = new Set();
  }));
  const failed = results.filter((r) => r.status === "rejected").length;
  clearBulk();
  document.dispatchEvent(new Event('app:render'));
  ensurePolling();
  if (failed) toast.error(`Reprocess failed for ${failed} of ${imgs.length}`);
  else toast(`Reprocessing ${imgs.length} image${imgs.length === 1 ? "" : "s"}…`, { duration: "short" });
}

async function doBulkDelete() {
  const imgs = selectedImages();
  if (!confirm(`Delete ${imgs.length} image${imgs.length === 1 ? "" : "s"}?`)) return;
  const deleted = new Set();
  await Promise.allSettled(imgs.map(async (img) => {
    const r = await fetch(`/api/images/${img.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    deleted.add(img.id);
  }));
  state.images = state.images.filter((i) => !deleted.has(i.id));
  const failed = imgs.length - deleted.size;
  clearBulk();
  document.dispatchEvent(new Event('app:render'));
  if (failed) toast.error(`Couldn't delete ${failed} of ${imgs.length}`);
}

async function addAllToCrate(crateId) {
  const crate = state.crates.find((c) => c.id === crateId);
  // The API toggles membership, so skip images already in the crate.
  const imgs = selectedImages().filter((i) => !i.crateIds.has(crateId));
  if (!imgs.length) {
    toast.info(`Already in "${crate ? crate.name : "crate"}"`);
    return;
  }
  let counts = [];
  await Promise.allSettled(imgs.map(async (img) => {
    const r = await fetch(`/api/crates/${crateId}/images/${img.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    if (added) img.crateIds.add(crateId);
    counts.push(count);
  }));
  if (crate && counts.length) crate.image_count = Math.max(crate.image_count || 0, ...counts);
  const failed = imgs.length - counts.length;
  document.dispatchEvent(new Event('app:render'));
  if (failed) toast.error(`Couldn't add ${failed} of ${imgs.length} to crate`);
  else toast(`Added ${counts.length} to "${crate ? crate.name : "crate"}"`, { duration: "short" });
}

function closeBulkCratePop() {
  if (!cratePopState) return;
  cratePopState.pop.remove();
  document.removeEventListener("click", cratePopState.outside, true);
  cratePopState = null;
}

function openBulkCratePop(anchorEl) {
  if (cratePopState) { closeBulkCratePop(); return; }

  const pop = document.createElement("div");
  pop.className = "float-menu crate-pop";

  if (state.crates.length) {
    for (const crate of state.crates) {
      const row = document.createElement("div");
      row.className = "cp-row";
      const nameEl = document.createElement("span");
      nameEl.className = "cp-name";
      nameEl.textContent = crate.name;
      row.appendChild(nameEl);
      row.addEventListener("click", () => {
        closeBulkCratePop();
        addAllToCrate(crate.id);
      });
      pop.appendChild(row);
    }
    const sep = document.createElement("div");
    sep.className = "cp-sep";
    pop.appendChild(sep);
  }

  const inp = document.createElement("input");
  inp.type = "text";
  inp.placeholder = "New crate…";
  inp.className = "cp-input";
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const name = inp.value.trim();
    if (!name) return;
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
  });
  pop.appendChild(inp);

  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  requestAnimationFrame(() => inp.focus());
  const outside = onOutsideClick(pop, anchorEl, closeBulkCratePop);
  cratePopState = { pop, outside };
}

// Drop selections for images that no longer exist (deleted elsewhere, board change).
document.addEventListener('app:render', () => {
  if (!state.bulkSelected.size) return;
  const ids = new Set(state.images.map((i) => i.id));
  for (const id of [...state.bulkSelected]) {
    if (!ids.has(id)) state.bulkSelected.delete(id);
  }
  updateBulkBar();
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !state.bulkSelected.size) return;
  if (!document.getElementById("lightbox").hidden) return;
  if (document.querySelector(".te-overlay")) return;
  if (cratePopState) { closeBulkCratePop(); return; }
  clearBulk();
});
