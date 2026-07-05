// dropdown.js — the shared dropdown/popover component.
//
// One dropdown is open at a time. The component owns the shell (.dropdown),
// viewport-aware positioning (right- or left-aligned to the anchor, flipped
// above it when out of room below, clamped to the window edges), content-aware
// width between min/max, a scrollable body capped at `maxItems` rows, dismissal
// (outside click, Escape, re-click of the anchor), arrow-key navigation, and
// repositioning on scroll/resize.
//
// Callers describe content with `build(body, ctx)` (the scrollable area) and an
// optional `footer(foot, ctx)` (pinned below the scroll area), composing rows
// from the ddRow / ddSep / ddInput helpers plus any custom elements.

const MARGIN = 8; // gap kept between the pop and the viewport edges
const GAP = 6;    // gap between the anchor and the pop

let current = null; // { anchor, hover, close }

export function closeDropdown(reason = "manual") {
  current?.close(reason);
}

export function openDropdown(anchor, {
  className = "",
  build,
  footer,
  align = "end",   // "end": right edges aligned; "start": left edges aligned
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
  el.className = "dropdown" + (className ? " " + className : "");
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
  const ctx = { el, body, close: (reason = "manual") => close(reason), reposition };
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

  function reposition() {
    capBodyHeight();
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    let left = align === "start" ? a.left : a.right - r.width;
    left = Math.min(Math.max(left, MARGIN), window.innerWidth - MARGIN - r.width);
    let top = a.bottom + GAP;
    if (top + r.height > window.innerHeight - MARGIN) {
      const above = a.top - GAP - r.height;
      top = above >= MARGIN ? above : Math.max(MARGIN, window.innerHeight - MARGIN - r.height);
    }
    el.style.left = Math.round(left) + "px";
    el.style.top = Math.round(top) + "px";
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
      const rows = [...el.querySelectorAll(".dd-row")];
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
  anchor.classList.add("dd-open");
  anchor.setAttribute("aria-haspopup", "menu");
  anchor.setAttribute("aria-expanded", "true");
  if (focus) requestAnimationFrame(() => el.querySelector(focus)?.focus());

  current = { anchor, hover, close };
  return ctx;
}

// A standard menu row: [leading?] label [trailing?]. Clicks on the embedded
// leading/trailing controls are theirs to handle; onClick gets the rest.
export function ddRow({ label, active = false, href, leading, trailing, onClick } = {}) {
  const row = document.createElement(href ? "a" : "div");
  row.className = "dd-row" + (active ? " active" : "");
  row.setAttribute("role", "menuitem");
  row.tabIndex = -1;
  if (href) row.href = href;
  if (leading) row.appendChild(leading);
  const lbl = document.createElement("span");
  lbl.className = "dd-label";
  lbl.textContent = label;
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
