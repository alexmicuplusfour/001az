// The automatic-ingestion modal: per-board source + filters + sort/limit +
// trigger, with an on-demand results preview. Fully descriptor-driven — the
// server's /api/boards/:id/ingest payload declares the source schema, filter
// catalog (with kinds that pick the operator set and input type), sorts and
// trigger modes, so this file knows nothing about folders vs future feed
// adapters.
//
// Preview is manual and two-stage: a Preview button fetches just the match
// count; clicking the count swaps this modal to a read-only results list
// (connector-browse-style table with Load more) — no inline table trying to
// summarize thousands of files. Back returns to the settings view with every
// buffered edit intact (same modal, same closure — nothing is rebuilt).
import { state } from './state.js';
import { fmtDuration } from './utils.js';
import { toast } from './toast.js';
import { createModal } from './modal.js';
import { pagedTableScaffold, fmtUsd, fmtNumber, fmtPercent } from './paged-table.js';
import { switchRow } from './board-modal.js';
import { refreshBoardIngest, ensurePolling } from './data.js';

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
const PAGE_SIZE = 50;

const relTime = (ts) => `${fmtDuration(Date.now() - ts)} ago`;

let modalEl = null;

export function openIngestModal() {
  if (modalEl) return; // already open

  const canEdit = !!state.boardManage;
  const { overlay, dialog, body, footer, titleEl, close } = createModal({
    title: "Automatic ingestion",
    id: "ingest-modal",
    bodyStyle: "display:flex;flex-direction:column;",
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
      // Opt-in: a board with no saved config opens with ingestion OFF, so
      // configuring a source and hitting Save can't silently arm the sweep.
      // An existing config keeps its saved state (only an explicit false = off).
      enabled: saved ? saved.enabled !== false : false,
      source: { ...(saved?.source || {}) },
      filters: (saved?.filters || []).map((f) => ({ ...f })),
      sort: saved?.sort ? { ...saved.sort } : { by: desc.sorts?.[0]?.by, order: "desc" },
      limit: saved?.limit ?? null,
      // Default to watching when the adapter offers it (folders); a feed
      // adapter without "continuous" starts on its first declared mode —
      // defaulting outside the descriptor would make Save fail validation.
      trigger: saved?.trigger
        ? { ...saved.trigger }
        : { mode: (desc.triggerModes || []).includes("continuous") ? "continuous" : (desc.triggerModes?.[0] || "manual") },
    };
    for (const s of desc.source || []) {
      if (s.default !== undefined && cfg.source[s.key] === undefined) cfg.source[s.key] = s.default;
    }

    // Two views in one modal: settings (the config sections) and results (the
    // paged preview list). Swapping views detaches nothing — all edit state
    // lives on in the settings DOM while results are shown.
    const settingsView = document.createElement("div");
    settingsView.style.cssText = "display:flex;flex-direction:column;gap:4px;";
    const resultsView = document.createElement("div");
    resultsView.style.cssText = "display:none;flex-direction:column;gap:12px;min-height:0;flex:1;";
    body.append(settingsView, resultsView);
    const footerSettings = document.createElement("div");
    footerSettings.style.cssText = "display:flex;align-items:center;gap:8px;";
    const footerResults = document.createElement("div");
    footerResults.style.cssText = "display:none;align-items:center;gap:8px;";
    footer.append(footerSettings, footerResults);

    // switchRow has no disabled mode — read-only viewers get inert rows.
    const inertUnlessEditable = (row) => {
      if (!canEdit) row.style.pointerEvents = "none";
      return row;
    };

    // ── Enable ──
    settingsView.appendChild(inertUnlessEditable(switchRow("Enable automatic ingestion", null, cfg.enabled, (on) => {
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
        sel.addEventListener("change", () => { cfg.source[s.key] = sel.value; invalidatePreview(); });
        row.append(lbl, sel);
        srcSection.appendChild(row);
      } else if (s.type === "boolean") {
        srcSection.appendChild(inertUnlessEditable(switchRow(s.label, null, cfg.source[s.key] !== false, (on) => {
          cfg.source[s.key] = on;
          invalidatePreview();
        }, { small: true })));
      }
    }
    if (!(desc.source || []).length) {
      const note = document.createElement("p");
      note.className = "im-hint";
      note.textContent = "This board feeds from its connector's universe — nothing to configure.";
      srcSection.appendChild(note);
    }
    settingsView.appendChild(srcSection);

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
          // Day counts can't be negative; plain number fields can (a feed
          // filtering 24h change ≤ -5 is the bread-and-butter case).
          if (f.op === "within_days") { input.min = "1"; input.placeholder = "days"; }
        } else if (kind === "date") {
          input.type = "date";
        } else {
          input.type = "text";
        }
        input.value = f.value ?? "";
        input.disabled = !canEdit;
        input.addEventListener("input", () => {
          f.value = input.type === "number" ? (input.value === "" ? "" : Number(input.value)) : input.value;
          invalidatePreview();
        });
        valWrap.replaceChildren(input);
      }

      fnSel.disabled = !canEdit;
      opSel.disabled = !canEdit;
      fnSel.addEventListener("change", () => { f.fn = fnSel.value; f.value = ""; syncOps(); invalidatePreview(); });
      opSel.addEventListener("change", () => { f.op = opSel.value; syncValueInput(); invalidatePreview(); });

      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "fe-rm";
      rm.textContent = "×";
      rm.disabled = !canEdit;
      rm.addEventListener("click", () => {
        cfg.filters.splice(cfg.filters.indexOf(f), 1);
        row.remove();
        invalidatePreview();
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
      invalidatePreview();
    });
    filterSection.appendChild(addFilter);
    const filterHint = document.createElement("p");
    filterHint.className = "im-hint";
    filterHint.textContent = "No filters = everything in the source is eligible. All filters must match.";
    filterSection.appendChild(filterHint);
    settingsView.appendChild(filterSection);

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
    sortSel.addEventListener("change", () => { cfg.sort = { ...cfg.sort, by: sortSel.value }; invalidatePreview(); });
    orderSel.addEventListener("change", () => { cfg.sort = { ...cfg.sort, order: orderSel.value }; invalidatePreview(); });
    limitInput.addEventListener("input", () => {
      cfg.limit = limitInput.value === "" ? null : Number(limitInput.value);
    });
    sortRow.append(sortLbl, sortSel, orderSel, limitLbl, limitInput);
    sortSection.appendChild(sortRow);
    const limitHint = document.createElement("p");
    limitHint.className = "im-hint";
    limitHint.textContent = "Sorting decides which items win when a per-run limit is set (e.g. 20 newest per day).";
    sortSection.appendChild(limitHint);
    settingsView.appendChild(sortSection);

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
    settingsView.appendChild(trigSection);

    // ── Preview: a button fetches the count; the count opens the results view ──
    const prevSection = section("Preview");
    const prevRow = document.createElement("div");
    prevRow.className = "im-row";
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "im-preview-btn";
    // Label + spinner as siblings: while loading the label goes hidden (keeping
    // the button's width so it can't jump) and the spinner shows centered.
    const previewLabel = document.createElement("span");
    previewLabel.className = "im-btn-label";
    previewLabel.textContent = "Preview";
    const previewSpin = document.createElement("span");
    previewSpin.className = "im-btn-spin";
    previewSpin.setAttribute("aria-hidden", "true");
    previewBtn.append(previewLabel, previewSpin);
    const countBtn = document.createElement("button");
    countBtn.type = "button";
    countBtn.className = "im-preview-count";
    countBtn.style.display = "none";
    countBtn.title = "View the matching items";
    prevRow.append(previewBtn, countBtn);
    prevSection.appendChild(prevRow);
    settingsView.appendChild(prevSection);

    // Status line from the sweep-owned run state.
    if (info.state?.last_run_at) {
      const st = info.state;
      const line = document.createElement("p");
      line.className = "im-status" + (st.last_error ? " error" : "");
      line.textContent = st.last_error
        ? `Last run ${relTime(st.last_run_at)} — error: ${st.last_error}`
        : `Last run ${relTime(st.last_run_at)} — added ${st.last_added ?? 0}${st.drain_left ? ` (${st.drain_left} still draining)` : ""}`;
      settingsView.appendChild(line);
    }

    // A config edit makes a shown count a lie — hide it until re-previewed,
    // so the results view can never open on stale numbers. The seq also
    // discards an in-flight count fetch: without it, a slow response landing
    // after an edit would re-show a count for a config the user no longer has.
    let previewSeq = 0;
    function invalidatePreview() {
      previewSeq++;
      countBtn.style.display = "none";
    }

    previewBtn.addEventListener("click", async () => {
      const mySeq = ++previewSeq;
      previewBtn.disabled = true;
      previewBtn.classList.add("loading");
      try {
        const r = await fetch(`/api/boards/${state.boardId}/ingest/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(previewConfig()),
        });
        const data = await r.json().catch(() => ({}));
        if (mySeq !== previewSeq) return;
        if (!r.ok) {
          invalidatePreview();
          toast.error(data.error || "Preview failed");
          return;
        }
        // Lead with what a run would actually take; the rest is accounting.
        const plus = data.capped ? "+" : "";
        const already = data.count - data.new;
        countBtn.textContent =
          `${data.new}${plus} new match${data.new === 1 && !data.capped ? "" : "es"}` +
          (already > 0 ? ` — ${already} already ingested` : "") + " ›";
        countBtn.style.display = "";
      } catch {
        if (mySeq === previewSeq) toast.error("Preview failed");
      } finally {
        previewBtn.disabled = false;
        previewBtn.classList.remove("loading");
      }
    });
    countBtn.addEventListener("click", showResults);

    // Only send filters the user has finished typing (a value-less filter
    // matches nothing server-side, which reads as a broken preview).
    const unfinishedFilter = (f) => f.value === "" || f.value === null || f.value === undefined;
    function previewConfig() {
      return {
        source: cfg.source,
        filters: cfg.filters.filter((f) => !unfinishedFilter(f)),
        sort: cfg.sort,
        trigger: cfg.trigger.mode ? cfg.trigger : { mode: "manual" },
        ...(cfg.limit ? { limit: cfg.limit } : {}),
      };
    }

    // ── Results view: read-only paged list, connector-browse chrome ──
    const { scroll, thead, tbody, note, moreBtn } = pagedTableScaffold();
    note.style.display = "none"; // .cb-note pads even when empty — hide until it speaks
    resultsView.appendChild(scroll);

    // Columns straight from the catalog: label first, then up to three
    // non-name fields — agnostic to what the adapter exposes. A trailing
    // status column marks rows the ledger already holds (a run skips them),
    // so the "N new" promise on the count button is traceable in the list.
    const cols = (desc.filters || []).filter((c) => c.fn !== "name").slice(0, 3);
    {
      const tr = document.createElement("tr");
      for (const h of ["Item", ...cols.map((c) => c.label), ""]) {
        const th = document.createElement("th");
        th.textContent = h;
        tr.appendChild(th);
      }
      thead.appendChild(tr);
    }

    let resultOffset = 0;
    let resultSeq = 0; // guards a slow page landing after Back → reopen

    function appendRows(rows) {
      for (const row of rows) {
        const tr = document.createElement("tr");
        const name = document.createElement("td");
        name.className = "cb-primary-name";
        name.textContent = row.label;
        tr.appendChild(name);
        for (const c of cols) {
          const td = document.createElement("td");
          const v = row.values?.[c.fn];
          // `display` is the adapter's richer column kind (feed descriptors
          // carry usd/percent) — same formatters as the browse modal, so a
          // sub-cent price never flattens to "0".
          td.textContent = v === null || v === undefined ? "—"
            : c.display === "usd" ? fmtUsd(Number(v))
            : c.display === "percent" ? fmtPercent(Number(v))
            : c.kind === "date" ? new Date(v).toLocaleDateString()
            : c.kind === "number" ? fmtNumber(Number(v))
            : String(v);
          tr.appendChild(td);
        }
        const status = document.createElement("td");
        status.className = "cb-col-add";
        if (row.ingested) {
          const span = document.createElement("span");
          span.className = "cb-on-board";
          span.textContent = "Ingested";
          status.appendChild(span);
        }
        tr.appendChild(status);
        tbody.appendChild(tr);
      }
    }

    async function loadPage() {
      const mySeq = resultSeq;
      moreBtn.disabled = true;
      note.style.display = "none";
      try {
        const r = await fetch(`/api/boards/${state.boardId}/ingest/preview`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...previewConfig(), sample: { offset: resultOffset, limit: PAGE_SIZE } }),
        });
        const data = await r.json().catch(() => ({}));
        if (mySeq !== resultSeq) return;
        if (!r.ok) {
          note.textContent = data.error || "Preview failed";
          note.style.display = "";
          return;
        }
        appendRows(data.sample || []);
        resultOffset += (data.sample || []).length;
        moreBtn.style.display = data.hasMore ? "" : "none";
        if (!data.hasMore) {
          note.textContent = !tbody.children.length
            ? "Nothing matches."
            : data.capped ? "Showing the first 1000 scanned — narrow the filters for an exact view." : "";
          note.style.display = note.textContent ? "" : "none";
        }
      } catch {
        if (mySeq === resultSeq) {
          note.textContent = "Preview failed";
          note.style.display = "";
        }
      } finally {
        moreBtn.disabled = false;
      }
    }
    moreBtn.addEventListener("click", loadPage);

    function showResults() {
      resultSeq++;
      resultOffset = 0;
      tbody.replaceChildren();
      moreBtn.style.display = "none";
      settingsView.style.display = "none";
      footerSettings.style.display = "none";
      resultsView.style.display = "flex";
      footerResults.style.display = "flex";
      dialog.classList.add("results");
      titleEl.textContent = "Ingestion preview";
      loadPage();
    }
    function showSettings() {
      resultSeq++;
      resultsView.style.display = "none";
      footerResults.style.display = "none";
      settingsView.style.display = "flex";
      footerSettings.style.display = "flex";
      dialog.classList.remove("results");
      titleEl.textContent = "Automatic ingestion";
    }

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "ghost";
    backBtn.textContent = "← Back to settings";
    backBtn.addEventListener("click", showSettings);
    footerResults.appendChild(backBtn);

    // ── Footer (settings view) ──
    if (canEdit) {
      const saveBtn = document.createElement("button");
      saveBtn.textContent = "Save";
      saveBtn.addEventListener("click", async () => {
        // Preview quietly skips an unfinished filter row, but saving that way
        // would flip "matches nothing yet" into "matches everything" on the
        // next run — refuse and point at the row instead.
        const unfinished = cfg.filters.find(unfinishedFilter);
        if (unfinished) {
          const label = (desc.filters || []).find((c) => c.fn === unfinished.fn)?.label || unfinished.fn;
          toast.error(`The "${label}" filter has no value — fill it in or remove it`);
          return;
        }
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
          // The PATCH that just succeeded is the truth about enabled-ness —
          // stamp it locally first, so a dropped refetch can't leave the poll
          // cadence and chip behind the save.
          state.boardIngest = !!payload.enabled;
          ensurePolling();
          document.dispatchEvent(new Event("app:render"));
          refreshBoardIngest(); // refines the next-run stamp
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
          // The route just armed next_run_at = now — no refetch needed. The
          // chip flips to "now" on its next tick, and its own expiry refetch
          // follows the sweep from there.
          state.boardIngestNextRun = Date.now();
          toast("Ingestion run queued");
        } catch {
          toast.error("Run failed");
        }
      });
      footerSettings.append(saveBtn, runBtn);
    } else {
      const note = document.createElement("p");
      note.style.cssText = "font-size:12px;color:#8a8a92;margin:0;";
      note.textContent = "Only board admins can edit ingestion.";
      footerSettings.appendChild(note);
    }
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
