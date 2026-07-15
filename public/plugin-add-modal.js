// The "Add plugin" browse modal: the whole CONNECTION catalog (every non-core
// plugin), each with its label + description + role tag. Available ones show an
// Add button (writes installed:true, refreshes the page underneath); already-
// installed ones show a disabled "Added" — so added plugins stay in the list
// across reopens, not just within one session. The catalog entry IS the future
// dropped-in-module manifest — a later phase grows an "add from GitHub / npm
// URL" path here; today it browses what ships.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal } from "/modal.js";
import { tagFor } from "/admin-plugins.js";

export function openAddPluginModal(connections, ctx) {
  const { body, close } = createModal({
    title: "Add a plugin",
    bodyStyle: "display:flex;flex-direction:column;",
  });

  const intro = document.createElement("p");
  intro.className = "sub";
  intro.style.margin = "0 0 6px";
  intro.textContent = "Connections you can add. Adding one puts it on the Plugins page; configure its key via the gear.";
  body.appendChild(intro);

  const list = document.createElement("div");
  body.appendChild(list);

  if (!connections.length) {
    const empty = document.createElement("div");
    empty.className = "pa-empty";
    empty.textContent = "No connections available.";
    list.appendChild(empty);
  } else {
    for (const p of connections) list.appendChild(row(p));
  }

  function row(p) {
    const r = document.createElement("div");
    r.className = "pa-row";

    const main = document.createElement("div");
    main.className = "p-main";
    const label = document.createElement("div");
    label.className = "p-label";
    label.textContent = p.label;
    const desc = document.createElement("div");
    desc.className = "p-desc";
    desc.textContent = p.description || "";
    main.append(label, desc);
    r.appendChild(main);

    const tag = document.createElement("span");
    tag.className = "p-tag";
    tag.textContent = tagFor(p, ctx.defaults);
    r.appendChild(tag);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    const asAdded = () => { addBtn.textContent = "Added"; addBtn.className = "ghost sm"; addBtn.disabled = true; };
    if (p.state.installed) {
      asAdded(); // already on the page — shown for context, not addable again
    } else {
      addBtn.className = "sm";
      addBtn.textContent = "Add";
      addBtn.onclick = async () => {
        addBtn.disabled = true;
        addBtn.textContent = "Adding…";
        try {
          await api("PATCH", `/api/admin/plugins/${p.id}`, { installed: true });
          toast(`${p.label} added`);
          asAdded(); // keep the row; flip the button in place (no list reshuffle)
          ctx.refresh(); // refresh the page underneath so the new card appears
        } catch (err) {
          addBtn.disabled = false;
          addBtn.className = "sm";
          addBtn.textContent = "Add";
          toast.error(err.message);
        }
      };
    }
    r.appendChild(addBtn);
    return r;
  }
}
