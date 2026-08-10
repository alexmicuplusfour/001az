// Admin shell: the left-nav tab switcher (with hash deep-linking) plus the
// three tab renders. Each tab lives in its own module; renderMembers runs first
// because it also gates the shell visible, while the boards/plugins renders
// re-check access and no-op for non-admins.
import { ICONS } from "/utils.js";
import { renderMembers } from "/admin-members.js";
import { renderBoards } from "/admin-boards.js";
import { renderPluginSurfaces } from "/admin-plugins.js";
import { renderBackups } from "/admin-backups.js";
import { renderLogs, setLogsActive } from "/admin-logs.js";

// --- Tabs ---
// The rail's markup names its glyphs (data-icon) instead of carrying them; fill
// them in before anything else runs. Static HTML is the one place that can't
// import from the icon set, and this is the whole cost of joining it.
for (const el of document.querySelectorAll("[data-icon]")) {
  el.insertAdjacentHTML("afterbegin", ICONS[el.dataset.icon]);
}

const TAB_NAMES = ["members", "boards", "capabilities", "plugins", "backups", "logs"];
const tabBtns = [...document.querySelectorAll(".tab")];
function selectTab(name) {
  tabBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "panel-" + name));
  // A deep-link suffix (#capabilities/tag) survives selection; anything else
  // normalizes to the bare tab hash.
  const keep = location.hash.startsWith("#" + name + "/") ? location.hash : "#" + name;
  history.replaceState(null, "", name === "members" ? location.pathname : keep);
  setLogsActive(name === "logs"); // the SSE stream follows tab visibility
}
tabBtns.forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
// The tab is the hash's first segment — in-page links (the Plugins tab's
// "default tagger" badges → #capabilities/tag) switch tabs through this.
const tabFromHash = () => location.hash.slice(1).split("/")[0];
if (TAB_NAMES.includes(tabFromHash())) selectTab(tabFromHash());
addEventListener("hashchange", () => { if (TAB_NAMES.includes(tabFromHash())) selectTab(tabFromHash()); });

renderMembers().catch(() => (document.getElementById("gate").innerHTML = 'Error loading. <a href="/">Back</a>'));
renderBoards().catch(() => {});
renderPluginSurfaces().catch(() => {}); // Capabilities + Plugins: one state fetch, both tabs
renderBackups().catch(() => {});
renderLogs().catch(() => {});
