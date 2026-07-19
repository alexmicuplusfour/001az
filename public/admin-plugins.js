// Plugins tab: the integrations catalog as a flat list of INSTALLED cards —
// capabilities (the app's own: media handlers, the embedder) and connections
// (AI providers, data providers) side by side, no segment headers. Each card =
// label + one-line description + a right-aligned role tag; the gear opens the
// plugin's config modal, Remove takes it off the page (disabled for core
// capabilities). "Add plugin" browses what's available. Everything renders from
// GET /api/admin/plugins; this module holds no catalog knowledge of its own.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { openPluginModal } from "/plugin-modal.js";
import { openAddPluginModal } from "/plugin-add-modal.js";

const GEAR_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const KEY_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`;

// Which provider currently backs the tagger / embedder slots (for badges + tag).
// The tagger falls back to the anthropic env var when no default key is set.
export function slotProviders(slots, keys) {
  const keyProvider = (id) => keys.find((k) => k.id === id)?.provider || null;
  const tagger = slots.tagger.keyId
    ? keyProvider(slots.tagger.keyId)
    : slots.tagger.envKey ? "anthropic" : null;
  const embedder = !slots.embedder.enabled ? null
    : slots.embedder.provider === "local" ? "local"
    : keyProvider(slots.embedder.keyId);
  // Transcription always resolves (the whisper sidecar by default); the server
  // hands us the provider actually in effect.
  const transcriber = slots.transcriber?.active || "whisper";
  return { tagger, embedder, transcriber };
}

// The right-aligned tag: category + the role/qualifier that defines the card.
// AI shows the slot it's currently the default for (tagger/embedder), else bare
// "AI"; a data connector shows its domain; media is always core.
export function tagFor(p, defaults) {
  // An external plugin that failed to load carries only its manifest — no live
  // p.connector/p.ai descriptor — so guard every deref below with `?.`.
  if (p.state?.loadError) return "Plugin · error";
  if (p.kind === "ai") {
    if (defaults.tagger === p.name) return "AI · tagger";
    if (defaults.embedder === p.name) return "AI · embedder";
    if (defaults.transcriber === p.name) return "AI · transcriber";
    return "AI";
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
    if (p.ai.keyless) return null;
    const n = p.state.keyCount;
    return n ? { text: `${n} key${n > 1 ? "s" : ""}` } : { text: "no key yet", warn: true };
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

export async function renderPlugins() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  let data, keys, srcConnections;
  try {
    [data, keys, srcConnections] = await Promise.all([
      api("GET", "/api/admin/plugins"),
      api("GET", "/api/admin/ai-keys"),
      api("GET", "/api/admin/source-connections"),
    ]);
  } catch { return; }
  const { plugins, slots } = data;
  const defaults = slotProviders(slots, keys);
  const installed = plugins.filter((p) => p.state.installed);

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Plugins</h2><p class="sub">Capabilities and connections in one place. Add the services you use; core capabilities are always on. Configure keys and options via the gear.</p>`;

  const ctx = { slots, keys, connections: srcConnections, defaults, refresh: renderPlugins };

  // The Add modal browses the whole CONNECTION catalog (every non-core plugin),
  // marking installed ones "Added" — so they stay visible across reopens, not
  // just within one session. Core capabilities are never addable.
  const connections = plugins.filter((p) => !p.core);
  const add = document.createElement("div");
  add.className = "plugin-add";
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.textContent = "+ Add plugin";
  // Always openable — the modal browses the whole connection catalog (added ones
  // shown as "Added"), so it stays useful even when nothing new is available.
  addBtn.onclick = () => openAddPluginModal(connections, ctx);
  add.appendChild(addBtn);
  sec.appendChild(add);

  const list = document.createElement("div");
  list.className = "plugin-list";
  for (const p of installed) list.appendChild(pluginRow(p, ctx));
  sec.appendChild(list);

  document.getElementById("plugins-content").replaceChildren(sec);
}

function badge(text, cls = "") {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? ` ${cls}` : "");
  b.textContent = text;
  return b;
}

function pluginRow(p, ctx) {
  // An external plugin whose code failed to load never reached the live maps, so
  // it has no descriptor to render badges/keys/config from — its own errored card.
  if (p.external && p.state.loadError) return erroredRow(p, ctx);

  const row = document.createElement("div");
  row.className = "plugin-row";

  const main = document.createElement("div");
  main.className = "p-main";
  const label = document.createElement("div");
  label.className = "p-label";
  label.textContent = p.label;
  const desc = document.createElement("div");
  desc.className = "p-desc";
  desc.textContent = p.description || "";
  main.append(label, desc);
  if (p.external && p.source) main.appendChild(sourceLine(p.source));
  row.appendChild(main);

  // slot default badges
  if (p.kind === "ai") {
    if (ctx.defaults.tagger === p.name)
      row.appendChild(badge(ctx.slots.tagger.keyId ? "default tagger" : "default tagger · env"));
    if (ctx.defaults.embedder === p.name) row.appendChild(badge("default embedder"));
    if (ctx.defaults.transcriber === p.name) row.appendChild(badge("default transcriber"));
  }
  if (p.kind === "connector") {
    const d = ctx.slots.domains[p.connector.domain] || {};
    // Badge whichever card actually resolves as the domain default (d.effective),
    // not the stored star — so removing the starred provider still shows the
    // active fallback as default. Note when the star points elsewhere (e.g. it
    // was removed): the star setting is preserved so re-adding restores it.
    if (d.effective === p.name) {
      row.appendChild(badge("default"));
      if (d.setting && d.setting !== d.effective) row.appendChild(badge(`was ${d.setting}`, "warn"));
    }
  }

  const note = keyNote(p);
  if (note) {
    const el = document.createElement("span");
    el.className = "p-note" + (note.warn ? " warn" : "");
    el.innerHTML = KEY_SVG; // stroke=currentColor → matches the label text color
    const txt = document.createElement("span");
    txt.textContent = note.text;
    el.appendChild(txt);
    row.appendChild(el);
  }

  const tag = document.createElement("span");
  tag.className = "p-tag";
  tag.textContent = tagFor(p, ctx.defaults);
  row.appendChild(tag);

  const gear = document.createElement("button");
  gear.className = "gear";
  gear.title = `Configure ${p.label}`;
  gear.innerHTML = GEAR_SVG;
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
  row.appendChild(main);

  const tag = document.createElement("span");
  tag.className = "p-tag";
  tag.textContent = tagFor(p, ctx.defaults);
  row.appendChild(tag);

  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "ghost sm";
  retry.textContent = "Retry";
  retry.disabled = !p.source?.url;
  retry.title = p.source?.url ? "Re-download and load from the stored source" : "No source URL on record";
  retry.onclick = () => retryInstall(p, ctx, retry);
  row.appendChild(retry);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "danger sm";
  remove.textContent = "Remove";
  remove.onclick = () => removePlugin(p, ctx);
  row.appendChild(remove);

  return row;
}

async function retryInstall(p, ctx, btn) {
  // Retry re-downloads and re-RUNS code from the stored URL — the same risk the
  // install modal confirms. For a moving ref (a branch / the default) that code
  // may have changed since it was first trusted, so name the risk again here.
  if (!confirm(
    `Reinstall ${p.label} from:\n${p.source.url}\n\n` +
    "This re-downloads and runs code from the internet with the server's full " +
    "access — there is no sandbox. Only continue if you trust this source.",
  )) return;
  btn.disabled = true;
  btn.textContent = "Retrying…";
  try {
    await api("POST", "/api/admin/plugins/install", { url: p.source.url });
    toast(`${p.label} reinstalled`);
    ctx.refresh();
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "Retry";
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
    const roles = [];
    if (ctx.defaults.tagger === p.name) roles.push("the default tagger");
    if (ctx.defaults.embedder === p.name) roles.push("the default embedder");
    if (roles.length) return `This is ${roles.join(" and ")}.`;
  }
  if (p.kind === "connector") {
    const d = ctx.slots.domains[p.connector.domain] || {};
    if ((d.setting || d.effective) === p.name) return `This is the default ${p.connector.domain} provider.`;
  }
  if (p.kind === "source") {
    const n = p.state.connectionCount || 0;
    if (n) return `Its ${n} saved connection${n > 1 ? "s" : ""} become unusable until you add it back.`;
  }
  return "";
}
