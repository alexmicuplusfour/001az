// Plugins tab: the unified integrations catalog — AI providers, connector
// data providers, media types — as a segmented list. Toggle = enabled
// (usable), badge = the slot default (preselected); the gear opens each
// plugin's own modal (plugin-modal.js) for keys/config/defaults. Everything
// renders from GET /api/admin/plugins; this module holds no catalog
// knowledge of its own. Self-guards on /api/me.
import { toast } from "/toast.js";
import { api } from "/api.js";
import { makeSwitch } from "/board-modal.js";
import { openPluginModal } from "/plugin-modal.js";

const GEAR_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
const LOCK_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`;

// Which provider currently backs the tagger / embedder slots (for badges).
// The tagger falls back to the anthropic env var when no default key is set.
export function slotProviders(slots, keys) {
  const keyProvider = (id) => keys.find((k) => k.id === id)?.provider || null;
  const tagger = slots.tagger.keyId
    ? keyProvider(slots.tagger.keyId)
    : slots.tagger.envKey ? "anthropic" : null;
  const embedder = !slots.embedder.enabled ? null
    : slots.embedder.provider === "local" ? "local"
    : keyProvider(slots.embedder.keyId);
  return { tagger, embedder };
}

export async function renderPlugins() {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;

  let data, keys;
  try {
    [data, keys] = await Promise.all([api("GET", "/api/admin/plugins"), api("GET", "/api/admin/ai-keys")]);
  } catch { return; }
  const { plugins, slots } = data;
  const defaults = slotProviders(slots, keys);

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Plugins</h2><p class="sub">Every integration in one place. The switch turns a plugin on or off; a badge marks the default for its slot (tagger, embedder, data provider). Configure keys and options via the gear.</p>`;

  // Segments in display order: AI, then each connector domain, then media.
  const segs = [];
  const bySeg = new Map();
  for (const p of plugins) {
    if (!bySeg.has(p.segment)) { bySeg.set(p.segment, []); segs.push(p.segment); }
    bySeg.get(p.segment).push(p);
  }
  const segLabel = (seg, list) =>
    seg === "ai" ? "AI providers" : seg === "media" ? "Media types" : list[0].connector.domainLabel;

  const ctx = { slots, keys, defaults, refresh: renderPlugins };
  for (const seg of segs) {
    const list = bySeg.get(seg);
    const box = document.createElement("div");
    box.className = "plugin-seg";
    box.innerHTML = `<h3>${segLabel(seg, list)}</h3>`;
    for (const p of list) box.appendChild(pluginRow(p, ctx));
    sec.appendChild(box);
  }

  document.getElementById("plugins-content").replaceChildren(sec);
}

function badge(text, cls = "") {
  const b = document.createElement("span");
  b.className = "badge" + (cls ? ` ${cls}` : "");
  b.textContent = text;
  return b;
}

function rowHint(p, ctx) {
  if (p.kind === "ai") {
    if (p.ai.keyless) return "runs on-server · no API key";
    const n = p.state.keyCount;
    const env = p.name === "anthropic" && ctx.slots.tagger.envKey ? " · env key" : "";
    return (n ? `${n} key${n > 1 ? "s" : ""}` : "no keys") + env;
  }
  if (p.kind === "connector")
    return p.state.hasKey ? "key stored" : p.connector.needsKey ? "no key yet" : "keyless tier";
  return p.capabilities.extensions.map((e) => "." + e).join(" ");
}

function pluginRow(p, ctx) {
  const row = document.createElement("div");
  row.className = "plugin-row" + (p.state.enabled ? "" : " is-off");

  const dot = document.createElement("span");
  const h = p.state.health;
  dot.className = "dot" +
    (!p.state.enabled ? " off" : h?.failCount >= 3 ? " bad" : h?.failCount >= 1 ? " warn" : "");
  if (h?.lastError?.message) dot.title = h.lastError.message;
  row.appendChild(dot);

  const label = document.createElement("span");
  label.className = "p-label";
  label.textContent = p.label;
  row.appendChild(label);

  // slot badges
  if (p.kind === "ai") {
    if (ctx.defaults.tagger === p.name)
      row.appendChild(badge(ctx.slots.tagger.keyId ? "default tagger" : "default tagger · env"));
    if (ctx.defaults.embedder === p.name) row.appendChild(badge("default embedder"));
  }
  if (p.kind === "connector") {
    const d = ctx.slots.domains[p.connector.domain] || {};
    const starred = (d.setting || d.effective) === p.name;
    if (starred) {
      row.appendChild(badge("default"));
      // truthful UI: a disabled default keeps its star, with the fallback named
      if (!p.state.enabled && d.effective && d.effective !== p.name)
        row.appendChild(badge(`falling back to ${d.effective}`, "warn"));
    }
  }

  const hint = document.createElement("span");
  hint.className = "p-hint";
  hint.textContent = rowHint(p, ctx);
  row.appendChild(hint);

  if (p.core) {
    const lock = document.createElement("span");
    lock.className = "core-lock";
    lock.title = "Core plugin — always on";
    lock.innerHTML = LOCK_SVG;
    row.appendChild(lock);
  } else {
    const sw = makeSwitch(p.state.enabled, async (on) => {
      try {
        await api("PATCH", `/api/admin/plugins/${p.id}`, { enabled: on });
        toast(`${p.label} ${on ? "enabled" : "disabled"}`);
        ctx.refresh();
      } catch (err) {
        toast.error(err.message);
        ctx.refresh();
      }
    }, { small: true });
    row.appendChild(sw);
  }

  const gear = document.createElement("button");
  gear.className = "gear";
  gear.title = `Configure ${p.label}`;
  gear.innerHTML = GEAR_SVG;
  gear.onclick = () => openPluginModal(p, ctx);
  row.appendChild(gear);

  return row;
}
