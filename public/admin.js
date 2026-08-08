// Admin shell: the left-nav tab switcher (with hash deep-linking) plus the
// three tab renders. Each tab lives in its own module; renderMembers runs first
// because it also gates the shell visible, while the boards/plugins renders
// re-check access and no-op for non-admins.
import { ICONS } from "/utils.js";
import { renderMembers } from "/admin-members.js";
import { renderBoards } from "/admin-boards.js";
import { renderPlugins } from "/admin-plugins.js";
import { renderBackups } from "/admin-backups.js";
import { renderLogs, setLogsActive } from "/admin-logs.js";

// --- Tabs ---
// The rail's markup names its glyphs (data-icon) instead of carrying them; fill
// them in before anything else runs. Static HTML is the one place that can't
// import from the icon set, and this is the whole cost of joining it.
for (const el of document.querySelectorAll("[data-icon]")) {
  el.insertAdjacentHTML("afterbegin", ICONS[el.dataset.icon]);
}

const TAB_NAMES = ["members", "boards", "plugins", "backups", "logs"];
const tabBtns = [...document.querySelectorAll(".tab")];
function selectTab(name) {
  tabBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "panel-" + name));
  history.replaceState(null, "", name === "members" ? location.pathname : "#" + name);
  setLogsActive(name === "logs"); // the SSE stream follows tab visibility
}
tabBtns.forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
const initialTab = location.hash.slice(1);
if (TAB_NAMES.includes(initialTab)) selectTab(initialTab);

renderMembers().catch(() => (document.getElementById("gate").innerHTML = 'Error loading. <a href="/">Back</a>'));
renderBoards().catch(() => {});
renderPlugins().catch(() => {});
renderBackups().catch(() => {});
renderLogs().catch(() => {});
