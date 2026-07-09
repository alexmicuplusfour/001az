// toast.js is DOM-coupled but only through a handful of element calls, so a
// tiny stub is enough to test its lifecycle logic (durations, sticky, queue)
// under mocked timers. Regression coverage for the `duration: null` bug where
// `??` swallowed the null and gave "sticky" toasts a 4.5s timer.
import { test } from "node:test";
import assert from "node:assert/strict";

function elem(tag) {
  return {
    tag,
    children: [],
    style: {},
    parent: null,
    className: "",
    textContent: "",
    hidden: false,
    id: "",
    appendChild(c) {
      c.parent = this;
      this.children.push(c);
      return c;
    },
    addEventListener() {},
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this);
      this.parent = null;
    },
  };
}

const body = elem("body");
globalThis.document = { body, createElement: elem };
const { toast } = await import("../public/toast.js");
const wrap = body.children[0]; // #toast-wrap, created on import

function onScreen() {
  return wrap.children.length;
}

test("duration: null is sticky — survives every timed duration", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pill = toast("Uploading 1 / 1000", { duration: null });
  assert.equal(onScreen(), 1);
  t.mock.timers.tick(60_000); // far past 'long' (8s)
  assert.equal(onScreen(), 1, "sticky toast must not expire");
  pill.remove();
  assert.equal(onScreen(), 0);
});

test("loading toasts are sticky by default", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const h = toast("Processing 5 images…", { loading: true });
  t.mock.timers.tick(60_000);
  assert.equal(onScreen(), 1);
  h.remove();
});

test("default toast still expires after medium (4.5s)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  toast("saved");
  assert.equal(onScreen(), 1);
  t.mock.timers.tick(4400);
  assert.equal(onScreen(), 1);
  t.mock.timers.tick(200);
  assert.equal(onScreen(), 0);
});

test("sticky toasts bypass the visible cap instead of queueing", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  toast("a");
  toast("b");
  toast("c"); // MAX_VISIBLE timed toasts on screen
  const pill = toast("Uploading 1 / 1000", { duration: null });
  assert.notEqual(pill, null, "sticky toast must show immediately, not queue");
  assert.equal(onScreen(), 4);
  t.mock.timers.tick(60_000); // timed ones expire, sticky stays
  assert.equal(onScreen(), 1);
  pill.remove();
});

test("update() changes message and progress on a live sticky toast", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const pill = toast("Uploading 0 / 10", { duration: null, progress: 0 });
  t.mock.timers.tick(10_000);
  pill.update("Uploading 5 / 10", { progress: 50 });
  const el = wrap.children[0];
  assert.equal(el.children.find((c) => c.className === "toast-msg").textContent, "Uploading 5 / 10");
  const barFill = el.children.find((c) => c.className === "toast-bar").children[0];
  assert.equal(barFill.style.width, "50%");
  pill.remove();
});
