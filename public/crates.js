import { state } from './state.js';
import { itemsChanged } from './state-signals.js';
import { batch } from './vendor/signals.mjs';
import { getJson } from './api.js';
import { ICONS } from './utils.js';
import { openDropdown, ddRow, ddSep, ddInput } from './dropdown.js';
import { createCheckbox } from './checkbox.js';
import { toast } from './toast.js';
import { pinWhileOpen } from './grid.js';
import { html, render } from './vendor/preact.mjs';

let crateState = null; // { close, card } for the currently open crate pop

// The board's crates, as this reader sees them: their own plus the public ones.
// ONE implementation — boot calls it and so does the event channel, the way
// data.js's refreshItemsOnce serves both the poll and an event. Two copies of
// "how crates arrive" is how the two come to disagree about a field.
//
// `setCrates` is separate because the invariant below belongs to every writer,
// not just this fetch: doDeleteCrate clears the same selection by hand, and a
// third writer would have had to remember it a third time.
export async function loadCrates() {
  const { data } = await getJson(`/api/crates?board=${encodeURIComponent(state.boardId)}`, { cache: "no-store" });
  if (Array.isArray(data)) setCrates(data);
}

// A crate that is gone cannot stay selected. Nothing else notices: filters.js
// keeps matching item.crateIds against an id no crate has, so the grid empties
// with nothing on screen to say why.
export function setCrates(list) {
  batch(() => {
    state.crates = list;
    if (state.selectedCrateId != null && !list.some((c) => c.id === state.selectedCrateId)) {
      state.selectedCrateId = null;
    }
  });
}

export function closeCratePop(skipTeardown = false) {
  crateState?.close(skipTeardown ? "keep-card" : "manual");
}

export function crateDisplayName(crate) {
  return crate.owned ? crate.name : `${crate.name} (${crate.owner_name})`;
}

// A crate's name, and whose it is when it isn't yours. The component is for the
// toolbar's Crates button (Preact); appendCrateLabel draws the same into a
// hand-built element, the crates menu's rows (planning/ui-updates-plan.md, D6).
export function CrateLabel({ crate }) {
  return html`${crate.name}${crate.owned ? null : html`<span class="crate-owner">${` (${crate.owner_name})`}</span>`}`;
}

export function appendCrateLabel(parent, crate) {
  const box = document.createElement("span");
  render(html`<${CrateLabel} crate=${crate} />`, box);
  parent.append(...box.childNodes);
}

export function crateLabelEl(crate) {
  const el = document.createElement("span");
  el.className = "dd-label";
  appendCrateLabel(el, crate);
  return el;
}

function ownCrates() {
  return state.crates.filter((c) => c.owned);
}

async function doDeleteCrate(crate, onClose) {
  try {
    const r = await fetch(`/api/crates/${crate.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    batch(() => {
      setCrates(state.crates.filter((c) => c.id !== crate.id));
      for (const item of state.items) item.crateIds.delete(crate.id);
      itemsChanged();
    });
    onClose();
  } catch {
    toast.error("Couldn't delete crate");
  }
}

function crateDelBtn(crate) {
  const del = document.createElement("button");
  del.className = "dd-del";
  del.title = "Delete crate";
  del.innerHTML = ICONS.trash;
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete crate "${crate.name}"?`)) return;
    await doDeleteCrate(crate, closeCratePop);
  });
  return del;
}

function crateVisBtn(crate) {
  const btn = document.createElement("button");
  btn.className = "dd-vis";
  const sync = () => {
    btn.title = crate.public ? "Make private" : "Make public";
    btn.innerHTML = crate.public ? ICONS.eye : ICONS.eyeOff;
  };
  sync();
  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    const next = !crate.public;
    try {
      const r = await fetch(`/api/crates/${crate.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ public: next }),
      });
      if (!r.ok) throw new Error();
      const { crate: updated } = await r.json();
      crate.public = updated.public;
      sync();
      toast(crate.public ? "Crate is now public" : "Crate is now private", { duration: "short" });
    } catch {
      toast.error("Couldn't update crate visibility");
    }
  });
  return btn;
}

function crateTrailing(crate) {
  if (!crate.owned) return null;
  const wrap = document.createElement("span");
  wrap.className = "dd-actions";
  wrap.append(crateVisBtn(crate), crateDelBtn(crate));
  return wrap;
}

async function toggleCrateItemApi(item, crateId, checkbox) {
  const prev = checkbox.checked;
  try {
    const r = await fetch(`/api/crates/${crateId}/items/${item.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    checkbox.checked = added;
    const leaving = state.selectedCrateId === crateId && !added;
    // The item just left the filtered crate: its card is about to be drawn
    // away, so a card-anchored pop closes first, or it would be left orphaned.
    if (leaving && crateState?.card) closeCratePop(true);
    batch(() => {
      if (added) item.crateIds.add(crateId);
      else item.crateIds.delete(crateId);
      itemsChanged();
      const crate = state.crates.find((c) => c.id === crateId);
      if (crate) {
        crate.item_count = count;
        state.crates = [...state.crates]; // a count moved in place: a new list, so what reads it redraws
      }
    });
    // The lightbox's crate button reads membership off the item.
    if (!leaving) document.dispatchEvent(new Event('app:lightbox-crate-changed'));
  } catch {
    checkbox.checked = prev;
    toast.error("Couldn't update crate");
  }
}

async function createCrateWithItem(name, item, anchorEl) {
  try {
    const r = await fetch("/api/crates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, board_id: state.boardId }),
    });
    if (!r.ok) { toast.error("Couldn't create crate"); return; }
    const { crate } = await r.json();
    // The toolbar's Crates button only exists while state.crates is non-empty,
    // so the first crate's write is what draws it. The card persists across
    // it and its chrome stays pinned (the "keep-card" close below), so
    // anchorEl survives the draw.
    if (!state.crates.find((c) => c.id === crate.id)) state.crates = [...state.crates, crate];
    const r2 = await fetch(`/api/crates/${crate.id}/items/${item.id}`, { method: "POST" });
    if (r2.ok) {
      const { added, count } = await r2.json();
      batch(() => {
        if (added) item.crateIds.add(crate.id);
        itemsChanged();
        state.crates = state.crates.map((c) => (c.id === crate.id ? { ...c, item_count: count } : c));
      });
    }
    // Reopen so the new crate shows up as a row; keep the card's hover chrome.
    closeCratePop(true);
    openCratePop(anchorEl, item);
  } catch {
    toast.error("Couldn't create crate");
  }
}

export function openCratePop(anchorEl, item = null) {
  const pin = pinWhileOpen(anchorEl);
  const crates = item ? ownCrates() : state.crates;

  const ctx = openDropdown(anchorEl, {
    className: "crate-pop",
    minWidth: 190,
    focus: item ? ".dd-input" : undefined,
    build: (body) => {
      for (const crate of crates) {
        if (item) {
          // Assign mode: checkboxes to add/remove the item from crates.
          const cb = createCheckbox({
            variant: "dark",
            checked: item.crateIds.has(crate.id),
            onChange: () => toggleCrateItemApi(item, crate.id, cb),
          });
          body.appendChild(ddRow({
            label: crate.name,
            leading: cb.el,
            trailing: crateTrailing(crate),
            onClick: () => {
              cb.checked = !cb.checked;
              toggleCrateItemApi(item, crate.id, cb);
            },
          }));
        } else {
          // Filter mode: click a crate to filter the gallery.
          body.appendChild(ddRow({
            labelEl: crateLabelEl(crate),
            active: state.selectedCrateId === crate.id,
            trailing: crateTrailing(crate),
            onClick: () => {
              closeCratePop();
              state.selectedCrateId = state.selectedCrateId === crate.id ? null : crate.id;
            },
          }));
        }
      }
    },
    footer: item ? (foot) => {
      if (crates.length) foot.appendChild(ddSep());
      foot.appendChild(ddInput({
        placeholder: "New crate…",
        onSubmit: (name) => createCrateWithItem(name, item, anchorEl),
      }));
    } : undefined,
    onClose: (reason) => {
      crateState = null;
      pin.release(reason);
    },
  });

  if (!ctx) return; // second click on the same anchor: toggled closed
  pin.hold(ctx);
  crateState = { close: ctx.close, card: pin.el };
}
