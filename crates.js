import { state } from './state.js';
import { ICONS, onOutsideClick, positionPop } from './utils.js';
import { toast } from './toast.js';
import { teardownCardHover } from './grid.js';

let cratePopState = null;

export function closeCratePop(skipTeardown = false) {
  if (!cratePopState) return;
  const { card } = cratePopState;
  cratePopState.pop.remove();
  document.removeEventListener("click", cratePopState.outside, true);
  cratePopState = null;
  if (card) {
    card.classList.remove("crate-open");
    if (!skipTeardown && !card.matches(":hover")) teardownCardHover(card);
  }
}

async function doDeleteCrate(crate, onClose) {
  try {
    const r = await fetch(`/api/crates/${crate.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    state.crates = state.crates.filter((c) => c.id !== crate.id);
    for (const im of state.images) im.crateIds.delete(crate.id);
    if (state.selectedCrateId === crate.id) state.selectedCrateId = null;
    onClose();
    document.dispatchEvent(new Event('app:render'));
  } catch {
    toast.error("Couldn't delete crate");
  }
}

async function toggleCrateImageApi(img, crateId, checkbox) {
  const prev = checkbox.checked;
  try {
    const r = await fetch(`/api/crates/${crateId}/items/${img.id}`, { method: "POST" });
    if (!r.ok) throw new Error();
    const { added, count } = await r.json();
    checkbox.checked = added;
    if (added) img.crateIds.add(crateId);
    else img.crateIds.delete(crateId);
    const crate = state.crates.find((c) => c.id === crateId);
    if (crate) crate.image_count = count;
    if (state.selectedCrateId === crateId && !added) {
      // The image just left the filtered crate: its card is about to be
      // re-rendered away, so a card-anchored pop would be left orphaned.
      if (cratePopState && cratePopState.card) closeCratePop(true);
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

export function openCratePop(anchorEl, img = null) {
  if (cratePopState && cratePopState.anchor === anchorEl) { closeCratePop(); return; }
  closeCratePop();

  const pop = document.createElement("div");
  pop.className = "float-menu crate-pop";

  if (img) {
    // Assign mode: checkboxes to add/remove image from crates.
    if (state.crates.length) {
      for (const crate of state.crates) {
        const row = document.createElement("div");
        row.className = "cp-row";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = img.crateIds.has(crate.id);

        const nameEl = document.createElement("span");
        nameEl.className = "cp-name";
        nameEl.textContent = crate.name;

        const del = document.createElement("button");
        del.className = "cd-del";
        del.title = "Delete crate";
        del.innerHTML = ICONS.trash;
        del.addEventListener("click", async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete crate "${crate.name}"?`)) return;
          await doDeleteCrate(crate, closeCratePop);
        });

        row.append(cb, nameEl, del);
        cb.addEventListener("change", () => toggleCrateImageApi(img, crate.id, cb));
        row.addEventListener("click", (e) => {
          if (e.target === cb || e.target === del) return;
          cb.checked = !cb.checked;
          toggleCrateImageApi(img, crate.id, cb);
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
        const r2 = await fetch(`/api/crates/${crate.id}/items/${img.id}`, { method: "POST" });
        if (r2.ok) {
          const { added, count } = await r2.json();
          if (added) img.crateIds.add(crate.id);
          const found = state.crates.find((c) => c.id === crate.id);
          if (found) found.image_count = count;
        }
        // Rebuild pop without going through closeCratePop — card DOM must stay intact
        if (cratePopState) {
          cratePopState.pop.remove();
          document.removeEventListener("click", cratePopState.outside, true);
          cratePopState = null;
        }
        openCratePop(anchorEl, img);
      } catch {
        toast.error("Couldn't create crate");
      }
    });
    pop.appendChild(inp);
  } else {
    // Filter mode: click a crate to filter the gallery.
    for (const crate of state.crates) {
      const row = document.createElement("div");
      row.className = "cp-row" + (state.selectedCrateId === crate.id ? " active" : "");

      const name = document.createElement("span");
      name.className = "cp-name";
      name.textContent = crate.name;

      const del = document.createElement("button");
      del.className = "cd-del";
      del.title = "Delete crate";
      del.innerHTML = ICONS.trash;
      del.addEventListener("click", async (e) => {
        e.stopPropagation();
        await doDeleteCrate(crate, closeCratePop);
      });

      row.append(name, del);
      row.addEventListener("click", (e) => {
        if (del.contains(e.target)) return;
        state.selectedCrateId = state.selectedCrateId === crate.id ? null : crate.id;
        closeCratePop();
        document.dispatchEvent(new Event('app:render'));
      });
      pop.appendChild(row);
    }
  }

  document.body.appendChild(pop);
  positionPop(pop, anchorEl);
  if (img) requestAnimationFrame(() => pop.querySelector(".cp-input")?.focus());

  const card = img ? anchorEl.closest(".card") : null;
  if (card) card.classList.add("crate-open");
  const outside = onOutsideClick(pop, anchorEl, closeCratePop);
  cratePopState = { pop, outside, anchor: anchorEl, card };
}
