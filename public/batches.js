// batches.js — a gallery view drawn a batch at a time into #grid
// (planning/list-view-plan.md, D7). Every view draws the filtered list the
// same way: from its first batch when the filters or the view change, the
// next batch as the page nears the "load more" marker under #grid (the
// sentinel), and far enough to hold an item the lightbox closes on. Each view
// draws its own tree and keeps its own observer on the marker; this owns what
// they had each written out: how many are drawn, the list they were drawn
// from, the next batch, drawing far enough, and re-arming the observer.
import { taggedFiltered } from './filters.js';
import { effectiveView, toggleView } from './view.js';
import { pageJumped } from './header-scroll.js';

const elGrid = document.getElementById("grid");
const elGridSentinel = document.getElementById("grid-sentinel");

// The key #grid was last drawn under, from app.js render(): the filters and
// the view. Every view draws into #grid, so all of them go by this one key. A
// key other than the last one (the filters changed, or the view flipped)
// starts the view over at its first batch and always draws, since #grid may
// be holding another view's tree: each view skips a draw when nothing it
// reads has moved, and a flip moves nothing it reads.
let shownKey = "";
function freshKey(key) {
  if (key === shownKey) return false;
  shownKey = key;
  return true;
}

const views = [];

// One view's batches. `draw(force)` draws the view's tree from `last` and
// `limit`; `after()` follows a draw the page didn't ask for (the next batch,
// or drawing far enough), which is where the grid lays out its masonry.
export function batchedView(name, size, draw, after = () => {}) {
  const view = {
    limit: size,
    last: { progress: [], items: [] }, // what render() last handed the view
    // What app.js render() hands the view, kept for the batches after it.
    // Returns whether the key was fresh; the view draws.
    render(key, progress, items) {
      const fresh = freshKey(key);
      if (fresh) view.limit = size;
      view.last = { progress, items };
      return fresh;
    },
    // The lightbox pages through the whole filtered list, so the item it
    // closes on can sit past the ones drawn; a view switch brings back an item
    // the other view had in sight (switchView), with a batch more after it
    // (`more`) so the page reaches below it. Only the view showing draws, and
    // it's laid out now: the grid's masonry would otherwise wait a frame.
    reveal(item, more = false) {
      if (effectiveView() !== name) return;
      const items = taggedFiltered();
      const at = items.indexOf(item);
      if (at < 0) return; // no longer in the list
      const want = Math.min(at + 1 + (more ? size : 0), items.length);
      if (want > view.limit) grow(want, items);
      else after();
    },
    poke() {
      observer.unobserve(elGridSentinel);
      observer.observe(elGridSentinel);
    },
  };
  function grow(limit, items) {
    view.limit = limit;
    view.last.items = items;
    draw();
    after();
    view.poke(); // the marker may still be in reach: the next batch then follows
  }
  const observer = new IntersectionObserver((entries) => {
    if (effectiveView() !== name || !entries.some((e) => e.isIntersecting)) return;
    const items = taggedFiltered();
    if (view.limit < items.length) grow(Math.min(view.limit + size, items.length), items);
  }, { rootMargin: "1200px 0px" });
  observer.observe(elGridSentinel);
  views.push(view);
  return view;
}

// Back to the item the lightbox closed on: the view showing draws far enough
// to hold it, and the page scrolls to it. Every view draws an item under its
// data-id; that element is returned, for the lightbox to hand focus to.
export function showItem(item) {
  if (!item) return null;
  for (const v of views) v.reveal(item);
  const el = elGrid.querySelector(`[data-id="${item.id}"]`);
  el?.scrollIntoView({ behavior: "instant", block: "center" });
  return el;
}

// What covers the top of the screen: the fixed header, and in List its column
// header, stuck under it (styles.css), which the rows slide beneath.
function coveredTop() {
  const th = elGrid.querySelector("thead th");
  if (th) return (parseFloat(getComputedStyle(th).top) || 0) + th.offsetHeight;
  return document.querySelector("header")?.getBoundingClientRect().bottom ?? 0;
}

// The first item in sight: top-most, then left-most (the grid's masonry),
// and the height its top showed at.
function inSight() {
  const edge = coveredTop();
  let first = null;
  for (const el of elGrid.querySelectorAll("[data-id]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= edge || r.top >= window.innerHeight) continue;
    if (!first || r.top < first.top - 1 || (Math.abs(r.top - first.top) <= 1 && r.left < first.left)) {
      first = { id: el.dataset.id, top: r.top, left: r.left };
    }
  }
  return first && { id: first.id, y: Math.max(first.top, edge) };
}

// A switch from the toolbar's toggles keeps your place (planning/
// list-view-plan.md, Stage 4): the first item in sight, drawn in the other
// view with a batch after it, and scrolled back to the height it showed at,
// never under List's column header. The list's first item goes back to the
// top. The jump isn't the reader scrolling, so the folding header stays as it
// was (header-scroll.js).
export function switchView(view) {
  const place = inSight();
  toggleView(view); // the page draws the other view, at once (app.js)
  if (!place) return;
  const items = taggedFiltered();
  const item = items.find((i) => String(i.id) === place.id);
  if (!item) return;
  if (item === items[0]) window.scrollTo(0, 0);
  else {
    for (const v of views) v.reveal(item, true);
    const el = elGrid.querySelector(`[data-id="${item.id}"]`);
    if (el) window.scrollBy(0, el.getBoundingClientRect().top - Math.max(place.y, coveredTop()));
  }
  pageJumped();
}

// After a draw, every view's observer looks again: the marker may be in reach
// with nothing crossing it. Each ignores the look unless its view is showing.
export function pokeBatches() {
  for (const v of views) v.poke();
}
