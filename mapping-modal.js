import { state } from './state.js';
import { toast } from './toast.js';
import { openDropdown, ddRow } from './dropdown.js';
import { createModal } from './modal.js';

const KINDS = ["text", "number", "url", "date"];
// Liveness cadence choices (minutes). 0 = Off (the field is fetched once at add
// and never refreshed). "How often the field updates in the app" — the sweep
// re-fetches the whole entity but only rewrites fields whose cadence elapsed.
const CADENCES = [[0, "Off"], [1, "1 min"], [5, "5 min"], [15, "15 min"], [60, "1 hour"], [360, "6 hours"], [1440, "1 day"]];

let modalEl = null;

export function openMappingModal() {
  if (modalEl) return; // already open

  const isAdmin = !!state.me?.is_admin;
  // Clone current mapping so edits are buffered until Save.
  let fields = (state.boardMapping?.fields || []).map((f) => ({ ...f }));
  let identityFrom = state.boardMapping?.identity?.from || "raw";
  let identityHint = state.boardMapping?.identity?.hint || "";
  let inputConnector = state.boardMapping?.input?.connector || null; // set when a connector template is loaded
  let connectorCatalog = null;   // the active connector's full field set (manifest.fields)
  let connectorLabel = null;

  const { overlay, body, footer, closeBtn, close } = createModal({
    title: "Entity mapping",
    bodyStyle: "display:flex;flex-direction:column;gap:12px;",
    onClose: () => { modalEl = null; },
  });
  modalEl = overlay;

  // Explanation + identity anchor
  const intro = document.createElement("div");
  intro.className = "mm-intro";
  intro.innerHTML =
    "<p>Define structured fields for each item. Connector fields come from a live " +
    "data source; AI fields are extracted from the item's content.</p>";
  body.appendChild(intro);

  // Template row — top of the body, subtle. Applying a connector template
  // rewires the whole mapping (input, identity, fields) in one click.
  if (isAdmin) {
    const templateRow = document.createElement("div");
    templateRow.className = "mm-template-row";
    const templateLabel = document.createElement("span");
    templateLabel.className = "mm-template-label";
    templateLabel.textContent = "Template";
    const loadBtn = document.createElement("button");
    loadBtn.className = "mm-template-btn";
    loadBtn.textContent = inputConnector ? `Connector: ${inputConnector}` : "Load template…";
    loadBtn.addEventListener("click", async () => {
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
    idHint.placeholder = "AI instruction — how to identify this entity (e.g. \"the person's full name\")";
    idHint.rows = 2;
    idHint.value = identityHint;
    idHint.disabled = !isAdmin;
    idHint.addEventListener("input", () => { identityHint = idHint.value; });
    idHintWrap.appendChild(idHint);

    idSrcSel.addEventListener("change", () => {
      identityFrom = idSrcSel.value;
      idHintWrap.style.display = identityFrom === "ai" ? "block" : "none";
    });

    identityRow.append(idControls, idHintWrap);
  }

  renderIdentityRow();
  body.appendChild(identityRow);

  const fieldsList = document.createElement("div");
  fieldsList.className = "mm-fields";

  // A liveness cadence select bound to a field object's live/every. Off (0)
  // clears them. Identity has no liveness (it's the stable key), so it never
  // gets one of these.
  function livenessSelect(f, enabled) {
    const sel = document.createElement("select");
    sel.className = "mm-live";
    sel.disabled = !isAdmin || !enabled;
    sel.title = "How often this field refreshes in the app";
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
    return sel;
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
    const h = document.createElement("div");
    h.className = "modal-section-title";
    h.textContent = text;
    return h;
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

  renderFields();
  body.appendChild(fieldsList);
  // For an already-bound board, fetch the connector's catalog so un-included
  // fields show too (template load fills it directly).
  if (inputConnector && !connectorCatalog) loadCatalog();

  if (isAdmin) {
    const addBtn = document.createElement("button");
    addBtn.className = "fe-add-facet";
    addBtn.textContent = "+ Add AI field";
    addBtn.addEventListener("click", () => {
      if (fields.length >= 12) { toast.info("Maximum 12 fields"); return; }
      fields.push({ key: "", kind: "text", from: "ai", hint: "" });
      renderFields();
      const rows = fieldsList.querySelectorAll(".mm-key");
      rows[rows.length - 1]?.focus();
    });
    body.appendChild(addBtn);
  }

  // Footer
  if (isAdmin) {
    const saveBtn = document.createElement("button");
    saveBtn.className = "mm-save";
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", save);
    footer.append(saveBtn);
  } else {
    const note = document.createElement("p");
    note.style.cssText = "font-size:12px;color:#8a8a92;margin:0;";
    note.textContent = "Only admins can edit the entity mapping.";
    footer.appendChild(note);
  }

  async function loadCatalog() {
    try {
      const connectors = await fetch("/api/connectors").then((r) => r.json());
      const c = connectors.find((x) => x.name === inputConnector);
      if (c) { connectorCatalog = c.fields || []; connectorLabel = c.label; renderFields(); }
    } catch { /* leave catalog null → the saved-fields fallback stands */ }
  }

  function applyTemplate(connector) {
    const t = connector.template;
    inputConnector = t.input?.connector || null;
    identityFrom = t.identity?.from || "raw";
    identityHint = t.identity?.hint || "";
    fields = (t.fields || []).map((f) => ({ ...f }));
    connectorCatalog = connector.fields || [];
    connectorLabel = connector.label;
    renderIdentityRow();
    renderFields();
    toast(`${connector.label} template loaded`);
  }

  async function save() {
    // Flush any pending key-input blur normalizations.
    const activeKey = document.activeElement;
    if (activeKey && fieldsList.contains(activeKey)) activeKey.blur();

    // Separate AI fields (need validation) from connector fields (locked, pass through).
    const aiFields = fields.filter((f) => f.from === "ai" && f.key);
    const connectorFields = fields.filter((f) => f.from === "connector");
    const seen = new Set();
    for (const f of aiFields) {
      if (!/^[a-z][a-z0-9_]*$/.test(f.key)) { toast.error(`Invalid field key: "${f.key}"`); return; }
      if (seen.has(f.key)) { toast.error(`Duplicate field key: "${f.key}"`); return; }
      seen.add(f.key);
    }

    if (identityFrom === "ai" && !identityHint.trim()) {
      toast.error("Identity hint is required when using AI instruction");
      return;
    }
    const identitySlot = identityFrom === "ai"
      ? { from: "ai", hint: identityHint.trim() }
      : identityFrom === "connector"
        ? { from: "connector" }
        : { from: "raw" };

    const allFields = [
      ...connectorFields.map((f) => ({ key: f.key, kind: f.kind, from: "connector", fn: f.fn, ...(f.live ? { live: true, every: f.every } : {}) })),
      ...aiFields.map((f) => ({ key: f.key, kind: f.kind, from: "ai", ...(f.hint ? { hint: f.hint } : {}) })),
    ];
    const hasContent = allFields.length > 0 || identityFrom !== "raw" || inputConnector;
    const mapping = hasContent
      ? {
          ...(inputConnector ? { input: { connector: inputConnector } } : {}),
          identity: identitySlot,
          fields: allFields,
        }
      : null;

    try {
      const r = await fetch(`/api/admin/boards/${state.boardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapping }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        toast.error(body.error || "Save failed");
        return;
      }
      state.boardMapping = mapping;
      toast("Mapping saved");
      close();
      // Re-render so the toolbar picks up the new mapping — the plus button's
      // behaviour (file picker vs connector search) depends on mapping.input.
      document.dispatchEvent(new Event('app:render'));
    } catch {
      toast.error("Save failed");
    }
  }

  requestAnimationFrame(() => {
    (fieldsList.querySelector(".mm-key") || closeBtn).focus();
  });
}
