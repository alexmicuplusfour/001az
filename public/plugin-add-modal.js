// The "Add plugin" browse modal: the whole CONNECTION catalog (every non-core
// plugin), each with its label + description + role tag. Available ones show an
// Add button (writes installed:true, refreshes the page underneath); already-
// installed ones show a disabled "Added" — so added plugins stay in the list
// across reopens, not just within one session. Above the list, an "Install from
// URL" field fetches, installs, and loads a community plugin live (GitHub / npm /
// tarball); the browse list below is the catalog that ships with the app.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { createModal, busy } from "/modal.js";
import { tagFor } from "/admin-plugins.js";

export function openAddPluginModal(connections, ctx) {
  const { body, close } = createModal({
    title: "Add a plugin",
    bodyStyle: "display:flex;flex-direction:column;",
  });

  body.appendChild(installFromUrlZone(ctx, close));

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
    tag.textContent = tagFor(p, ctx.capabilities);
    r.appendChild(tag);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    const asAdded = () => { addBtn.textContent = "Added"; addBtn.className = "ghost sm"; addBtn.disabled = true; };
    if (p.state.installed) {
      asAdded(); // already on the page — shown for context, not addable again
    } else {
      addBtn.className = "sm";
      addBtn.textContent = "Add";
      addBtn.onclick = busy(addBtn, async () => {
        try {
          await api("PATCH", `/api/admin/plugins/${p.id}`, { installed: true });
          toast(`${p.label} added`);
          asAdded(); // claims the button (busy leaves it "Added", disabled)
          ctx.refresh(); // refresh the page underneath so the new card appears
        } catch (err) {
          toast.error(err.message);
        }
      });
    }
    r.appendChild(addBtn);
    return r;
  }
}

// Paste a GitHub/npm/tarball URL → the server downloads, runs `npm install`,
// validates, and loads it live. This RUNS code from the internet as the server
// (ratified self-hosted trust model, no sandbox), so a confirm names that risk
// before the POST. The install is long-running (npm); the button shows a pending
// state and errors surface inline rather than as a toast that outlives the modal.
function installFromUrlZone(ctx, close) {
  const zone = document.createElement("div");
  zone.className = "pa-install";

  const label = document.createElement("p");
  label.className = "sub";
  label.textContent = "Install a community plugin from a GitHub repo (or a folder inside one), an npm package, a tarball URL, or a directory path on the server.";
  zone.appendChild(label);

  const row = document.createElement("div");
  row.className = "pa-install-row";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "github:owner/repo · https://github.com/…/tree/main/dir · npm:name · /path/on/server";
  input.autocomplete = "off";
  input.spellcheck = false;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "sm";
  btn.textContent = "Install";
  row.append(input, btn);
  zone.appendChild(row);

  const err = document.createElement("div");
  err.className = "pa-install-err";
  err.hidden = true;
  zone.appendChild(err);

  async function install() {
    const url = input.value.trim();
    err.hidden = true;
    if (!url) { input.focus(); return; }
    if (!confirm(
      `Install a plugin from:\n${url}\n\n` +
      "This downloads and runs code from the internet with the server's full " +
      "access — there is no sandbox. Only install sources you trust.",
    )) return;
    input.disabled = true; // busy() can only restore the element it wraps
    try {
      const { plugin } = await api("POST", "/api/admin/plugins/install", { url });
      toast(`${plugin?.label || "Plugin"} installed`);
      ctx.refresh();  // the new card appears on the page underneath
      close();
    } catch (e) {
      input.disabled = false;
      err.textContent = e.message;
      err.hidden = false;
    }
  }

  const run = busy(btn, install);
  btn.onclick = run;
  input.onkeydown = (e) => { if (e.key === "Enter") run(); };
  return zone;
}
