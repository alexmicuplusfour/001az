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
import { createModal, sectionHeadingEl } from './modal.js';
import { pagedTableScaffold, fmtUsd, fmtNumber, fmtPercent, ALIGN_END } from './paged-table.js';
import { switchRow } from './board-modal.js';
import { openSourceBrowse } from './source-browse-modal.js';
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

  fetch(`/api/boards/${state.boardId}/ingest`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then((info) => {
      loading.remove();
      build(info);
    })
    .catch((status) => {
      // The config carries server folder paths, so the GET is manager-gated —
      // plain members get told why instead of a generic failure.
      loading.textContent = status === 403
        ? "Only board admins can view ingestion settings."
        : "Failed to load ingestion settings.";
    });

  function build(info) {
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
    // Per-source field defaults are seeded per SELECTED source (each source has
    // its own field schema) inside buildFileSource — not here, where the source
    // isn't chosen yet.

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

    // ── Source ──
    // File boards get a source picker (local folder / FTP / S3, whichever are
    // installed), each with its own fields; connector boards feed from their
    // connector's universe and have nothing to configure. info.sources is the
    // installed source backends (+ pickable connections); null on a connector.
    const srcSection = section("Source");
    if (info.sources) {
      buildFileSource(srcSection);
    } else {
      const note = document.createElement("p");
      note.className = "im-hint";
      note.textContent = "This board feeds from its connector's universe — nothing to configure.";
      srcSection.appendChild(note);
    }
    settingsView.appendChild(srcSection);

    // The file-source picker + the selected source's fields. cfg.source carries
    // { type, folder|path, recursive, connectionId? } — type absent = folder.
    // Layout: a compact "Pull from" line (source type + connection, inline) over
    // a focused Folder block (path field + Browse) and the subfolders toggle —
    // the folder is the thing you actually set, so it gets the emphasis.
    function buildFileSource(host) {
      const sources = info.sources;
      if (!cfg.source.type) cfg.source.type = "folder";
      if (!sources.some((s) => s.type === cfg.source.type)) cfg.source.type = sources[0].type;
      const current = () => sources.find((x) => x.type === cfg.source.type) || sources[0];
      // Fill the selected source's field defaults (e.g. recursive:true) for
      // anything the saved config left unset — each source carries its own
      // schema (info.sources[].sourceSchema), so this is per-source, not shared.
      const seedSourceDefaults = (s) => {
        for (const f of s?.sourceSchema || [])
          if (f.default !== undefined && cfg.source[f.key] === undefined) cfg.source[f.key] = f.default;
      };
      seedSourceDefaults(current());

      // "Pull from" line: the source-type picker (only when there's a choice) and,
      // for a remote source, the connection picker — both inline on one row.
      const pullRow = document.createElement("div");
      pullRow.className = "im-row";
      const pullLbl = document.createElement("label");
      pullLbl.textContent = "Pull from";
      pullRow.append(pullLbl);

      if (sources.length > 1) {
        const typeSel = document.createElement("select");
        typeSel.setAttribute("aria-label", "Source type");
        for (const s of sources) {
          const o = document.createElement("option");
          o.value = s.type;
          o.textContent = s.label;
          if (s.type === cfg.source.type) o.selected = true;
          typeSel.appendChild(o);
        }
        typeSel.disabled = !canEdit;
        typeSel.addEventListener("change", () => {
          const next = sources.find((x) => x.type === typeSel.value) || sources[0];
          // A source switch is a fresh source config (keep only recursive intent).
          cfg.source = { type: typeSel.value, recursive: cfg.source.recursive !== false };
          seedSourceDefaults(next);
          // Remote sources CAN watch continuously, but a 30s poll against a
          // network source is rarely wanted — nudge a carried-over "continuous"
          // to interval. A default, not a law: continuous stays in the dropdown.
          if (next.needsConnection && cfg.trigger.mode === "continuous") cfg.trigger.mode = "interval";
          renderConn();
          renderDetail();
          renderTriggerModes(); // the new source may offer different modes
          invalidatePreview();
        });
        pullRow.appendChild(typeSel);
      }

      let connSel = null;
      function renderConn() {
        if (connSel) { connSel.remove(); connSel = null; }
        const s = current();
        if (!s.needsConnection || !s.connections || !s.connections.length) return;
        // Default to — or repair a dangling saved id to — the first connection,
        // so the select's value and cfg.source.connectionId always agree.
        if (!s.connections.some((c) => String(c.id) === String(cfg.source.connectionId)))
          cfg.source.connectionId = s.connections[0].id;
        connSel = document.createElement("select");
        connSel.setAttribute("aria-label", "Connection");
        for (const c of s.connections) {
          const o = document.createElement("option");
          o.value = String(c.id);
          o.textContent = c.label;
          connSel.appendChild(o);
        }
        connSel.value = String(cfg.source.connectionId);
        connSel.disabled = !canEdit;
        connSel.addEventListener("change", () => { cfg.source.connectionId = Number(connSel.value); invalidatePreview(); });
        pullRow.appendChild(connSel);
      }
      renderConn();
      host.appendChild(pullRow);
      // Nothing to pick (single source, no connection) → drop the empty row.
      if (!pullRow.querySelector("select")) pullRow.style.display = "none";

      const detail = document.createElement("div");
      detail.style.cssText = "display:flex;flex-direction:column;gap:6px;";
      host.appendChild(detail);

      function renderDetail() {
        detail.replaceChildren();
        const s = current();
        if (s.type === "folder" && (!info.root || !s.ready)) {
          const warn = document.createElement("p");
          warn.className = "mm-face-hint";
          warn.textContent = "The server has no ingestion root configured (INGEST_ROOT), so folder ingestion is unavailable.";
          detail.appendChild(warn);
          return;
        }
        if (s.needsConnection && (!s.connections || !s.connections.length)) {
          const note = document.createElement("p");
          note.className = "im-hint";
          note.textContent = `No ${s.label} connections yet — an admin adds them on the Plugins page.`;
          detail.appendChild(note);
          return;
        }
        renderFolderBlock(detail, s);
      }
      renderDetail();
    }

    // The focused Folder block: a "Folder" label over a full-width path field +
    // Browse (the tree modal), then the subfolders toggle. `key` is where the
    // base path lives on cfg.source (local folder keeps `folder`; remote uses
    // `path`); blank = the source's root.
    function renderFolderBlock(host, s) {
      const key = s.type === "folder" ? "folder" : "path";

      const lbl = document.createElement("div");
      lbl.className = "im-sublabel";
      lbl.textContent = "Folder";
      host.appendChild(lbl);

      const row = document.createElement("div");
      row.className = "im-source-path";
      const pathIn = document.createElement("input");
      pathIn.type = "text";
      pathIn.placeholder = "blank = the whole source";
      pathIn.value = cfg.source[key] || "";
      pathIn.disabled = !canEdit;
      pathIn.addEventListener("input", () => { cfg.source[key] = pathIn.value; invalidatePreview(); });
      const browseBtn = document.createElement("button");
      browseBtn.type = "button";
      browseBtn.className = "im-btn";
      browseBtn.textContent = "Browse…";
      browseBtn.disabled = !canEdit || !s.browsable || (s.needsConnection && cfg.source.connectionId == null);
      browseBtn.addEventListener("click", () => {
        openSourceBrowse({
          boardId: state.boardId,
          source: { type: s.type, connectionId: cfg.source.connectionId },
          start: cfg.source[key] || "",
          onPick: (picked) => { cfg.source[key] = picked; pathIn.value = picked; invalidatePreview(); },
        });
      });
      row.append(pathIn, browseBtn);
      host.appendChild(row);

      host.appendChild(inertUnlessEditable(switchRow("Include subfolders", null, cfg.source.recursive !== false, (on) => {
        cfg.source.recursive = on;
        invalidatePreview();
      }, { small: true })));
    }

    // The trigger modes offered for the currently-selected source (file boards
    // read them per source; connector boards fall back to the shared descriptor).
    function sourceTriggerModes() {
      if (!info.sources) return desc.triggerModes || [];
      const s = info.sources.find((x) => x.type === (cfg.source.type || "folder"));
      return s?.triggerModes || desc.triggerModes || [];
    }

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
    modeSel.setAttribute("aria-label", "Trigger");
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

    // A gentle note when watching continuously — chattier against a remote source.
    const trigHint = document.createElement("p");
    trigHint.className = "im-hint";
    const currentSource = () => (info.sources || []).find((x) => x.type === (cfg.source.type || "folder"));

    function syncTriggerInputs() {
      everyInput.style.display = cfg.trigger.mode === "interval" ? "" : "none";
      atInput.style.display = cfg.trigger.mode === "daily" ? "" : "none";
      if (cfg.trigger.mode !== "continuous") { trigHint.style.display = "none"; return; }
      trigHint.style.display = "";
      trigHint.textContent = currentSource()?.needsConnection
        ? "Continuous re-checks the source about every 30s — fine for your own server, but a busy poll on a remote source. Interval is gentler."
        : "Continuous re-checks the folder about every 30s.";
    }
    // Trigger modes come from the selected source (all sources offer all modes;
    // remote just defaults away from continuous). Rebuilt when the source
    // switches; a mode the new source doesn't list falls to its first mode.
    function renderTriggerModes() {
      const modes = sourceTriggerModes();
      if (!modes.includes(cfg.trigger.mode)) cfg.trigger.mode = modes[0] || "manual";
      modeSel.replaceChildren();
      for (const m of modes) {
        const o = document.createElement("option");
        o.value = m;
        o.textContent = TRIGGER_LABELS[m] || m;
        if (m === cfg.trigger.mode) o.selected = true;
        modeSel.appendChild(o);
      }
      syncTriggerInputs();
    }
    modeSel.addEventListener("change", () => { cfg.trigger.mode = modeSel.value; syncTriggerInputs(); });
    everyInput.addEventListener("input", () => { cfg.trigger.every = Number(everyInput.value); });
    atInput.addEventListener("input", () => { cfg.trigger.at = atInput.value; });
    renderTriggerModes();
    trigRow.append(modeSel, everyInput, atInput);
    trigSection.appendChild(trigRow);
    trigSection.appendChild(trigHint);
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

    // Columns straight from the catalog: the label as "Item", then the fields
    // the source flagged for preview (`preview` on its browse/file catalog) —
    // each source owns its own compact set, so nothing arbitrary gets sliced off
    // and a headline field like volume can't silently vanish. A source that
    // flags none falls back to every non-name field. A trailing status column
    // marks rows the ledger already holds (a run skips them), so the "N new"
    // promise on the count button is traceable in the list.
    const nonName = (desc.filters || []).filter((c) => c.fn !== "name");
    const flagged = nonName.filter((c) => c.preview);
    const cols = flagged.length ? flagged : nonName;
    // Alignment keys off the same kind the cell formatter uses: `display`
    // when the descriptor carries one (usd/percent), else the filter kind.
    const alignEnd = (c) => ALIGN_END.has(c.display || c.kind);
    {
      const tr = document.createElement("tr");
      const itemTh = document.createElement("th");
      itemTh.textContent = "Item";
      tr.appendChild(itemTh);
      for (const c of cols) {
        const th = document.createElement("th");
        th.textContent = c.label;
        if (alignEnd(c)) th.className = "cb-end";
        tr.appendChild(th);
      }
      tr.appendChild(document.createElement("th")); // status column
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
          if (alignEnd(c)) td.className = "cb-end";
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
          // The scanned depth is whatever the walk actually reached, not a
          // constant — the server ships the number it enumerated to. Only a
          // safety backstop or an operator's INGEST_FEED_CAP stops it short,
          // so this line is now rare rather than routine.
          const scanned = Number(data.scanned) || 0;
          note.textContent = !tbody.children.length
            ? "Nothing matches."
            : data.capped
              ? `Showing the first ${scanned ? `${scanned.toLocaleString()} ` : ""}scanned — narrow the filters for an exact view.`
              : "";
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
    const t = sectionHeadingEl(title);
    t.style.marginBottom = "12px"; // the caps title's old spacing to the section content
    el.appendChild(t);
    return el;
  }
}
