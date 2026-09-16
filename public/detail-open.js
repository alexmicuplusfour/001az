// The one door to the detail view.
//
// It used to be three doors, and one of them was in the wrong place: each kind
// in kinds.js carried `openDetail(item) { openLightbox(item) }`. All four were
// identical, so it was never kind-specific behaviour — it was a constant that
// made a 221-line vocabulary module (what kinds of thing can sit on a board,
// and how to name and thumbnail each one) import an 853-line viewer. That one
// edge accounted for four of the six import cycles in this frontend and for
// the deepest chain in its graph.
//
// So the registry describes items and this decides what opens them, which is
// also what lets the viewer arrive on the first open instead of at boot: the
// lightbox and the detail/chart modules behind it are ~25 kB nobody needs
// until they click something.
//
// initLightbox rides the door's one-time hook. It only creates an overlay and
// attaches listeners to elements index.html already carries, so it has no
// reason to run before the first open — main() no longer calls it.
import { lazyDoor } from './lazy-door.js';

const door = lazyDoor(() => import('./lightbox.js'), {
  failMsg: "Couldn't open the detail view",
  after: (m) => m.initLightbox(),
});

export const openDetail = door.fn('openLightbox');
export const openDetailAt = door.fn('openLightboxAt');
export const preloadDetail = door.preload;
