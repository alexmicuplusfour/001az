// Capabilities tab: one card per capability, rendered VERBATIM from
// GET /api/admin/capabilities — state chip, what's serving, why it fell, who
// else could serve it, what's waiting, and the capability-level knobs. This
// module holds no capability knowledge: every card derives from fields the
// payload declares (capability-present.js is the pure mapping), so a
// capability added to the server's registry appears here with no edit.
//
// Two actions, both delegations: Test posts the capability's probe; Configure
// opens the SERVING provider's existing plugin modal — the page diagnoses, the
// Plugins surface owns the lifecycle. Deep links: #capabilities/<id> selects
// the tab (admin.js) and flashes the card (here).
import { api } from "/api.js";
import { toast } from "/toast.js";
import { openPluginModal, busy } from "/plugin-modal.js";
import { refreshPluginSurfaces, loadPluginState } from "/admin-plugins.js";
import { presentChip, presentLines, presentSupported, configureTarget, fmtProbe } from "/capability-present.js";

const chipEl = ({ cls, text }) => {
  const s = document.createElement("span");
  s.className = "cap-chip" + (cls ? ` ${cls}` : "");
  s.textContent = text;
  return s;
};

// The Configure action: open the plugin modal of whichever provider the card
// is ABOUT (running, else configured, else the floor). Unavailable entries
// have no provider to open — send the admin to the Plugins tab to add one.
async function openConfigure(c) {
  const name = configureTarget(c);
  const state = await loadPluginState();
  const p = state.plugins.find((x) =>
    c.kind === "domain" ? x.kind === "connector" && x.segment === c.id && x.name === name
      : x.kind === "ai" && x.name === name);
  if (!p) { location.hash = "#plugins"; return; }
  // Mutations inside the modal refresh BOTH surfaces — the Plugins tab it
  // belongs to and this one, which is a projection of the same state.
  openPluginModal(p, { ...state, refresh: refreshPluginSurfaces, getState: loadPluginState });
}

function capCard(c) {
  const card = document.createElement("div");
  card.className = "cap-card";
  card.dataset.cap = c.id;

  const head = document.createElement("div");
  head.className = "cap-head";
  const label = document.createElement("span");
  label.className = "cap-label";
  label.textContent = c.label;
  head.append(label, chipEl(presentChip(c)));
  card.appendChild(head);

  const blurb = document.createElement("div");
  blurb.className = "cap-blurb";
  blurb.textContent = c.blurb || "";
  card.appendChild(blurb);

  const lines = presentLines(c);
  if (lines.length) {
    const dl = document.createElement("div");
    dl.className = "cap-lines";
    for (const { k, v } of lines) {
      const row = document.createElement("div");
      const key = document.createElement("span");
      key.className = "k";
      key.textContent = k + ":";
      row.append(key, document.createTextNode(v));
      dl.appendChild(row);
    }
    card.appendChild(dl);
  }

  // One chip row per roster the entry carries. AI/domain entries list who
  // could serve (a not-yet-added provider links to the Plugins tab, where
  // adding happens); the always-on entries list what they accept instead.
  const roster = (items, render) => {
    if (!items?.length) return;
    const div = document.createElement("div");
    div.className = "cap-roster";
    for (const it of items) div.appendChild(render(it));
    card.appendChild(div);
  };
  roster(c.supportedBy, (p) => {
    const pres = presentSupported(p);
    const el = document.createElement(pres.link ? "a" : "span");
    el.className = "cap-chip" + (pres.warn ? " warn" : pres.dim ? " dim" : "");
    el.textContent = pres.text;
    if (pres.link) el.href = "#plugins";
    return el;
  });
  roster(c.handlers, (h) => {
    const el = document.createElement("span");
    el.className = "cap-chip";
    el.textContent = `${h.label} (${h.extensions.join(", ")})`;
    return el;
  });
  roster(c.sources, (s) => {
    const el = document.createElement("span");
    el.className = "cap-chip" + (s.ready === false ? " warn" : "");
    el.textContent = s.label
      + (s.core ? " — built-in" : s.installed ? ` — ${s.connectionCount ?? 0} connection${s.connectionCount === 1 ? "" : "s"}` : " — not added")
      + (s.ready === false ? " · INGEST_ROOT not set" : "");
    return el;
  });

  // Capability-level knobs (e.g. detection's threshold) — the first UI these
  // have ever had; committed on change through the capability bind route.
  for (const f of c.config || []) {
    const row = document.createElement("div");
    row.className = "cap-config";
    const lab = document.createElement("span");
    lab.className = "k";
    lab.textContent = f.key.replace(/_/g, " ");
    const input = document.createElement("input");
    input.type = "number";
    input.step = "any";
    input.value = f.value ?? "";
    input.onchange = async () => {
      try {
        await api("POST", `/api/admin/capabilities/${c.id}/bind`, { config: { [f.key]: Number(input.value) } });
        toast("Saved");
      } catch (err) {
        toast.error(err.message);
        input.value = f.value ?? "";
      }
    };
    row.append(lab, input);
    card.appendChild(row);
  }

  const actions = document.createElement("div");
  actions.className = "cap-actions";
  if (c.probeable) {
    const test = document.createElement("button");
    test.className = "ghost";
    test.textContent = "Test";
    test.onclick = busy(test, "Testing…", async () => {
      try {
        toast(fmtProbe(await api("POST", `/api/admin/capabilities/${c.id}/probe`)));
      } catch (err) { toast.error(err.message); }
    });
    actions.appendChild(test);
  }
  if (c.kind === "ai" || c.kind === "domain") {
    const cfg = document.createElement("button");
    cfg.className = "ghost";
    cfg.textContent = configureTarget(c) ? "Configure" : "Add a provider";
    cfg.onclick = busy(cfg, "Opening…", () => openConfigure(c));
    actions.appendChild(cfg);
  }
  if (actions.children.length) card.appendChild(actions);
  return card;
}

// #capabilities/<id> → flash that card. Re-checked on every hash change so the
// Plugins-tab badges work while the panel is already mounted.
function highlightFromHash() {
  const m = location.hash.match(/^#capabilities\/(.+)$/);
  if (!m) return;
  const card = document.querySelector(`.cap-card[data-cap="${CSS.escape(m[1])}"]`);
  if (!card) return;
  card.scrollIntoView({ block: "center" });
  card.classList.add("flash");
  setTimeout(() => card.classList.remove("flash"), 1600);
}
addEventListener("hashchange", highlightFromHash);

// `prefetched` mirrors renderPlugins': callers that just loaded the state hand
// the capabilities array over instead of this render refetching the page's
// most expensive GET (three settings walks per AI entry, server-side).
export async function renderCapabilities(prefetched) {
  const me = await fetch("/api/me").then((r) => r.json());
  if (!me || !me.is_admin) return;
  let caps = prefetched;
  if (!caps) { try { ({ capabilities: caps } = await api("GET", "/api/admin/capabilities")); } catch { return; } }

  const sec = document.createElement("div");
  sec.className = "section";
  sec.innerHTML = `<h2>Capabilities</h2><p class="sub">What this instance can do right now — what serves each capability, what fell back and why, and what's waiting on a key. Configure opens the provider's settings; adding providers lives on the Plugins tab.</p>`;

  const list = document.createElement("div");
  list.className = "cap-list";
  for (const c of caps) list.appendChild(capCard(c));
  sec.appendChild(list);

  document.getElementById("capabilities-content").replaceChildren(sec);
  highlightFromHash();
}
