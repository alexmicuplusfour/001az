import { state } from './state.js';
import { itemsChanged } from './state-signals.js';
import { batch } from './vendor/signals.mjs';
import { api, getJson } from './api.js';
import { ICONS } from './utils.js';
import { openDropdown, ddRow, ddSep, ddInput, ddHead, ddEmpty } from './dropdown.js';
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

// A count moved in place: a new list, so what reads it redraws.
function setCrateCount(crateId, count) {
  const crate = state.crates.find((c) => c.id === crateId);
  if (!crate) return;
  crate.item_count = count;
  state.crates = [...state.crates];
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
      setCrateCount(crateId, count);
    });
  } catch {
    checkbox.checked = prev;
    toast.error("Couldn't update crate");
  }
}

// Make a crate, or find yours by that name (the server does both), and put it
// on the list. The one create request: the card menu and the picker both come
// here. Answers the crate, or null once it has said why not.
async function createCrate(name) {
  try {
    const { crate } = await api("POST", "/api/crates", { name, board_id: state.boardId });
    // The toolbar's Crates button only exists while state.crates is non-empty,
    // so the first crate's write is what draws it.
    if (!state.crates.some((c) => c.id === crate.id)) state.crates = [...state.crates, crate];
    return crate;
  } catch {
    toast.error("Couldn't create crate");
    return null;
  }
}

// Put cards in a crate, and only put them in: a card already there stays, and
// so does one a repeat sends again. The checkbox rows toggle instead
// (toggleCrateItemApi); anything that means "put these in" comes here.
// Answers the server's { added, already, count }, or null once it has said
// why not.
export async function addToCrate(crateId, items) {
  try {
    const result = await api("POST", `/api/crates/${crateId}/items`, { ids: items.map((i) => i.id) });
    batch(() => {
      for (const item of items) item.crateIds.add(crateId);
      itemsChanged();
      setCrateCount(crateId, result.count);
    });
    return result;
  } catch {
    toast.error("Couldn't add to crate");
    return null;
  }
}

async function createCrateWithItem(name, item, anchorEl) {
  const crate = await createCrate(name);
  if (!crate) return;
  // An add, not the checkbox's toggle: the name can be a crate the card is
  // already in, since the server finds yours by name, and a toggle would take
  // it out.
  await addToCrate(crate.id, [item]);
  // Reopen so the new crate shows up as a row. The card persists across the
  // first crate's drawing of the Crates button, and its chrome stays pinned
  // (the "keep-card" close), so anchorEl survives it.
  closeCratePop(true);
  openCratePop(anchorEl, item);
}

export function openCratePop(anchorEl, item = null) {
  const pin = pinWhileOpen(anchorEl);
  const crates = item ? ownCrates() : state.crates;

  const ctx = openDropdown(anchorEl, {
    className: "crate-pop",
    minWidth: 190,
    focus: item ? ".dd-input" : undefined,
    build: (body) => {
      // Named the way the saved filters menu is.
      body.appendChild(ddHead("Crates"));
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
    footer: item ? (foot) => newCrateInput(foot, crates, (name) => createCrateWithItem(name, item, anchorEl)) : undefined,
    onClose: (reason) => {
      crateState = null;
      pin.release(reason);
    },
  });

  if (!ctx) return; // second click on the same anchor: toggled closed
  pin.hold(ctx);
  crateState = { close: ctx.close, card: pin.el };
}

// Pick one of your crates, or make one: the bulk bar's menu, and the alert
// editor's (planning/alert-crating-plan.md). Unlike the card menu above, a
// pick here is an answer rather than an edit: the menu closes and hands the
// crate to onPick. Returns the menu, for an opener that has to close it.
export function openCratePicker(anchorEl, { activeId = null, onPick, align } = {}) {
  const crates = ownCrates();
  return openDropdown(anchorEl, {
    className: "crate-pop",
    minWidth: 190,
    align,
    focus: ".dd-input",
    build: (body, { close }) => {
      body.appendChild(ddHead("Crates"));
      for (const crate of crates) {
        body.appendChild(ddRow({
          label: crate.name,
          active: crate.id === activeId,
          onClick: () => { close(); onPick(crate); },
        }));
      }
    },
    footer: (foot, { close }) => newCrateInput(foot, crates, async (name) => {
      const crate = await createCrate(name);
      if (crate) { close(); onPick(crate); }
    }),
  });
}

// A crate menu's "New crate…" box. Over it, a line under the list the menu
// shows, or with no list, a note saying so (the saved filters menu's).
function newCrateInput(foot, crates, onSubmit) {
  foot.appendChild(crates.length ? ddSep() : ddEmpty("None yet — name one below."));
  foot.appendChild(ddInput({ placeholder: "New crate…", onSubmit }));
}
