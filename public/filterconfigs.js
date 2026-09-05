// filterconfigs.js — the caret half of the split Filters button.
//
// A saved config is a named snapshot of the facet selection, per user per
// board. Clicking one applies it one-shot (replaces the current pills) —
// there's no lingering "active view", the pills are the whole truth.
//
// The pop's footer also carries the odds lens toggle (patterns.js): the app's
// only per-viewer filter-adjacent menu, which is what that switch is. It owns
// the ROW, not the behavior — the flip/persist/repaint is toggleOdds'.

import { state } from './state.js';
import { ICONS } from './utils.js';
import { openDropdown, ddRow, ddSep, ddInput, ddEmpty, ddCheckRow } from './dropdown.js';
import { toast } from './toast.js';
import { activeCount, applyFilterConfig, selectedAsConfig, configMatchesCurrent } from './filters.js';
import { toggleOdds, toggleClusters } from './patterns.js';

async function doDeleteConfig(cfg, onClose) {
  try {
    const r = await fetch(`/api/filter-configs/${cfg.id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    state.filterConfigs = state.filterConfigs.filter((c) => c.id !== cfg.id);
    onClose();
    document.dispatchEvent(new Event('app:render')); // saved row in the filter panel
  } catch {
    toast.error("Couldn't delete saved filter");
  }
}

function configDelBtn(cfg, onClose) {
  const del = document.createElement("button");
  del.className = "dd-del";
  del.title = "Delete saved filter";
  del.innerHTML = ICONS.trash;
  del.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete saved filter "${cfg.name}"?`)) return;
    await doDeleteConfig(cfg, onClose);
  });
  return del;
}

async function saveCurrentAs(name, onClose) {
  try {
    const r = await fetch("/api/filter-configs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, board_id: state.boardId, config: selectedAsConfig() }),
    });
    if (!r.ok) throw new Error();
    const { config } = await r.json();
    // Same name overwrites server-side; mirror that here.
    const i = state.filterConfigs.findIndex((c) => c.id === config.id);
    if (i >= 0) state.filterConfigs[i] = config;
    else state.filterConfigs.push(config);
    onClose();
    document.dispatchEvent(new Event('app:render')); // saved row in the filter panel
    toast(`Saved "${config.name}"`, { duration: "short" });
  } catch {
    toast.error("Couldn't save filters");
  }
}

// The drawer header carries the same chevron as the toolbar split button,
// opening the same dropdown (the toolbar one is behind the drawer's scrim).
// Called at boot once state.me is known.
export function initFilterConfigsUI() {
  const btn = document.getElementById("filter-drawer-saved");
  btn.hidden = !state.me; // configs are per-user
  btn.innerHTML = ICONS.chevron;
  btn.addEventListener("click", () => openFilterConfigPop(btn));
}

export function openFilterConfigPop(anchorEl) {
  openDropdown(anchorEl, {
    className: "filter-config-pop",
    align: "start",
    minWidth: 190,
    build: (body, { close }) => {
      if (!state.filterConfigs.length) {
        body.appendChild(ddEmpty(activeCount() > 0
          ? "No saved filters yet — name the current ones below."
          : "Pick some filters, then save them here for reuse."));
        return;
      }
      for (const cfg of state.filterConfigs) {
        body.appendChild(ddRow({
          label: cfg.name,
          active: configMatchesCurrent(cfg.config),
          trailing: configDelBtn(cfg, close),
          onClick: () => {
            applyFilterConfig(cfg.config);
            close();
          },
        }));
      }
    },
    footer: (foot, { close }) => {
      if (activeCount() > 0) {
        if (state.filterConfigs.length) foot.appendChild(ddSep());
        foot.appendChild(ddInput({
          placeholder: "Save current filters…",
          onSubmit: (name) => saveCurrentAs(name, close),
        }));
      }
      // The lenses (planning/pattern-surfaces-plan.md): per-viewer ways of
      // looking, so they live with the other per-viewer filter things rather
      // than in board settings.
      foot.appendChild(ddSep());
      // Both lenses close BEFORE toggling: the render a toggle triggers
      // rebuilds the toolbar, and this pop's anchor (the chevron) with it.
      const cb = ddCheckRow({
        label: "Show pattern odds",
        checked: state.showOdds,
        title: "Mark filter values that pair with the current selection far more (or less) often than chance",
        onChange: () => { close(); toggleOdds(cb.checked); },
      });
      foot.appendChild(cb.el);
      const cl = ddCheckRow({
        label: "Show clusters",
        checked: state.showClusters,
        title: "Find groups of items that keep answering alike, and show them as a filter row",
        onChange: () => { close(); toggleClusters(cl.checked); },
      });
      foot.appendChild(cl.el);
    },
  });
}
