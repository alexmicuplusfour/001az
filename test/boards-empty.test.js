// The boards page with nothing on it — the first screen of a fresh instance,
// and now the destination a boardless landing arrives at (app.js: zero
// accessible boards redirects here instead of rendering an item-scoped gallery
// with no item scope).
//
// What it pins is that the empty state reads the SIGNED-IN USER, not just the
// count. Both sentences are true of zero boards; only one is true of the person
// looking at it, and the wrong one is worse than no sentence at all — an admin
// told to "ask an admin for access" is being sent to themselves, past the "+ New
// board" button in the corner of the same screen.
//
// Two readers means two boots, and the page reads `me` once at module scope —
// so this is a second FILE rather than a second test in boards-page.test.js.
// node:test gives each file its own process, which is exactly the isolation a
// top-level `const me` needs.
import { test, before } from "node:test";
import assert from "node:assert/strict";

import { byId } from "./dom-stub.js";

const ME = { id: 1, name: "Root", email: "root@example.com", is_admin: true };

globalThis.fetch = async (url) => {
  const body =
    url.includes("/api/me") ? ME :
    url.includes("/api/boards/overview") ? [] :
    url.includes("/api/boards/signals") ? [] : null;
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

test("an admin is pointed at the button they already have", () => {
  assert.equal(grid.children.length, 1);
  const note = grid.children[0];
  assert.equal(note.className, "boards-note");
  assert.equal(note.textContent, "No boards yet — use + New board to make the first one.");
});

test("…and that button is genuinely on the page the sentence describes", () => {
  // The copy names a control by its label; if the header ever stops rendering
  // it, the sentence becomes a lie and this fails with the reason attached.
  const auth = toolbar.children.find((c) => c.className === "auth");
  const labels = auth.children.map((c) => c.innerHTML || "");
  assert.ok(labels.some((h) => h.includes("New board")), "header carries + New board");
});

test("the gate cleared and the grid is visible, empty or not", () => {
  // The empty state is CONTENT, not a failure — it has to clear "Checking
  // access…" the same way a wall of cards would.
  assert.equal(byId["gate"].hidden, true);
  assert.equal(grid.hidden, false);
});
