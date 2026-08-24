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
import { glyphEl } from './utils.js';

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

// ─── Bottom drawer — an editing surface inside a modal ──────────────────────
// A full-width sheet that rises from the bottom of `hostEl` (a modal body)
// over a scrim, holds one editing task, and ends it with ONE primary action.
// The mapping pane's field/slot editors are the first consumer; the component
// is generic on purpose — any modal whose editors currently inline-expand
// inside a scrolling body has this exact problem.
//
// The contract is the interaction shape, nothing more:
//   - one primary button (the caller's commit — the caller applies its draft
//     and calls close(); the component never touches caller state);
//   - dismissal paths that never half-apply: Cancel, scrim click, Esc — each
//     runs onDismiss and closes, and none of them is the primary action.
// Draft/commit semantics therefore stay entirely caller-side: hand `build` a
// COPY of your state and write it back only in primary.onClick.
//
//   const drawer = createDrawer(bodyEl);            // once per modal body
//   drawer.open({ head, build, primary: { label, onClick, disabled? },
//                 onDismiss, tall });               // tall: fixed-height sheet
//   drawer.refresh();                               // re-run build in place
//   drawer.setPrimaryDisabled(on);                  // gate the commit while open
//
// Esc is registered on document in CAPTURE phase and stops propagation while
// the drawer is open — mountModal's own Escape handler lives on document too
// (bubble), and without the capture+stop, one keypress would fall through the
// drawer and dismiss the whole modal under it.
export function createDrawer(hostEl) {
  if (getComputedStyle(hostEl).position === "static") hostEl.style.position = "relative";

  const scrim = document.createElement("div");
  scrim.className = "drawer-scrim";
  const sheet = document.createElement("div");
  sheet.className = "drawer";
  sheet.setAttribute("role", "dialog");
  sheet.setAttribute("aria-modal", "true");
  const head = document.createElement("div");
  head.className = "drawer-head";
  const body = document.createElement("div");
  body.className = "drawer-body";
  const foot = document.createElement("div");
  foot.className = "drawer-foot";
  sheet.append(head, body, foot);
  hostEl.append(scrim, sheet);

  let current = null; // { build, onDismiss } while open
  let opener = null;  // the element to hand focus back to
  let okBtn = null;   // the current open's primary — setPrimaryDisabled's target

  function onKey(e) {
    if (!current) return;
    // A ghost task: the host modal was torn down around an open drawer (the
    // scrim covers the dialog, not the overlay ring, so click-out can close
    // the modal under an open sheet — close() never ran). Detach on the
    // first keypress instead of swallowing Tab and Escape for a sheet
    // nobody can see, and release the detached tree the closure retains.
    if (!sheet.isConnected) { close(); return; }
    if (e.key === "Escape") {
      e.stopPropagation(); // the host modal must NOT also close on this press
      dismiss();
      return;
    }
    // Focus trap: the scrim blocks pointers but not Tab — without this, focus
    // walks into live controls behind the sheet (tile × buttons, the modal's
    // own Save) and Enter operates them mid-draft. Wrap at the sheet's edges;
    // a focus that has already escaped is pulled back in.
    if (e.key === "Tab") {
      const focusables = [...sheet.querySelectorAll("input, textarea, select, button")]
        .filter((n) => !n.disabled && n.offsetParent !== null);
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const inside = sheet.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === first)) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && (!inside || document.activeElement === last)) {
        e.preventDefault(); first.focus();
      }
    }
  }

  function setOpen(on) {
    scrim.classList.toggle("open", on);
    sheet.classList.toggle("open", on);
  }

  function close() {
    if (!current) return;
    current = null;
    document.removeEventListener("keydown", onKey, true);
    setOpen(false);
    // Return focus to whatever opened the drawer — it's still on screen, the
    // sheet merely covered it.
    opener?.focus?.({ preventScroll: true });
    opener = null;
  }

  function dismiss() {
    const cb = current?.onDismiss;
    close();
    cb?.();
  }
  scrim.addEventListener("click", dismiss);

  function open({ head: headNodes, build, primary, onDismiss, tall } = {}) {
    opener = document.activeElement;
    current = { build, onDismiss };
    // Size axis: by default the sheet hugs its content (max-height 88%);
    // `tall` pins it to a fixed fraction of the host — a stable viewport for
    // a task whose content resizes as it runs (a directory tree re-renders
    // per level). Toggled per open because the sheet is reused: a default
    // task after a tall one must hug again. Set before the reflow read below
    // so the first open resolves its closed geometry at the right size.
    sheet.classList.toggle("tall", !!tall);

    head.replaceChildren(...[].concat(headNodes || []));
    body.replaceChildren();
    build?.(body);

    foot.replaceChildren();
    // The dialog's own footer convention: unclassed is the primary, `.ghost` is
    // the secondary. Same two buttons, so the same two classes.
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", dismiss);
    const ok = document.createElement("button");
    ok.type = "button";
    ok.textContent = primary?.label || "Done";
    // A primary may open gated (`disabled`) and be flipped by
    // setPrimaryDisabled while the task runs — for commits that are only
    // valid once async state arrives (a browse level that rendered).
    // Dismissal paths are never gated: leaving without applying always works.
    ok.disabled = !!primary?.disabled;
    ok.addEventListener("click", () => primary?.onClick?.());
    okBtn = ok;
    foot.append(cancel, ok);

    document.addEventListener("keydown", onKey, true);
    // Resolve the CLOSED style before flipping to open. On the first open the
    // sheet was appended in this same task (createDrawer is called lazily, by
    // the click that opens it), so the browser had no computed "from" state to
    // transition out of and jumped straight to the end — the first drawer of a
    // session appeared with no animation and every one after it animated.
    // Reading a layout property forces that recalc; it costs one reflow, once
    // per open, on a click that is already rebuilding the sheet's contents.
    void sheet.offsetHeight;
    setOpen(true);
    // First focusable in the TASK, so keyboard users land in the form rather
    // than on its Cancel — scoped to the body rather than excluding the footer
    // by class, which is both simpler and one less thing the footer's markup
    // can break. A task with nothing to focus falls back to its own commit —
    // unless that commit opened `disabled`, which refuses focus; then focus
    // stays on the opener until the trap's first Tab pulls it in.
    (body.querySelector("input, textarea, select, button") || ok)
      .focus?.({ preventScroll: true });
  }

  // Re-run build in place — for editors whose structure changes mid-edit
  // (option rows added/removed). The caller's build closes over its draft, so
  // a refresh redraws the same task, not a new one.
  function refresh() {
    if (!current?.build) return;
    body.replaceChildren();
    current.build(body);
  }

  // Gate the commit while the task runs (async validity — see the header).
  // A no-op when closed, so a stale async callback landing after a dismissal
  // can't flip a button that belongs to the next task.
  function setPrimaryDisabled(on) {
    if (!current) return;
    okBtn.disabled = !!on;
  }

  return { open, refresh, close, isOpen: () => !!current, setPrimaryDisabled };
}

// Drawer form group: dim label / control / quiet hint (.dw-*) — the shape
// every drawer task states its questions in. Label and hint are optional.
export function dwGroup(label, control, hint) {
  const g = document.createElement("div");
  g.className = "dw-group";
  if (label) {
    const l = document.createElement("div");
    l.className = "dw-label";
    l.textContent = label;
    g.appendChild(l);
  }
  g.appendChild(control);
  if (hint) {
    const h = document.createElement("div");
    h.className = "dw-hint";
    h.textContent = hint;
    g.appendChild(h);
  }
  return g;
}

// Standard drawer head: glyph + title + the source label pushed right (CSS on
// .drawer-src). The refs come back so a task can live-update its own head —
// the field editor retitles as its key input types; the identity editor
// recolors its glyph on a pick.
export function drawerHeadParts(glyphName, ai, title, src) {
  const g = glyphEl(glyphName, ai);
  const t = document.createElement("span");
  t.className = "drawer-title";
  t.textContent = title;
  const s = document.createElement("span");
  s.className = "drawer-src";
  s.textContent = src;
  return { nodes: [g, t, s], g, t, s };
}

// A tile: one bounded object in a list — glyph | name over a quiet summary |
// optional ×. Nothing on a tile is editable; opening it (onOpen) IS the edit.
// onOpen absent = a locked tile: a div, no hover cursor, no tab stop (a thing
// with no editor still renders and can still be removable). onRemove absent =
// no ×. `place` rides the main button for keepPlace focus restoration.
export function tileRow({ glyph, ai, name, sum, title, place, onOpen, onRemove, removeLabel, removeTitle }) {
  const tile = document.createElement("div");
  tile.className = "tile" + (ai ? " ai" : "");
  const main = document.createElement(onOpen ? "button" : "div");
  main.className = "tile-main";
  if (onOpen) {
    main.type = "button";
    if (place) main.dataset.place = place;
    main.addEventListener("click", onOpen);
  } else {
    main.style.cursor = "default"; // the class assumes a button; this one isn't
  }
  if (title) main.title = title;
  main.appendChild(glyphEl(glyph, ai));
  const body = document.createElement("div");
  body.className = "tile-body";
  const nameEl = document.createElement("div");
  nameEl.className = "tile-name";
  nameEl.textContent = name;
  const sumEl = document.createElement("div");
  sumEl.className = "tile-sum";
  sumEl.textContent = sum;
  body.append(nameEl, sumEl);
  main.appendChild(body);
  tile.appendChild(main);
  if (onRemove) {
    const rm = document.createElement("button");
    rm.className = "tile-rm";
    rm.type = "button";
    rm.textContent = "×";
    if (removeLabel) rm.setAttribute("aria-label", removeLabel);
    if (removeTitle) rm.title = removeTitle;
    rm.addEventListener("click", (e) => { e.stopPropagation(); onRemove(); });
    tile.appendChild(rm);
  }
  return tile;
}
