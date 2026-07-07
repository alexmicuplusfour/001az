// Shared modal chrome: overlay + dialog + header/body/footer, plus the
// close / Escape / click-out wiring every modal repeated by hand. Styling lives
// in modal.css (loaded by both the gallery and admin). The caller fills `body`
// and `footer` after the call — the references are live, so late appends show.
//
//   const { body, footer, close } = createModal({ title: "Edit board" });
//
// Options: title (string, also the dialog aria-label), id (overlay element id),
// bodyStyle (cssText for the body), onClose (run after the modal is dismissed).
export function createModal({ title = "", id, bodyStyle = "", onClose } = {}) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  if (id) overlay.id = id;

  const dialog = document.createElement("div");
  dialog.className = "modal-dialog";
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  if (title) dialog.setAttribute("aria-label", title);
  dialog.addEventListener("click", (e) => e.stopPropagation());

  const header = document.createElement("div");
  header.className = "modal-header";
  const titleEl = document.createElement("div");
  titleEl.className = "modal-title";
  titleEl.textContent = title;
  const closeBtn = document.createElement("button");
  closeBtn.className = "modal-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "×";
  header.append(titleEl, closeBtn);

  const body = document.createElement("div");
  body.className = "modal-body";
  if (bodyStyle) body.style.cssText = bodyStyle;

  const footer = document.createElement("div");
  footer.className = "modal-footer";

  dialog.append(header, body, footer);
  overlay.appendChild(dialog);

  let closed = false;
  function onKey(e) { if (e.key === "Escape") close(); }
  function close() {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.body.style.overflow = "";
    document.removeEventListener("keydown", onKey);
    onClose?.();
  }

  // Click-out: close only when both the mousedown and the click land on the
  // overlay, so a text-selection drag that releases outside doesn't dismiss.
  let mdOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => { mdOnOverlay = e.target === overlay; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay && mdOnOverlay) close(); });
  closeBtn.addEventListener("click", close);

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);

  return { overlay, dialog, header, titleEl, body, footer, closeBtn, close };
}
