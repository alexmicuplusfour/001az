// keepPlace (modal.js) — what the board editor's list rebuilds must not cost
// the reader.
//
// Every structural edit in these panes goes through a full re-render: tick a
// connector field, remove an AI field, delete a taxonomy value. Emptying the
// list collapses the modal body's content, the browser clamps scrollTop to the
// new maximum of zero, and refilling restores the height but not the position —
// so un-ticking one field near the bottom dropped the reader at the top of the
// modal with no indication of what had happened. The same rebuild destroys the
// control that was just operated, which costs a keyboard user the keyboard.
//
// The helper was written twice before it was written once: the facet editor had
// a private copy of the scroll half, and the mapping pane — four rebuilding
// renders in the same scrolling body — had none. So the contract is pinned
// here rather than left to two call sites to agree on.
import { test } from "node:test";
import assert from "node:assert/strict";

// A DOM just deep enough: an ancestor chain to walk, a computed overflow-y to
// read, and a scrollTop that CLAMPS on layout the way a browser's does — that
// clamp being the entire behaviour under defence. Modelling it is the point of
// the stub, not an incidental detail of it.
const focusCalls = [];

function el({ overflowY = "visible", scrollHeight = 0, clientHeight = 0, place } = {}) {
  const node = {
    tag: "div",
    parentElement: null,
    children: [],
    dataset: place ? { place } : {},
    overflowY,
    clientHeight,
    _top: 0,
    _sh: scrollHeight,
    get scrollHeight() { return this._sh; },
    // Content changed → the browser re-clamps the offset to the new maximum.
    set scrollHeight(v) { this._sh = v; this.scrollTop = this._top; },
    get scrollTop() { return this._top; },
    set scrollTop(v) { this._top = Math.max(0, Math.min(v, Math.max(0, this._sh - this.clientHeight))); },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === this) return true;
      return false;
    },
    querySelectorAll(sel) {
      assert.equal(sel, "[data-place]");
      const out = [];
      const walk = (n) => n.children.forEach((c) => { if (c.dataset.place) out.push(c); walk(c); });
      walk(this);
      return out;
    },
    focus(opts) { focusCalls.push({ node: this, opts }); globalThis.document.activeElement = this; },
    append(...kids) {
      for (const k of kids) { k.parentElement = this; this.children.push(k); }
    },
    clear() { this.children.forEach((c) => { c.parentElement = null; }); this.children = []; },
  };
  return node;
}

globalThis.getComputedStyle = (n) => ({ overflowY: n.overflowY });
globalThis.document = { activeElement: null };

const { keepPlace } = await import("../public/modal.js");

// A scrolling modal body with a list inside it, scrolled two thirds down.
function scrolledList({ scrollHeight = 1000, clientHeight = 200, top = 600 } = {}) {
  const host = el({ overflowY: "auto", scrollHeight, clientHeight });
  const list = el();
  host.append(list);
  host.scrollTop = top;
  return { host, list };
}

test("holds the offset across a rebuild that would have clamped it to zero", () => {
  const { host, list } = scrolledList();
  const render = keepPlace(list, () => {
    list.clear();
    host.scrollHeight = 0;          // the list is empty for an instant…
    assert.equal(host.scrollTop, 0, "the clamp the helper exists to undo");
    host.scrollHeight = 990;        // …and refilled one row shorter
  });

  render();

  assert.equal(host.scrollTop, 600);
});

test("restores after the content is back, so the restore isn't clamped in turn", () => {
  const { host, list } = scrolledList();
  // A rebuild that leaves the list genuinely shorter than where the reader was:
  // the offset can only go as far as the new content allows, and that is the
  // right answer — not zero.
  const render = keepPlace(list, () => { host.scrollHeight = 400; });

  render();

  assert.equal(host.scrollTop, 200); // 400 - 200 clientHeight
});

test("finds the nearest ancestor that actually scrolls, not the nearest that says it might", () => {
  const outer = el({ overflowY: "auto", scrollHeight: 1000, clientHeight: 200 });
  const overflowButUnscrolled = el({ overflowY: "auto", scrollHeight: 300, clientHeight: 300 });
  const tallButVisible = el({ overflowY: "visible", scrollHeight: 900, clientHeight: 100 });
  const list = el();
  outer.append(overflowButUnscrolled);
  overflowButUnscrolled.append(tallButVisible);
  tallButVisible.append(list);
  outer.scrollTop = 700;

  keepPlace(list, () => { outer.scrollHeight = 0; outer.scrollHeight = 1000; })();

  assert.equal(outer.scrollTop, 700);
});

test("no scrolling ancestor at all — the render still runs", () => {
  const list = el();
  let ran = false;
  keepPlace(list, () => { ran = true; })();
  assert.equal(ran, true);
});

test("returns focus to the control rebuilt under the same place", () => {
  focusCalls.length = 0;
  const { host, list } = scrolledList();
  const before = el({ place: "connector:price" });
  list.append(before);
  document.activeElement = before;

  keepPlace(list, () => {
    list.clear();
    host.scrollHeight = 0;
    list.append(el({ place: "connector:market_cap" }), el({ place: "connector:price" }));
    host.scrollHeight = 1000;
  })();

  assert.equal(focusCalls.length, 1);
  assert.equal(focusCalls[0].node.dataset.place, "connector:price");
  assert.notEqual(focusCalls[0].node, before, "the rebuilt control, not the destroyed one");
});

test("focus is restored WITHOUT scrolling — the offset just restored is the answer", () => {
  focusCalls.length = 0;
  const { host, list } = scrolledList();
  const cb = el({ place: "file:created" });
  list.append(cb);
  document.activeElement = cb;

  keepPlace(list, () => { list.clear(); list.append(el({ place: "file:created" })); })();

  assert.deepEqual(focusCalls[0].opts, { preventScroll: true });
  assert.equal(host.scrollTop, 600);
});

test("a control the edit removed is not restored — there is nowhere to put it", () => {
  focusCalls.length = 0;
  const { list } = scrolledList();
  const cb = el({ place: "file:created" });
  list.append(cb);
  document.activeElement = cb;

  // Un-ticking a file field deletes its row outright.
  keepPlace(list, () => { list.clear(); list.append(el({ place: "file:size" })); })();

  assert.equal(focusCalls.length, 0);
});

test("focus outside the rebuilt list is left where it is", () => {
  focusCalls.length = 0;
  const { host, list } = scrolledList();
  const elsewhere = el({ place: "connector:price" });
  host.append(elsewhere); // a sibling of the list, not inside it
  document.activeElement = elsewhere;

  keepPlace(list, () => { list.clear(); list.append(el({ place: "connector:price" })); })();

  assert.equal(focusCalls.length, 0, "nothing was taken, so nothing is given back");
});

test("nothing focused at all is not an error", () => {
  focusCalls.length = 0;
  const { list } = scrolledList();
  document.activeElement = null;
  keepPlace(list, () => { list.clear(); })();
  assert.equal(focusCalls.length, 0);
});
