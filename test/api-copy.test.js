// api.js `copy()`: the clipboard helper the Members tab, the MCP tab and every
// Copy button on a section heading share (modal.js clipBar). It runs inside
// click handlers, where a thrown error is a button that does nothing when
// pressed, so it never throws: over plain http there is no navigator.clipboard
// at all, and the button says so instead (planning/templates-plan.md, Stage 1,
// proof 11).
import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";
import { copy, flash } from "../public/api.js";

const button = (label = "Copy") => ({ textContent: label, dataset: {} });
const setClipboard = (clipboard) =>
  Object.defineProperty(globalThis, "navigator", { value: clipboard === undefined ? {} : { clipboard }, configurable: true });
const settle = () => new Promise((r) => setImmediate(r));

afterEach(() => mock.timers.reset());

test("with no clipboard at all, the button says so and nothing throws", () => {
  setClipboard(undefined);
  const b = button();
  assert.doesNotThrow(() => copy("text", b));
  assert.equal(b.textContent, "couldn't copy");
});

test("a write the browser refuses says so too", async () => {
  setClipboard({ writeText: () => Promise.reject(new Error("denied")) });
  const b = button();
  copy("text", b);
  await settle();
  assert.equal(b.textContent, "couldn't copy");
});

test("a write that lands says copied, then the button's own label again", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let wrote = null;
  setClipboard({ writeText: (t) => { wrote = t; return Promise.resolve(); } });
  const b = button();
  copy("the text", b);
  await settle();
  assert.equal(wrote, "the text");
  assert.equal(b.textContent, "copied!");
  mock.timers.tick(1200);
  assert.equal(b.textContent, "Copy");
});

// The old helper read the label at the moment of the flash, so a second click
// inside the moment took "copied!" for the label and left it there for good.
// And the second flash gets its whole moment: the first one's end doesn't cut
// it short.
test("a second flash inside the moment holds for its own moment, then ends on the button's label", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const b = button("Paste");
  flash(b, "couldn't paste");
  mock.timers.tick(600);
  flash(b, "couldn't paste");
  mock.timers.tick(700);
  assert.equal(b.textContent, "couldn't paste", "past the first flash's end");
  mock.timers.tick(500);
  assert.equal(b.textContent, "Paste");
});
