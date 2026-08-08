// dropdown.js — the shared dropdown/popover component.
//
// One dropdown is open at a time. The component owns the shell (.dropdown),
// viewport-aware positioning (right- or left-aligned to the anchor, flipped
// above it when out of room below, clamped to the window edges), content-aware
// width between min/max, a scrollable body capped at `maxItems` rows (opened
// with the active row scrolled into view), dismissal
// (outside click, Escape, re-click of the anchor), arrow-key navigation, and
// repositioning on scroll/resize.
//
// Callers describe content with `build(body, ctx)` (the scrollable area) and an
// optional `footer(foot, ctx)` (pinned below the scroll area), composing rows
// from the ddRow / ddCheckRow / ddAction / ddSep / ddInput helpers plus any
// custom elements.

import { createCheckbox } from "./checkbox.js";

const MARGIN = 8; // gap kept between the pop and the viewport edges
const GAP = 6;    // gap between the anchor and the pop

// Where the pop goes, as arithmetic — no DOM, so the cases that are awkward to
// reach in a browser (an anchor low enough to force a flip, one so low that
// neither side fits, one hard against a window edge) are pinned in
// test/dropdown-place.test.js instead of being eyeballed.
//
// Rects are {top, bottom, left, right, width, height} in viewport coordinates,
// exactly as getBoundingClientRect gives them.
export function placePop({ anchor, pop, viewport, align = "end", gap = GAP, margin = MARGIN }) {
  let left = align === "start" ? anchor.left : anchor.right - pop.width;
  // clamp to the window; the left clamp wins, so a pop wider than the viewport
  // starts at the margin rather than being pushed off the near edge
  left = Math.min(Math.max(left, margin), viewport.width - margin - pop.width);
  left = Math.max(left, margin);

  let top = anchor.bottom + gap;
  if (top + pop.height > viewport.height - margin) {
    const above = anchor.top - gap - pop.height;
    // flip above when it fits there; otherwise sit as low as the margin allows
    top = above >= margin ? above : Math.max(margin, viewport.height - margin - pop.height);
  }
  return { left: Math.round(left), top: Math.round(top) };
}

let current = null; // { anchor, hover, close }

export function closeDropdown(reason = "manual") {
  current?.close(reason);
}

export function openDropdown(anchor, {
  className = "",
  build,
  footer,
  align = "end",   // "end": right edges aligned; "start": left edges aligned
  variant = "dark", // "dark" | "light" — the surface it sits on (cf. createCheckbox)
  hover = false,   // hover popover: closes when the pointer leaves anchor + pop
  minWidth,
  maxWidth,
  maxItems = 10,   // body rows shown before scrolling kicks in (0 = no cap)
  focus,           // selector focused after open, e.g. ".dd-input"
  onClose,
} = {}) {
  if (current) {
    if (hover && current.anchor === anchor) return null; // already open; hover-hold keeps it alive
    if (hover && !current.hover) return null;            // a hover pop never steals a click-opened menu
    const toggled = !hover && current.anchor === anchor;
    current.close("toggle");
    if (toggled) return null;
  }

  const el = document.createElement("div");
  el.className = "dropdown"
    + (variant === "light" ? " dropdown--light" : "")
    + (className ? " " + className : "");
  el.setAttribute("role", "menu");
  if (minWidth != null) el.style.minWidth = minWidth + "px";
  if (maxWidth != null) el.style.maxWidth = maxWidth + "px";
  // measure from a known spot so shrink-to-fit sizing isn't viewport-clipped
  el.style.left = "0px";
  el.style.top = "0px";

  const body = document.createElement("div");
  body.className = "dd-body";
  el.appendChild(body);

  let closed = false;
  // `variant` rides on the ctx so a builder can hand it to the parts that need
  // to know their surface (ddCheckRow) without the caller repeating itself.
  const ctx = { el, body, variant, close: (reason = "manual") => close(reason), reposition };
  build?.(body, ctx);
  if (footer) {
    const foot = document.createElement("div");
    foot.className = "dd-footer";
    footer(foot, ctx);
    el.appendChild(foot);
  }
  document.body.appendChild(el);

  function capBodyHeight() {
    body.style.maxHeight = "";
    let cap = Infinity;
    const rows = body.children;
    if (maxItems && rows.length > maxItems) {
      // show maxItems rows plus half of the next so the cut is visibly scrollable
      const next = rows[maxItems];
      cap = next.offsetTop - rows[0].offsetTop + Math.round(next.offsetHeight / 2);
    }
    // never taller than the roomier side of the anchor allows
    const a = anchor.getBoundingClientRect();
    const chrome = el.offsetHeight - body.offsetHeight; // padding + footer
    const room = Math.max(
      window.innerHeight - MARGIN - GAP - a.bottom,
      a.top - GAP - MARGIN
    ) - chrome;
    const max = Math.min(cap, Math.max(room, 60));
    if (body.scrollHeight > max) body.style.maxHeight = max + "px";
  }

  // When the body scrolls, start it with the active row in view rather than
  // at the top — only nudged as far as needed, and only once at open so a
  // window-scroll reposition never yanks the user's own scrolling around.
  function revealActive() {
    if (body.scrollHeight <= body.clientHeight) return;
    const row = body.querySelector(".active");
    if (!row) return;
    const top = row.offsetTop - body.offsetTop; // offsetParent is the fixed shell
    const bottom = top + row.offsetHeight;
    if (top < body.scrollTop) body.scrollTop = top;
    else if (bottom > body.scrollTop + body.clientHeight) body.scrollTop = bottom - body.clientHeight;
  }

  function reposition() {
    capBodyHeight();
    const { left, top } = placePop({
      anchor: anchor.getBoundingClientRect(),
      pop: el.getBoundingClientRect(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
      align,
    });
    el.style.left = left + "px";
    el.style.top = top + "px";
  }

  const onOutside = (e) => {
    if (!el.contains(e.target) && !anchor.contains(e.target)) close("outside");
  };

  const onKeydown = (e) => {
    if (e.key === "Escape") {
      // consume it: an open dropdown outranks lightbox/bulk Escape handling
      e.stopPropagation();
      close("escape");
      if (!hover) anchor.focus?.();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      // footer actions are part of the same walk — they're the last stops
      const rows = [...el.querySelectorAll(".dd-row, .dd-action")];
      if (!rows.length) return;
      e.preventDefault();
      const i = rows.indexOf(document.activeElement);
      const next = e.key === "ArrowDown"
        ? (i === -1 ? 0 : (i + 1) % rows.length)
        : (i === -1 ? rows.length - 1 : (i - 1 + rows.length) % rows.length);
      rows[next].focus();
    } else if ((e.key === "Enter" || e.key === " ") && document.activeElement?.classList?.contains("dd-row")) {
      e.preventDefault();
      document.activeElement.click();
    }
  };

  let raf = 0;
  const onScrollOrResize = (e) => {
    if (e && e.target instanceof Node && el.contains(e.target)) return; // .dd-body scrolling
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(reposition);
  };

  let hoverTimer = 0;
  const holdOpen = () => clearTimeout(hoverTimer);
  const scheduleClose = () => {
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => close("hover-out"), 120);
  };

  function close(reason) {
    if (closed) return;
    closed = true;
    clearTimeout(hoverTimer);
    cancelAnimationFrame(raf);
    document.removeEventListener("click", onOutside, true);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("resize", onScrollOrResize);
    document.removeEventListener("scroll", onScrollOrResize, true);
    if (hover) {
      anchor.removeEventListener("pointerenter", holdOpen);
      anchor.removeEventListener("pointerleave", scheduleClose);
    }
    el.remove();
    anchor.classList.remove("dd-open");
    anchor.setAttribute("aria-expanded", "false");
    if (current && current.close === close) current = null;
    onClose?.(reason);
  }

  // The click that opened the menu has already passed document's capture
  // phase, so listening immediately can't catch it.
  document.addEventListener("click", onOutside, true);
  document.addEventListener("keydown", onKeydown, true);
  window.addEventListener("resize", onScrollOrResize);
  document.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
  if (hover) {
    el.addEventListener("pointerenter", holdOpen);
    el.addEventListener("pointerleave", scheduleClose);
    anchor.addEventListener("pointerenter", holdOpen);
    anchor.addEventListener("pointerleave", scheduleClose);
  }

  reposition();
  revealActive();
  anchor.classList.add("dd-open");
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  if (focus) requestAnimationFrame(() => el.querySelector(focus)?.focus());

  current = { anchor, hover, close };
  return ctx;
}

// A standard menu row: [leading?] label [trailing?]. Clicks on the embedded
// leading/trailing controls are theirs to handle; onClick gets the rest.
//
// `sublabel` stacks a dim second line under the label — for a choice whose
// human name and machine name are both worth showing (a facet's label over its
// key). The main text keeps its ellipsis; the sub gets its own.
export function ddRow({ label, labelEl, sublabel, active = false, href, leading, trailing, onClick } = {}) {
  const row = document.createElement(href ? "a" : "div");
  row.className = "dd-row" + (active ? " active" : "") + (sublabel ? " has-sub" : "");
  row.setAttribute("role", "menuitem");
  row.tabIndex = -1;
  if (href) row.href = href;
  if (leading) row.appendChild(leading);
  let lbl = labelEl;
  if (!lbl) {
    lbl = Object.assign(document.createElement("span"), { className: "dd-label" });
    if (sublabel) {
      lbl.appendChild(Object.assign(document.createElement("span"), { className: "dd-label-text", textContent: label }));
      lbl.appendChild(Object.assign(document.createElement("span"), { className: "dd-sub", textContent: sublabel }));
    } else {
      lbl.textContent = label;
    }
  }
  row.appendChild(lbl);
  if (trailing) row.appendChild(trailing);
  if (onClick) {
    row.addEventListener("click", (e) => {
      if (leading?.contains(e.target) || trailing?.contains(e.target)) return;
      onClick(e);
    });
  }
  return row;
}

// A full-width footer action: [icon] label. An action that navigates is built
// as a real <a> (middle-click opens a tab); one that acts is a <button>. They
// are only ever built here, so the two render as the same box — callers pick
// the element by passing href or onClick, not by hand-rolling the markup.
export function ddAction({ label, icon, href, onClick } = {}) {
  const el = document.createElement(href ? "a" : "button");
  // An action with an icon is a row and reads left-to-right from its glyph. One
  // without is a button, and a button's label belongs in the middle of it.
  el.className = "dd-action" + (icon ? "" : " dd-action--plain");
  if (href) el.href = href;
  else el.type = "button";
  if (icon) {
    const wrap = document.createElement("span");
    wrap.className = "dd-icon";
    wrap.innerHTML = icon;
    el.appendChild(wrap);
  }
  el.appendChild(Object.assign(document.createElement("span"), { className: "dd-label", textContent: label }));
  if (onClick) el.addEventListener("click", onClick);
  return el;
}

// A checkbox as a menu row. The row IS the <label>, so the hit target is the
// whole row rather than a 16px box, and it carries dd-row's metrics — a menu of
// choices should not be packed tighter than a menu of actions just because the
// choices happen to be checkboxes.
//
// Returns createCheckbox's handle with the row as its `el`, so callers read
// `.checked` and set `.disabled` exactly as they would on a bare one.
// `child: true` indents a row that belongs to the one above it, to the column
// where the parent's text starts.
export function ddCheckRow({ label, checked, disabled, variant = "dark", child = false, onChange } = {}) {
  const cb = createCheckbox({ variant, checked, disabled, label, onChange });
  cb.el.classList.add("dd-row", "dd-check");
  if (child) cb.el.classList.add("dd-row--child");
  cb.el.setAttribute("role", "menuitemcheckbox");
  cb.el.tabIndex = -1; // joins the arrow-key walk; Enter/Space clicks the label
  return cb;
}

export function ddSep() {
  const sep = document.createElement("div");
  sep.className = "dd-sep";
  return sep;
}

// Text input that submits its trimmed value on Enter.
export function ddInput({ placeholder = "", onSubmit } = {}) {
  const inp = document.createElement("input");
  inp.type = "text";
  inp.className = "dd-input";
  inp.placeholder = placeholder;
  inp.addEventListener("click", (e) => e.stopPropagation());
  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const value = inp.value.trim();
    if (value) onSubmit?.(value, inp);
  });
  return inp;
}
