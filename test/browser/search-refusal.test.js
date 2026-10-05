// A search on a board with nothing embedded, in a real browser against the
// real routes (planning/field-embedding-plan.md Stage 2, D8). The browser
// suite runs no worker, so these cards stay without vectors: the state an
// are.na board is in for good, and any board is in while it waits its turn.
// The server declines with one sentence and embeds nothing; the page shows
// the sentence as a plain note, not the red error, and leaves the grid alone.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { seedInstance, meterTotals } from "../helpers.js";
import { updateBoard } from "../../server/db.js";

let app, user, boardId;

before(async () => {
  app = await openApp();
  ({ user, boardId } = await app.signIn({ boardName: "Unembedded board" }));
  await updateBoard(app.db, boardId, { facets: [{ key: "color", label: "Color", values: ["red", "blue"] }] });
  for (const tags of [["color/red"], ["color/blue"]]) await seedInstance(app.db, boardId, "tagged", { tags });
});
after(() => app?.close());

// The board drawn, with the search box there: the test server has an
// embedder (the on-device one), so the box shows on every board.
async function openBoard() {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await page.waitForSelector("#grid .card");
  assert.ok(await page.$(".search-box input"), "precondition: the box shows, because an embedder exists");
  return page;
}

// The toast carrying `text`, and whether it's the plain one.
async function toastSaying(page, text) {
  const el = page.locator(".toast", { hasText: text });
  await el.waitFor();
  return { text: await el.locator(".toast-msg").textContent(), plain: (await el.getAttribute("class")) === "toast" };
}

test("a search on a board with nothing embedded says so in a plain note, and the grid keeps its cards", async () => {
  const page = await openBoard();
  const cards = await page.locator("#grid .card").count();
  const box = page.locator(".search-box input");
  await box.fill("red");
  await box.press("Enter");

  assert.deepEqual(await toastSaying(page, "can be searched by meaning"),
    { text: "Nothing on this board can be searched by meaning yet.", plain: true });
  assert.equal(await page.locator("#grid .card").count(), cards, "the grid keeps its cards");
  assert.equal(await page.$(".search-clear"), null, "no search is showing, so there's nothing to clear");
  assert.equal(await box.inputValue(), "red", "the query stays in the box");
  assert.deepEqual(page.failures, [{ status: 409, url: "/api/search" }], "declined, not failed");
  assert.deepEqual(page.errors, []);
  assert.equal(Number((await meterTotals(app.db, boardId, "embed"))?.calls || 0), 0, "the query wasn't embedded");
});

test("Find similar by meaning on a card with no vector says so the same way", async () => {
  const page = await openBoard();
  const card = page.locator("#grid .card[data-id]").first();
  await card.hover();
  await card.locator(".tag-chip").hover();
  await page.getByText("Find similar by meaning").click();

  assert.deepEqual(await toastSaying(page, "can't be searched by meaning"),
    { text: "This card can't be searched by meaning yet.", plain: true });
  assert.deepEqual(page.failures, [{ status: 409, url: "/api/search/similar" }]);
  assert.deepEqual(page.errors, []);
});

test("a search that fails with a 409 of its own is still the red error", async () => {
  // The error handler passes a provider's status through, 409 included; only
  // the server's own mark makes a refusal a plain note.
  const page = await openBoard();
  await page.route("**/api/search?**", (route) => route.fulfill({
    status: 409, contentType: "application/json", body: JSON.stringify({ error: "upstream conflict" }),
  }));
  const box = page.locator(".search-box input");
  await box.fill("red");
  await box.press("Enter");

  assert.deepEqual(await toastSaying(page, "upstream conflict"), { text: "upstream conflict", plain: false });
  assert.equal(await page.locator(".toast.toast--error").count(), 1, "the red one");
});
