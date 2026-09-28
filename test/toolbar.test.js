// The toolbar drawn whole, through renderToolbar, in jsdom. Both tests hold
// fixes from Stage 2's second pass (planning/ui-updates-plan.md): places
// where the old rebuild, starting from nothing each time, had been right by
// construction, and drawing in place wasn't yet.
import { test } from "node:test";
import assert from "node:assert/strict";
import "./jsdom-stub.js";

const { state } = await import("../public/state.js");
const { renderToolbar } = await import("../public/toolbar.js");

Object.assign(state, {
  me: { id: 1, name: "tester" },
  boardId: "b1",
  boardName: "Board",
  work: { running: [], queued: [{ kind: "tag", label: "Tagging", n: 5, leg: true }] },
});

test("a row that throws while it draws stays whole, and the next repaint draws it as it was", async () => {
  // Preact keeps a record of what it drew. A throw partway through a draw
  // left that record half updated, and the next repaint drew on top of it:
  // a second user menu and + button, there until a reload.
  //
  // jsdom has no reportError. A browser reports the error as if nothing had
  // caught it, so it still reaches the console and the browser tests' error log.
  const reported = [];
  globalThis.reportError = (e) => reported.push(e.message);
  const drawn = () => document.getElementById("toolbar").innerHTML + document.getElementById("toolbar-sub").innerHTML;
  renderToolbar(3);
  assert.ok(document.querySelector("#toolbar .jobs-chip.busy"), "setup: the jobs chip is drawn, busy");
  const before = drawn();

  // The jobs chip reads state.boardPaused while it draws, and nothing else in
  // the toolbar does. That read throws, in two repaints in one moment, as a
  // click that repaints twice would have it.
  let paused = state.boardPaused;
  let throws = 0;
  Object.defineProperty(state, "boardPaused", {
    configurable: true,
    enumerable: true,
    get() {
      if (throws) { throws--; throw new Error("the jobs chip threw"); }
      return paused;
    },
    set(v) { paused = v; },
  });
  throws = 1;
  assert.doesNotThrow(() => renderToolbar(3), "the row catches it");
  throws = 1;
  assert.doesNotThrow(() => renderToolbar(3), "and a second repaint in the same moment");
  throws = 0;
  await new Promise((r) => setTimeout(r, 0));
  renderToolbar(3);

  assert.deepEqual(reported, ["the jobs chip threw"], "reported once: the second repaint left the row as it was");
  assert.equal(document.querySelectorAll("#toolbar .auth").length, 1, "one user menu and + button, not two");
  assert.equal(drawn(), before, "and the toolbar is back exactly as it was");
  Object.defineProperty(state, "boardPaused", { value: paused, writable: true, configurable: true, enumerable: true });
});

test("the view toggles: List on every board and Rows only where rows can matter, each switching its view on and off", () => {
  // planning/list-view-plan.md, D10: grid is the unmarked default.
  const btn = (view) => document.querySelector(`#toolbar-sub .view-btn[aria-label="Toggle ${view} view"]`);
  try {
    renderToolbar(3);
    assert.equal(btn("rows"), null, "a board where nothing stacks has no Rows button");
    assert.equal(btn("list").getAttribute("aria-pressed"), "false");
    btn("list").click();
    assert.equal(state.view, "list");
    renderToolbar(3);
    assert.equal(btn("list").getAttribute("aria-pressed"), "true");
    assert.equal(btn("list").title, "Back to grid view");
    state.boardMapping = { card: { by: "who" } }; // a card key: files can stack
    renderToolbar(3);
    btn("rows").click();
    assert.equal(state.view, "rows", "Rows pressed while List was on: straight across");
    renderToolbar(3);
    btn("rows").click();
    assert.equal(state.view, "grid", "pressed again: back to the grid");
  } finally {
    state.view = null;
    state.boardMapping = null;
    localStorage.removeItem("boardView:b1");
  }
});

test("while a search is on, the sort button says Relevance, and the chosen sort comes back after", () => {
  const label = () => document.querySelector("#toolbar-sub .sort-btn").textContent;
  state.sort = { by: "name", dir: "asc", label: "Name" };
  try {
    renderToolbar(3);
    assert.equal(label(), "Name ↑");
    state.searchResults = new Map();
    renderToolbar(3);
    assert.equal(label(), "Relevance", "the search's order is the one in effect");
    state.searchResults = null;
    renderToolbar(3);
    assert.equal(label(), "Name ↑");
  } finally {
    state.sort = null;
    state.searchResults = null;
  }
});

test("a paused schedule switched back on shows just its icon until its first stamp, not \"paused\"", () => {
  // Armed but not yet stamped: the ingest chip has no countdown to show until
  // the sweep stamps the next run, within a tick. The rebuilt chip was empty
  // until then; the chip that stays must not keep its last words.
  const chip = () => document.querySelector("#toolbar .ingest-chip");
  Object.assign(state, { boardIngestMode: "paused", boardIngestNextRun: null, boardIngestError: false });
  try {
    renderToolbar(3);
    assert.equal(chip()?.textContent, "paused", "setup: a held schedule says so");

    state.boardIngestMode = "scheduled";
    renderToolbar(3);
    const face = { text: chip().textContent, title: chip().title, paused: chip().classList.contains("paused") };
    assert.deepEqual(face, { text: "", title: "", paused: false }, "just the icon");
  } finally {
    // The chip goes, taking its once-a-second timer with it: left running, it
    // would keep this file from ever finishing.
    state.boardIngestMode = null;
    renderToolbar(3);
  }
});
