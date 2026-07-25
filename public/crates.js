import { state } from './state.js';
import { ICONS } from './utils.js';
import { openDropdown, ddRow, ddSep, ddInput } from './dropdown.js';
import { createCheckbox } from './checkbox.js';
import { toast } from './toast.js';
import { teardownCardHover } from './grid.js';

let crateState = null; // { close, card } for the currently open crate pop

export function closeCratePop(skipTeardown = false) {
  crateState?.close(skipTeardown ? "keep-card" : "manual");
}

export function crateDisplayName(crate) {
  return crate.owned ? crate.name : `${crate.name} (${crate.owner_name})`;
}

export function appendCrateLabel(parent, crate) {
  parent.append(crate.name);
  if (!crate.owned) {
    const owner = document.createElement("span");
    owner.className = "crate-owner";
    owner.textContent = ` (${crate.owner_name})`;
    parent.appendChild(owner);
  }
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
    state.crates = state.crates.filter((c) => c.id !== crate.id);
    for (const im of state.items) im.crateIds.delete(crate.id);
    if (state.selectedCrateId === crate.id) state.selectedCrateId = null;
    onClose();
    document.dispatchEvent(new Event('app:render'));
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

async function toggleCrateItemApi(img, crateId, checkbox) {
  const prev = checkbox.checked;
  try {
    const r = await fetch(`/api/crates/${crateId}/items/${img.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    checkbox.checked = added;
    if (added) img.crateIds.add(crateId);
    else img.crateIds.delete(crateId);
    const crate = state.crates.find((c) => c.id === crateId);
    if (crate) crate.item_count = count;
    if (state.selectedCrateId === crateId && !added) {
      // The item just left the filtered crate: its card is about to be
      // re-rendered away, so a card-anchored pop would be left orphaned.
      if (crateState?.card) closeCratePop(true);
      document.dispatchEvent(new Event('app:render'));
    } else {
      // Targeted update: only the lightbox crate button needs refreshing.
      document.dispatchEvent(new Event('app:lightbox-crate-changed'));
    }
  } catch {
    checkbox.checked = prev;
    toast.error("Couldn't update crate");
  }
}

async function createCrateWithItem(name, img, anchorEl) {
  try {
    const r = await fetch("/api/crates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, board_id: state.boardId }),
    });
    if (!r.ok) { toast.error("Couldn't create crate"); return; }
    const { crate } = await r.json();
    if (!state.crates.find((c) => c.id === crate.id)) state.crates.push(crate);
    const r2 = await fetch(`/api/crates/${crate.id}/items/${img.id}`, { method: "POST" });
    if (r2.ok) {
      const { added, count } = await r2.json();
      if (added) img.crateIds.add(crate.id);
      const found = state.crates.find((c) => c.id === crate.id);
      if (found) found.item_count = count;
    }
    // The toolbar's Crates button only exists while state.crates is non-empty,
    // so the first crate needs a full render to surface it. Cards are reused
    // (crate membership isn't in cardSig), so anchorEl survives the render.
    document.dispatchEvent(new Event('app:render'));
    // Reopen so the new crate shows up as a row; keep the card's hover chrome.
    closeCratePop(true);
    openCratePop(anchorEl, img);
  } catch {
    toast.error("Couldn't create crate");
  }
}

export function openCratePop(anchorEl, img = null) {
  const card = img ? anchorEl.closest(".card") : null;
  const crates = img ? ownCrates() : state.crates;

  const ctx = openDropdown(anchorEl, {
    className: "crate-pop",
    minWidth: 190,
    focus: img ? ".dd-input" : undefined,
    build: (body) => {
      for (const crate of crates) {
        if (img) {
          // Assign mode: checkboxes to add/remove the item from crates.
          const cb = createCheckbox({
            variant: "dark",
            checked: img.crateIds.has(crate.id),
            onChange: () => toggleCrateItemApi(img, crate.id, cb),
          });
          body.appendChild(ddRow({
            label: crate.name,
            leading: cb.el,
            trailing: crateTrailing(crate),
            onClick: () => {
              cb.checked = !cb.checked;
              toggleCrateItemApi(img, crate.id, cb);
            },
          }));
        } else {
          // Filter mode: click a crate to filter the gallery.
          body.appendChild(ddRow({
            labelEl: crateLabelEl(crate),
            active: state.selectedCrateId === crate.id,
            trailing: crateTrailing(crate),
            onClick: () => {
              state.selectedCrateId = state.selectedCrateId === crate.id ? null : crate.id;
              closeCratePop();
              document.dispatchEvent(new Event('app:render'));
            },
          }));
        }
      }
    },
    footer: img ? (foot) => {
      if (crates.length) foot.appendChild(ddSep());
      foot.appendChild(ddInput({
        placeholder: "New crate…",
        onSubmit: (name) => createCrateWithItem(name, img, anchorEl),
      }));
    } : undefined,
    onClose: (reason) => {
      crateState = null;
      if (card) {
        card.classList.remove("pop-open");
        if (reason !== "keep-card" && !card.matches(":hover")) teardownCardHover(card);
      }
    },
  });

  if (!ctx) return; // second click on the same anchor: toggled closed
  if (card) card.classList.add("pop-open");
  crateState = { close: ctx.close, card };
}
