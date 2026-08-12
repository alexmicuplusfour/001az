// The provenance band (modal.js `provBand`) — the "Using <model> Change" line
// the board editor puts at the point where a model matters.
//
// It exists as a component because it was written twice, and the two copies
// disagreed about the only rule it has: what to do with nothing to name. Both
// guarded with "hide when there's no label", and both then rendered
// "Using none configured" on an install with nothing bound — the string is
// perfectly truthy, so it walked straight through the guard. A band that says
// that is making a claim about nothing, which is the opposite of its job.
//
// So the empty state is pinned here, in both directions: the copy it shows, and
// that the label it used to show is gone rather than merely hidden behind it.
import { test } from "node:test";
import assert from "node:assert/strict";

const node = (tag) => ({
  tag, className: "", type: "", textContent: "", hidden: false,
  style: {}, children: [], listeners: {},
  append(...c) { this.children.push(...c); },
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); },
  click() { (this.listeners.click || []).forEach((fn) => fn()); },
});
globalThis.document = {
  createElement: (tag) => node(tag),
  createTextNode: (text) => ({ tag: "#text", textContent: text }),
};

const { provBand } = await import("../public/modal.js");

// The band's three parts, in render order: the lead words, the name, the action.
const read = (band) => {
  const [lead, what, btn] = band.el.children;
  return { lead: lead.textContent, what: what.textContent, hidden: what.hidden, btn: btn.textContent };
};

test("with a model to name it reads exactly 'Using <model> Change'", () => {
  const band = provBand(() => {});
  band.set({ label: "prod — openai · gpt-5.4-mini" });
  assert.deepEqual(read(band), {
    lead: "Using", what: "prod — openai · gpt-5.4-mini", hidden: false, btn: "Change",
  });
  assert.equal(band.el.className, "prov");
});

test("with nothing to name it says so, and offers the way to fix it", () => {
  const band = provBand(() => {});
  band.set({ empty: "No tagger configured" });
  const r = read(band);
  assert.equal(r.lead, "No tagger configured");
  assert.equal(r.btn, "Set one up", "'Change' names an action there is nothing to change");
  assert.equal(r.hidden, true, "no empty <b> holding a gap open");
});

// The regression the component was extracted for: an install with nothing bound
// must never produce this sentence, whatever the caller passes as a label.
test("a falsy label is nothing to name, not a name", () => {
  for (const nothing of [null, undefined, ""]) {
    const band = provBand(() => {});
    band.set({ label: nothing, empty: "No extractor configured" });
    assert.equal(read(band).lead, "No extractor configured", `for ${JSON.stringify(nothing)}`);
    assert.notEqual(read(band).what, "none configured");
  }
});

test("falling back to the empty state clears the model it used to name", () => {
  const band = provBand(() => {});
  band.set({ label: "prod — openai · gpt-5.4-mini" });
  band.set({ empty: "No tagger configured" });
  assert.equal(read(band).what, "", "a hidden element still carries its text into the next render");
});

test("the action fires whoever opened the band", () => {
  let opened = 0;
  const band = provBand(() => opened++);
  band.set({ label: "prod — openai" });
  band.el.children[2].click();
  assert.equal(opened, 1);
});

// The third state, and the reason it lives here rather than at the call sites:
// "no band at all" is a different answer from "a band saying nothing runs", and
// when the two callers each owned this they spelled it two different ways.
test("nothing to be provenance about is no band, not an empty one", () => {
  const band = provBand(() => {});
  assert.equal(band.el.hidden, true, "hidden until something is known");
  band.set({ label: "prod — openai" });
  assert.equal(band.el.hidden, false);
  band.set(null);
  assert.equal(band.el.hidden, true, "back to absent, not to the empty state");
  band.set({ empty: "No tagger configured" });
  assert.equal(band.el.hidden, false, "…which is a visible band with something to say");
});
