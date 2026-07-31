import { toast } from './toast.js';
import { openDropdown, ddRow, ddSep } from './dropdown.js';
import { ICONS } from './utils.js';
import { loadProviders, byName, syncModelPicker, switchRow } from './board-modal.js';
import { sectionHeadingEl } from './modal.js';

const KINDS = ["text", "number", "url", "date"];
// Liveness cadence choices (minutes). 0 = Off (the field is fetched once at add
// and never refreshed). "How often the field updates in the app" — the sweep
// re-fetches the whole entity but only rewrites fields whose cadence elapsed.
const CADENCES = [[0, "Off"], [1, "1 min"], [5, "5 min"], [15, "15 min"], [60, "1 hour"], [360, "6 hours"], [1440, "1 day"]];

// Builds the entity-mapping editor into `container` — a pane inside the board
// modal (board-modal.js), which owns the modal chrome + the single Save button.
// Returns { isDirty, collect }: the host folds collect()'s payload into its one
// PATCH/POST. Fully parameterized (no gallery-state reads), so it works on
// admin.html and for not-yet-created boards:
//   isAdmin  — editable pane + extraction row; false = read-only view
//   mapping  — the board's current mapping (null for a new/unmapped board)
//   hasItems — locks the connector-template picker (templates rewire the whole
//              mapping, only sane while the board is empty)
//   extract  — { keyId, model } stored extraction override (admin), or null
export function buildMappingPane({ container, isAdmin = false, mapping = null, hasItems = false, extract = null }) {
  // Any user edit flips the pane dirty, so a pure-tagging save omits `mapping`
  // and doesn't needlessly re-run the server's reschedule/backfill.
  let dirty = false;
  const markDirty = () => { dirty = true; };
  // Clone current mapping so edits are buffered until Save.
  let fields = (mapping?.fields || []).map((f) => ({ ...f }));
  let identityFrom = mapping?.identity?.from || "raw";
  let identityHint = mapping?.identity?.hint || "";
  // Classify mode (Slice 3): a declared list of allowed answers. Its presence is
  // the mode; `classifyOn` just drives the reveal so an on-with-empty state is
  // distinguishable (and blocked at save) from off.
  let candidates = (mapping?.identity?.candidates || []).map((c) => ({ ...c }));
  let classifyOn = candidates.length > 0;
  let inputConnector = mapping?.input?.connector || null; // set when a connector template is loaded
  let connectorCatalog = null;   // the active connector's full field set (manifest.fields)
  let fileFieldCatalog = null;   // file-metadata field catalog (server/media) — file boards only
  let connectorFaces = [];       // the connector's face producers (with per-provider availability)
  let connectorLabel = null;
  let connectorProviders = [];   // [{ name, label, needsKey }] — for naming providers in hints
  let connectorActiveProvider = null; // the backend currently resolving this connector
  let faceCfg = { ...(mapping?.face || { from: "raw" }) }; // the entity's card visual

  // Extraction provider — the stored override arrives via `extract` (the host
  // already has it); only the key/catalog registry is fetched here. extractLoaded
  // gates the save payload: until that fetch lands, the save omits extract
  // fields so a quick Save can't wipe a stored override.
  let extractKeyId = extract?.keyId ?? null;
  let extractModel = extract?.model ?? null;
  let extractKeySel = null;
  let extractModelSel = null;
  let extractLoaded = false;

  // The host (board-modal) provides a flex-column container and owns its
  // visibility via the Mapping/Tagging toggle — so we never set `display` here,
  // where an inline display:flex would defeat the host's display:none.
  // Real data edits (text/select/checkbox) fire input/change; button-driven
  // mutations (add/remove/apply-template) call markDirty() at their handlers.
  container.addEventListener("input", markDirty, true);
  container.addEventListener("change", markDirty, true);
  const body = container;

  // Template row — very top of the body, right-aligned, divider below.
  // Applying a connector template rewires the whole mapping (input, identity,
  // fields) in one click — which only makes sense while the board is empty:
  // existing items were ingested under the current input source, so once the
  // first item lands the picker locks (no switching to a connector, no
  // removing one that's already feeding the board).
  if (isAdmin) {
    const templateRow = document.createElement("div");
    templateRow.className = "mm-template-row";
    const templateLabel = document.createElement("span");
    templateLabel.className = "mm-template-label";
    templateLabel.textContent = "Template";
    const loadBtn = document.createElement("button");
    loadBtn.className = "mm-template-btn";
    loadBtn.textContent = inputConnector ? `Connector: ${inputConnector}` : "Load template…";
    if (hasItems) {
      loadBtn.disabled = true;
      const why = inputConnector
        ? "This board already has items, so its connector template can't be changed or removed. Create a new board to use a different template."
        : "This board already has items, so a template can't be applied — its items came from file uploads. Create a new board to start from a template.";
      loadBtn.title = why;
      templateRow.title = why;
    } else loadBtn.addEventListener("click", async () => {
      loadBtn.disabled = true;
      let connectors;
      try {
        connectors = await fetch("/api/connectors").then((r) => r.json());
      } catch {
        toast.error("Failed to load connectors");
        return;
      } finally {
        loadBtn.disabled = false;
      }
      if (!connectors.length) { toast.info("No connectors available"); return; }
      openDropdown(loadBtn, {
        align: "start",
        minWidth: 180,
        build: (menuBody, { close }) => {
          for (const c of connectors) {
            menuBody.appendChild(ddRow({
              label: c.label,
              onClick: () => {
                applyTemplate(c);
                loadBtn.textContent = `Connector: ${c.name}`;
                close();
              },
            }));
          }
        },
      });
    });
    templateRow.append(templateLabel, loadBtn);
    body.appendChild(templateRow);
  }

  // Explanation + identity anchor
  const intro = document.createElement("div");
  intro.className = "mm-intro";
  intro.innerHTML =
    "<p>Define structured fields for each item. Connector fields come from a live " +
    "data source; AI fields are extracted from the item's content.</p>";
  body.appendChild(intro);

  // Identity row — always present. Raw/AI are hand-switchable; connector-bound
  // identity renders locked with a badge, matching the connector field rows.
  const identityRow = document.createElement("div");

  function renderIdentityRow() {
    const isConnectorId = identityFrom === "connector";
    identityRow.className = "mm-row" + (isConnectorId ? " mm-row-connector" : "");
    identityRow.replaceChildren();

    const idControls = document.createElement("div");
    idControls.className = "fe-head";

    const idKey = document.createElement("span");
    idKey.className = "mm-key-locked";
    idKey.textContent = "identity";
    idControls.appendChild(idKey);

    if (isConnectorId) {
      // Locked, badge-styled — same pattern as the connector field rows below.
      const badge = document.createElement("span");
      badge.className = "mm-connector-badge";
      badge.textContent = `${inputConnector}:id`;
      idControls.appendChild(badge);
      identityRow.appendChild(idControls);
      return;
    }

    const idSrcSel = document.createElement("select");
    idSrcSel.disabled = !isAdmin;
    [["raw", "filename (raw)"], ["ai", "AI instruction"]].forEach(([val, label]) => {
      const opt = document.createElement("option");
      opt.value = val; opt.textContent = label;
      if (val === identityFrom) opt.selected = true;
      idSrcSel.appendChild(opt);
    });
    idControls.appendChild(idSrcSel);

    const idHintWrap = document.createElement("div");
    idHintWrap.style.cssText = "margin-top:6px;display:" + (identityFrom === "ai" ? "block" : "none") + ";";
    const idHint = document.createElement("textarea");
    idHint.placeholder = "What to extract as the item's title — any format (e.g. \"the person's full name\", \"invoice month, as Month - YYYY\")";
    idHint.rows = 2;
    idHint.value = identityHint;
    idHint.disabled = !isAdmin;
    idHint.addEventListener("input", () => { identityHint = idHint.value; });
    idHintWrap.appendChild(idHint);

    // Classify mode: a "Match to a list" toggle that reveals a flat editor of
    // allowed options (value + optional per-option hint). Off = open extraction,
    // exactly as before. Reuses the tagging value-editor's fe-* styling so it
    // reads the same as the Tagging tab. Shown only under AI instruction.
    const classifyWrap = document.createElement("div");
    classifyWrap.style.cssText = "margin-top:8px;display:" + (identityFrom === "ai" ? "block" : "none") + ";";

    const candidatesBox = document.createElement("div");
    candidatesBox.className = "fe-root";
    candidatesBox.style.cssText = "margin-top:6px;display:" + (classifyOn ? "block" : "none") + ";";

    function renderCandidates() {
      candidatesBox.replaceChildren();
      candidates.forEach((c, i) => {
        const rowEl = document.createElement("div");
        rowEl.className = "fe-val-row";
        rowEl.style.cssText = "gap:6px;";
        const valIn = document.createElement("input");
        valIn.placeholder = "option";
        valIn.value = c.value || "";
        valIn.disabled = !isAdmin;
        valIn.style.cssText = "flex:0 0 38%;";
        valIn.addEventListener("input", () => { c.value = valIn.value; });
        const hintIn = document.createElement("input");
        hintIn.placeholder = "hint (optional) — helps the AI tell options apart";
        hintIn.value = c.hint || "";
        hintIn.disabled = !isAdmin;
        hintIn.style.cssText = "flex:1;";
        hintIn.addEventListener("input", () => { c.hint = hintIn.value; });
        rowEl.append(valIn, hintIn);
        if (isAdmin) {
          const rm = document.createElement("button");
          rm.className = "fe-rm";
          rm.type = "button";
          rm.textContent = "×";
          rm.addEventListener("click", () => { candidates.splice(i, 1); markDirty(); renderCandidates(); });
          rowEl.appendChild(rm);
        }
        candidatesBox.appendChild(rowEl);
      });
      if (isAdmin) {
        const add = document.createElement("button");
        add.className = "fe-add-val";
        add.type = "button";
        add.textContent = "+ option";
        add.addEventListener("click", () => {
          candidates.push({ value: "", hint: "" });
          markDirty();
          renderCandidates();
          candidatesBox.querySelectorAll(".fe-val-row input").item((candidates.length - 1) * 2)?.focus();
        });
        candidatesBox.appendChild(add);
      }
    }
    renderCandidates();

    const classifyToggle = switchRow(
      "Match to a list",
      "constrain the answer to options you define — leave off to extract any value",
      classifyOn,
      (on) => {
        classifyOn = on;
        markDirty();
        candidatesBox.style.display = on ? "block" : "none";
        if (on && !candidates.length) { candidates.push({ value: "", hint: "" }); renderCandidates(); }
      },
      { small: true }
    );
    // Read-only pane: the switch has no disabled state of its own, so freeze it
    // to match the disabled inputs/selects elsewhere.
    if (!isAdmin) { classifyToggle.style.pointerEvents = "none"; classifyToggle.style.opacity = "0.6"; }
    classifyWrap.append(classifyToggle, candidatesBox);

    idSrcSel.addEventListener("change", () => {
      identityFrom = idSrcSel.value;
      const isAi = identityFrom === "ai";
      idHintWrap.style.display = isAi ? "block" : "none";
      classifyWrap.style.display = isAi ? "block" : "none";
      // A file board's face controls only make sense under derived identity
      // (several instances per entity), so they track this select — like the hint.
      renderFaceRow();
    });

    identityRow.append(idControls, idHintWrap, classifyWrap);
  }

  renderIdentityRow();
  body.appendChild(identityRow);

  // Face row — connector boards only, below identity (the face is ~mandatory).
  // Source = symbol tile (raw) or a connector face producer (e.g. price chart);
  // a chart adds a period select and the same cadence widget as fields.
  const faceRow = document.createElement("div");
  body.appendChild(faceRow);

  function renderFaceRow() {
    faceRow.replaceChildren();
    // File boards get a face row too (normalized): a read-only "File preview"
    // label that expands to instance-pick controls under derived identity.
    if (!inputConnector) { faceRow.style.display = ""; renderFileFaceRow(); return; }
    if (!connectorFaces.length) { faceRow.style.display = "none"; return; }
    faceRow.style.display = "";
    const isProducer = faceCfg.from === "connector";
    faceRow.className = "mm-row" + (isProducer ? " mm-row-connector" : "");

    const controls = document.createElement("div");
    controls.className = "fe-head";
    const key = document.createElement("span");
    key.className = "mm-key-locked";
    key.textContent = "face";
    controls.appendChild(key);

    const srcSel = document.createElement("select");
    srcSel.disabled = !isAdmin;
    const tile = document.createElement("option");
    tile.value = "raw"; tile.textContent = "Symbol tile";
    srcSel.appendChild(tile);
    for (const p of connectorFaces) {
      const opt = document.createElement("option");
      opt.value = p.name; opt.textContent = p.label;
      srcSel.appendChild(opt);
    }
    srcSel.value = isProducer ? faceCfg.producer : "raw";
    srcSel.addEventListener("change", () => {
      if (srcSel.value === "raw") faceCfg = { from: "raw" };
      else {
        const p = connectorFaces.find((x) => x.name === srcSel.value);
        const period = faceCfg.period && p.periods.includes(faceCfg.period) ? faceCfg.period
          : p.periods.includes("1y") ? "1y" : p.periods[0];
        faceCfg = { from: "connector", producer: p.name, period, ...(faceCfg.live ? { live: true, every: faceCfg.every } : {}) };
      }
      renderFaceRow();
    });
    controls.appendChild(srcSel);

    if (isProducer) {
      const producer = connectorFaces.find((x) => x.name === faceCfg.producer);
      const periodSel = document.createElement("select");
      periodSel.disabled = !isAdmin;
      periodSel.title = "Chart range";
      for (const per of producer?.periods || []) {
        const opt = document.createElement("option");
        opt.value = per; opt.textContent = per;
        periodSel.appendChild(opt);
      }
      periodSel.value = faceCfg.period;
      periodSel.addEventListener("change", () => { faceCfg.period = periodSel.value; });
      controls.append(periodSel, livenessSelect(faceCfg, true));
    }
    faceRow.appendChild(controls);

    // Warn when the chosen face can't be rendered by the connector's active
    // provider — cards silently fall back to the tile otherwise. Name the
    // provider and, if any others can render it, point the way to switch.
    if (isProducer) {
      const producer = connectorFaces.find((x) => x.name === faceCfg.producer);
      if (producer && producer.available === false) {
        const activeLabel = connectorProviders.find((p) => p.name === connectorActiveProvider)?.label || connectorActiveProvider || "The active provider";
        const capable = (producer.supportedBy || [])
          .filter((n) => n !== connectorActiveProvider)
          .map((n) => connectorProviders.find((p) => p.name === n)?.label || n);
        const hint = document.createElement("div");
        hint.className = "mm-face-hint";
        hint.textContent =
          `${activeLabel} can’t render this face — cards will show the symbol tile instead.` +
          (capable.length ? ` Switch to ${capable.join(" or ")} in Admin → Plugins to enable it.` : "");
        faceRow.appendChild(hint);
      }
    }
  }

  // A file board's face row. The face is always the "File preview" — the pretty
  // rendered face of one instance (mirroring identity's "filename (raw)"). Under
  // derived identity an entity can bundle several instances, so a second line
  // refines WHICH one supplies that preview: a preferred file type (image by
  // default) and, among those, first/latest added.
  function renderFileFaceRow() {
    faceRow.className = "mm-row";
    const controls = document.createElement("div");
    controls.className = "fe-head";
    const key = document.createElement("span");
    key.className = "mm-key-locked";
    key.textContent = "face";
    const label = document.createElement("span");
    label.className = "mm-locked-badge";
    label.textContent = "File preview";
    controls.append(key, label);
    faceRow.appendChild(controls);

    if (identityFrom !== "ai") return; // one instance per entity — nothing to pick

    const mkSel = (opts, val, title) => {
      const sel = document.createElement("select");
      sel.disabled = !isAdmin;
      sel.title = title;
      for (const [v, l] of opts) {
        const o = document.createElement("option");
        o.value = v; o.textContent = l;
        if (v === val) o.selected = true;
        sel.appendChild(o);
      }
      return sel;
    };
    const prefer = faceCfg.prefer && faceCfg.prefer !== "any" ? faceCfg.prefer : "image";
    const preferSel = mkSel(
      [["image", "Image"], ["document", "Document"], ["audio", "Audio"]],
      prefer, "Preferred file type for the preview");
    const pickSel = mkSel(
      [["first", "First added"], ["latest", "Latest added"]],
      faceCfg.pick || "first", "Which instance when several qualify");
    const sync = () => { faceCfg = { from: "file", prefer: preferSel.value, pick: pickSel.value }; };
    preferSel.addEventListener("change", sync);
    pickSel.addEventListener("change", sync);

    const sub = document.createElement("div");
    sub.className = "mm-face-prefer";
    const lbl = document.createElement("span");
    lbl.className = "mm-face-prefer-label";
    lbl.textContent = "Prefer (when available)";
    sub.append(lbl, preferSel, pickSel);
    faceRow.appendChild(sub);
  }

  const fieldsList = document.createElement("div");
  fieldsList.className = "mm-fields";

  // A liveness cadence select bound to a field object's live/every. Off (0)
  // clears them. Identity has no liveness (it's the stable key), so it never
  // gets one of these. The refresh glyph in front labels what the select does:
  // this is a re-fetch cadence, not just another dropdown.
  function livenessSelect(f, enabled) {
    const wrap = document.createElement("span");
    wrap.className = "mm-live-wrap";
    wrap.title = "How often this field refreshes in the app";

    const icon = document.createElement("span");
    icon.className = "mm-live-icon";
    icon.innerHTML = ICONS.redo;

    const sel = document.createElement("select");
    sel.className = "mm-live";
    sel.disabled = !isAdmin || !enabled;
    if (sel.disabled) wrap.classList.add("disabled");
    for (const [min, label] of CADENCES) {
      const opt = document.createElement("option");
      opt.value = String(min);
      opt.textContent = label;
      sel.appendChild(opt);
    }
    sel.value = String(f?.live ? f.every : 0);
    sel.addEventListener("change", () => {
      if (!f) return;
      const every = Number(sel.value);
      if (every > 0) { f.live = true; f.every = every; }
      else { delete f.live; delete f.every; }
    });
    wrap.append(icon, sel);
    return wrap;
  }

  // One catalog field: include checkbox + locked identity (key/badge/kind) +
  // liveness. The catalog is connector-global; whether a field is included and
  // its cadence is this board's choice (mapping.fields).
  function makeCatalogRow(cat) {
    const inc = fields.find((f) => f.from === "connector" && f.key === cat.key);
    const row = document.createElement("div");
    row.className = "mm-row mm-row-connector";
    const controls = document.createElement("div");
    controls.className = "fe-head";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!inc;
    cb.disabled = !isAdmin;
    cb.title = "Include this field";
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!inc) fields.push({ key: cat.key, kind: cat.kind, from: "connector", fn: cat.fn });
      } else {
        const idx = fields.findIndex((f) => f.from === "connector" && f.key === cat.key);
        if (idx >= 0) fields.splice(idx, 1);
      }
      renderFields();
    });

    const keyLabel = document.createElement("span");
    keyLabel.className = "mm-key-locked";
    keyLabel.style.fontFamily = "monospace";
    keyLabel.textContent = cat.key;

    const badge = document.createElement("span");
    badge.className = "mm-connector-badge";
    badge.textContent = `${inputConnector}:${cat.fn}`;

    const kindLabel = document.createElement("span");
    kindLabel.className = "mm-locked-badge";
    kindLabel.textContent = cat.kind;

    controls.append(cb, keyLabel, badge, kindLabel, livenessSelect(inc, !!inc));
    row.appendChild(controls);
    return row;
  }

  // One INCLUDED file-metadata field (server/media): a locked row matching the
  // connector rows — checkbox (checked; uncheck removes) + key + file:<fn> chip
  // + kind. No liveness (files are immutable). Un-included fields aren't listed
  // here; they're added from the "+ Add file field" menu, so the catalog isn't
  // a wall of rows by default.
  function makeFileCatalogRow(cat) {
    const inc = fields.find((f) => f.from === "file" && f.key === cat.key);
    const row = document.createElement("div");
    row.className = "mm-row mm-row-connector";
    const controls = document.createElement("div");
    controls.className = "fe-head";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!inc;
    cb.disabled = !isAdmin;
    cb.title = "Remove this field";
    cb.addEventListener("change", () => {
      if (cb.checked) {
        if (!inc) fields.push({ key: cat.key, kind: cat.kind, from: "file", fn: cat.fn });
      } else {
        const idx = fields.findIndex((f) => f.from === "file" && f.key === cat.key);
        if (idx >= 0) fields.splice(idx, 1);
      }
      renderFields();
    });

    const keyLabel = document.createElement("span");
    keyLabel.className = "mm-key-locked";
    keyLabel.style.fontFamily = "monospace";
    keyLabel.textContent = cat.key;

    const badge = document.createElement("span");
    badge.className = "mm-connector-badge";
    badge.textContent = `file:${cat.fn}`;

    const kindLabel = document.createElement("span");
    kindLabel.className = "mm-locked-badge";
    kindLabel.textContent = cat.kind;

    controls.append(cb, keyLabel, badge, kindLabel);
    row.appendChild(controls);
    // A caveat some fields carry (e.g. `created` is null for browser uploads).
    if (cat.note) {
      const note = document.createElement("div");
      note.className = "mm-face-hint";
      note.textContent = cat.note;
      row.appendChild(note);
    }
    return row;
  }

  // "+ Add file field" — opens a menu of the not-yet-included catalog fields,
  // grouped by applicability (All files / Images / Documents). Keeps the modal
  // compact: only chosen file fields render as rows above.
  function fileMenuLabel(cat) {
    const wrap = document.createElement("span");
    wrap.className = "dd-label";
    wrap.style.cssText = "display:flex;align-items:center;gap:8px;";
    const key = document.createElement("span");
    key.style.fontFamily = "monospace";
    key.textContent = cat.key;
    const kind = document.createElement("span");
    kind.className = "mm-locked-badge";
    kind.textContent = cat.kind;
    wrap.append(key, kind);
    return wrap;
  }

  function openAddFileFieldMenu(anchor) {
    const included = new Set(fields.filter((f) => f.from === "file").map((f) => f.fn));
    const available = (fileFieldCatalog || []).filter((c) => !included.has(c.fn));
    if (!available.length) { toast.info("All file fields added"); return; }
    openDropdown(anchor, {
      align: "start",
      minWidth: 240,
      build: (menuBody, { close }) => {
        const groups = [];
        for (const c of available) {
          let g = groups.find((x) => x.name === c.group);
          if (!g) { g = { name: c.group, items: [] }; groups.push(g); }
          g.items.push(c);
        }
        groups.forEach((g, gi) => {
          if (gi > 0) menuBody.appendChild(ddSep());
          const h = document.createElement("div");
          h.style.cssText = "padding:6px 12px 2px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#8a8a92;";
          h.textContent = g.name;
          menuBody.appendChild(h);
          for (const c of g.items) {
            menuBody.appendChild(ddRow({
              labelEl: fileMenuLabel(c),
              onClick: () => {
                fields.push({ key: c.key, kind: c.kind, from: "file", fn: c.fn });
                markDirty();
                close();
                renderFields();
              },
            }));
          }
        });
      },
    });
  }

  function makeAddFileFieldBtn() {
    const btn = document.createElement("button");
    btn.className = "fe-add-facet";
    btn.textContent = "+ Add file field";
    btn.addEventListener("click", () => openAddFileFieldMenu(btn));
    return btn;
  }

  // AI field row — editable key/kind/hint, removable.
  function makeAiRow(f) {
    const row = document.createElement("div");
    row.className = "mm-row";
    const controls = document.createElement("div");
    controls.className = "fe-head";

    const keyInput = document.createElement("input");
    keyInput.type = "text";
    keyInput.className = "mm-key";
    keyInput.style.cssText = "flex:1;min-width:90px;font-family:monospace;";
    keyInput.placeholder = "field_key";
    keyInput.value = f.key || "";
    keyInput.disabled = !isAdmin;
    keyInput.addEventListener("blur", () => {
      f.key = keyInput.value.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "") || "";
      keyInput.value = f.key;
    });

    const kindSel = document.createElement("select");
    kindSel.disabled = !isAdmin;
    for (const k of KINDS) {
      const opt = document.createElement("option");
      opt.value = k;
      opt.textContent = k;
      if (k === (f.kind || "text")) opt.selected = true;
      kindSel.appendChild(opt);
    }
    kindSel.addEventListener("change", () => { f.kind = kindSel.value; });
    if (!f.kind) f.kind = "text";

    const removeBtn = document.createElement("button");
    removeBtn.className = "fe-rm";
    removeBtn.setAttribute("aria-label", "Remove field");
    removeBtn.textContent = "×";
    removeBtn.disabled = !isAdmin;
    removeBtn.addEventListener("click", () => {
      const idx = fields.indexOf(f);
      if (idx >= 0) fields.splice(idx, 1);
      markDirty();
      renderFields();
    });

    controls.append(keyInput, kindSel);
    if (isAdmin) controls.appendChild(removeBtn);

    const hint = document.createElement("textarea");
    hint.placeholder = "AI instruction — describe what to extract and from where (e.g. \"the candidate's full name\")";
    hint.rows = 2;
    hint.value = f.hint || "";
    hint.disabled = !isAdmin;
    hint.addEventListener("input", () => { f.hint = hint.value; });

    row.append(controls, hint);
    return row;
  }

  function sectionTitle(text) {
    const el = sectionHeadingEl(text); // textContent path — the connector label rides in here
    // Siblings in the mm-fields gap:12 column — extra top margin pulls the
    // heading away from the section above so it binds to its own group.
    el.style.marginTop = "10px";
    return el;
  }

  function renderFields() {
    fieldsList.replaceChildren();

    // Connector fields (catalog) — only for connector-bound boards.
    if (inputConnector) {
      fieldsList.appendChild(sectionTitle(connectorLabel ? `Connector fields · ${connectorLabel}` : "Connector fields"));
      if (connectorCatalog) {
        for (const cat of connectorCatalog) fieldsList.appendChild(makeCatalogRow(cat));
      } else {
        // Catalog not loaded yet (or fetch failed): show the saved connector
        // fields as locked rows so the modal isn't empty; cadence still editable.
        const conn = fields.filter((f) => f.from === "connector");
        if (conn.length) {
          for (const f of conn) {
            const row = document.createElement("div");
            row.className = "mm-row mm-row-connector";
            const controls = document.createElement("div");
            controls.className = "fe-head";
            const keyLabel = document.createElement("span");
            keyLabel.className = "mm-key-locked"; keyLabel.style.fontFamily = "monospace";
            keyLabel.textContent = f.key;
            const badge = document.createElement("span");
            badge.className = "mm-connector-badge"; badge.textContent = `${inputConnector}:${f.fn}`;
            const kindLabel = document.createElement("span");
            kindLabel.className = "mm-locked-badge"; kindLabel.textContent = f.kind;
            controls.append(keyLabel, badge, kindLabel, livenessSelect(f, true));
            row.appendChild(controls);
            fieldsList.appendChild(row);
          }
        } else {
          const p = document.createElement("p");
          p.className = "mm-empty"; p.textContent = "Loading connector fields…";
          fieldsList.appendChild(p);
        }
      }
    }

    // File fields — file boards only. Only the INCLUDED fields render as rows
    // (with a file:<fn> chip, matching the connector rows); "+ Add file field"
    // reveals the rest, so the ~15-field catalog isn't a wall of rows.
    if (!inputConnector) {
      fieldsList.appendChild(sectionTitle("File fields"));
      const includedFile = fields.filter((f) => f.from === "file");
      for (const f of includedFile) {
        const cat = (fileFieldCatalog || []).find((c) => c.fn === f.fn) || { key: f.key, fn: f.fn, kind: f.kind };
        fieldsList.appendChild(makeFileCatalogRow(cat));
      }
      if (!fileFieldCatalog) {
        // Catalog still loading: show a line only when there's nothing to list.
        if (!includedFile.length) {
          const p = document.createElement("p");
          p.className = "mm-empty"; p.textContent = "Loading file fields…";
          fieldsList.appendChild(p);
        }
      } else if (isAdmin) {
        fieldsList.appendChild(makeAddFileFieldBtn());
      } else if (!includedFile.length) {
        const p = document.createElement("p");
        p.className = "mm-empty"; p.textContent = "No file fields.";
        fieldsList.appendChild(p);
      }
    }

    // AI fields.
    const aiFields = fields.filter((f) => f.from === "ai");
    fieldsList.appendChild(sectionTitle("AI-extracted fields"));
    if (!aiFields.length) {
      const empty = document.createElement("p");
      empty.className = "mm-empty";
      empty.textContent = isAdmin ? "No AI fields — add one below." : "No AI fields defined.";
      fieldsList.appendChild(empty);
    } else {
      aiFields.forEach((f) => fieldsList.appendChild(makeAiRow(f)));
    }
  }

  renderFaceRow();
  renderFields();
  body.appendChild(fieldsList);
  // For an already-bound board, fetch the connector's catalog so un-included
  // fields + face producers show too (template load fills them directly).
  if (inputConnector && !connectorCatalog) loadCatalog();
  // File boards: fetch the media field catalog so the "File fields" section can
  // offer every addable field (already-included ones render checked).
  if (!inputConnector) loadFileFields();

  if (isAdmin) {
    const addBtn = document.createElement("button");
    addBtn.className = "fe-add-facet";
    addBtn.textContent = "+ Add AI field";
    addBtn.addEventListener("click", () => {
      if (fields.filter((f) => f.from === "ai").length >= 12) { toast.info("Maximum 12 AI fields"); return; }
      fields.push({ key: "", kind: "text", from: "ai", hint: "" });
      markDirty();
      renderFields();
      const rows = fieldsList.querySelectorAll(".mm-key");
      rows[rows.length - 1]?.focus();
    });
    body.appendChild(addBtn);
  }

  // Extraction provider (admin only) — subordinate to the AI fields section,
  // rendered as a compact labeled row rather than a peer section.
  if (isAdmin) {
    const extractRow = document.createElement("div");
    extractRow.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:8px;";
    const extractLabel = document.createElement("span");
    extractLabel.style.cssText = "font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#8a8a92;white-space:nowrap;";
    extractLabel.textContent = "Extraction provider";
    extractKeySel = document.createElement("select");
    extractKeySel.style.cssText = "flex:1;min-width:0;font-size:13px;";
    extractKeySel.disabled = true;
    extractModelSel = document.createElement("select");
    extractModelSel.style.cssText = "flex:1;min-width:0;font-size:13px;";
    extractModelSel.hidden = true;
    extractRow.append(extractLabel, extractKeySel, extractModelSel);
    body.appendChild(extractRow);

    // Load keys + provider catalog, then populate selects.
    let aiKeys = [];
    let aiCatalog = {};
    const syncExtractModel = () => {
      const key = aiKeys.find((k) => String(k.id) === extractKeySel.value);
      extractModelSel.hidden = !key;
      // Null entry/keyId on the Board-default row (guards the hidden select
      // against a stale in-flight response); `saved` = the mapping's
      // persisted model.
      syncModelPicker(extractModelSel, key ? aiCatalog[key.provider] : null, key ? key.id : null, {
        saved: key && key.id === extractKeyId ? extractModel : null,
      });
    };
    Promise.all([
      fetch("/api/admin/ai-keys").then((r) => r.json()),
      loadProviders(),
    ]).then(([keys, catalog]) => {
      aiKeys = keys;
      aiCatalog = byName(catalog);
      const defOpt = document.createElement("option");
      defOpt.value = "";
      defOpt.textContent = "Board default";
      extractKeySel.appendChild(defOpt);
      for (const k of keys) {
        const opt = document.createElement("option");
        opt.value = String(k.id);
        opt.textContent = `${k.name} — ${k.provider}`;
        extractKeySel.appendChild(opt);
      }
      if (extractKeyId && keys.find((k) => k.id === extractKeyId)) {
        extractKeySel.value = String(extractKeyId);
      } else if (extractKeyId) {
        // Stored key no longer exists — treat as board default rather than
        // sending a dead id back on save.
        extractKeyId = null;
        extractModel = null;
      }
      extractKeySel.disabled = false;
      extractKeySel.addEventListener("change", () => {
        extractKeyId = extractKeySel.value ? Number(extractKeySel.value) : null;
        extractModel = null;
        syncExtractModel();
      });
      extractModelSel.addEventListener("change", () => { extractModel = extractModelSel.value || null; });
      syncExtractModel();
      extractLoaded = true;
    }).catch(() => {});
  }

  // The host modal owns the Save button. Non-admins get a read-only pane, so
  // say why inline (the host's Save persists tagging only for them).
  if (!isAdmin) {
    const note = document.createElement("p");
    note.style.cssText = "font-size:12px;color:#8a8a92;margin:8px 0 0;";
    note.textContent = "Only admins can edit the entity mapping.";
    body.appendChild(note);
  }

  async function loadCatalog() {
    try {
      const connectors = await fetch("/api/connectors").then((r) => r.json());
      const c = connectors.find((x) => x.name === inputConnector);
      if (c) {
        connectorCatalog = c.fields || [];
        connectorFaces = c.faces || [];
        connectorLabel = c.label;
        connectorProviders = c.providers || [];
        connectorActiveProvider = c.activeProvider || null;
        renderFields();
        renderFaceRow();
      }
    } catch { /* leave catalog null → the saved-fields fallback stands */ }
  }

  async function loadFileFields() {
    if (fileFieldCatalog) return;
    try {
      fileFieldCatalog = await fetch("/api/file-fields").then((r) => r.json());
      renderFields();
    } catch { /* leave null → the "Loading…" line stands, AI section still works */ }
  }

  function applyTemplate(connector) {
    const t = connector.template;
    inputConnector = t.input?.connector || null;
    identityFrom = t.identity?.from || "raw";
    identityHint = t.identity?.hint || "";
    candidates = (t.identity?.candidates || []).map((c) => ({ ...c }));
    classifyOn = candidates.length > 0;
    fields = (t.fields || []).map((f) => ({ ...f }));
    connectorCatalog = connector.fields || [];
    connectorFaces = connector.faces || [];
    connectorLabel = connector.label;
    connectorProviders = connector.providers || [];
    connectorActiveProvider = connector.activeProvider || null;
    faceCfg = t.face ? { ...t.face } : { from: "raw" };
    markDirty();
    renderIdentityRow();
    renderFaceRow();
    renderFields();
    toast(`${connector.label} template loaded`);
  }

  // Validate + assemble the mapping payload for the host modal's PATCH. Returns
  // { ok:false } after toasting on invalid input, else { ok:true, payload } —
  // the payload merges straight into the board PATCH body (extract_* only once
  // the provider fetch has landed, so a quick Save can't wipe a stored override).
  function collect() {
    // Flush any pending key-input blur normalizations.
    const activeKey = document.activeElement;
    if (activeKey && fieldsList.contains(activeKey)) activeKey.blur();

    // Separate AI fields (need validation) from connector + file fields (locked, pass through).
    const aiFields = fields.filter((f) => f.from === "ai" && f.key);
    const connectorFields = fields.filter((f) => f.from === "connector");
    const fileFields = fields.filter((f) => f.from === "file");
    const seen = new Set();
    for (const f of aiFields) {
      if (!/^[a-z][a-z0-9_]*$/.test(f.key)) { toast.error(`Invalid field key: "${f.key}"`); return { ok: false }; }
      if (seen.has(f.key)) { toast.error(`Duplicate field key: "${f.key}"`); return { ok: false }; }
      seen.add(f.key);
    }

    if (identityFrom === "ai" && !identityHint.trim()) {
      toast.error("Identity hint is required when using AI instruction");
      return { ok: false };
    }
    // Classify: keep only options that carry a value; trim hints. An on toggle
    // with nothing usable is a half-state — block it rather than save a listless
    // classifier (keeps "mode = has a list" true, mirroring the server).
    const cleanCandidates = candidates
      .map((c) => ({ value: (c.value || "").trim(), ...(c.hint && c.hint.trim() ? { hint: c.hint.trim() } : {}) }))
      .filter((c) => c.value);
    if (identityFrom === "ai" && classifyOn && !cleanCandidates.length) {
      toast.error("Add at least one option, or turn off “Match to a list”");
      return { ok: false };
    }
    const identitySlot = identityFrom === "ai"
      ? { from: "ai", hint: identityHint.trim(), ...(classifyOn && cleanCandidates.length ? { candidates: cleanCandidates } : {}) }
      : identityFrom === "connector"
        ? { from: "connector" }
        : { from: "raw" };

    const allFields = [
      ...connectorFields.map((f) => ({ key: f.key, kind: f.kind, from: "connector", fn: f.fn, ...(f.live ? { live: true, every: f.every } : {}) })),
      ...fileFields.map((f) => ({ key: f.key, kind: f.kind, from: "file", fn: f.fn })),
      ...aiFields.map((f) => ({ key: f.key, kind: f.kind, from: "ai", ...(f.hint ? { hint: f.hint } : {}) })),
    ];
    let face = null;
    if (faceCfg.from === "connector") {
      face = { from: "connector", producer: faceCfg.producer, period: faceCfg.period, ...(faceCfg.live ? { live: true, every: faceCfg.every } : {}) };
    } else if (!inputConnector && identityFrom === "ai") {
      // Derived file board: the preview follows an explicit preference — image by
      // default. There's no "no preference" option; prefer is soft (selectFace
      // falls back to any instance when the type is absent), so a default of image
      // just means "show the image if there is one". Raw identity is single-
      // instance, so flipping ai→raw and saving drops the face entirely.
      face = { from: "file", prefer: faceCfg.prefer && faceCfg.prefer !== "any" ? faceCfg.prefer : "image", pick: faceCfg.pick || "first" };
    }
    const hasContent = allFields.length > 0 || identityFrom !== "raw" || inputConnector || face;
    const mapping = hasContent
      ? {
          ...(inputConnector ? { input: { connector: inputConnector } } : {}),
          identity: identitySlot,
          ...(face ? { face } : {}),
          fields: allFields,
        }
      : null;

    return {
      ok: true,
      payload: {
        mapping,
        ...(extractLoaded ? {
          extract_key_id: extractKeyId ?? null,
          extract_model: extractKeyId ? (extractModel || null) : null,
        } : {}),
      },
    };
  }

  return { isDirty: () => dirty, collect };
}
