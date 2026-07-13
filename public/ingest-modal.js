// The automatic-ingestion modal: per-board source + filters + sort/limit +
// trigger, with a live results preview. Fully descriptor-driven — the server's
// /api/boards/:id/ingest payload declares the source schema, filter catalog
// (with kinds that pick the operator set and input type), sorts and trigger
// modes, so this file knows nothing about folders vs future feed adapters.
import { state } from './state.js';
import { toast } from './toast.js';
import { createModal } from './modal.js';
import { switchRow } from './board-modal.js';
import { ensurePolling } from './data.js';

const OP_LABELS = {
  contains: "contains", equals: "equals", starts_with: "starts with",
  gte: "≥", lte: "≤", eq: "=",
  within_days: "within last N days", before: "before", after: "after",
};
const OPS_BY_KIND = {
  text: ["contains", "equals", "starts_with"],
  number: ["gte", "lte", "eq"],
  date: ["within_days", "before", "after"],
};
const TRIGGER_LABELS = {
  manual: "Manual only",
  continuous: "Continuous (watch)",
  interval: "Every N minutes",
  daily: "Daily at a set time",
};

const relTime = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

let modalEl = null;

export function openIngestModal() {
  if (modalEl) return; // already open

  const canEdit = !!state.boardManage;
  const { overlay, body, footer, close } = createModal({
    title: "Automatic ingestion",
    id: "ingest-modal",
    bodyStyle: "display:flex;flex-direction:column;gap:4px;",
    onClose: () => { modalEl = null; },
  });
  modalEl = overlay;

  const loading = document.createElement("p");
  loading.className = "cb-note";
  loading.textContent = "Loading…";
  body.appendChild(loading);

  Promise.all([
    fetch(`/api/boards/${state.boardId}/ingest`).then((r) => (r.ok ? r.json() : Promise.reject(r.status))),
    fetch(`/api/ingest/folders`).then((r) => (r.ok ? r.json() : { root: false, folders: [] })).catch(() => ({ root: false, folders: [] })),
  ]).then(([info, folderInfo]) => {
    loading.remove();
    build(info, folderInfo);
  }).catch((status) => {
    // The config carries server folder paths, so the GET is manager-gated —
    // plain members get told why instead of a generic failure.
    loading.textContent = status === 403
      ? "Only board admins can view ingestion settings."
      : "Failed to load ingestion settings.";
  });

  function build(info, folderInfo) {
    if (!info.available) {
      const note = document.createElement("p");
      note.className = "cb-note";
      note.textContent = "Automatic ingestion isn't available for this board's input type yet.";
      body.appendChild(note);
      return;
    }
    const desc = info.descriptor;
    const catalogByFn = Object.fromEntries((desc.filters || []).map((c) => [c.fn, c]));

    // Buffered config — edits stay local until Save.
    const saved = info.config;
    const cfg = {
      enabled: saved ? saved.enabled !== false : true,
      source: { ...(saved?.source || {}) },
      filters: (saved?.filters || []).map((f) => ({ ...f })),
      sort: saved?.sort ? { ...saved.sort } : { by: desc.sorts?.[0]?.by, order: "desc" },
      limit: saved?.limit ?? null,
      trigger: saved?.trigger ? { ...saved.trigger } : { mode: "continuous" },
    };
    for (const s of desc.source || []) {
      if (s.default !== undefined && cfg.source[s.key] === undefined) cfg.source[s.key] = s.default;
    }

    // switchRow has no disabled mode — read-only viewers get inert rows.
    const inertUnlessEditable = (row) => {
      if (!canEdit) row.style.pointerEvents = "none";
      return row;
    };

    // ── Enable ──
    body.appendChild(inertUnlessEditable(switchRow("Enable automatic ingestion", null, cfg.enabled, (on) => {
      cfg.enabled = on;
    })));

    // ── Source (descriptor-driven) ──
    const srcSection = section("Source");
    for (const s of desc.source || []) {
      if (s.type === "folder") {
        if (!info.root) {
          const warn = document.createElement("p");
          warn.className = "mm-face-hint";
          warn.textContent = "The server has no ingestion root configured (INGEST_ROOT), so folder ingestion is unavailable.";
          srcSection.appendChild(warn);
          continue;
        }
        const row = document.createElement("div");
        row.className = "im-row";
        const lbl = document.createElement("label");
        lbl.textContent = s.label;
        const sel = document.createElement("select");
        const opts = [...(folderInfo.folders || [])];
        // Keep a saved folder selectable even if it vanished from the root.
        if (cfg.source[s.key] && !opts.includes(cfg.source[s.key])) opts.unshift(cfg.source[s.key]);
        if (!opts.length) {
          const o = document.createElement("option");
          o.value = "";
          o.textContent = "— no folders under the ingestion root —";
          sel.appendChild(o);
        } else {
          for (const f of opts) {
            const o = document.createElement("option");
            o.value = f;
            o.textContent = f;
            if (f === cfg.source[s.key]) o.selected = true;
            sel.appendChild(o);
          }
          if (!cfg.source[s.key]) cfg.source[s.key] = opts[0];
        }
        sel.disabled = !canEdit;
        sel.addEventListener("change", () => { cfg.source[s.key] = sel.value; refreshPreview(); });
        row.append(lbl, sel);
        srcSection.appendChild(row);
      } else if (s.type === "boolean") {
        srcSection.appendChild(inertUnlessEditable(switchRow(s.label, null, cfg.source[s.key] !== false, (on) => {
          cfg.source[s.key] = on;
          refreshPreview();
        }, { small: true })));
      }
    }
    if (!(desc.source || []).length) {
      const note = document.createElement("p");
      note.className = "im-hint";
      note.textContent = "This board feeds from its connector's universe — nothing to configure.";
      srcSection.appendChild(note);
    }
    body.appendChild(srcSection);

    // ── Filters ──
    const filterSection = section("Filters");
    const filterList = document.createElement("div");
    filterList.className = "im-filters";
    filterSection.appendChild(filterList);

    function filterRow(f) {
      const row = document.createElement("div");
      row.className = "im-filter-row";

      const fnSel = document.createElement("select");
      for (const c of desc.filters) {
        const o = document.createElement("option");
        o.value = c.fn;
        o.textContent = c.label;
        if (c.fn === f.fn) o.selected = true;
        fnSel.appendChild(o);
      }

      const opSel = document.createElement("select");
      const valWrap = document.createElement("span");
      valWrap.className = "im-filter-val";

      function syncOps() {
        const kind = catalogByFn[f.fn]?.kind || "text";
        const ops = OPS_BY_KIND[kind];
        if (!ops.includes(f.op)) f.op = ops[0];
        opSel.replaceChildren();
        for (const op of ops) {
          const o = document.createElement("option");
          o.value = op;
          o.textContent = OP_LABELS[op] || op;
          if (op === f.op) o.selected = true;
          opSel.appendChild(o);
        }
        syncValueInput();
      }

      function syncValueInput() {
        const kind = catalogByFn[f.fn]?.kind || "text";
        const input = document.createElement("input");
        if (kind === "number" || f.op === "within_days") {
          input.type = "number";
          input.min = "0";
          if (f.op === "within_days") input.placeholder = "days";
        } else if (kind === "date") {
          input.type = "date";
        } else {
          input.type = "text";
        }
        input.value = f.value ?? "";
        input.disabled = !canEdit;
        input.addEventListener("input", () => {
          f.value = input.type === "number" ? (input.value === "" ? "" : Number(input.value)) : input.value;
          refreshPreview();
        });
        valWrap.replaceChildren(input);
      }

      fnSel.disabled = !canEdit;
      opSel.disabled = !canEdit;
      fnSel.addEventListener("change", () => { f.fn = fnSel.value; f.value = ""; syncOps(); refreshPreview(); });
      opSel.addEventListener("change", () => { f.op = opSel.value; syncValueInput(); refreshPreview(); });

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "fe-rm";
      rm.textContent = "×";
      rm.disabled = !canEdit;
      rm.addEventListener("click", () => {
        cfg.filters.splice(cfg.filters.indexOf(f), 1);
        row.remove();
        refreshPreview();
      });

      syncOps();
      row.append(fnSel, opSel, valWrap, rm);
      return row;
    }

    for (const f of cfg.filters) filterList.appendChild(filterRow(f));
    const addFilter = document.createElement("button");
    addFilter.type = "button";
    addFilter.className = "fe-add-val";
    addFilter.textContent = "+ filter";
    addFilter.disabled = !canEdit;
    addFilter.addEventListener("click", () => {
      const first = desc.filters[0];
      const f = { fn: first.fn, op: OPS_BY_KIND[first.kind][0], value: "" };
      cfg.filters.push(f);
      filterList.appendChild(filterRow(f));
    });
    filterSection.appendChild(addFilter);
    const filterHint = document.createElement("p");
    filterHint.className = "im-hint";
    filterHint.textContent = "No filters = everything in the source is eligible. All filters must match.";
    filterSection.appendChild(filterHint);
    body.appendChild(filterSection);

    // ── Sort & limit ──
    const sortSection = section("Sort & limit");
    const sortRow = document.createElement("div");
    sortRow.className = "im-row";
    const sortLbl = document.createElement("label");
    sortLbl.textContent = "Sort by";
    const sortSel = document.createElement("select");
    for (const s of desc.sorts || []) {
      const o = document.createElement("option");
      o.value = s.by;
      o.textContent = s.label || s.by;
      if (s.by === cfg.sort?.by) o.selected = true;
      sortSel.appendChild(o);
    }
    const orderSel = document.createElement("select");
    for (const [v, l] of [["desc", "Descending"], ["asc", "Ascending"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = l;
      if (v === (cfg.sort?.order || "desc")) o.selected = true;
      orderSel.appendChild(o);
    }
    const limitLbl = document.createElement("label");
    limitLbl.textContent = "Limit per run";
    const limitInput = document.createElement("input");
    limitInput.type = "number";
    limitInput.min = "1";
    limitInput.max = "500";
    limitInput.placeholder = "all";
    limitInput.style.width = "80px";
    if (cfg.limit) limitInput.value = cfg.limit;
    sortSel.disabled = orderSel.disabled = limitInput.disabled = !canEdit;
    sortSel.addEventListener("change", () => { cfg.sort = { ...cfg.sort, by: sortSel.value }; refreshPreview(); });
    orderSel.addEventListener("change", () => { cfg.sort = { ...cfg.sort, order: orderSel.value }; refreshPreview(); });
    limitInput.addEventListener("input", () => {
      cfg.limit = limitInput.value === "" ? null : Number(limitInput.value);
    });
    sortRow.append(sortLbl, sortSel, orderSel, limitLbl, limitInput);
    sortSection.appendChild(sortRow);
    const limitHint = document.createElement("p");
    limitHint.className = "im-hint";
    limitHint.textContent = "Sorting decides which items win when a per-run limit is set (e.g. 20 newest per day).";
    sortSection.appendChild(limitHint);
    body.appendChild(sortSection);

    // ── Trigger ──
    const trigSection = section("Trigger");
    const trigRow = document.createElement("div");
    trigRow.className = "im-row";
    const modeSel = document.createElement("select");
    for (const m of desc.triggerModes || []) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = TRIGGER_LABELS[m] || m;
      if (m === cfg.trigger.mode) o.selected = true;
      modeSel.appendChild(o);
    }
    const everyInput = document.createElement("input");
    everyInput.type = "number";
    everyInput.min = "1";
    everyInput.style.width = "80px";
    everyInput.placeholder = "minutes";
    if (cfg.trigger.every) everyInput.value = cfg.trigger.every;
    const atInput = document.createElement("input");
    atInput.type = "time";
    if (cfg.trigger.at) atInput.value = cfg.trigger.at;
    modeSel.disabled = everyInput.disabled = atInput.disabled = !canEdit;

    function syncTriggerInputs() {
      everyInput.style.display = cfg.trigger.mode === "interval" ? "" : "none";
      atInput.style.display = cfg.trigger.mode === "daily" ? "" : "none";
    }
    modeSel.addEventListener("change", () => { cfg.trigger.mode = modeSel.value; syncTriggerInputs(); });
    everyInput.addEventListener("input", () => { cfg.trigger.every = Number(everyInput.value); });
    atInput.addEventListener("input", () => { cfg.trigger.at = atInput.value; });
    syncTriggerInputs();
    trigRow.append(modeSel, everyInput, atInput);
    trigSection.appendChild(trigRow);
    body.appendChild(trigSection);

    // ── Preview ──
    const prevSection = section("Preview");
    const countLine = document.createElement("p");
    countLine.className = "im-preview-count";
    countLine.textContent = "…";
    const sampleWrap = document.createElement("div");
    sampleWrap.className = "im-sample";
    prevSection.append(countLine, sampleWrap);
    body.appendChild(prevSection);

    // Status line from the sweep-owned run state.
    if (info.state?.last_run_at) {
      const st = info.state;
      const line = document.createElement("p");
      line.className = "im-status" + (st.last_error ? " error" : "");
      line.textContent = st.last_error
        ? `Last run ${relTime(st.last_run_at)} — error: ${st.last_error}`
        : `Last run ${relTime(st.last_run_at)} — added ${st.last_added ?? 0}${st.drain_left ? ` (${st.drain_left} still draining)` : ""}`;
      body.appendChild(line);
    }

    // Debounced preview with a stale-response guard.
    let seq = 0;
    let debounce = null;
    function refreshPreview() {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const mySeq = ++seq;
        try {
          const r = await fetch(`/api/boards/${state.boardId}/ingest/preview`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(previewConfig()),
          });
          const data = await r.json().catch(() => ({}));
          if (mySeq !== seq) return;
          if (!r.ok) {
            countLine.textContent = data.error || "Preview failed";
            sampleWrap.replaceChildren();
            return;
          }
          const plus = data.capped ? "+" : "";
          countLine.textContent =
            `${data.count}${plus} match${data.count === 1 && !data.capped ? "" : "es"}` +
            (data.new !== data.count ? ` — ${data.new}${plus} not yet ingested` : "");
          renderSample(data.sample || []);
        } catch {
          if (mySeq === seq) countLine.textContent = "Preview failed";
        }
      }, 400);
    }

    // Only send filters the user has finished typing (a value-less filter
    // matches nothing server-side, which reads as a broken preview).
    function previewConfig() {
      return {
        source: cfg.source,
        filters: cfg.filters.filter((f) => f.value !== "" && f.value !== null && f.value !== undefined),
        sort: cfg.sort,
        trigger: cfg.trigger.mode ? cfg.trigger : { mode: "manual" },
        ...(cfg.limit ? { limit: cfg.limit } : {}),
      };
    }

    function renderSample(rows) {
      sampleWrap.replaceChildren();
      if (!rows.length) return;
      // Columns straight from the catalog: label first, then up to three
      // non-name fields — agnostic to what the adapter exposes.
      const cols = (desc.filters || []).filter((c) => c.fn !== "name").slice(0, 3);
      const table = document.createElement("table");
      table.className = "cb-table";
      const thead = document.createElement("thead");
      const hr = document.createElement("tr");
      for (const h of ["Item", ...cols.map((c) => c.label)]) {
        const th = document.createElement("th");
        th.textContent = h;
        hr.appendChild(th);
      }
      thead.appendChild(hr);
      const tbody = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.className = "cb-primary-name";
        name.textContent = row.label;
        tr.appendChild(name);
        for (const c of cols) {
          const td = document.createElement("td");
          const v = row.values?.[c.fn];
          td.textContent = v === null || v === undefined ? "—"
            : c.kind === "date" ? new Date(v).toLocaleDateString()
            : c.kind === "number" ? Number(v).toLocaleString()
            : String(v);
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.append(thead, tbody);
      sampleWrap.appendChild(table);
    }

    // ── Footer ──
    if (canEdit) {
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async () => {
        const payload = { ...previewConfig(), enabled: cfg.enabled };
        try {
          const r = await fetch(`/api/boards/${state.boardId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ingest: payload }),
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            toast.error(data.error || "Save failed");
            return;
          }
          state.boardIngest = !!payload.enabled;
          ensurePolling(); // the slow poll follows the flag
          toast("Ingestion saved");
          close();
        } catch {
          toast.error("Save failed");
        }
      });
      const runBtn = document.createElement("button");
      runBtn.className = "ghost";
      runBtn.textContent = "Run now";
      runBtn.title = "Runs the saved configuration on the next worker tick";
      runBtn.addEventListener("click", async () => {
        try {
          const r = await fetch(`/api/boards/${state.boardId}/ingest/run`, { method: "POST" });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) return toast.error(data.error || "Run failed");
          toast("Ingestion run queued");
        } catch {
          toast.error("Run failed");
        }
      });
      footer.append(saveBtn, runBtn);
    } else {
      const note = document.createElement("p");
      note.style.cssText = "font-size:12px;color:#8a8a92;margin:0;";
      note.textContent = "Only board admins can edit ingestion.";
      footer.appendChild(note);
    }

    refreshPreview();
  }

  function section(title) {
    const el = document.createElement("div");
    el.className = "modal-section";
    const t = document.createElement("div");
    t.className = "modal-section-title";
    t.textContent = title;
    el.appendChild(t);
    return el;
  }
}
