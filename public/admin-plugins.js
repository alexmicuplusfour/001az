// Plugins tab: the integrations catalog as a flat list of INSTALLED cards —
// capabilities (the app's own: media handlers, the embedder) and connections
// (AI providers, data providers) side by side, no segment headers. Each card =
// label + one-line description + a right-aligned role tag; the gear opens the
// plugin's config modal, Remove takes it off the page (disabled for core
// capabilities). "Add plugin" browses what's available. Everything renders from
// GET /api/admin/plugins; this module holds no catalog knowledge of its own.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { openPluginModal, busy } from "/plugin-modal.js";
import { openAddPluginModal } from "/plugin-add-modal.js";
import { renderCapabilities } from "/admin-capabilities.js";
import { servingRoles, roleBadge } from "/capability-present.js";
import { ICONS } from "/utils.js";

// The kind filter above the list: chip labels per card family, in display
// order. "all" is the default; the selection lives at module level so the
// modal's refresh-after-mutation re-renders keep the narrowed view.
const KIND_FILTERS = [["ai", "AI"], ["connector", "Data"], ["media", "Media"], ["source", "Sources"]];
let activeKind = "all";


// The right-aligned tag: category + the role/qualifier that defines the card.
// AI shows the first capability this provider currently serves — read off the
// capabilities feed by the same rule as the badges, so no capability can be
// left out of a hand-list here; a data connector shows its domain; media is
// always core.
export function tagFor(p, caps) {
  // An external plugin that failed to load carries only its manifest — no live
  // p.connector/p.ai descriptor — so guard every deref below with `?.`.
  if (p.state?.loadError) return "Plugin · error";
  if (p.kind === "ai") {
    const role = servingRoles(caps, p.name)[0];
    return role ? `AI · ${role.agent}` : "AI";
  }
  if (p.kind === "connector") return `Data · ${p.connector?.domain ?? "external"}`;
  if (p.kind === "source") return p.core ? "Source · local" : "Source · remote";
  return "Media · core";
}

// The dynamic key state — whether a connection is configured yet. The static
// description says "bring a key"; this says whether you have.
function keyNote(p) {
  if (p.state?.loadError) return null; // errored externals show their reason, not a key note
  if (p.kind === "ai") {
    if (p.ai.onDevice) return null; // in-process — nothing to connect
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
  // the legacy `slots` payload has no reader left (7c).
  return { plugins: data.plugins, keys, connections, capabilities: caps.capabilities };
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
  const { plugins, keys, connections: srcConnections, capabilities } = state;
  const installed = plugins.filter((p) => p.state.installed);

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Plugins</h2><p class="sub">Capabilities and connections in one place. Add the services you use; core capabilities are always on. Configure keys and options via the gear.</p>`;

  // refresh repaints BOTH admin surfaces that project this state — the cards
  // here and the Capabilities tab, which would otherwise go stale the moment a
  // modal opened from THIS tab rebinds something. (Deliberate module cycle with
  // admin-capabilities; both sides only call each other's functions later, so
  // ESM resolves it fine.)
  // `capabilities` rides in ctx from the FIRST render — the modal's sections
  // read it, and before 7c a gear-opened modal only received it after its
  // first mutation's reload merged fresh state (sections were missing on
  // first open from this tab).
  const ctx = {
    plugins, keys, connections: srcConnections, capabilities,
    refresh: refreshPluginSurfaces,
    getState: loadPluginState,
  };

  // The Add modal browses the whole CONNECTION catalog (every non-core plugin),
  // marking installed ones "Added" — so they stay visible across reopens, not
  // just within one session. Core capabilities are never addable.
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
  filters.className = "plugin-filters";
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
  const c = document.createElement("span");
  c.className = "count";
  c.textContent = count;
  b.appendChild(c);
  b.onclick = onClick;
  return b;
}

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

  const remove = document.createElement("button");
  remove.type = "button";
  remove.textContent = "Remove";
  if (p.core) {
    // not a destructive action here — a neutral, disabled control
    remove.className = "ghost sm";
    remove.disabled = true;
    remove.title = "Core capability — always installed";
  } else {
    remove.className = "danger sm";
    remove.onclick = () => removePlugin(p, ctx);
  }
  row.appendChild(remove);

  return row;
}

// An external plugin's provenance: where it came from + the ref actually installed.
function sourceLine(source) {
  const el = document.createElement("div");
  el.className = "p-src";
  el.textContent = source.ref ? `${source.url} · ${source.ref}` : source.url;
  el.title = el.textContent;
  return el;
}

// A failed-to-load external plugin: its reason + Retry (re-run the install from the
// stored URL — installFromUrl retries an errored id in place) + Remove (uninstall).
// No gear/badges/key-note: there's no live descriptor to configure.
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

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost sm";
  retry.textContent = "Retry";
  retry.disabled = !p.source?.url;
  retry.title = p.source?.url ? "Re-download and load from the stored source" : "No source URL on record";
  retry.onclick = busy(retry, "Retrying…", () => retryInstall(p, ctx));
  row.appendChild(retry);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger sm";
  remove.textContent = "Remove";
  remove.onclick = () => removePlugin(p, ctx);
  row.appendChild(remove);

  return row;
}

async function retryInstall(p, ctx) {
  // Retry re-downloads and re-RUNS code from the stored URL — the same risk the
  // install modal confirms. For a moving ref (a branch / the default) that code
  // may have changed since it was first trusted, so name the risk again here.
  // (Button state is `busy`'s job — the shared helper the rest of the admin
  // client uses.)
  if (!confirm(
    `Reinstall ${p.label} from:\n${p.source.url}\n\n` +
    "This re-downloads and runs code from the internet with the server's full " +
    "access — there is no sandbox. Only continue if you trust this source.",
  )) return;
  try {
    await api("POST", "/api/admin/plugins/install", { url: p.source.url });
    toast(`${p.label} reinstalled`);
    ctx.refresh();
  } catch (err) {
    toast.error(err.message);
    ctx.refresh(); // a failed retry persisted a fresh reason — re-render so the card shows it
  }
}

// Remove never blocks (graceful degradation) — it just names the impact first.
// An external plugin is truly uninstalled (DELETE: code off the disk); a built-in
// is only made unavailable (PATCH installed:false), so the copy differs.
async function removePlugin(p, ctx) {
  const impact = removalImpact(p, ctx);
  const msg = p.external
    ? `Uninstall ${p.label}?` +
      (impact ? `\n\n${impact}` : "") +
      `\n\nThis deletes its downloaded code. Existing boards keep their data; re-adding means downloading it again.`
    : `Remove ${p.label}?` +
      (impact ? `\n\n${impact}` : "") +
      `\n\nExisting boards keep their data — it just won't refresh until you add it back.`;
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
    const d = domainCap(ctx, p);
    if ((d?.bound?.provider || d?.running?.provider) === p.name) return `This is the default ${p.connector.domain} provider.`;
  }
  if (p.kind === "source") {
    const n = p.state.connectionCount || 0;
    if (n) return `Its ${n} saved connection${n > 1 ? "s" : ""} become unusable until you add it back.`;
  }
  return "";
}
