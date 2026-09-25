// Plugins tab: the integrations catalog as a flat list of INSTALLED cards —
// built-ins (the app's own: media handlers, the embedder) and connections
// (AI providers, data providers) side by side, no segment headers. Each card =
// label + one-line description + a right-aligned role tag; the gear opens the
// plugin's config modal, Remove takes it off the page (disabled for
// built-ins), and a plugin installed from a source gets Update. "Add plugin"
// browses what's available. Everything renders from
// GET /api/admin/plugins; this module holds no catalog knowledge of its own.
import { toast } from "./toast.js";
import { api } from "./api.js";
import { openPluginModal } from "./plugin-modal.js";
import { busy } from "./modal.js";
import { openAddPluginModal } from "./plugin-add-modal.js";
import { renderCapabilities } from "./admin-capabilities.js";
import { servingRoles, roleBadge } from "./capability-present.js";
import { ICONS, appendCount } from "./utils.js";

// The kind filter above the list: chip labels per card family, in display
// order. "all" is the default; the selection lives at module level so the
// modal's refresh-after-mutation re-renders keep the narrowed view.
const KIND_FILTERS = [["ai", "AI"], ["connector", "Data"], ["media", "Media"], ["source", "Sources"]];
let activeKind = "all";


// The word every tag leads with: the card's family.
const FAMILY = { ai: "AI", connector: "Data", source: "Source", media: "Media" };

// One of the image's own example plugins (examples/plugins/*): a bundled row
// nobody has added yet, or a plugin added from one (its `source.bundled`).
// Added or not, it is the same example — it keeps its tag and, in the Add
// modal, its place at the end (planning/plugin-contract-plan.md, Stage 4).
export const isExample = (p) => !!(p.bundled || p.source?.bundled);

// The right-aligned tag: category + the role/qualifier that defines the card.
// AI shows the first capability this provider currently serves — read off the
// capabilities feed by the same rule as the badges, so no capability can be
// left out of a hand-list here; a data connector shows its domain; media is
// always core. An example says that instead, so it never reads as one of the
// app's own integrations; its AI card's badges still name what it serves.
export function tagFor(p, caps) {
  // Three kinds of row carry only a MANIFEST, with no live p.connector/p.ai
  // descriptor behind it: an external plugin that failed to load, a bundled
  // example nobody has installed (welcome-plan.md Stage 2b), and a community
  // listing, whose domain rides its `community` block. Guard every descriptor
  // deref here and in keyNote below — both run over the same list.
  if (p.state?.loadError) return "Plugin · error";
  const family = FAMILY[p.kind];
  if (isExample(p)) return `${family} · example`;
  if (p.kind === "ai") {
    const role = servingRoles(caps, p.name)[0];
    return role ? `${family} · ${role.agent}` : family;
  }
  if (p.kind === "connector") return `${family} · ${p.connector?.domain ?? p.community?.domain ?? "external"}`;
  if (p.kind === "source") return `${family} · ${p.core ? "local" : "remote"}`;
  return `${family} · core`;
}

// The dynamic key state — whether a connection is configured yet. The static
// description says "bring a key"; this says whether you have.
function keyNote(p) {
  if (p.state?.loadError) return null; // errored externals show their reason, not a key note
  if (p.kind === "ai") {
    if (!p.ai || p.ai.onDevice) return null; // no descriptor loaded (see tagFor), or in-process
    const n = p.state.keyCount;
    const noun = p.ai.keyless ? "connection" : "key"; // keyless-networked rows are connections without a secret
    return n ? { text: `${n} ${noun}${n > 1 ? "s" : ""}` } : { text: `no ${noun} yet`, warn: true };
  }
  if (p.kind === "connector") {
    if (p.state.hasKey) return { text: "key stored" };
    return p.connector.needsKey ? { text: "no key yet", warn: true } : { text: "keyless" };
  }
  if (p.kind === "source") {
    if (!p.capabilities.needsConnection) return null; // folder: nothing to connect
    const n = p.state.connectionCount || 0;
    return n ? { text: `${n} connection${n > 1 ? "s" : ""}` } : { text: "no connections yet", warn: true };
  }
  return null;
}

// The one fetch that backs both the cards and the config modal: plugins + keys
// + source connections, with the resolved slot defaults. The modal re-runs this
// after every mutation so it can rebuild itself against fresh state without
// closing.
export async function loadPluginState() {
  const [data, keys, connections, caps] = await Promise.all([
    api("GET", "/api/admin/plugins"),
    api("GET", "/api/admin/ai-keys"),
    api("GET", "/api/admin/source-connections"),
    api("GET", "/api/admin/capabilities"),
  ]);
  // `capabilities` is the one status source: the modal's sections, the
  // Capabilities tab, and the cards' badges/tags/star states all read it —
  // the legacy `slots` payload has no reader left (7c). `communityIndex` is
  // whether the Add dialog draws its Community tab.
  return {
    plugins: data.plugins, installLocked: !!data.installLocked, communityIndex: !!data.communityIndex,
    keys, connections, capabilities: caps.capabilities,
  };
}

// One refresh for the two surfaces that project plugin state, threading the
// state so neither refetches what the caller just loaded. Actions that changed
// state without fetching call it bare — both renders then load for themselves.
export const refreshPluginSurfaces = (state) => { renderPlugins(state); renderCapabilities(state?.capabilities); };

// The admin shell's entry for both surfaces: one gate, ONE state fetch — the
// capabilities feed is the page's most expensive GET and used to be fetched
// twice per load, once by each tab's render.
export async function renderPluginSurfaces() {
  const me = await fetch("/api/me").then((r) => r.json()).catch(() => null);
  if (!me || !me.is_admin) return;
  let state;
  try { state = await loadPluginState(); } catch { return; }
  refreshPluginSurfaces(state);
}

export async function renderPlugins(prefetched) {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  // Callers (the modal's in-place reload) can hand us the state they just
  // fetched so we don't hit the network twice for the same render.
  let state = prefetched;
  if (!state) { try { state = await loadPluginState(); } catch { return; } }
  const { plugins } = state;
  const installed = plugins.filter((p) => p.state.installed);

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Plugins</h2><p class="sub">Built-ins and connections in one place. Add the services you use; the built-ins are always on. Configure keys and options via the gear.</p>`;

  // ctx is the whole state, from the FIRST render — the modal's sections read
  // it — plus refresh, which repaints BOTH admin surfaces that project this
  // state: the cards here and the Capabilities tab, which would otherwise go
  // stale the moment a modal opened from THIS tab rebinds something.
  // (Deliberate module cycle with admin-capabilities; both sides only call
  // each other's functions later, so ESM resolves it fine.)
  const ctx = { ...state, refresh: refreshPluginSurfaces, getState: loadPluginState };

  // The Add modal browses the whole CONNECTION catalog (every non-core plugin),
  // marking installed ones "Added" — so they stay visible across reopens, not
  // just within one session. The always-on built-ins are never addable.
  const connections = plugins.filter((p) => !p.core);
  const add = document.createElement("div");
  add.className = "plugin-add";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.innerHTML = ICONS.plus + "<span>Add plugin</span>";
  // Always openable — the modal browses the whole connection catalog (added ones
  // shown as "Added"), so it stays useful even when nothing new is available.
  addBtn.onclick = () => openAddPluginModal(connections, ctx);
  add.appendChild(addBtn);
  sec.appendChild(add);

  // Removing the last card of the selected kind (via ctx.refresh) would leave
  // an empty list behind a chip that no longer renders — fall back to All.
  const kindCount = (k) => installed.filter((p) => p.kind === k).length;
  if (activeKind !== "all" && kindCount(activeKind) === 0) activeKind = "all";

  const filters = document.createElement("div");
  filters.className = "pill-row";
  const setKind = (k) => { activeKind = k; renderPlugins(state); };
  filters.appendChild(filterPill("All", installed.length, activeKind === "all", () => setKind("all")));
  for (const [kind, label] of KIND_FILTERS) {
    const n = kindCount(kind);
    if (n) filters.appendChild(filterPill(label, n, activeKind === kind, () => setKind(kind)));
  }
  sec.appendChild(filters);

  const visible = activeKind === "all" ? installed : installed.filter((p) => p.kind === activeKind);
  const list = document.createElement("div");
  list.className = "plugin-list";
  for (const p of visible) list.appendChild(pluginRow(p, ctx));
  sec.appendChild(list);

  document.getElementById("plugins-content").replaceChildren(sec);
}

// A gallery-style filter chip: label + dim count, dark when active. Clicking
// a chip selects it outright (single-select — "All" is how you widen back).
function filterPill(label, count, active, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pill" + (active ? " active" : "");
  b.textContent = label;
  appendCount(b, count);
  b.onclick = onClick;
  return b;
}

// What a button the operator's lock (PLUGIN_INSTALL_DISABLE) holds says — the
// card's Update and Retry, and the Add dialog's listing buttons and its
// Install from a URL.
export const INSTALL_LOCKED_TITLE = "Installing plugins is turned off on this server";

// A connector card's domain entry off the capabilities feed — `bound` is the
// stored star, `running` what actually resolves (the old slots.domains'
// setting/effective, same words the feed uses everywhere else).
const domainCap = (ctx, p) =>
  (ctx.capabilities || []).find((c) => c.kind === "domain" && c.id === p.connector.domain);

function badge(text, cls = "") {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? ` ${cls}` : "");
  b.textContent = text;
  return b;
}

// A slot-default badge that is also a door: it names which capability this
// card holds, so it links to that capability's card on the Capabilities tab
// (admin.js switches tabs on hashchange; admin-capabilities flashes the card).
function badgeLink(text, capId, cls = "") {
  const a = document.createElement("a");
  a.className = "badge" + (cls ? ` ${cls}` : "");
  a.href = "#capabilities/" + capId;
  a.textContent = text;
  return a;
}

function pluginRow(p, ctx) {
  // An external plugin whose code failed to load never reached the live maps, so
  // it has no descriptor to render badges/keys/config from — its own errored card.
  if (p.external && p.state.loadError) return erroredRow(p, ctx);

  const row = document.createElement("div");
  row.className = "plugin-row";

  const main = document.createElement("div");
  main.className = "p-main";
  const head = document.createElement("div");
  head.className = "p-head";
  const label = document.createElement("div");
  label.className = "p-label";
  label.textContent = p.label;
  head.appendChild(label);

  // slot default badges — inline with the title, since they name what the row
  // IS; each links to its capability's card on the Capabilities tab. One rule
  // over the feed (servingRoles) instead of four hand-written checks — a new
  // capability badges itself, and none can be forgotten the way the
  // transcriber was in removalImpact.
  if (p.kind === "ai") {
    for (const c of servingRoles(ctx.capabilities, p.name)) {
      const b = roleBadge(c);
      head.appendChild(badgeLink(b.text, b.capId));
    }
  }
  if (p.kind === "connector") {
    const d = domainCap(ctx, p);
    // Badge whichever card actually resolves as the domain default (running),
    // not the stored star — so removing the starred provider still shows the
    // active fallback as default. Note when the star points elsewhere (e.g. it
    // was removed): the star setting is preserved so re-adding restores it.
    if (d?.running?.provider === p.name) {
      head.appendChild(badgeLink("default", p.connector.domain));
      if (d.bound?.provider && d.bound.provider !== d.running.provider)
        head.appendChild(badgeLink(`was ${d.bound.provider}`, p.connector.domain, "warn"));
    }
  }

  const desc = document.createElement("div");
  desc.className = "p-desc";
  desc.textContent = p.description || "";
  main.append(head, desc);
  if (p.external && p.source) main.appendChild(sourceLine(p.source));

  // meta line under the description: connection state + category, both badges
  const meta = document.createElement("div");
  meta.className = "p-meta";
  const note = keyNote(p);
  if (note) {
    const el = document.createElement("span");
    el.className = "p-note" + (note.warn ? " warn" : "");
    el.innerHTML = ICONS.key; // stroke=currentColor → matches the badge text color
    const txt = document.createElement("span");
    txt.textContent = note.text;
    el.appendChild(txt);
    meta.appendChild(el);
  }

  const tag = document.createElement("span");
  tag.className = "p-tag";
  tag.textContent = tagFor(p, ctx.capabilities);
  meta.appendChild(tag);
  main.appendChild(meta);
  row.appendChild(main);

  const gear = document.createElement("button");
  gear.className = "gear";
  gear.title = `Configure ${p.label}`;
  gear.innerHTML = ICONS.gear;
  gear.onclick = () => openPluginModal(p, ctx);
  row.appendChild(gear);

  // A plugin installed from a source can fetch it again; a built-in updates
  // with the app.
  if (p.external) row.appendChild(updateButton(p, ctx));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  if (p.core) {
    // not a destructive action here — a neutral, disabled control
    remove.className = "ghost sm";
    remove.disabled = true;
    remove.title = "Built-in — always installed";
  } else {
    remove.className = "danger sm";
    remove.onclick = () => removePlugin(p, ctx);
  }
  row.appendChild(remove);

  return row;
}

// An external plugin's provenance: where it came from, the version its author
// named (when the manifest names one) and the ref actually installed — each
// once. A pinned source already ends with its ref (`…@<sha>` · `<sha>`), and an
// npm one with its version, which the manifest usually repeats.
function sourceLine(source) {
  const parts = [source.url];
  for (const part of [source.version, source.ref])
    if (part && !parts.includes(part) && !source.url.endsWith(`@${part}`)) parts.push(part);
  return provenance(parts);
}

// A provenance line: the parts, dot-separated, the whole of it on hover for
// when it's cut short. The card's source line, and a Community listing's
// author, version and source in the Add dialog.
export function provenance(parts) {
  const el = document.createElement("div");
  el.className = "p-src";
  el.textContent = parts.join(" · ");
  el.title = el.textContent;
  return el;
}

// A failed-to-load external plugin: its reason + Retry (the Update verb, from the
// stored source) + Remove (uninstall). No gear/badges/key-note: there's no live
// descriptor to configure.
function erroredRow(p, ctx) {
  const row = document.createElement("div");
  row.className = "plugin-row errored";

  const main = document.createElement("div");
  main.className = "p-main";
  const label = document.createElement("div");
  label.className = "p-label";
  label.textContent = p.label;
  const err = document.createElement("div");
  err.className = "p-err";
  err.textContent = `Failed to load: ${p.state.loadError?.message || "unknown error"}`;
  main.append(label);
  if (p.source) main.appendChild(sourceLine(p.source));
  main.appendChild(err);

  // same meta placement as a healthy row — just the category, no key note
  const meta = document.createElement("div");
  meta.className = "p-meta";
  const tag = document.createElement("span");
  tag.className = "p-tag";
  tag.textContent = tagFor(p, ctx.capabilities);
  meta.appendChild(tag);
  main.appendChild(meta);
  row.appendChild(main);

  row.appendChild(updateButton(p, ctx));

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger sm";
  remove.textContent = "Remove";
  remove.onclick = () => removePlugin(p, ctx);
  row.appendChild(remove);

  return row;
}

// Update and Retry: one verb (POST …/update), two labels — Retry is its name on
// a card whose code failed to load. The operator's lock (PLUGIN_INSTALL_DISABLE)
// leaves only the bundled examples updatable; the button then stays, disabled,
// saying why. (Button state while it runs is `busy`'s job — the shared helper
// the rest of the admin client uses.)
function updateButton(p, ctx) {
  const retry = !!p.state.loadError;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "ghost sm";
  b.textContent = retry ? "Retry" : "Update";
  const locked = ctx.installLocked && !p.source.bundled;
  b.disabled = locked;
  b.title = locked ? INSTALL_LOCKED_TITLE : "Fetch it again from its source, keeping its keys and settings";
  b.onclick = busy(b, () => updateFromSource(p, ctx, retry));
  return b;
}

// Fetch an external plugin again from its stored source and swap the new
// version in; its keys, settings, bindings and pins all stay. That re-RUNS code
// — at a moving ref (a branch, the default) possibly different code from what
// was first trusted — so it confirms like an install. Except a bundled source:
// the image's own examples, which the Add modal installs without asking either.
async function updateFromSource(p, ctx, retry) {
  if (!p.source.bundled && !confirm(
    `${retry ? "Reinstall" : "Update"} ${p.label} from:\n${p.source.url}\n\n` +
    "This fetches its code again and runs it with the server's full access — " +
    "there is no sandbox, and the code there may have changed since you added it. " +
    "Only continue if you trust this source.",
  )) return;
  try {
    await api("POST", `/api/admin/plugins/${p.id}/update`);
    toast(`${p.label} ${retry ? "reinstalled" : "updated"}`);
    ctx.refresh();
  } catch (err) {
    toast.error(err.message);
    ctx.refresh(); // a failed Retry stored a fresh reason — re-render so the card shows it
  }
}

// Remove never blocks (graceful degradation) — it just names the impact first.
// An external plugin is truly uninstalled (DELETE: code off the disk); a built-in
// is only made unavailable (PATCH installed:false), so the copy differs.
async function removePlugin(p, ctx) {
  const impact = removalImpact(p, ctx);
  const msg = [
    `${p.external ? "Uninstall" : "Remove"} ${p.label}?`,
    impact,
    p.external ? `This deletes ${uninstallDeletes(p)}. Existing boards keep their data.`
      : "Existing boards keep their data — it just won't refresh until you add it back.",
  ].filter(Boolean).join("\n\n");
  if (!confirm(msg)) return;
  try {
    if (p.external) await api("DELETE", `/api/admin/plugins/${p.id}`);
    else await api("PATCH", `/api/admin/plugins/${p.id}`, { installed: false });
    toast(`${p.label} ${p.external ? "uninstalled" : "removed"}`);
    ctx.refresh();
  } catch (err) {
    toast.error(err.message);
  }
}

// What an uninstall deletes, in the order the server deletes it
// (plugin-loader.js cleanupPluginConfig): every kind's saved connections or
// key go with its code, and the confirm says so (plugin-contract-plan.md,
// Stage 5). An errored card's counts never loaded, so it names the kinds of
// thing instead.
function uninstallDeletes(p) {
  if (p.state.loadError) return "its downloaded code and anything saved for it — connections, keys, settings";
  const n = p.kind === "ai" ? p.state.keyCount : p.kind === "source" ? p.state.connectionCount : 0;
  if (n) return `its ${n} saved connection${n === 1 ? "" : "s"} and its downloaded code`;
  if (p.kind === "connector" && p.state.hasKey) return "its stored API key and its downloaded code";
  return "its downloaded code";
}

function removalImpact(p, ctx) {
  if (p.state?.loadError) return ""; // errored: never registered, so nothing depends on it
  if (p.kind === "ai") {
    // From the feed, by the same rule as the badges — the hand-list this
    // replaces silently omitted the transcriber, so removing the default
    // transcription provider warned about nothing.
    const roles = servingRoles(ctx.capabilities, p.name).map((c) => `the default ${c.agent}`);
    if (roles.length) return `This is ${roles.join(" and ")}.`;
  }
  if (p.kind === "connector") {
    // A domain plugin's Remove takes its domain: every board on it stops
    // refreshing, and every other plugin providing it stops working. That, not
    // being its default — which its own provider nearly always is — is what
    // the admin is deciding (plugin-contract-plan.md, Stage 5 second pass).
    if (p.connector.addsDomain) {
      const domain = p.connector.domain;
      const others = ctx.plugins
        .filter((o) => o.kind === "connector" && o.state.installed && o.id !== p.id && o.connector?.domain === domain)
        .map((o) => o.label);
      const one = others.length === 1;
      return `It adds the ${domain} domain, which goes with it: boards on ${domain} stop refreshing` +
        (others.length ? `, and ${others.join(" and ")}, which provide${one ? "s" : ""} ${domain}, stop${one ? "s" : ""} working.` : ".");
    }
    const d = domainCap(ctx, p);
    if ((d?.bound?.provider || d?.running?.provider) === p.name) return `This is the default ${p.connector.domain} provider.`;
  }
  // A built-in source is only switched off, so its connections wait for it; an
  // external one's are deleted with it, which the uninstall sentence says.
  if (p.kind === "source" && !p.external) {
    const n = p.state.connectionCount || 0;
    if (n) return `Its ${n} saved connection${n > 1 ? "s" : ""} become unusable until you add it back.`;
  }
  return "";
}
