// switchRow's programmatic setter (board-modal.js). It exists because three
// call sites need to move a knob from code rather than from a click: the
// double-check/web-research mutual exclusion, and the ingestion modal forcing
// `enabled` on when the trigger goes manual.
//
// The contract that matters is the one that isn't visible in the signature —
// setSwitch must NOT fire onChange. Every caller has already written the model
// value itself, so a setter that echoed back through the handler would either
// double-write or, in the exclusion's case, recurse. Before this was shared API
// the same two lines were hand-copied in three places and had already drifted
// on which selector found the button; pinning the behaviour is what keeps the
// single copy honest.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./browser-stub.js";

// A node with the parts makeSwitch/switchRow actually touch: className backed
// by a real class set (the click handler reads classList.contains("on") to
// decide the next state), attributes, children and listeners.
const node = (tag) => {
  const classes = new Set();
  return {
    tag, type: "", textContent: "", hidden: false, style: {}, children: [], attrs: {}, listeners: {},
    get className() { return [...classes].join(" "); },
    set className(v) {
      classes.clear();
      String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    append(...c) { this.children.push(...c); },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
    click() { (this.listeners.click || []).forEach((fn) => fn({ stopPropagation() {}, target: this })); },
  };
};
// `body` because board-modal's import graph reaches toast.js, which mounts its
// host element at module scope; the listener hooks because data.js registers on
// load. Neither is under test — they just have to exist for the import.
globalThis.document = {
  createElement: node,
  createTextNode: (t) => ({ tag: "#text", textContent: t }),
  body: node("body"),
  addEventListener() {},
  dispatchEvent() { return true; },
};

const { switchRow } = await import("../public/board-modal.js");

const knob = (row) => row.children.find((c) => c.classList.contains("switch"));
const read = (row) => {
  const sw = knob(row);
  return { on: sw.classList.contains("on"), aria: sw.getAttribute("aria-checked") };
};

test("setSwitch moves the knob and its aria state, in both directions", () => {
  const row = switchRow("Run on this schedule", null, false, () => {});
  assert.deepEqual(read(row), { on: false, aria: "false" }, "starts at the passed-in value");

  row.setSwitch(true);
  assert.deepEqual(read(row), { on: true, aria: "true" });
  row.setSwitch(false);
  assert.deepEqual(read(row), { on: false, aria: "false" },
    "and back — a row hidden mid-edit must not strand a stale knob");
});

test("setSwitch does not fire onChange; clicking does", () => {
  const seen = [];
  const row = switchRow("Double-check tags", null, false, (on) => seen.push(on));

  row.setSwitch(true);
  assert.deepEqual(seen, [], "the caller already owns the model — echoing it back would double-write");

  knob(row).click();
  assert.deepEqual(seen, [false], "a real click still reports, and reports the value it flipped TO");
  assert.deepEqual(read(row), { on: false, aria: "false" }, "click and setter agree on the visual state");
});
