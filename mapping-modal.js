import { state } from './state.js';
import { toast } from './toast.js';

const KINDS = ["text", "number", "url", "date"];

let modalEl = null;
let mousedownOnOverlay = false;

export function openMappingModal() {
  if (modalEl) return; // already open

  const isAdmin = !!state.me?.is_admin;
  // Clone current mapping fields so edits are buffered until Save.
  let fields = (state.boardMapping?.fields || []).map((f) => ({ ...f }));

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

  // Identity row — always present, not editable in this slice (raw filename).
  const identityRow = document.createElement("div");
  identityRow.className = "mm-row mm-row-locked";
  const idControls = document.createElement("div");
  idControls.className = "fe-head";
  const idKey = document.createElement("span");
  idKey.className = "mm-key-locked";
  idKey.textContent = "identity";
  const idBadge = document.createElement("span");
  idBadge.className = "mm-locked-badge";
  idBadge.textContent = "filename · raw";
  idControls.append(idKey, idBadge);
  identityRow.appendChild(idControls);
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
    row.className = "mm-row";

    // Controls line: key · kind · source · remove
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

    // Source: always "AI instruction" in v1; Connector option visible but disabled.
    const srcSel = document.createElement("select");
    srcSel.className = "mm-src";  // keeps the dimmed colour for the locked "AI instruction" source
    srcSel.disabled = !isAdmin;
    const optAI = document.createElement("option");
    optAI.value = "ai";
    optAI.textContent = "AI instruction";
    const optConn = document.createElement("option");
    optConn.value = "connector";
    optConn.textContent = "Connector";
    optConn.disabled = true;
    optConn.title = "Coming with live data sources";
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

    // Hint textarea
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
    saveBtn.textContent = "Save";
    saveBtn.addEventListener("click", save);
    footer.append(saveBtn);
  } else {
    const note = document.createElement("p");
    note.style.cssText = "font-size:12px;color:#8a8a92;margin:0;";
    note.textContent = "Only admins can edit the entity mapping.";
    footer.appendChild(note);
  }

  async function save() {
    // Flush any pending key-input blur normalizations.
    const activeKey = document.activeElement;
    if (activeKey && fieldsList.contains(activeKey)) activeKey.blur();

    const valid = fields.filter((f) => f.key);
    const seen = new Set();
    for (const f of valid) {
      if (!/^[a-z][a-z0-9_]*$/.test(f.key)) {
        toast.error(`Invalid field key: "${f.key}"`);
        return;
      }
      if (seen.has(f.key)) { toast.error(`Duplicate field key: "${f.key}"`); return; }
      seen.add(f.key);
    }

    const mapping = valid.length
      ? { fields: valid.map((f) => ({ key: f.key, kind: f.kind, from: "ai", ...(f.hint ? { hint: f.hint } : {}) })) }
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
    } catch {
      toast.error("Save failed");
    }
  }

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);
  document.body.appendChild(overlay);
  modalEl = overlay;

  function close() {
    if (!modalEl) return;
    modalEl.remove();
    modalEl = null;
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
