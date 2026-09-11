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

// The browser the page boots against, from the shared stub rather than a hand
// copy — the same "ONE copy on purpose" argument browser-stub.js makes, one
// altitude up: this file and boards-empty.test.js both need a document a page
// can BUILD into, and a second copy drifts.
import { byId, historyCalls, localStore as store } from "./dom-stub.js";

// Reached from a board that turned out not to be ours — app.js's 404 branch
// sends the reader here with this param. Set BEFORE the page is imported, since
// boards.js reads the address once during boot, and set on THIS harness rather
// than a third one: a revoked board is most often a board you lost while
// keeping others, so the message belongs on a page with cards on it.
globalThis.location.search = "?gone=1";

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

test("a reader bounced off a board is told why, without being told which", () => {
  const wrapEl = document.body.children.find((c) => c.id === "toast-wrap");
  const msgs = wrapEl.children.map((t) => t.children.find((c) => c.className === "toast-msg")?.textContent);
  assert.deepEqual(msgs, [
    "That board isn't available — it may have been deleted, or your access to it removed.",
  ]);
  // The board id was in the address and is deliberately NOT in the sentence:
  // the server answered 404 precisely so that a reader who can't open a board
  // learns nothing about it, and a message naming it would hand that back.
  assert.ok(!msgs[0].includes(BOARD));
});

test("…and the note is consumed, so a reload doesn't re-explain the move", () => {
  assert.deepEqual(historyCalls, ["/boards"]);
  assert.equal(location.search, "");
});
