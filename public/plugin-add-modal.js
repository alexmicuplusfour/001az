// The "Add plugin" browse modal: the available (not-installed) plugins from the
// same catalog, each with its label + description + role tag and an Add button.
// Adding writes installed:true and refreshes the page underneath. The catalog
// entry IS the future dropped-in-module manifest — a later phase grows an "add
// from GitHub / npm URL" path here; today it browses what ships.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal } from "/modal.js";
import { tagFor } from "/admin-plugins.js";

export function openAddPluginModal(available, ctx) {
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

  // Local copy so an Add can drop the row without a full reopen.
  let items = [...available];

  function render() {
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "pa-empty";
      empty.textContent = "Everything available is already installed.";
      list.appendChild(empty);
      return;
    }
    for (const p of items) list.appendChild(row(p));
  }

  function row(p) {
    const r = document.createElement("div");
    r.className = "pa-row";

    const main = document.createElement("div");
    main.className = "pa-main";
    const label = document.createElement("div");
    label.className = "pa-label";
    label.textContent = p.label;
    const desc = document.createElement("div");
    desc.className = "pa-desc";
    desc.textContent = p.description || "";
    main.append(label, desc);
    r.appendChild(main);

    const tag = document.createElement("span");
    tag.className = "pa-tag";
    tag.textContent = tagFor(p, ctx.defaults);
    r.appendChild(tag);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "pa-add";
    addBtn.textContent = "Add";
    addBtn.onclick = async () => {
      addBtn.disabled = true;
      try {
        await api("PATCH", `/api/admin/plugins/${p.id}`, { installed: true });
        toast(`${p.label} added`);
        items = items.filter((x) => x.id !== p.id);
        render();
        ctx.refresh(); // refresh the page underneath so the new card appears
      } catch (err) {
        addBtn.disabled = false;
        toast.error(err.message);
      }
    };
    r.appendChild(addBtn);
    return r;
  }

  render();
}
