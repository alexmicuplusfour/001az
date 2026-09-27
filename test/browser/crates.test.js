// The gallery's crate adds through the real server, in a real browser
// (planning/alert-crating-plan.md, Stages 2 and 4). The bulk bar's picker,
// with its "New crate…" and then a pick of that crate for a selection that's
// partly in it already; a crate made from the lightbox's crate menu, which the
// lightbox's crate button counts at once; and an alert that fills a crate made
// from its editor. Each answer is read from the database, not from the page.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, servePixels } from "./harness.js";
import { seedInstance } from "../helpers.js";
import { updateBoard, crateItemIds } from "../../server/db.js";

let app, user, boardId;

before(async () => {
  app = await openApp();
  ({ user, boardId } = await app.signIn({ boardName: "Crates board" }));
  await updateBoard(app.db, boardId, { facets: [{ key: "color", label: "Color", values: ["red", "blue", "green", "amber"] }] });
  for (const color of ["red", "blue", "green", "amber"]) {
    await seedInstance(app.db, boardId, "tagged", { tags: [`color/${color}`] });
  }
});
after(() => app?.close());

async function openBoard() {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await servePixels(page);
  await page.waitForSelector("#grid .card[data-id]");
  return page;
}

const sorted = (ids) => [...ids].sort((x, y) => x - y);
// The cards in a crate of this user's, by its name, as the server holds them.
async function crateCards(name) {
  const { rows } = await app.db.query(
    "SELECT id FROM crates WHERE user_id=$1 AND board_id=$2 AND name=$3", [user.id, boardId, name]);
  return rows.length ? sorted(await crateItemIds(app.db, rows[0].id)) : null;
}
const toast = (page, text) => page.locator(".toast", { hasText: text }).waitFor({ timeout: 5000 });

test("the bulk bar puts every selected card in a crate, a new one or one that holds some already", async () => {
  const page = await openBoard();
  const cards = page.locator("#grid .card[data-id]");
  const idOf = async (i) => Number(await cards.nth(i).getAttribute("data-id"));
  const [a, b, c] = [await idOf(0), await idOf(1), await idOf(2)];

  // Two cards, into a crate made from the picker's "New crate…".
  await cards.nth(0).hover();
  await cards.nth(0).locator(".sel-cb").click();
  await cards.nth(1).click(); // in bulk mode a click selects
  await page.click("#bulk-bar .bb-btn.crate");
  const input = page.locator(".crate-pop .dd-input");
  await input.fill("bulk picks");
  await input.press("Enter");
  await toast(page, 'Added 2 to "bulk picks"');
  assert.deepEqual(await crateCards("bulk picks"), sorted([a, b]));

  // Then one card that's in it and one that isn't, into it from its row.
  await cards.nth(1).click(); // b out of the selection, a stays
  await cards.nth(2).click(); // c in
  await page.click("#bulk-bar .bb-btn.crate");
  await page.locator(".crate-pop .dd-row", { hasText: "bulk picks" }).click();
  await toast(page, 'Added 1 to "bulk picks"');
  assert.deepEqual(await crateCards("bulk picks"), sorted([a, b, c]), "all three: the one already there stayed");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a crate made from the lightbox's crate menu is counted on its crate button at once", async () => {
  const page = await openBoard();
  const { rows } = await app.db.query(
    `SELECT e.id FROM entities e
      WHERE e.board_id=$1 AND NOT EXISTS (SELECT 1 FROM crate_items ci WHERE ci.item_id = e.id)
      ORDER BY e.id LIMIT 1`, [boardId]);
  const free = rows[0].id;
  await page.locator(`#grid .card[data-id="${free}"]`).click();
  await page.waitForSelector("#lightbox-crate:not([hidden])");
  assert.equal(await page.locator("#lightbox-crate span").count(), 0, "setup: in no crate, so no count");

  await page.click("#lightbox-crate");
  const input = page.locator(".crate-pop .dd-input");
  await input.fill("from the lightbox");
  await input.press("Enter");
  await page.locator("#lightbox-crate span", { hasText: "1" }).waitFor({ timeout: 3000 });
  assert.deepEqual(await crateCards("from the lightbox"), [free]);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("an alert with a crate made in its editor collects the next card that matches, and only that", async () => {
  // The alert watches amber. The card that's amber already is the baseline and
  // stays out; the blue card, retagged amber afterwards, is news.
  const page = await openBoard();
  await page.click('#filters .pill[data-value="amber"]');
  await page.click(".plus-caret");
  await page.getByText("Alert on current filter…").click();
  await page.fill("#alert-name", "amber watch");
  await page.locator(".switch-row", { hasText: "Add matches to a crate" }).locator(".switch").click();
  await page.click(".al-crate .al-picker");
  const input = page.locator(".crate-pop .dd-input");
  await input.fill("amber finds");
  await input.press("Enter");
  await page.locator(".al-crate .al-picker", { hasText: "amber finds" }).waitFor({ timeout: 5000 });
  await page.getByRole("button", { name: "Create alert" }).click();
  await toast(page, 'Alert "amber watch" created');

  // Retagged by hand, through the route the tag editor uses.
  const { rows: [blue] } = await app.db.query(
    `SELECT id AS instance, entity_ids[1] AS card FROM items
      WHERE board_id=$1 AND tags @> '["color/blue"]'::jsonb`, [boardId]);
  const r = await page.request.patch(`${app.base}/api/instances/${blue.instance}/tags`, { data: { tags: ["color/amber"] } });
  assert.equal(r.status(), 200, await r.text());

  // The crate's view shows it, and not the card that was amber all along.
  await page.click(".crates-btn");
  await page.locator(".crate-pop .dd-row", { hasText: "amber finds" }).click();
  await page.waitForFunction((card) => {
    const ids = [...document.querySelectorAll("#grid .card[data-id]")].map((c) => Number(c.dataset.id));
    return ids.length === 1 && ids[0] === card;
  }, Number(blue.card), { timeout: 5000 });
  assert.deepEqual(await crateCards("amber finds"), [Number(blue.card)]);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
