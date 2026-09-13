// The boards page with nothing on it — the first screen of a fresh instance,
// and now the destination a boardless landing arrives at (app.js: zero
// accessible boards redirects here instead of rendering an item-scoped gallery
// with no item scope).
//
// What it pins is that the empty state reads the SIGNED-IN USER, not just
// the count. A member with no boards is waiting on someone else, so they get
// a sentence; an admin gets the placeholder card that CREATES — and the
// wrong one is worse than nothing at all: an admin told to "ask an admin for
// access" is being sent to themselves.
//
// Two readers means two boots, and the page reads `me` once at module scope —
// so this is a second FILE rather than a second test in boards-page.test.js.
// node:test gives each file its own process, which is exactly the isolation a
// top-level `const me` needs.
//
// SINCE planning/welcome-plan.md Stage 1, the admin here is a SKIPPED admin,
// not a fresh one. A genuinely fresh admin — no boards, no model, never asked
// to be left alone — is redirected to /welcome by the boot ladder and never
// reaches this screen at all.
//
// Hence `setup_pending: false` on ME below, and it is DOCUMENTATION, not a
// guard. Leave the field out and this file still passes three green tests:
// `undefined` is falsy, the new rung doesn't fire, and the ladder falls
// through to the render branch exactly as it did before the rung existed. So
// the fixture would go on describing a state that no longer reaches this
// screen, and nothing would say so — dom-stub's throwing location.replace
// never gets a chance to fire, because no redirect is attempted.
//
// The positive case has its own file for that reason (welcome-gate.test.js):
// the two are a pair, and only the sibling can fail when the rung breaks.
//
// The same admin is also the SETUP STRIP's reader (welcome-plan.md 3b) — they
// declined a model and their instance still cannot tag — so the strip is
// asserted here rather than in a file of its own. Which means this fixture now
// answers the capability feed too: leave that route out and the page's own
// try/catch swallows the miss, so the strip would quietly stop rendering with
// three green tests to show for it.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { byId } from "./dom-stub.js";

const ME = { id: 1, name: "Root", email: "root@example.com", is_admin: true, setup_pending: false };

// One entry, the shape GET /api/admin/capabilities/:id serves. `unavailable`
// with nothing waiting is the honest fresh-and-skipped state since Stage 4
// (welcome-plan.md 4.4): no provider is pre-added, so nothing INSTALLED
// advertises tagging — which is a different sentence from "needs a key" and the
// reason the state machine has both words. Nothing queued either, there being
// no board to put items in.
//
// The other states presentTrouble speaks for are pinned directly, on the pure
// function, in test/capability-present.test.js. What this file is for is the
// wiring: that the page asks, and renders what it gets.
const TAG = {
  id: "tag", kind: "ai", label: "Tagging", state: "unavailable",
  running: null, supportedBy: [], demand: { waiting: 0 },
};

globalThis.fetch = async (url) => {
  const body =
    url.includes("/api/me") ? ME :
    url.includes("/api/boards/overview") ? [] :
    url.includes("/api/boards/signals") ? [] :
    url.includes("/api/admin/capabilities/tag") ? TAG : null;
  if (body === null) throw new Error("unexpected fetch " + url);
  return { ok: true, status: 200, json: async () => body };
};

let grid, toolbar;

before(async () => {
  // No cards, so the signals ticker's `ready` gate should never let it arm —
  // asserted below, and this is also what keeps the run from hanging on a live
  // 60 s interval if that gate ever breaks.
  globalThis.setInterval = () => { throw new Error("ticker armed with no cards"); };
  await import("../public/boards.js");
  await new Promise((r) => setTimeout(r, 50));
  grid = byId["boards-grid"];
  toolbar = byId["toolbar"];
});

test("an admin gets the first board's silhouette — a button that creates", () => {
  assert.equal(grid.children.length, 1);
  const card = grid.children[0];
  // A dashed outline, a plus, the words — and NONE of the board card's
  // classes: dressed as one, it read as an existing empty board. Not a
  // .bc-wrap and no data-board either: wraps() means "the boards on screen",
  // and dom-stub's document.querySelectorAll matches on the class precisely
  // so a placeholder cannot answer for a card.
  assert.equal(card.tag, "button");
  assert.equal(card.className, "bc-new");
  // The ghost is a real card's skeleton in the card's own classes — that is
  // the whole sizing mechanism, so its shape is the assertion.
  const [ghost, label] = card.children;
  assert.equal(ghost.className, "bc-new-ghost");
  assert.deepEqual(ghost.children.map((c) => c.className), ["bc-face", "bc-body"]);
  assert.equal(label.className, "bc-new-label");
  const [plus, words] = label.children;
  assert.equal(plus.className, "bc-new-plus");
  assert.equal(words.textContent, "New board");
});

test("…and the toolbar still carries + New board beside it", () => {
  // The standing control, not the invitation: the placeholder is the empty
  // state's door and leaves with it, while this button stays for every later
  // board. Two doors on one screen is the design, not a leftover.
  const auth = toolbar.children.find((c) => c.className === "auth");
  const labels = auth.children.map((c) => c.innerHTML || "");
  assert.ok(labels.some((h) => h.includes("New board")), "header carries + New board");
});

test("the strip says what isn't running, in the feed's own words", () => {
  // Not this page's words: `unavailable` is presentChip's, and the count is the
  // feed's. The strip authoring its own sentence is the thing capability-
  // present.js exists to prevent — see presentTrouble.
  // The box it wears (styles.css's .warn-box) is declared in boards.html with
  // the rest of the page's structure, so it is not visible from here — this
  // stub knows the elements the page ASKS FOR, not the markup they came from.
  // What is assertable is what the page decided: to show it, and what it says.
  const strip = byId["setup-strip"];
  assert.equal(strip.hidden, false);
  const [label, rest] = strip.children[0].children;
  assert.equal(label.textContent, "Tagging");
  // Nothing queued yet, so no count — "0 items waiting" is a sentence with no
  // information in it.
  assert.equal(rest.textContent, " — unavailable");
  assert.equal(strip.children.length, 2);
  assert.equal(strip.children[1].href, "/welcome");
});

test("the gate cleared and the grid is visible, empty or not", () => {
  // The empty state is CONTENT, not a failure — it has to clear "Checking
  // access…" the same way a wall of cards would.
  assert.equal(byId["gate"].hidden, true);
  assert.equal(grid.hidden, false);
});
