// Admin shell: the left-nav tab switcher (with hash deep-linking) plus the
// three tab renders. Each tab lives in its own module; renderMembers runs first
// because it also gates the shell visible, while the boards/plugins renders
// re-check access and no-op for non-admins.
import { ICONS } from "./utils.js";
import { mountTabs } from "./tabs.js";
import { renderMembers } from "./admin-members.js";
import { renderBoards } from "./admin-boards.js";
import { renderUsage } from "./admin-usage.js";
import { renderStorage } from "./admin-storage.js";
import { renderPluginSurfaces } from "./admin-plugins.js";
import { renderBackups } from "./admin-backups.js";
import { renderLogs, setLogsActive } from "./admin-logs.js";
import { renderMcp } from "./admin-mcp.js";

// --- Tabs ---
// The rail's markup names its glyphs (data-icon) instead of carrying them; fill
// them in before anything else runs. Static HTML is the one place that can't
// import from the icon set, and this is the whole cost of joining it.
for (const el of document.querySelectorAll("[data-icon]")) {
  el.insertAdjacentHTML("afterbegin", ICONS[el.dataset.icon]);
}

// The switcher itself is tabs.js, shared with the account page. What stays
// here is the part that is this page's: two renders that hang off visibility.
mountTabs({
  names: ["members", "boards", "usage", "storage", "capabilities", "plugins", "backups", "logs", "mcp"],
  defaultTab: "members",
  onSelect: (name) => {
    setLogsActive(name === "logs"); // the SSE stream follows tab visibility
    // Storage renders on SELECT, not at boot like its siblings: its GET walks
    // the filesystem server-side and exists to be live — the user looking IS
    // the sample (storage-plan.md). Re-opening re-measures; that's the point.
    if (name === "storage") renderStorage().catch(() => {});
  },
});

renderMembers().catch(() => (document.getElementById("gate").innerHTML = 'Error loading. <a href="/">Back</a>'));
renderBoards().catch(() => {});
renderUsage().catch(() => {});
renderPluginSurfaces().catch(() => {}); // Capabilities + Plugins: one state fetch, both tabs
renderBackups().catch(() => {});
renderLogs().catch(() => {});
renderMcp().catch(() => {});
