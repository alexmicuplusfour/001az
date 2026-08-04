// Hide-on-scroll header chrome: the top row (crate switcher, credits, account)
// folds away when the list scrolls down and comes back when it scrolls up. The
// filters + sort row stays reachable at all times.
//
// The fold is entirely CSS — a grid track on the card collapsing to 0fr (see
// the header rules in styles.css). All this module does is decide which way the
// user is scrolling, and keep the card's stand-in spacer the right size.
const header = document.querySelector("header");
const space = document.getElementById("header-space");

// Accumulated movement needed to flip state. Reveal is the twitchier direction
// — an accidental nudge upward shouldn't throw the chrome back in your face —
// so it asks for a little more travel than the collapse does.
const COLLAPSE_AFTER = 8;
const REVEAL_AFTER = 24;
const REVEAL_AT_TOP = 80; // within this many px of the top, always open

let lastY = 0;
let travel = 0; // signed run of movement in the current direction
let collapsed = false;
let ticking = false;

// The card is fixed, so it holds no place in the flow; the spacer holds it for
// them. Its height is the card's bottom edge, which folds in the 12px the card
// floats below the viewport top.
//
// Measured only while the card is open, because the reserved space has to
// describe the open card — rewriting it mid-fold would reflow the page, the one
// thing this design is built to avoid. The spacer never affects the card's own
// size, so the observer cannot chase its own tail.
function measure() {
  if (collapsed) return;
  space.style.height = `${Math.round(header.getBoundingClientRect().bottom)}px`;
}

function setCollapsed(next) {
  if (next === collapsed) return;
  collapsed = next;
  header.classList.toggle("header-collapsed", next);
}

function apply() {
  ticking = false;
  const y = Math.max(0, window.scrollY);
  const dy = y - lastY;
  lastY = y;

  // The top of the page always shows the whole card, so the effect never fights
  // the landing.
  if (y < REVEAL_AT_TOP) {
    travel = 0;
    setCollapsed(false);
    return;
  }

  // Reversing direction restarts the run: the thresholds then measure a
  // deliberate scroll rather than the tail of the opposite one.
  if (dy === 0) return;
  if ((dy > 0) !== (travel > 0)) travel = 0;
  travel += dy;

  if (travel > COLLAPSE_AFTER) setCollapsed(true);
  else if (travel < -REVEAL_AFTER) setCollapsed(false);
}

export function initHeaderScroll() {
  if (!header || !space) return;
  lastY = Math.max(0, window.scrollY);

  // Fires once on observe and again on every reflow that resizes the card —
  // content filling in after boot, chips wrapping, the viewport changing.
  new ResizeObserver(measure).observe(header);

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
