import { state } from './state.js';
import { toast } from './toast.js';
import { openDropdown, ddRow } from './dropdown.js';

const KINDS = ["text", "number", "url", "date"];

let modalEl = null;
let mousedownOnOverlay = false;

export function openMappingModal() {
  if (modalEl) return; // already open

  const isAdmin = !!state.me?.is_admin;
  // Clone current mapping so edits are buffered until Save.
  let fields = (state.boardMapping?.fields || []).map((f) => ({ ...f }));
  let identityFrom = state.boardMapping?.identity?.from || "raw";
  let identityHint = state.boardMapping?.identity?.hint || "";
  let inputConnector = state.boardMapping?.input?.connector || null; // set when a connector template is loaded

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.setAttribute("aria-label", "Entity mapping");

  // Header
  const header = document.createElement("div");
  header.className = "modal-header";
  const title = document.createElement("div");
  title.className = "modal-title";
  title.textContent = "Entity mapping";
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  header.append(title, closeBtn);

  // Body — scrollable field list
  const body = document.createElement("div");
  body.className = "modal-body";
  body.style.cssText = "display:flex;flex-direction:column;gap:12px;";

  // Explanation + identity anchor
  const intro = document.createElement("div");
  intro.className = "mm-intro";
  intro.innerHTML =
    "<p>Define structured fields to extract from each item using AI. " +
    "Extracted values appear in the Details panel and give the tagger extra context.</p>";
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

  // Section header for user-defined fields
  const fieldsHeader = document.createElement("div");
  fieldsHeader.className = "modal-section-title";
  fieldsHeader.textContent = "AI-extracted fields";
  body.appendChild(fieldsHeader);

  const fieldsList = document.createElement("div");
  fieldsList.className = "mm-fields";

  function renderFields() {
    fieldsList.replaceChildren();
    if (!fields.length) {
      const empty = document.createElement("p");
      empty.className = "mm-empty";
      empty.textContent = isAdmin
        ? "No fields yet — add one below."
        : "No fields defined for this board.";
      fieldsList.appendChild(empty);
      return;
    }
    fields.forEach((f, i) => fieldsList.appendChild(makeRow(f, i)));
  }

  function makeRow(f, i) {
    const row = document.createElement("div");
    const isConnectorField = f.from === "connector";
    row.className = "mm-row" + (isConnectorField ? " mm-row-connector" : "");

    const controls = document.createElement("div");
    controls.className = "fe-head";

    if (isConnectorField) {
      // Locked connector field: key label + connector badge, no editing.
      const keyLabel = document.createElement("span");
      keyLabel.className = "mm-key-locked";
      keyLabel.style.fontFamily = "monospace";
      keyLabel.textContent = f.key;
      const badge = document.createElement("span");
      badge.className = "mm-connector-badge";
      badge.textContent = `${inputConnector}:${f.fn}`;
      const kindLabel = document.createElement("span");
      kindLabel.className = "mm-locked-badge";
      kindLabel.textContent = f.kind;
      controls.append(keyLabel, badge, kindLabel);
      row.appendChild(controls);
      return row;
    }

    // AI field row — editable.
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

    const srcSel = document.createElement("select");
    srcSel.className = "mm-src";
    srcSel.disabled = !isAdmin;
    const optAI = document.createElement("option");
    optAI.value = "ai"; optAI.textContent = "AI instruction";
    const optConn = document.createElement("option");
    optConn.value = "connector"; optConn.textContent = "Connector";
    optConn.disabled = true; optConn.title = "Coming with live data sources";
    srcSel.append(optAI, optConn);
    srcSel.value = "ai";

    const removeBtn = document.createElement("button");
    removeBtn.className = "fe-rm";
    removeBtn.setAttribute("aria-label", "Remove field");
    removeBtn.textContent = "×";
    removeBtn.disabled = !isAdmin;
    removeBtn.addEventListener("click", () => { fields.splice(i, 1); renderFields(); });

    controls.append(keyInput, kindSel, srcSel);
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

  renderFields();
  body.appendChild(fieldsList);

  if (isAdmin) {
    const addBtn = document.createElement("button");
    addBtn.className = "fe-add-facet";
    addBtn.textContent = "+ Add field";
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
  const footer = document.createElement("div");
  footer.className = "modal-footer";

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

  function applyTemplate(connector) {
    const t = connector.template;
    inputConnector = t.input?.connector || null;
    identityFrom = t.identity?.from || "raw";
    identityHint = t.identity?.hint || "";
    fields = (t.fields || []).map((f) => ({ ...f }));
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
      ...connectorFields,
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

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  modalEl = overlay;

  function close() {
    if (!modalEl) return;
    modalEl.remove();
    modalEl = null;
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKeydown);
  }

  closeBtn.addEventListener("click", close);

  // Click-out: only close when the mousedown and click are both on the overlay
  // (prevents a text-selection drag-release from dismissing the modal).
  overlay.addEventListener("mousedown", (e) => { mousedownOnOverlay = e.target === overlay; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay && mousedownOnOverlay) close(); });

  function onKeydown(e) { if (e.key === "Escape") close(); }
  document.addEventListener("keydown", onKeydown);

  requestAnimationFrame(() => {
    (fieldsList.querySelector(".mm-key") || closeBtn).focus();
  });
}
