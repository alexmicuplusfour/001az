// Shared modal lifecycle: animated mount/dismiss plus Escape and click-out
// wiring. `mountModal` also supports custom modal chrome such as the tag editor.
// Styling for the standard overlay/dialog lives in modal.css (loaded by both
// the gallery and admin). The caller fills `body` and `footer` after the call —
// the references are live, so late appends show.
//
//   const { body, footer, close } = createModal({ title: "Edit board" });
//
// Options: title (string, also the dialog aria-label), id (overlay element id),
// bodyStyle (cssText for the body), onClose (run after the modal is dismissed).
export function mountModal({ overlay, dialog, onClose } = {}) {
  if (!overlay || !dialog) throw new Error("mountModal requires an overlay and dialog");

  let closed = false;
  let removed = false;
  let closeTimer = null;
  function onKey(e) { if (e.key === "Escape") close(); }
  function finishClose() {
    if (removed) return;
    removed = true;
    if (closeTimer !== null) window.clearTimeout(closeTimer);
    overlay.remove();
    document.body.style.overflow = "";
    onClose?.();
  }
  function close() {
    if (closed) return;
    closed = true;
    document.removeEventListener("keydown", onKey);
    overlay.classList.remove("is-open");
    overlay.classList.add("is-closing");
    dialog.addEventListener("transitionend", finishClose, { once: true });
    closeTimer = window.setTimeout(finishClose, 250);
  }

  // Click-out: close only when both the mousedown and the click land on the
  // overlay, so a text-selection drag that releases outside doesn't dismiss.
  let mdOnOverlay = false;
  overlay.addEventListener("mousedown", (e) => { mdOnOverlay = e.target === overlay; });
  overlay.addEventListener("click", (e) => { if (e.target === overlay && mdOnOverlay) close(); });

  document.body.appendChild(overlay);
  document.body.style.overflow = "hidden";
  document.addEventListener("keydown", onKey);
  window.requestAnimationFrame(() => {
    if (!closed) overlay.classList.add("is-open");
  });

  return close;
}

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

  const close = mountModal({ overlay, dialog, onClose });
  closeBtn.addEventListener("click", close);

  return { overlay, dialog, header, titleEl, body, footer, closeBtn, close };
}
