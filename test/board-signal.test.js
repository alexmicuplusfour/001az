// The boards index's rollup dot (planning/boards-signals-plan.md).
//
// Two halves with different failure modes. The PREDICATE half's whole point is
// that it shares the gallery's watermarks rather than agreeing to behave like
// them — so the assertion that matters is cross-surface: the mark the job log
// writes in the gallery must darken this card, with nothing else changing.
//
// The PAINT half is DOM-bound and is the part most likely to ship broken,
// because the index gets none of the guarantees the gallery's render model
// hands the header for free. It runs from a full render AND from an in-place
// repaint, and the two must produce the same DOM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { localStore as store } from "./browser-stub.js";

// browser-stub's createElement is enough for modules that only build nodes;
// this one REMOVES them, which is the behaviour under test. A detach that
// silently did nothing would let the accumulation bug pass.
globalThis.document.createElement = () => {
  const el = {
    className: "",
    parent: null,
    appendChild() {},
    setAttribute() {},
    remove() {
      const kids = el.parent?.children;
      if (kids) kids.splice(kids.indexOf(el), 1);
    },
  };
  return el;
};

const { boardSignal, applyBoardDot } = await import("../public/board-signal.js");
const { markSeen, JOBS_SEEN, DIAG_SEEN } = await import("../public/seen-mark.js");

const BOARD = "b-1";
const row = (over = {}) => ({
  board_id: BOARD, failed_at: null, alerts_unseen: 0, diagnostic_at: null, ...over,
});

// ── the predicate ────────────────────────────────────────────────────────────

test("a board with nothing to say is dark", () => {
  store.clear();
  assert.equal(boardSignal(row()), null);
});

test("a board the signals fetch has not described yet is dark, not lit", () => {
  store.clear();
  assert.equal(boardSignal(undefined), null);
});

test("each of the three lights it on its own", () => {
  store.clear();
  assert.deepEqual(boardSignal(row({ failed_at: 5000 })), ["a job failed"]);
  assert.deepEqual(boardSignal(row({ alerts_unseen: 3 })), ["3 new alert matches"]);
  assert.deepEqual(boardSignal(row({ diagnostic_at: 5000 })), ["a new tagging consistency finding"]);
});

test("one alert match is singular", () => {
  store.clear();
  assert.deepEqual(boardSignal(row({ alerts_unseen: 1 })), ["1 new alert match"]);
});

test("all three at once are all named, in one answer", () => {
  // Lit-ness and the label are one call deliberately: the dot and the sentence
  // that explains it cannot disagree if they are the same value.
  store.clear();
  const parts = boardSignal(row({ failed_at: 5000, alerts_unseen: 2, diagnostic_at: 9000 }));
  assert.equal(parts.length, 3);
});

test("acknowledging the job log IN THE GALLERY darkens the index dot", () => {
  // The whole design in one assertion. seen-mark.js keys on `${scope}:${boardId}`,
  // so the index dot and the gallery dot are the same dot — no second ledger, no
  // synchronisation, and no state here that could fall out of step.
  store.clear();
  assert.ok(boardSignal(row({ failed_at: 5000 })));
  markSeen(JOBS_SEEN, BOARD, 5000); // exactly what markJobsSeen() writes
  assert.equal(boardSignal(row({ failed_at: 5000 })), null);
});

test("…and the next failure lights it again", () => {
  store.clear();
  markSeen(JOBS_SEEN, BOARD, 5000);
  assert.ok(boardSignal(row({ failed_at: 9_999_999_999_999 })));
});

test("the two watermarks do not share a key", () => {
  // One key builder, two scopes: reading the job log must not quietly mark the
  // findings read. The header's own version of this is pinned in jobs-dot.test.js
  // and the index reads both marks, so it can break it in a new place.
  store.clear();
  markSeen(JOBS_SEEN, BOARD, 5000);
  assert.deepEqual(boardSignal(row({ diagnostic_at: 4000 })), ["a new tagging consistency finding"]);
});

test("a watermark on one board says nothing about another", () => {
  store.clear();
  markSeen(JOBS_SEEN, BOARD, 5000);
  assert.ok(boardSignal({ board_id: "b-2", failed_at: 5000, alerts_unseen: 0, diagnostic_at: null }));
});

test("a diagnostic the server refused to disclose cannot light", () => {
  // The gate arrives as data: /facet-stats is manager-only, so a plain member is
  // handed null and there is no second client-side test to get wrong.
  store.clear();
  assert.equal(boardSignal(row({ diagnostic_at: null })), null);
});

// ── the paint ────────────────────────────────────────────────────────────────

// Enough DOM for one card. `:scope >` is not worth emulating: the stub answers
// the two selectors the module actually asks for.
const hasNote = (c) => String(c.className).split(" ").includes("bc-signal-note");

function wrapEl() {
  const card = {
    attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { c.parent = card; card.children.push(c); return c; },
    // Matched by class CONTAINMENT, not equality: the note carries the shared
    // .vis-hidden utility alongside its own name, and a stub that compared the
    // whole attribute would quietly stop finding it.
    querySelector(sel) {
      return sel === ".bc-signal-note" ? card.children.find(hasNote) || null : null;
    },
    // What a screen reader would compose from the link's content. The card's own
    // text stands in for the name/count/chips the real one carries, so a change
    // that REPLACED the name rather than adding to it shows up here.
    get accName() { return ["People", "247 items", ...card.children.map((c) => c.textContent)].join(" "); },
    get note() { return card.children.find(hasNote)?.textContent ?? null; },
  };
  const self = {
    card,
    children: [],
    classes: new Set(["bc-wrap"]),
    appendChild(c) { c.parent = this; this.children.push(c); return c; },
    // Only the two selectors the module actually asks for. `:scope >` is not
    // worth emulating any further than "a direct child".
    querySelector(sel) {
      if (sel === ".board-card") return this.card;
      if (sel === ":scope > .btn-dot") return this.children.find((c) => c.className === "btn-dot") || null;
      return null;
    },
    get dots() { return this.children.filter((c) => c.className === "btn-dot").length; },
  };
  // Closed over `self`, not over a shared binding: two wraps have to be
  // independent for the render-vs-paint comparison below to mean anything.
  self.classList = {
    add: (c) => self.classes.add(c),
    remove: (c) => self.classes.delete(c),
    contains: (c) => self.classes.has(c),
  };
  return self;
}

let wrap;
const fresh = () => (wrap = wrapEl());

test("a lit board gets one dot, a hidden line saying why, and a tooltip", () => {
  store.clear();
  fresh();
  applyBoardDot(wrap, row({ failed_at: 5000 }));
  assert.equal(wrap.dots, 1);
  assert.ok(wrap.classes.has("has-dot"));
  assert.equal(wrap.card.note, "a job failed");
  assert.equal(wrap.children.find((c) => c.className === "btn-dot").title, "a job failed",
    "the sighted reader can hover the dot to find out what it means");
});

test("the signal ADDS to the card's accessible name rather than replacing it", () => {
  // The trap this avoids: aria-label on the link would override everything the
  // card already says, so "People, 247 items, Cryptocurrencies" would collapse
  // to whatever the dot chose to announce — silently, and on dark cards too.
  store.clear();
  fresh();
  applyBoardDot(wrap, row({ failed_at: 5000 }));
  assert.equal(wrap.card.attrs["aria-label"], undefined, "no aria-label to override the content");
  assert.match(wrap.card.accName, /People 247 items a job failed/);
});

test("a dark board says nothing extra, and keeps its own name", () => {
  store.clear();
  fresh();
  applyBoardDot(wrap, row());
  assert.equal(wrap.dots, 0);
  assert.equal(wrap.card.note, null);
  assert.equal(wrap.card.accName, "People 247 items");
});

test("repeated paints leave ONE dot, not one per tick", () => {
  // The accumulation guarantee the header gets for free from renderToolbar
  // building fresh elements each pass. Here the node survives, so the module has
  // to remove before it adds — and a board with a standing failure repaints
  // every minute for as long as the tab is open.
  store.clear();
  fresh();
  for (let i = 0; i < 5; i++) applyBoardDot(wrap, row({ failed_at: 5000 }));
  assert.equal(wrap.dots, 1);
});

test("a signal going dark removes the dot, the class AND the stale label", () => {
  store.clear();
  fresh();
  applyBoardDot(wrap, row({ failed_at: 5000 }));
  markSeen(JOBS_SEEN, BOARD, 5000);
  applyBoardDot(wrap, row({ failed_at: 5000 }));
  assert.equal(wrap.dots, 0);
  assert.equal(wrap.classes.has("has-dot"), false);
  assert.equal(wrap.card.note, null, "a line left behind is the failure no visual check catches");
  assert.equal(wrap.card.accName, "People 247 items");
});

test("the wording follows the signals, not the first one to arrive", () => {
  store.clear();
  fresh();
  applyBoardDot(wrap, row({ failed_at: 5000 }));
  applyBoardDot(wrap, row({ failed_at: 5000, alerts_unseen: 4 }));
  assert.equal(wrap.card.note, "a job failed, 4 new alert matches");
  // Through `hasNote`, the same class-CONTAINMENT test the stub's querySelector
  // uses, and for the reason stated there: the note carries .vis-hidden
  // alongside its own name, so an equality check against "bc-signal-note" alone
  // matches nothing this module can produce — it would pass whether the line
  // landed on the wrapper or not.
  assert.equal(wrap.children.filter(hasNote).length, 0,
    "the line belongs to the card, not the wrapper");
});

test("a fresh render and a repaint produce the same DOM", () => {
  // The invariant. render() runs on a path with nothing to do with signals — the
  // manage pencil hands it to openBoardModal as onSaved — so every card is
  // rebuilt whenever anyone saves board settings. If the two paths can disagree,
  // the bug only appears after a save.
  store.clear();
  const painted = wrapEl();
  applyBoardDot(painted, row({ diagnostic_at: 7000 }));
  applyBoardDot(painted, row({ diagnostic_at: 7000 })); // a tick
  const rendered = wrapEl();
  applyBoardDot(rendered, row({ diagnostic_at: 7000 })); // a rebuild
  assert.equal(painted.dots, rendered.dots);
  assert.deepEqual(painted.card.attrs, rendered.card.attrs);
  assert.equal(painted.card.note, rendered.card.note);
  assert.equal(painted.card.children.length, rendered.card.children.length, "no duplicated hidden line");
  assert.deepEqual([...painted.classes], [...rendered.classes]);
});
