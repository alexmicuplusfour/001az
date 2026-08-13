// The boards index's rollup: does this board want the reader's attention, and
// what for (planning/boards-signals-plan.md).
//
// ONE dot per card rather than three. At index altitude the question is *which
// board do I go to*, not *what kind of news is it* — the gallery answers the
// second question, and that is the right division: the index routes, the board
// explains. The card also already carries a count and up to three capability
// chips, and three more marks on it would be unreadable.
//
// The comparison is the SAME one the gallery's header dots make, against the
// same localStorage marks, because seen-mark.js keys on `${scope}:${boardId}`
// and always has. That is the whole design: acknowledge a board's job log in its
// gallery and this board's card goes dark, with no second ledger, no
// synchronisation, and no way for the two surfaces to disagree.
//
// Its own module, and not a function inside boards.js, because the two answer
// different questions: this one is the RULES — what counts as news and what the
// card then says — while boards.js is the page's wiring. The rules are what have
// cases worth pinning, and they are worth reading without the fetch-render-paint
// machinery around them.
import { unseen, JOBS_SEEN, DIAG_SEEN } from './seen-mark.js';
import { attachBtnDot } from './utils.js';

// Returns the reasons this board is lit, newest concern first, or null for a
// dark card. Reasons and lit-ness are one call and one answer deliberately: the
// dot and the accessible name that explains it must never be able to disagree,
// which they can the moment they are computed from two places.
//
// A missing row is dark, not lit. The index paints from whatever has landed, and
// a board the signals fetch has not described yet has nothing to point at —
// which is the same answer `unseen()` gives for an absent stamp, one layer down.
export function boardSignal(row) {
  if (!row) return null;
  const parts = [];
  // No count on the jobs half: the stamp says WHEN, not how many, and a number
  // here would need a second query to be true. Same refusal the jobs chip makes.
  if (unseen(JOBS_SEEN, row.board_id, row.failed_at)) parts.push("a job failed");
  // The alerts half is the one signal that CAN count, because the server keeps a
  // per-user ledger for it rather than a watermark — so it does.
  const n = Number(row.alerts_unseen) || 0;
  if (n > 0) parts.push(`${n} new alert match${n === 1 ? "" : "es"}`);
  // `diagnostic_at` is already gated server-side to managers of vote-mode
  // boards, so there is no second test here. A reader who cannot see findings is
  // handed null and cannot light on one — the gate arrives as data, which is
  // what keeps the disclosure decision on the side of the wire that owns it.
  if (unseen(DIAG_SEEN, row.board_id, row.diagnostic_at)) parts.push("a new tagging consistency finding");
  return parts.length ? parts : null;
}

// Put the answer on one card — the half that has to be right twice, since it
// runs from BOTH a full render and an in-place repaint.
//
// The invariant those two share: **a render and a paint must produce the same
// DOM.** If they can disagree, the bug only shows after a board settings save,
// which is the hardest possible way to find it.
//
// Takes the signals row and nothing else. It deliberately does NOT take the
// board: everything it writes is composed from `parts`, so handing it the board
// would be a parameter the body never reads and a dependency on the overview
// payload that does not exist.
export function applyBoardDot(wrap, row) {
  // Remove before adding, both of them. The gallery gets this for free —
  // renderToolbar builds fresh elements each pass, so attachBtnDot always
  // appends to a new node — but a repaint appends to a SURVIVING node, and a
  // board with a standing failure would otherwise grow a dot per tick.
  wrap.querySelector(":scope > .btn-dot")?.remove();
  wrap.classList.remove("has-dot");
  const card = wrap.querySelector(".board-card");
  card?.querySelector(".bc-signal-note")?.remove();
  const parts = boardSignal(row);
  if (!parts) return null;

  // A hidden line of text INSIDE the link, rather than an aria-label on it.
  //
  // The obvious move is `card.setAttribute("aria-label", …)`, and it is wrong:
  // aria-label REPLACES an element's content-derived name, so a card that reads
  // "People, 247 items, Cryptocurrencies" to a screen reader would collapse to
  // whatever this function chose to say — silently, and on every card, since a
  // dark one would have had to carry a label too. The signal is an ADDITION to
  // what the card already says, so it is added as content and the browser
  // composes the name: "People 247 items … a job failed".
  //
  // Which also disposes of the stale-label failure mode entirely. There is no
  // label to leave behind: the node is removed above and rebuilt here, on the
  // same terms as the dot, so the two cannot disagree about what is lit.
  const note = document.createElement("span");
  // Two classes, one each for the two jobs: `bc-signal-note` is what this module
  // finds it by, `vis-hidden` is the shared clip utility that hides it.
  note.className = "bc-signal-note vis-hidden";
  note.textContent = parts.join(", ");
  card?.appendChild(note);

  // …and the sighted half of the same problem, which the plan left as a loose
  // end and should not have: a bare red dot with no text anywhere on the page is
  // unreadable to the reader who CAN see it. The title rides on the dot rather
  // than the card, because a tooltip covering the whole card would fire on every
  // hover and would collide with the one .bc-name already carries.
  const dot = attachBtnDot(wrap);
  dot.title = parts.join(", ");
  return parts;
}
