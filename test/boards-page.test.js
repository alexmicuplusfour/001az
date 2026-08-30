// boards.js booting for real — the module the dots were wired into, and until
// now the one file in this feature no test could import.
//
// It could not be imported for one concrete reason, the same one announce.js had
// (see announce.test.js): its imports used the root-absolute `/x.js` form, which
// a browser resolves against the origin and Node resolves against the filesystem
// root. Made relative — which changes nothing in a browser, since a module
// specifier resolves against the importing MODULE's URL and never the
// document's — the page boots here behind a browser shim.
//
// What this pins is the WIRING, not the rendering: that the boot sequence
// completes in the right order, and that a card comes out of it carrying exactly
// one dot and a label that says why. The ordering is the live risk — the boot
// block sits at the top of the file and the maps it depends on are declared
// below it, so anything that ran a step too early would land in a temporal dead
// zone. That failure is invisible to every other test here and would be total in
// the browser: a blank page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";

// The localStorage the watermarks read, from the shared stub rather than a
// fourth hand-rolled copy — "ONE copy on purpose", as that file puts it. Its
// `document ||=` cannot shadow the richer one built below, since static imports
// evaluate before this module body runs.
import { localStore as store } from "./browser-stub.js";

const el = (tag = "div") => {
  const n = {
    tag, children: [], attrs: {}, dataset: {}, style: {}, classes: new Set(),
    className: "", textContent: "", innerHTML: "", href: "", title: "", type: "", hidden: false,
    classList: {
      add: (c) => n.classes.add(c), remove: (c) => n.classes.delete(c),
      contains: (c) => n.classes.has(c), toggle() {},
    },
    appendChild(c) { c.parent = n; n.children.push(c); return c; },
    append(...c) { c.forEach((x) => n.appendChild(x)); },
    replaceChildren(...c) { n.children.length = 0; c.forEach((x) => n.appendChild(x)); },
    remove() { const k = n.parent?.children; if (k) k.splice(k.indexOf(n), 1); },
    setAttribute(k, v) { n.attrs[k] = v; },
    getAttribute(k) { return n.attrs[k] ?? null; },
    removeAttribute(k) { delete n.attrs[k]; },
    addEventListener() {}, removeEventListener() {},
    querySelector(sel) {
      if (sel === ".board-card") return n.children.find((c) => String(c.className).includes("board-card")) || null;
      if (sel === ":scope > .btn-dot") return n.children.find((c) => c.className === "btn-dot") || null;
      // Containment, not equality — the note also carries the shared .vis-hidden
      // utility class.
      if (sel === ".bc-signal-note")
        return n.children.find((c) => String(c.className).split(" ").includes("bc-signal-note")) || null;
      return null;
    },
    querySelectorAll() { return []; },
  };
  return n;
};

const byId = {};
globalThis.document = {
  hidden: false,
  getElementById: (id) => (byId[id] ||= el()),
  createElement: el,
  createDocumentFragment: el,
  querySelector: (s) => (s === "header" ? el() : null),
  querySelectorAll: (s) => (s === "#boards-grid .bc-wrap" ? byId["boards-grid"].children : []),
  addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
  body: el(), documentElement: el(), head: el(),
};
globalThis.window = {
  addEventListener() {}, removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  getComputedStyle: () => ({}),
};
globalThis.getComputedStyle = () => ({});
globalThis.location = {
  href: "/boards", pathname: "/boards", search: "",
  // A redirect here means the auth gate misfired, which would leave a signed-in
  // reader bounced to the login page. Loud rather than silent.
  replace(u) { throw new Error("unexpected redirect to " + u); },
};
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
globalThis.Audio = class { play() { return Promise.resolve(); } };

const BOARD = "b-boot";
const OTHER = "b-second";
const served = { signals: [{ board_id: BOARD, failed_at: 5000, alerts_unseen: 2, diagnostic_at: null }] };

// TWO boards, because one is the case where half the card's controls don't
// exist: the rearrange grip only renders for a reader with something to
// rearrange (planning/board-arrangement-plan.md). The second is also managed,
// so the tools cluster is exercised holding both buttons.
globalThis.fetch = async (url) => {
  const body =
    url.includes("/api/me") ? { id: 1, name: "Boot", is_admin: false } :
    url.includes("/api/boards/overview")
      ? [
          { id: BOARD, name: "People", count: 2, facet_count: 0, has_mapping: false, manage: false, preview: [] },
          { id: OTHER, name: "Places", count: 0, facet_count: 0, has_mapping: false, manage: true, preview: [] },
        ]
      : url.includes("/api/boards/signals") ? served.signals : null;
  if (body === null) throw new Error("unexpected fetch " + url);
  return { ok: true, status: 200, json: async () => body };
};

const toolsOf = (w) => w.children.find((c) => c.className === "bc-tools");
const toolClasses = (w) => (toolsOf(w)?.children || []).map((c) => c.className);

let grid, wrap, card;
let armed = 0;

before(async () => {
  // The page arms a real 60 s ticker once it has cards, which would hold the
  // event loop open long past the assertions. Counted rather than merely
  // swallowed — that it arms AT ALL is the slice-4 wiring, and a truthy handle
  // because the double-start guard is `if (timer) return`.
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = () => ++armed;
  await import("../public/boards.js");
  // The page renders the grid on the overview and paints dots when signals
  // land — two fetches, deliberately not awaited together.
  await new Promise((r) => setTimeout(r, 50));
  globalThis.setInterval = realSetInterval;
  grid = byId["boards-grid"];
  wrap = grid.children[0];
  card = wrap?.querySelector(".board-card");
});

after(() => store.clear());

test("the page boots and renders a card per board", () => {
  assert.equal(grid.children.length, 2);
  assert.ok(card, "the wrapper holds a board-card link");
});

test("every card gets a rearrange grip once there is more than one board", () => {
  assert.deepEqual(toolClasses(grid.children[0]), ["bc-grip"]);
  // …and the manager's pencil rides in the same cluster, grip first, so the
  // two never have to know about each other's presence to be placed.
  assert.deepEqual(toolClasses(grid.children[1]), ["bc-grip", "bc-edit"]);
});

test("the card link opts out of the browser's own drag", () => {
  // A link is draggable by default, which would make grabbing anywhere on a
  // card start a URL drag instead of the rearrange the grip owns.
  assert.equal(card.draggable, false);
});

test("a card the signals response doesn't mention stays dark", () => {
  const other = grid.children[1];
  assert.equal(other.children.filter((c) => c.className === "btn-dot").length, 0);
  assert.ok(!other.classes.has("has-dot"));
});

test("the wrapper carries its board id, which is how a repaint finds its way back", () => {
  assert.equal(wrap.dataset.board, BOARD);
});

test("a lit board gets exactly one dot", () => {
  assert.equal(wrap.children.filter((c) => c.className === "btn-dot").length, 1);
  assert.ok(wrap.classes.has("has-dot"));
});

test("…and a hidden line inside the link that says what the dot is for", () => {
  // Added to the card's accessible name rather than overriding it with an
  // aria-label, so the board name and item count a screen reader already had
  // survive. Two signals, both named, in server order.
  assert.equal(card.querySelector(".bc-signal-note")?.textContent, "a job failed, 2 new alert matches");
  assert.equal(card.attrs["aria-label"], undefined);
});

test("the refresh ticker is armed once the page has cards", () => {
  assert.equal(armed, 1, "one interval, and only after the grid rendered");
});
