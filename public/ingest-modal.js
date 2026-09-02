// The ingestion modal: per-board source + filters + sort/limit + trigger, with
// an on-demand results preview. Fully descriptor-driven — the
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
import { fmtDuration, glyphEl, fmtUsd, relTime } from './utils.js';
import { toast } from './toast.js';
import { createModal, sectionHeadingEl, createDrawer, tileRow, busy } from './modal.js';
import { pagedTableScaffold, fmtNumber, fmtPercent, ALIGN_END } from './paged-table.js';
import { switchRow } from './board-modal.js';
import { openDropdown, ddRow, ddNote } from './dropdown.js';
import { openSourceChooser, pathKeyFor, sourceGlyph, fmtLocation, sourceRootLabel } from './source-chooser.js';
import { stampBoardIngest, ensurePolling } from './data.js';

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
  // "Off" rather than "Manual only": in a modal about AUTOMATIC ingestion the
  // trigger is the automatic part, so no trigger is the feature switched off —
  // the board still ingests, but only when Run now says so.
  manual: "Off",
  continuous: "Continuous (watch)",
  interval: "Every N minutes",
  daily: "Daily at a set time",
};
const PAGE_SIZE = 50;


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

    // Buffered config — edits stay local until Save. (Where a source keeps
    // its base path — `folder` vs `path` — is pathKeyFor, the source
    // module's one spelling of that rule.)
    const saved = info.config;
    const cfg = {
      // An existing config keeps its saved state (only an explicit false =
      // paused); picking the "Off" trigger forces this true, since a board
      // with no timer has nothing to hold (see syncTriggerInputs).
      enabled: saved ? saved.enabled !== false : false,
      source: { ...(saved?.source || {}) },
      filters: (saved?.filters || []).map((f) => ({ ...f })),
      sort: saved?.sort ? { ...saved.sort } : { by: desc.sorts?.[0]?.by, order: "desc" },
      limit: saved?.limit ?? null,
      // A board with no saved config opens with the trigger OFF. Automatic
      // ingestion is opt-in, and the old default — Continuous pre-selected but
      // held Paused — read as saved state ("it's on and paused?!") on every
      // unconfigured board. Off says the truth in one word, and it moves the
      // arming consent to the right place: a schedule present at Save time was
      // chosen by hand, so Save arming it is what the user asked for (the Off
      // state's enabled-normalization has already cleared the pause by then).
      // A feed adapter without "manual" starts on its first declared mode —
      // defaulting outside the descriptor would make Save fail validation.
      trigger: saved?.trigger
        ? { ...saved.trigger }
        : { mode: (desc.triggerModes || []).includes("manual") ? "manual" : (desc.triggerModes?.[0] || "manual") },
    };
    // The source block treats an ABSENT path key as "no source added yet". A
    // saved config is an added source even when its key is absent (a legacy
    // root-watch saved as bare `{type}`): normalize the historical
    // type-absent-means-folder and a missing key to "" so the modal renders
    // what the sweep actually does — only a truly unconfigured board opens
    // with nothing added.
    if (saved?.source) {
      if (!cfg.source.type) cfg.source.type = "folder";
      const k = pathKeyFor(cfg.source.type);
      if (cfg.source[k] === undefined) cfg.source[k] = "";
    }
    // "Is there a source to scan?" — the preview and Save both refuse to act
    // on a file board with no added path (acting would implicitly mean "the
    // whole ingest root", the exact presumption the add step exists to kill).
    const sourceAdded = () => !info.sources || cfg.source[pathKeyFor(cfg.source.type)] !== undefined;
    // Per-kind field defaults are seeded at chooser COMMIT (each kind carries
    // its own schema) — not here, where no kind is chosen yet.

    // Two views in one modal: settings (the config sections) and results (the
    // paged preview list). Swapping views detaches nothing — all edit state
    // lives on in the settings DOM while results are shown.
    const settingsView = document.createElement("div");
    settingsView.className = "im-settings";
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

    // The file-source block, on the mapping pane's Fields model: an added
    // source renders as a TILE — glyph, resolved location, quiet summary, × —
    // and everything that defines it (kind, connection, path, subfolders) is
    // chosen in the chooser drawer and committed by ONE click. cfg.source
    // carries { type, folder|path, recursive, connectionId? }; nothing added
    // = no path key (a saved legacy config normalizes above).
    let drawerInst = null;
    const drawer = () => (drawerInst ??= createDrawer(dialog));

    function buildFileSource(host) {
      const sources = info.sources;
      // Fill the committed kind's field defaults (a future schema field) for
      // anything the chooser didn't set explicitly — per-kind, from its own
      // schema (info.sources[].sourceSchema).
      const seedSourceDefaults = (sk) => {
        for (const f of sk?.sourceSchema || [])
          if (f.default !== undefined && cfg.source[f.key] === undefined) cfg.source[f.key] = f.default;
      };

      // Whether a kind can be picked at all. The reasons render as the add
      // menu's static rows (short form; full sentence on title) — or, when
      // NOTHING is usable, in place of the add button (full sentences).
      const usableKind = (sk) => (sk.type === "folder"
        ? !!(info.rootPath && sk.ready)
        : !sk.needsConnection || !!(sk.connections && sk.connections.length));
      const shortReason = (sk) => (sk.type === "folder"
        ? "needs INGEST_ROOT on the server"
        : "no connections yet — Plugins page");
      const fullReason = (sk) => (sk.type === "folder"
        ? "The server has no ingestion root configured (INGEST_ROOT), so folder ingestion is unavailable."
        : `No ${sk.label} connections yet — an admin adds them on the Plugins page.`);
      // What picking a usable kind means, in the menu's right-hand voice.
      const KIND_NOTES = {
        folder: "on the server's ingest root",
        ftp: "a folder on a server you connect to",
        s3: "a bucket prefix",
      };

      const wrap = document.createElement("div");
      wrap.style.cssText = "display:flex;flex-direction:column;gap:6px;";
      host.appendChild(wrap);

      // Kind settled (a menu pick, or the tile's saved one); everything else
      // is the chooser's — connection + path + subfolders, one atomic commit.
      function openChooser(sk) {
        const editing = sourceAdded() && cfg.source.type === sk.type;
        openSourceChooser({
          drawer: drawer(),
          boardId: state.boardId,
          source: sk,
          rootPath: info.rootPath || "",
          draft: editing
            ? {
                connectionId: cfg.source.connectionId,
                path: cfg.source[pathKeyFor(sk.type)] || "",
                recursive: cfg.source.recursive !== false,
              }
            : {},
          onCommit: (picked) => {
            // A commit is a fresh source config of the picked kind — nothing
            // from another kind survives it.
            cfg.source = {
              type: sk.type,
              ...(picked.connectionId !== undefined ? { connectionId: picked.connectionId } : {}),
              [pathKeyFor(sk.type)]: picked.path,
              ...(picked.recursive !== undefined ? { recursive: picked.recursive } : {}),
            };
            seedSourceDefaults(sk);
            // The schedule is NOT touched: a continuous trigger stays
            // continuous on a remote source. It can only be there because
            // the user set it (the default is Off), and the trigger hint
            // already says a 30s poll is busy against a network source —
            // inform, never override. (An earlier nudge to "interval" here
            // silently rewrote that explicit choice on every commit.)
            renderTriggerModes(); // the new kind may offer different modes
            invalidatePreview();
            renderSource();
            // The chooser's close() hands focus back to its opener, which
            // this render just detached — a no-op — so landing it on the new
            // tile here sticks.
            wrap.querySelector(".tile-main")?.focus?.({ preventScroll: true });
          },
        });
      }

      // "+ Add source" → the rich dropdown, in the add-field menu's grammar:
      // glyph, kind, a dim note. An unusable kind is a STATIC row (no
      // onClick — a line in a list, not a menu item) whose note says why.
      function openAddMenu(anchor) {
        openDropdown(anchor, {
          align: "start",
          width: "anchor",
          build: (menuBody, { close }) => {
            for (const sk of sources) {
              const lead = glyphEl(sourceGlyph(sk.type), false);
              lead.style.pointerEvents = "none";
              const ok = usableKind(sk);
              const row = ddRow({
                label: sk.label,
                leading: lead,
                trailing: ddNote(ok ? (KIND_NOTES[sk.type] ?? "") : shortReason(sk)),
                onClick: ok ? () => { close(); openChooser(sk); } : undefined,
              });
              if (!ok) row.title = fullReason(sk);
              menuBody.appendChild(row);
            }
          },
        });
      }

      // The silent health line: a limit-1 browse of the committed source that
      // renders ONLY a server-verdict error — an auto-check that announces
      // success answers a question nobody asked, and a transport blip has no
      // verdict to report. Eager (connectionless) kinds only: a dead FTP
      // server holds a 30s connect timeout, so remote saved paths surface
      // problems in the chooser (opening it IS the test) and in the sweep's
      // status line instead.
      async function probe(sk, health) {
        try {
          const r = await fetch(`/api/boards/${state.boardId}/ingest/source/browse`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              source: { type: sk.type, connectionId: cfg.source.connectionId },
              path: cfg.source[pathKeyFor(sk.type)] || "",
              limit: 1,
            }),
          });
          if (r.ok) return;
          const data = await r.json().catch(() => ({}));
          // isConnected: the tile re-rendered out from under a slow answer —
          // this line is no longer on screen, nothing to say.
          if (!data.error || !health.isConnected) return;
          health.classList.add("error");
          health.style.display = "";
          health.textContent = `✗ ${data.error}`;
        } catch { /* transport blip — no verdict, no line */ }
      }

      function renderTile() {
        const sk = sources.find((x) => x.type === cfg.source.type);
        const base = sk ? sourceRootLabel(sk, cfg.source.connectionId, info.rootPath) : "";
        const loc = fmtLocation(base, cfg.source[pathKeyFor(cfg.source.type)] || "");
        const recWord = cfg.source.recursive !== false ? "includes subfolders" : "this folder only";
        // A kind whose backend is gone (an uninstalled source plugin) still
        // renders and can still be removed — there's just no chooser to open
        // for it, since we don't know what it would ask. (The old type select
        // silently re-aimed such a config at the first installed kind — an
        // implied choice.)
        wrap.appendChild(tileRow({
          glyph: sourceGlyph(cfg.source.type),
          ai: false,
          name: loc,
          sum: `${sk ? sk.label : `${cfg.source.type} (not installed)`} · ${recWord}`,
          title: loc,
          onOpen: canEdit && sk ? () => openChooser(sk) : null,
          onRemove: canEdit
            ? () => {
                cfg.source = {};
                invalidatePreview();
                renderSource();
              }
            : null,
          removeLabel: "Remove source",
          removeTitle: "Remove this source — save afterwards to turn ingestion off for this board",
        }));
        const health = document.createElement("p");
        health.className = "im-status tight";
        health.style.display = "none";
        wrap.appendChild(health);
        // Silent existence check whenever the tile stands (open, commit) —
        // only bad news renders.
        if (sk && !sk.needsConnection) probe(sk, health);
      }

      function renderSource() {
        wrap.replaceChildren();
        if (sourceAdded()) {
          renderTile();
          return;
        }
        if (!canEdit) {
          const note = document.createElement("p");
          note.className = "im-hint";
          note.textContent = "No source configured.";
          wrap.appendChild(note);
          return;
        }
        const usable = sources.filter(usableKind);
        if (!usable.length) {
          // Nothing pickable: the reasons stand where the button would — a
          // menu of only-static rows would be a click into a dead end.
          for (const sk of sources) {
            const note = document.createElement("p");
            note.className = sk.type === "folder" ? "warn-box" : "im-hint";
            note.textContent = fullReason(sk);
            wrap.appendChild(note);
          }
          return;
        }
        const add = document.createElement("button");
        add.type = "button";
        add.className = "fe-add-facet";
        add.textContent = "+ Add source";
        // One installed kind = nothing to ask — straight to the chooser, the
        // same rule that used to hide the one-option type select.
        add.addEventListener("click", () => {
          if (sources.length === 1) openChooser(sources[0]);
          else openAddMenu(add);
        });
        wrap.appendChild(add);
      }

      renderSource();
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
    const trigSection = section("Trigger schedule");
    const trigRow = document.createElement("div");
    trigRow.className = "im-row";
    const modeSel = document.createElement("select");
    modeSel.setAttribute("aria-label", "Trigger schedule");
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

    // A pause on the SCHEDULE — the one thing `enabled` decides is whether the
    // timer re-arms itself, so the control rides on the same line as the
    // schedule it holds, pushed right. Inverted against `enabled`: the switch
    // reads as the hold, not as the running. Trigger "Off" has no timer to
    // hold, so the control drops out there entirely.
    const pauseRow = inertUnlessEditable(switchRow("Paused", null, !cfg.enabled, (on) => {
      cfg.enabled = !on;
    }, { small: true }));
    pauseRow.style.marginLeft = "auto";

    function syncTriggerInputs() {
      everyInput.style.display = cfg.trigger.mode === "interval" ? "" : "none";
      atInput.style.display = cfg.trigger.mode === "daily" ? "" : "none";
      // "Off" has no timer, so the flag has nothing to hold. The server
      // normalizes it to enabled on save; mirror that here so the hidden knob
      // can't drift from what will be stored — otherwise coming back to a
      // schedule shows a pause the save is about to discard.
      const off = cfg.trigger.mode === "manual";
      if (off) { cfg.enabled = true; pauseRow.setSwitch(false); }
      pauseRow.style.display = off ? "none" : "";
      if (cfg.trigger.mode !== "continuous") { trigHint.style.display = "none"; return; }
      trigHint.style.display = "";
      trigHint.textContent = currentSource()?.needsConnection
        ? "Continuous re-checks the source about every 30s — fine for your own server, but a busy poll on a remote source; after an error it retries every 5 minutes. Interval is gentler."
        : "Continuous re-checks the folder about every 30s (after an error, every 5 minutes until it recovers).";
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
    trigRow.append(modeSel, everyInput, atInput, pauseRow);
    trigSection.append(trigRow, trigHint);
    settingsView.appendChild(trigSection);

    // ── Preview: a button fetches the count; the count opens the results view ──
    const prevSection = section("Preview");
    const prevRow = document.createElement("div");
    prevRow.className = "im-row";
    const previewBtn = document.createElement("button");
    previewBtn.type = "button";
    previewBtn.className = "im-btn";
    previewBtn.textContent = "Preview";
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

    previewBtn.addEventListener("click", busy(previewBtn, async () => {
      // No source added = nothing to scan. Without this gate the preview
      // would fall through to "blank path" and scan the whole ingest root —
      // the exact presumption the add step exists to kill.
      if (!sourceAdded()) {
        toast.error("Add a source first — there's nothing to preview.");
        return;
      }
      const mySeq = ++previewSeq;
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
      }
    }));
    countBtn.addEventListener("click", showResults);

    // Only send filters the user has finished typing (a value-less filter
    // matches nothing server-side, which reads as a broken preview).
    const unfinishedFilter = (f) => f.value === "" || f.value === null || f.value === undefined;
    // The MATCH half of the config — what preview dry-runs. No trigger: the
    // schedule has no bearing on what matches, and a half-typed "every N
    // minutes" must not block a preview. Save adds it back (and the server
    // validates it there).
    function previewConfig() {
      return {
        source: cfg.source,
        filters: cfg.filters.filter((f) => !unfinishedFilter(f)),
        sort: cfg.sort,
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
        // No source added: with a saved config this is the remove gesture —
        // Save clears the board's ingestion outright (ingest: null). With
        // nothing saved either, there's nothing to write; saving the config
        // anyway would mean "watch the whole ingest root", the presumption
        // the add step exists to kill.
        let body;
        let okToast = "Ingestion saved";
        if (!sourceAdded()) {
          if (!saved) {
            toast.error("Add a source first — nothing to save.");
            return;
          }
          body = { ingest: null };
          okToast = "Ingestion removed";
        } else {
          // Preview quietly skips an unfinished filter row, but saving that
          // way would flip "matches nothing yet" into "matches everything" on
          // the next run — refuse and point at the row instead.
          const unfinished = cfg.filters.find(unfinishedFilter);
          if (unfinished) {
            const label = (desc.filters || []).find((c) => c.fn === unfinished.fn)?.label || unfinished.fn;
            toast.error(`The "${label}" filter has no value — fill it in or remove it`);
            return;
          }
          body = {
            ingest: {
              ...previewConfig(),
              trigger: cfg.trigger.mode ? cfg.trigger : { mode: "manual" },
              enabled: cfg.enabled,
            },
          };
        }
        try {
          const r = await fetch(`/api/boards/${state.boardId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) {
            toast.error(data.error || "Save failed");
            return;
          }
          // The PATCH answers with the mode and next-run stamp it landed on —
          // including the arming this save just did, and any normalization it
          // applied — so the chip and the poll cadence follow exactly what was
          // stored, with no second derivation here and no confirming refetch.
          // Only stamp if the pair actually arrived: a 200 whose body didn't
          // survive the trip would otherwise blank a chip the save just kept.
          if (data.ingest_mode !== undefined) stampBoardIngest(data);
          ensurePolling();
          document.dispatchEvent(new Event("app:render"));
          toast(okToast);
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
