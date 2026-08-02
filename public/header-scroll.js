// Hide-on-scroll header chrome: collapse the top row (crate switcher / credits /
// account) when the list scrolls down, restore it when scrolling up. The
// filters + sort row (#toolbar-sub) stays put so it's always reachable.
//
// Conventional pattern: a passive scroll listener throttled to one rAF per
// frame, a small delta threshold so trivial jitter (trackpad wobble, momentum
// tails) can't flicker the row, and a top zone that always shows the full
// header so the effect never fights the sticky landing. The actual motion is
// the CSS transition on #toolbar.
const header = document.querySelector("header");

const DELTA = 6; // px of movement before we react at all
const REVEAL_AT_TOP = 80; // within this many px of the top, always expanded

let lastY = 0;
let collapsed = false;
let ticking = false;

function setCollapsed(next) {
  if (next === collapsed) return;
  collapsed = next;
  header.classList.toggle("header-collapsed", next);
}

function apply() {
  ticking = false;
  const y = window.scrollY;
  const dy = y - lastY;
  if (Math.abs(dy) < DELTA) return;

  if (y < REVEAL_AT_TOP) setCollapsed(false);
  else if (dy > 0) setCollapsed(true); // scrolling down → hide
  else setCollapsed(false); // scrolling up → reveal

  lastY = y;
}

export function initHeaderScroll() {
  if (!header) return;
  lastY = window.scrollY;
  window.addEventListener(
    "scroll",
    () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(apply);
    },
    { passive: true }
  );
}
