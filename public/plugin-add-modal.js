// The "Add plugin" browse modal: the whole CONNECTION catalog (every non-core
// plugin), each with its label + description + role tag — the image's example
// plugins last, tagged as examples. Available ones show an Add button (writes
// installed:true, refreshes the page underneath); already-installed ones show
// a disabled "Added" — so added plugins stay in the list across reopens, not
// just within one session. The footer's "Install from a URL…" opens a drawer
// that fetches, installs, and loads a community plugin live (GitHub / npm /
// tarball / a path on the server) — unless the operator has turned that off
// (PLUGIN_INSTALL_DISABLE), when the footer says so instead.
//
// With the community index on (PLUGIN_INDEX_URL), two tabs open the dialog:
// Included — all of the above — and Community, the index's listings of plugins
// other people wrote, fetched on the first click (community-index-plan.md,
// Stage 4). A listing installs and updates from the source it pins, after the
// URL box's own warning.
import { toast } from "./toast.js";
import { api } from "./api.js";
import { createModal, busy, claim, paneToggle, createDrawer, drawerHeadParts } from "./modal.js";
import { tagFor, isExample, provenance, INSTALL_LOCKED_TITLE } from "./admin-plugins.js";
import { relTime } from "./utils.js";

export function openAddPluginModal(connections, ctx) {
  const { body, footer, dialog, close } = createModal({
    id: "plugin-add-modal",
    title: "Add a plugin",
    bodyStyle: "display:flex;flex-direction:column;",
  });

  const list = document.createElement("div");
  let shown = "included";

  // Each list's rows are built once, and a switch puts the same nodes back, so
  // a row keeps what happened to it — "Added", or a button still busy
  // installing — rather than being rebuilt from what the dialog opened with.
  //
  // Included: the app's own plugins first, then its examples — added or not,
  // an example keeps its place at the end.
  let included = null;
  function showIncluded() {
    included ??= connections.length
      ? [...connections.filter((c) => !isExample(c)), ...connections.filter(isExample)].map((p) => row(p, addButton(p)))
      : [note("No connections available.")];
    list.replaceChildren(...included);
  }

  // Community: the index, asked once per dialog on the first click — the page
  // never waits on it (D7). A switch back to Included while it loads is left
  // alone when the answer lands.
  let community = null;
  async function showCommunity() {
    list.replaceChildren(note("Loading the community list…"));
    community ??= api("GET", "/api/admin/plugins/community").catch((e) => ({ error: e.message })).then(communityList);
    const rows = await community;
    if (shown === "community") list.replaceChildren(...rows);
  }

  if (ctx.communityIndex) {
    body.appendChild(paneToggle([["included", "Included"], ["community", "Community"]], "included", (pane) => {
      shown = pane;
      if (pane === "included") showIncluded();
      else showCommunity();
    }));
  }
  showIncluded();
  body.appendChild(list);

  // Installing from a URL is the one act here that isn't a row's: it waits in
  // the footer, and its box, what the box takes and why an install failed
  // rise in a drawer over the dialog. Under the operator's lock the footer
  // says so in words — a held button could say it only on hover, and never
  // to a keyboard.
  if (ctx.installLocked) {
    const locked = document.createElement("p");
    locked.className = "sub";
    locked.style.margin = "0";
    locked.textContent = "Installing plugins from a URL, a package or a path is turned off on this server.";
    footer.appendChild(locked);
  } else {
    const fromUrl = document.createElement("button");
    fromUrl.type = "button";
    fromUrl.className = "ghost";
    fromUrl.textContent = "Install from a URL…";
    let drawer = null;
    fromUrl.onclick = () => installDrawer((drawer ??= createDrawer(dialog)), ctx, close, fromUrl);
    footer.appendChild(fromUrl);
  }

  // The index's answer, as the tab shows it: a failure with nothing to show
  // says why; rows gone stale behind a failed refresh say how old they are and
  // why; an index with no entries says so.
  function communityList({ plugins = [], fetchedAt = null, stale = false, error = null }) {
    if (error && !stale && !plugins.length) return [note(`Couldn't read the community list: ${error}`, "p-err")];
    const out = [];
    if (stale) {
      const old = document.createElement("div");
      old.className = "p-err";
      old.style.margin = "0 0 6px";
      old.textContent = `Fetched ${relTime(fetchedAt)}; the refresh failed: ${error}`;
      out.push(old);
    }
    if (!plugins.length) out.push(note("None listed yet. PLUGIN.md, in the app's repository, says how to get listed."));
    for (const p of plugins) out.push(row(p, communityButton(p)));
    return out;
  }

  function row(p, button) {
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
    // A listing's provenance, in the card's own style: who wrote it, the
    // version the index names, and the pinned source it installs from.
    if (p.community) main.appendChild(provenance([`by ${p.community.author}`, p.community.version, p.community.source]));
    r.appendChild(main);

    const tag = document.createElement("span");
    tag.className = "p-tag";
    tag.textContent = tagFor(p, ctx.capabilities);
    r.appendChild(tag);

    r.appendChild(button);
    return r;
  }

  function addButton(p) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    if (p.state.installed) {
      asAdded(addBtn); // already on the page — shown for context, not addable again
      return addBtn;
    }
    addBtn.className = "sm";
    addBtn.textContent = "Add";
    addBtn.onclick = busy(addBtn, async () => {
      try {
        // Two verbs for two kinds of "not added": a built-in's code is loaded
        // and `installed` is a visibility flag, while a bundled example
        // (welcome-plan.md 2b) has never loaded at all — no def for PATCH to
        // find — so it installs from its path, like the URL box. No confirm on
        // that path: that warning is about code from the internet, and this
        // source is the image the server is running from.
        if (p.bundled) await api("POST", "/api/admin/plugins/install", { url: p.bundled.path });
        else await api("PATCH", `/api/admin/plugins/${p.id}`, { installed: true });
        toast(`${p.label} added`);
        asAdded(addBtn);
        ctx.refresh(); // refresh the page underneath so the new card appears
      } catch (err) {
        toast.error(err.message);
      }
    });
    return addBtn;
  }

  // A listing's button, first match wins: an entry this app can't load says
  // so — the loader takes only its own apiVersion, so an install would fail
  // there; a plugin installed from another source than the listing's offers
  // "Update to …", which moves it onto the listed pin with its keys and
  // settings (D6); an installed one reads "Added"; the rest, "Add". Both verbs
  // run code from the listed source, so both ask the URL box's question, and
  // the operator's lock holds them as it holds the box.
  function communityButton(p) {
    const c = p.community;
    const b = document.createElement("button");
    b.type = "button";
    if (c.needsApp) {
      b.className = "ghost sm";
      b.textContent = "Needs a newer app";
      b.disabled = true;
      b.title = `Written for plugin API version ${c.apiVersion}, which this version of the app doesn't run`;
      return b;
    }
    const update = c.updateAvailable;
    if (p.state.installed && !update) {
      asAdded(b);
      return b;
    }
    b.className = "sm";
    b.textContent = update ? `Update to ${c.version}` : "Add";
    if (ctx.installLocked) {
      b.disabled = true;
      b.title = INSTALL_LOCKED_TITLE;
      return b;
    }
    if (update) b.title = `Installed from ${c.installedSource}`;
    b.onclick = busy(b, async () => {
      if (!confirmInstall(update ? `Update ${p.label} to ${c.version}` : `Install ${p.label}`, c.source)) return;
      try {
        if (update) await api("POST", `/api/admin/plugins/${p.id}/update`, { url: c.source });
        else await api("POST", "/api/admin/plugins/install", { url: c.source });
        toast(`${p.label} ${update ? "updated" : "added"}`);
        asAdded(b);
        ctx.refresh(); // the card underneath appears, or moves to the new pin
      } catch (err) {
        toast.error(err.message);
      }
    });
    return b;
  }
}

// "Added", disabled — claimed from busy(), which then leaves the button as is.
function asAdded(b) {
  b.className = "ghost sm";
  claim(b, "Added");
}

// The Add dialog's quiet line, where the list would be: nothing to show,
// loading, or why not.
function note(text, cls = "") {
  const el = document.createElement("div");
  el.className = "pa-empty" + (cls ? ` ${cls}` : "");
  el.textContent = text;
  return el;
}

// The warning before the URL box or a listing installs code from outside the
// image: a listing's Add and "Update to …" ask what the box asks (D12 — a
// listing is a pointer someone reviewed, not a security audit). The card's
// own Update asks its own question (admin-plugins.js).
function confirmInstall(what, source) {
  return confirm(
    `${what} from:\n${source}\n\n` +
    "This downloads and runs code from the internet with the server's full " +
    "access — there is no sandbox. Only install sources you trust.",
  );
}

// The URL box, in the dialog's drawer: paste a GitHub/npm/tarball URL or a
// path → the server downloads, runs `npm install`, validates, and loads it
// live. This RUNS code from the internet as the server (ratified self-hosted
// trust model, no sandbox), so a confirm names that risk before the POST. The
// install is long-running (npm): Install wears the busy state, and an error
// stays in the drawer under the box, the source still in it, rather than as a
// toast that outlives it. Success closes the dialog; the new card is on the
// page underneath.
//
// Nothing stops an install once it has started, and the drawer can still be
// dismissed while one runs. Then the footer's button (`opener`) stays busy
// until it ends, so a second can't start beside it, and the end arrives as a
// toast: a failure says why, and a success leaves the dialog open, since the
// reader has moved on to something in it. A failure after the whole dialog
// closed toasts too.
function installDrawer(drawer, ctx, close, opener) {
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "github:owner/repo · https://github.com/…/tree/main/dir · npm:name · /path/on/server";
  input.autocomplete = "off";
  input.spellcheck = false;
  const err = document.createElement("div");
  err.className = "pa-install-err";
  err.hidden = true;
  let left = false; // the drawer dismissed: this task's end goes to a toast

  const ok = drawer.open({
    head: drawerHeadParts("download", false, "Install from a URL", "").nodes,
    build(host) {
      const hint = document.createElement("div");
      hint.className = "dw-hint";
      hint.textContent = "Install a community plugin from a GitHub repo (or a folder inside one), an npm package, a tarball URL, or a directory path on the server.";
      host.append(hint, input, err);
    },
    // Unarmed until there's a source to install.
    primary: { label: "Install", disabled: true, onClick: () => install() },
    onDismiss: () => { left = true; },
  });
  const install = busy(ok, async () => {
    const url = input.value.trim();
    err.hidden = true;
    if (!confirmInstall("Install a plugin", url)) return;
    input.disabled = true; // busy() can only restore the element it wraps
    const running = api("POST", "/api/admin/plugins/install", { url });
    busy(opener, () => running.catch(() => {}))();
    try {
      const { plugin } = await running;
      toast(`${plugin?.label || "Plugin"} installed`);
      ctx.refresh();
      if (left) return;
      drawer.close();
      close();
    } catch (e) {
      if (left || !ok.isConnected) {
        drawer.close(); // a sheet orphaned with its dialog lets go of its keys
        toast.error(e.message);
        return;
      }
      input.disabled = false;
      input.focus(); // disabled, it lost focus; the fix is usually the source
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  input.addEventListener("input", () => drawer.setPrimaryDisabled(!input.value.trim()));
  // Enter presses Install, so it's held exactly when the button is: no source
  // yet, or an install already running.
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") ok.click(); });
}
