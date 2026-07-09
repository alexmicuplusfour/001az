// Admin shell: the left-nav tab switcher (with hash deep-linking) plus the
// three tab renders. Each tab lives in its own module; renderMembers runs first
// because it also gates the shell visible, while the boards/AI renders re-check
// access and no-op for non-admins.
import { renderMembers } from "/admin-members.js";
import { renderBoards } from "/admin-boards.js";
import { renderAiConfig } from "/admin-ai.js";
import { renderConnectors } from "/admin-connectors.js";

// --- Tabs ---
const TAB_NAMES = ["members", "boards", "ai", "connectors"];
const tabBtns = [...document.querySelectorAll(".tab")];
function selectTab(name) {
  tabBtns.forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => (p.hidden = p.id !== "panel-" + name));
  history.replaceState(null, "", name === "members" ? location.pathname : "#" + name);
}
tabBtns.forEach((t) => (t.onclick = () => selectTab(t.dataset.tab)));
const initialTab = location.hash.slice(1);
if (TAB_NAMES.includes(initialTab)) selectTab(initialTab);

renderMembers().catch(() => (document.getElementById("gate").innerHTML = 'Error loading. <a href="/">Back</a>'));
renderBoards().catch(() => {});
renderAiConfig().catch(() => {});
renderConnectors().catch(() => {});
