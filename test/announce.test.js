// The header's voice — announce.js — and the one rule the whole feature rests
// on: FIRE ON THE EDGE FROM DARK TO LIT, ONCE, AND NEVER AGAIN WHILE IT STAYS
// LIT. Everything else in the notification layer is downstream of that sentence,
// and until now nothing tested it.
//
// It could not be tested, for one concrete reason: board-modal.js — reached via
// announce.js -> alerts-modal.js -> board-modal.js — wrote its five imports in
// the root-absolute `/x.js` form, which a browser resolves and Node does not.
// That was the only such file among the 38 modules announce.js reaches. With
// those five lines relative the module imports here, and what is left is a
// browser shim broad enough to let the chain load.
//
// The shims are deliberately dumb. Nothing below tests rendering; `document` is
// a real EventTarget so `app:render` genuinely drives check(), and everything
// else exists only so module-scope code (grid's IntersectionObserver, toast's
// wrapper div) does not throw on the way in.
import { test } from "node:test";
import assert from "node:assert/strict";

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

const node = () => ({
  style: {}, dataset: {}, children: [], hidden: false,
  classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  setAttribute() {}, removeAttribute() {}, getAttribute: () => null,
  appendChild(c) { this.children.push(c); return c; },
  append(...c) { this.children.push(...c); },
  prepend() {}, remove() {}, insertAdjacentHTML() {},
  addEventListener() {}, removeEventListener() {},
  replaceChildren() { this.children.length = 0; },
  querySelector: () => null, querySelectorAll: () => [],
});

// A real EventTarget underneath, so startAnnouncing's listener and the
// app:render dispatches below are the actual wiring rather than a stand-in.
const bus = new EventTarget();
const body = node();
globalThis.document = {
  addEventListener: (...a) => bus.addEventListener(...a),
  removeEventListener: (...a) => bus.removeEventListener(...a),
  dispatchEvent: (e) => bus.dispatchEvent(e),
  createElement: node, createDocumentFragment: node,
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  body, documentElement: node(), head: node(),
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {},
  innerWidth: 1000, matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({ paddingRight: "0px" }),
};
globalThis.requestAnimationFrame = () => 0;
globalThis.getComputedStyle = () => ({ paddingRight: "0px" });
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.location = { search: "", pathname: "/", replace() {} };

// The audible half, counted. chime() only sounds for a toast that was actually
// shown, so this doubles as the assertion for that rule.
let chimes = 0;
globalThis.Audio = class {
  constructor() { this.volume = 0; this.currentTime = 0; }
  play() { chimes++; return Promise.resolve(); }
};

const { state } = await import("../public/state.js");
const { startAnnouncing } = await import("../public/announce.js");
const { refreshAlerts, refreshJobErrors } = await import("../public/signals.js");
const { markJobsSeen } = await import("../public/jobs-modal.js");

// toast.js builds its wrapper at module scope and appends it to body, so the
// first child of body IS the toast list. Counting its children counts the
// toasts actually on screen — which is not the same as the toasts asked for,
// and the difference is the point of one of the cases below.
const toasts = () => body.children[0].children.length;

const render = () => document.dispatchEvent(new Event("app:render"));
const replies = (payload) => async () => ({ ok: true, json: async () => payload });
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  // refreshAlerts starts the item poll when it discovers alerts; stub the timer
  // so no real pollTick is ever armed from a test.
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = () => 0;
  try { return await fn(); } finally { globalThis.fetch = real; globalThis.setTimeout = realTimeout; }
};

test("the edge rule", async (t) => {
  state.boardId = "b-announce";
  state.me = { id: 1 };
  state.alerts = [];
  state.jobsFailedAt = null;
  state.facetStats = null;
  state.boardManage = false; // the diagnostics dot has no surface here, so it never reads

  await t.test("a signal whose data has not landed is skipped, not recorded dark", async () => {
    // The real shape of the bug, and it has to be set up the real way: a failed
    // boot fetch leaves state.jobsFailedAt at null, which is indistinguishable
    // from "this board has never failed" — so the value alone reads DARK. Taking
    // that as the baseline is what arms the next successful fetch to announce a
    // failure from last week. ready() is what stops the reading being taken.
    //
    // Setting up a LIT value here instead would pass either way — with the gate
    // and without it — which is the version of this test that proves nothing.
    state.jobsFailedAt = null;
    startAnnouncing();
    assert.equal(toasts(), 0);
    assert.equal(chimes, 0);
  });

  await t.test("…so the first reading that DOES land only establishes the baseline", async () => {
    // An old failure, arriving through a successful read. It is lit, and it is
    // not news: it predates the session. "Whatever is already lit when the page
    // opens is never news" is the plan's sentence, and this is the line where a
    // missing ready() turns it false.
    await withFetch(replies({ failed_at: 5_000_000, now: Date.now() }), refreshJobErrors);
    render();
    assert.equal(toasts(), 0, "a failure that predates the session is not news");
    assert.equal(chimes, 0);
  });

  await t.test("a newer failure while the dot is ALREADY lit is still not an edge", async () => {
    // The rule's second half, and the reason a retag failing three hundred items
    // is one toast rather than three hundred. The dot is already saying "unread
    // news here"; a fresher stamp behind it does not make that more true.
    state.jobsFailedAt = Date.now() + 60_000;
    render();
    assert.equal(toasts(), 0);
    assert.equal(chimes, 0);
  });

  await t.test("acknowledging re-arms it, and the next failure announces", async () => {
    markJobsSeen();
    render();
    assert.equal(toasts(), 0, "acknowledging is a falling edge, not an announcement");

    state.jobsFailedAt = Date.now() + 120_000;
    render();
    assert.equal(toasts(), 1);
    assert.equal(chimes, 1);
  });

  await t.test("…and not again while it stays lit", async () => {
    render();
    render();
    assert.equal(toasts(), 1);
    assert.equal(chimes, 1);
  });

  await t.test("a repeat inside the toast's life is silent, not a second sound", async () => {
    // This one IS a rising edge — acknowledged, then a new failure — so check()
    // takes it and asks for a toast. But "A job failed" is a fixed string and the
    // first is still on screen, so toast() dedupes and hands back null. The chime
    // has to go with it: a sound with nothing to read is a notification that says
    // only "something", which is how a sound gets switched off for good.
    markJobsSeen();
    render();
    state.jobsFailedAt = Date.now() + 180_000;
    render();
    assert.equal(toasts(), 1, "the duplicate never reached the screen");
    assert.equal(chimes, 1, "so it made no sound either");
  });

  await t.test("a second signal keeps its own baseline and its own edge", async () => {
    // Alerts have been skipped by ready() this whole time — nothing had fetched
    // them — so their first landing is a baseline like anyone else's, even
    // though five toasts' worth of jobs history has gone by. The dots do not
    // share a baseline any more than they share a watermark.
    await withFetch(replies([{ id: 1, name: "Yellow chairs", unseen: 0 }]), refreshAlerts);
    render();
    assert.equal(toasts(), 1, "the first alerts reading is a baseline, not news");

    // …and now a firing. The message carries a count, so unlike "A job failed"
    // it is never a duplicate — which is what makes this the case that proves an
    // acknowledged signal really can announce again.
    await withFetch(replies([{ id: 1, name: "Yellow chairs", unseen: 3 }]), refreshAlerts);
    render();
    assert.equal(toasts(), 2);
    assert.equal(chimes, 2);
  });
});
