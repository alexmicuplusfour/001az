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
const toolbar = document.getElementById("toolbar");

const DELTA = 6; // px of movement before we react at all
const REVEAL_AT_TOP = 80; // within this many px of the top, always expanded

let lastY = 0;
let collapsed = false;
let ticking = false;

// The collapse must be layout-neutral (see the header rules in styles.css):
// CSS animates the row from its true height to 0 while the header's bottom
// margin grows by the same amount, keeping the document height constant so
// collapsing never shifts content or clamps the scroll position. That needs
// the row's real border-box height, measured while expanded.
function measure() {
  if (collapsed) return;
  // Release the height lock so the row reflows to its natural size (its
  // content and media-query padding both change it), then re-pin the fresh
  // value. The trailing read commits the pinned pixel height before any
  // same-frame class toggle, so the first fold transitions from a pixel
  // value rather than jumping from height:auto.
  header.style.removeProperty("--toolbar-h");
  header.style.setProperty("--toolbar-h", toolbar.offsetHeight + "px");
  void toolbar.offsetHeight;
}

function setCollapsed(next) {
  if (next === collapsed) return;
  if (next) measure(); // fresh height right before folding
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
  if (!header || !toolbar) return;
  lastY = window.scrollY;
  // No measurement at init: the toolbar hasn't rendered its content yet, so
  // pinning now would lock in a near-empty row's height and clip the real one.
  // Unpinned, the CSS height falls back to auto; the pin happens lazily right
  // before the first fold and refreshes after toolbar rebuilds and resizes.
  document.addEventListener("app:render", measure);
  window.addEventListener("resize", measure);
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
