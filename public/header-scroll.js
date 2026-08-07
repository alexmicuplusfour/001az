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
// — an accidental nudge upward shouldn't throw the chrome back in your face,
// and on a touchpad or trackpad the tail of a fling wobbles both ways — so it
// asks for a good deal more travel than the collapse does.
const COLLAPSE_AFTER = 8;
const REVEAL_AFTER = 40;
const REVEAL_AT_TOP = 80; // within this many px of the top, always open
// Long enough to outlast the card's transition (0.28s, in styles.css). Erring
// long only postpones a rare re-measure; erring short would take one mid-fold.
const FOLD_MS = 400;

let lastY = 0;
let travel = 0; // signed run of movement in the current direction
let collapsed = false;
let ticking = false;
let folding = 0; // timer id while the card is between its two heights

// The card is fixed, so it holds no place in the flow; the spacer holds it for
// them. Its height is the OPEN card's bottom edge, which folds in the 12px the
// card floats below the viewport top — and it keeps that height through the
// whole fold, so the page below never moves when the card does. That is the
// entire point of the spacer.
//
// Hence the two refusals. Closed, the box is the wrong card to describe.
// Mid-fold it is neither card: the observer fires on every frame of the
// transition, so measuring there would drag the gallery up by the height of row
// 1 and then walk it back down over the next 280ms — a page that visibly jerks
// every time the header reopens.
function measure() {
  if (collapsed || folding) return;
  space.style.height = `${Math.round(header.getBoundingClientRect().bottom)}px`;
}

function setCollapsed(next) {
  if (next === collapsed) return;
  collapsed = next;
  header.classList.toggle("header-collapsed", next);
  // One measurement once the card settles, for anything that resized it while
  // it was closed and got turned away — a filter row that wrapped on a rotate,
  // say. Costs a single reflow at the end of a fold instead of one per frame.
  clearTimeout(folding);
  folding = setTimeout(() => {
    folding = 0;
    measure();
  }, FOLD_MS);
}

// Where the page actually is, ignoring rubber-band. Touch platforms let you
// drag past either end and then spring back on their own — and that spring is a
// real upward delta, which is why bouncing at the foot of a board used to pop
// the header open. Clamping to the legitimate range pins the position at the
// end for the whole excursion, so the bounce out and the bounce back both
// contribute nothing to travel.
function scrollTop() {
  const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  return Math.min(Math.max(window.scrollY, 0), max);
}

function apply() {
  ticking = false;
  const y = scrollTop();
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
  lastY = scrollTop();

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
