// The empty state for a <select> (public/select.js) and the model picker that
// now goes through it (board-modal.js `syncModelPicker`).
//
// The rule underneath both: A PICKER MAY ONLY SHOW A SELECTION SOMEBODY MADE.
// Every wrong answer here is silent — a plugin panel that reads as "already the
// default tagger, key and model chosen" when the slot belongs to another
// provider entirely, or a promote button that posts key id 0 because "" went
// through Number(). Nothing throws; it just tells the reader something untrue.
//
// The shim below reproduces the mechanism that makes the lie the DEFAULT: a
// display-size-1 select with nothing marked selected falls to the first option
// that isn't disabled, exactly as the HTML spec's reset algorithm says. Take
// that out and the assertions prove nothing, because the browser's helpfulness
// is the whole problem.
import { test } from "node:test";
import assert from "node:assert/strict";

const option = () => ({
  tag: "option", value: "", textContent: "", selected: false, disabled: false, dataset: {},
});

const select = () => ({
  tag: "select", children: [], style: {}, dataset: {}, listeners: {},
  // Enough event surface for the live-listing tests below: a picker that moves
  // its own selection has to be able to announce it.
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  removeEventListener() {},
  dispatchEvent(e) { (this.listeners[e.type] || []).forEach((fn) => fn(e)); return true; },
  replaceChildren() { this.children.length = 0; },
  appendChild(c) { this.children.push(c); return c; },
  insertBefore(c, ref) {
    const i = ref ? this.children.indexOf(ref) : -1;
    this.children.splice(i < 0 ? this.children.length : i, 0, c);
    return c;
  },
  get firstChild() { return this.children[0] || null; },
  get selectedOptions() {
    const marked = this.children.filter((o) => o.selected);
    if (marked.length) return marked;
    const fallback = this.children.find((o) => !o.disabled);
    return fallback ? [fallback] : [];
  },
  get value() { return this.selectedOptions[0]?.value ?? ""; },
});

// Everything else exists only so board-modal.js's import chain (toast's
// module-scope wrapper div, facet-diagnostics' localStorage) loads.
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

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.document = {
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => true,
  createElement: (tag) => (tag === "select" ? select() : tag === "option" ? option() : node()),
  createDocumentFragment: node,
  querySelector: () => null, querySelectorAll: () => [], getElementById: () => null,
  body: node(), documentElement: node(), head: node(),
};
globalThis.window = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const { fillSelect, isUnset } = await import("../public/select.js");
const { syncModelPicker } = await import("../public/board-modal.js");

const keys = [
  { value: "1", label: "Personal" },
  { value: "2", label: "Work" },
];
const labels = (sel) => sel.children.map((o) => o.textContent);

test("nothing to preselect renders the prompt, not option one", () => {
  const sel = select();
  fillSelect(sel, keys, { placeholder: "Select a key" });
  assert.equal(isUnset(sel), true);
  assert.equal(sel.value, ""); // NOT "1"
  assert.deepEqual(labels(sel), ["Select a key", "Personal", "Work"]);
});

test("the prompt cannot be chosen again once you have answered", () => {
  const sel = select();
  fillSelect(sel, keys, { placeholder: "Select a key" });
  assert.equal(sel.children[0].disabled, true);
});

test("a saved value wins and the prompt never appears", () => {
  const sel = select();
  fillSelect(sel, keys, { value: "2", placeholder: "Select a key" });
  assert.equal(isUnset(sel), false);
  assert.equal(sel.value, "2");
  assert.deepEqual(labels(sel), ["Personal", "Work"]);
});

// The stale-slot case: config points at a key this provider no longer has. The
// browser would answer "Personal" on its behalf; empty is the honest answer.
test("a value the list no longer carries falls back to the prompt", () => {
  const sel = select();
  fillSelect(sel, keys, { value: "9", placeholder: "Select a key" });
  assert.equal(isUnset(sel), true);
  assert.equal(sel.value, "");
});

// "" is a real choice on the pickers that offer an App/Board default, so the
// empty state is recognised by its marker, never by its value.
test("an empty-valued option is a choice, not an empty state", () => {
  const sel = select();
  fillSelect(sel, [{ value: "", label: "App default" }, ...keys], { value: "" });
  assert.equal(isUnset(sel), false);
  assert.equal(sel.value, "");
});

test("a select with no placeholder still lets the browser answer", () => {
  const sel = select();
  fillSelect(sel, keys, {});
  assert.equal(isUnset(sel), false);
  assert.equal(sel.value, "1");
});

// --- the model picker on top of it ---

// keyId null: no live listing to wait for, so what these assert is the curated
// render alone.
const entry = {
  models: [{ id: "sonnet", note: "balanced" }, { id: "haiku", note: "fast" }],
  defaultModel: "haiku",
};

test("a provider's recommendation is not a selection", () => {
  const sel = select();
  syncModelPicker(sel, entry, null, { placeholder: "Select a model" });
  assert.equal(isUnset(sel), true);
  assert.equal(sel.value, ""); // not "haiku", however good a suggestion it is
});

test("without a placeholder the recommendation still leads", () => {
  const sel = select();
  syncModelPicker(sel, entry, null, {});
  assert.equal(sel.value, "haiku");
});

test("the slot's own saved model shows, prompt and recommendation aside", () => {
  const sel = select();
  syncModelPicker(sel, entry, null, { saved: "sonnet", placeholder: "Select a model" });
  assert.equal(isUnset(sel), false);
  assert.equal(sel.value, "sonnet");
});

// Retired ids still show — saved config never silently vanishes — and that
// option is a selection, so it must not read as empty either.
test("a saved model the catalog dropped is still an answer", () => {
  const sel = select();
  syncModelPicker(sel, entry, null, { saved: "opus-3", placeholder: "Select a model" });
  assert.equal(isUnset(sel), false);
  assert.equal(sel.value, "opus-3");
  assert.equal(sel.children[0].textContent, "opus-3");
});

// --- when the live listing lands (keyId set) ---
//
// The curated render is a guess made before the provider has spoken. When the
// answer arrives it owns the options, and it is allowed to move the selection —
// that is the whole point of asking. What it must not do is move it in silence:
// writing options fires no event, so every surface reading the picker went on
// describing the answer before this one. In the board editor that is a
// provenance band naming one model at the point of use while Save reads another
// off the select; the two have to be the same claim.
const liveFetch = (models, source = "live") => {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ models, source }) });
};
// syncModelPicker's listing is a promise chain, so let it settle.
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a landing that moves the selection announces it", async () => {
  liveFetch([{ id: "llama3.2:1b" }, { id: "qwen3:4b" }]);
  const sel = select();
  let heard = 0;
  sel.addEventListener("change", () => heard++);
  // The board editor's shape: no placeholder, so the recommendation leads.
  syncModelPicker(sel, entry, 7, {});
  assert.equal(sel.value, "haiku", "the guess, before the provider answers");
  await settle();
  // The guess is disproved, and nothing in the live list was chosen by anyone —
  // so the value moved on its own.
  assert.equal(sel.value, "llama3.2:1b");
  assert.equal(heard, 1, "the move was announced exactly once");
});

test("a landing that changes nothing stays quiet", async () => {
  liveFetch([{ id: "haiku" }, { id: "sonnet" }]);
  const sel = select();
  let heard = 0;
  sel.addEventListener("change", () => heard++);
  syncModelPicker(sel, entry, 7, {});
  await settle();
  assert.equal(sel.value, "haiku", "the live list confirms the selection");
  assert.equal(heard, 0, "no move, no event — this is not a repaint notification");
});

test("a persisted model kept through the landing is not a move", async () => {
  liveFetch([{ id: "llama3.2:1b" }]);
  const sel = select();
  let heard = 0;
  sel.addEventListener("change", () => heard++);
  syncModelPicker(sel, entry, 7, { saved: "opus-3" });
  await settle();
  assert.equal(sel.value, "opus-3", "saved config never silently vanishes");
  assert.equal(sel.children[0].textContent, "opus-3 — not listed by this connection");
  assert.equal(heard, 0);
});
