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
// Lock/unlock page scroll while a modal is open. Removing the scrollbar would
// otherwise reflow the page wider by its width; we reserve that width as
// padding-right on the root element so the layout stays put. We pad <html>
// rather than <body> on purpose: a page may center its body (max-width +
// margin:auto) with border-box, where growing body padding shrinks the content
// instead of holding it in place. The root has no such constraint. Ref-counted
// so a modal opened from another modal doesn't unlock early or pad twice.
let scrollLocks = 0;
let savedPaddingRight = "";
function lockScroll() {
  if (scrollLocks++ > 0) return;
  const root = document.documentElement;
  savedPaddingRight = root.style.paddingRight;
  const sbw = window.innerWidth - root.clientWidth;
  if (sbw > 0) {
    const cur = parseFloat(getComputedStyle(root).paddingRight) || 0;
    root.style.paddingRight = `${cur + sbw}px`;
  }
  document.body.style.overflow = "hidden";
}
function unlockScroll() {
  if (scrollLocks === 0 || --scrollLocks > 0) return;
  document.body.style.overflow = "";
  document.documentElement.style.paddingRight = savedPaddingRight;
}

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
    unlockScroll();
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
  lockScroll();
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

// ─── Keeping the reader's place across a rebuild ────────────────────────────
// The editors in these modals rebuild their whole list on every structural edit
// — remove a value, tick a field, apply a template — because one render that is
// always right is far easier to keep honest than a set of surgical patches. The
// cost is that a rebuild throws away two pieces of state the browser was
// holding on the user's behalf:
//
//   scroll — emptying the list collapses the scroll container's content, and
//            the browser clamps its scrollTop to the (now zero) maximum.
//            Refilling restores the height but not the position, so un-ticking
//            one field near the bottom threw the reader back to the top with no
//            indication of what had happened.
//   focus  — the control that was just operated is one of the nodes destroyed,
//            so focus falls back to <body>. Ticking a checkbox with the
//            keyboard therefore cost you the keyboard.
//
// `keepPlace(node, render)` wraps a render function so both survive it:
//
//   const renderFields = keepPlace(fieldsList, () => { ... });
//
// Give a control a stable `data-place` and focus returns to whatever is rebuilt
// under that name. A control that is GONE afterwards — a row the edit removed —
// simply isn't restored, which is the right answer; there is nowhere to put it.
//
// The scroll host is resolved by walking ancestors for a computed overflow-y of
// auto/scroll rather than by naming `.modal-body`. These editors mount in one
// modal today; a hardcoded selector is the kind that stops matching without
// failing.
function scrollHost(node) {
  for (let el = node.parentElement; el; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) return el;
  }
  return null;
}

export function keepPlace(node, render) {
  return () => {
    const host = scrollHost(node);
    const savedTop = host ? host.scrollTop : 0;
    const active = document.activeElement;
    const place = active && node.contains(active) ? active.dataset?.place : null;

    render();

    // After the content is back, so the assignment isn't clamped again.
    if (host) host.scrollTop = savedTop;
    if (place) {
      for (const el of node.querySelectorAll("[data-place]")) {
        if (el.dataset.place !== place) continue;
        // preventScroll: the offset restored a line above IS the answer to
        // where the reader was. focus() scrolling to its own idea of "in view"
        // would overrule it — and the control is on screen anyway, since the
        // user just operated it.
        el.focus({ preventScroll: true });
        break;
      }
    }
    // Callers that focus a NEWLY added row do so after render() returns, so
    // their scroll-into-view still wins — which is what you want when the thing
    // you just created is off-screen.
  };
}

// Bold section heading for modal bodies (plugins modal, board editor). Returns
// an HTML string: 16px title plus an optional gray sub line. `style` adds css
// to the wrapper — e.g. a bottom margin when no flex gap provides the spacing.
export function sectionHeading(title, sub, style = "") {
  return `<div${style ? ` style="${style}"` : ""}><h2 style="font-size:16px;margin:0 0 2px;">${title}</h2>${
    sub ? `<p style="margin:0;color:#6b6b72;">${sub}</p>` : ""}</div>`;
}

// A provenance band (`.prov` in modal.css): one quiet centered line naming the
// thing that will actually do the work, at the point where that matters, plus
// the way to change it. "Using <what> Change" — the copy is pinned, which is
// the argument for building it here instead of twice at the two call sites.
// `onAction` opens wherever the choice actually lives; the band itself operates
// nothing, which is the whole idea (transparency without another control).
//
// The empty state is the component's REASON, not a trailing case. Both bands
// used to guard with "hide it if there's no label", and both then printed
// "Using none configured" on an install with nothing bound — the exact claim a
// provenance line exists not to make, sailing through the guard because that is
// a perfectly truthy string. Handed no answer this says so plainly and offers
// the fix, since the reader who has configured nothing is precisely the one who
// needs that link. `empty` is the caller's because only it knows which kind of
// model is missing.
export function provBand(onAction) {
  const el = document.createElement("div");
  el.className = "prov";
  el.hidden = true; // nothing is known until someone says so
  const lead = document.createTextNode("");
  const what = document.createElement("b");
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "linkbtn";
  btn.addEventListener("click", onAction);
  el.append(lead, what, btn);
  return {
    el,
    // THREE states, and all three belong to the band — the first round of this
    // component took the copy and the empty case and left visibility with the
    // callers, which promptly grew two spellings of it again (one asking "is
    // there a picker", the other "is there a state").
    //   null            nothing to be provenance ABOUT — no such picker here,
    //                   or the feed never landed. No band.
    //   { label }       name it: "Using <label> Change".
    //   { empty }       nothing runs: say which model is missing, offer the fix.
    set(state) {
      el.hidden = !state;
      if (!state) return;
      const has = !!state.label;
      lead.textContent = has ? "Using" : state.empty || "Nothing configured";
      what.textContent = has ? state.label : "";
      what.hidden = !has;
      btn.textContent = has ? "Change" : "Set one up";
    },
  };
}

// Element-building variant: returns the heading node with the title applied
// via textContent — use when the title carries user-named text.
export function sectionHeadingEl(title, sub) {
  const host = document.createElement("div");
  host.innerHTML = sectionHeading("", sub);
  const el = host.firstElementChild;
  el.querySelector("h2").textContent = title;
  return el;
}
