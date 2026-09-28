// Shift picks a range, in a real browser (planning/list-view-plan.md, Stage
// 4): a Shift+click on text stretches the page's text selection from the last
// click to this one, and List's row reads a click that ends a text selection
// as no click at all. So in bulk mode a Shift+press doesn't select text, and
// the rows from the last pick to this one are picked instead.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { seedInstance } from "../helpers.js";

let app, user, boardId;

before(async () => {
  app = await openApp();
  ({ user, boardId } = await app.signIn({ boardName: "Range board" }));
  for (let i = 0; i < 12; i++) await seedInstance(app.db, boardId, "tagged", { tags: [] });
});
after(() => app?.close());

test("in bulk mode a Shift+click on a List row picks every row from the last pick to it, and selects no text", async () => {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await page.evaluate((id) => localStorage.setItem(`boardView:${id}`, "list"), boardId);
  await page.reload();
  await page.waitForSelector("#grid tr.list-row[data-id]");
  const rows = page.locator("#grid tr.list-row[data-id]");
  const ids = await rows.evaluateAll((trs) => trs.map((tr) => Number(tr.dataset.id)));
  const picked = () => page.evaluate(() => [...document.querySelectorAll("#grid tr.list-row.selected")].map((tr) => Number(tr.dataset.id)));
  await rows.nth(1).locator(".sel-cb").click();
  // A click on a row's text, in bulk mode: it picks the row, and the press
  // leaves the browser's caret in the text, where a Shift+click would stretch
  // a text selection from.
  await rows.nth(2).locator(".list-date").click();
  assert.deepEqual(await picked(), ids.slice(1, 3), "setup: two rows picked");
  await rows.nth(6).locator(".list-date").click({ modifiers: ["Shift"] });
  assert.deepEqual(await picked(), ids.slice(1, 7), "the rows from the last pick to this one");
  assert.equal(await page.evaluate(() => String(window.getSelection())), "", "and no text selected");
  // A click on the item count leaves a caret in the toolbar: a select button
  // with Shift doesn't stretch a selection from there either.
  await page.locator(".result-count").click();
  await rows.nth(9).locator(".sel-cb").click({ modifiers: ["Shift"] });
  assert.deepEqual(await picked(), ids.slice(1, 10), "a select button with Shift: the rows from the last pick");
  assert.equal(await page.evaluate(() => String(window.getSelection())), "");
  // A title selected earlier, to copy, doesn't swallow the Shift+click: the
  // row would read the click as that selection's end.
  await page.evaluate(() => window.getSelection().selectAllChildren(document.querySelectorAll("#grid .list-open")[4]));
  await rows.nth(11).locator(".list-date").click({ modifiers: ["Shift"] });
  assert.deepEqual(await picked(), ids.slice(1, 12), "with a title selected");
  assert.deepEqual(page.errors, []);
});

test("in the grid too: a Shift+click on a card in bulk mode picks the cards from the last pick to it, and selects no text", async () => {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await page.waitForSelector("#grid .card[data-id]");
  const cards = page.locator("#grid .card[data-id]");
  const ids = await cards.evaluateAll((els) => els.map((el) => Number(el.dataset.id)));
  const picked = () => page.evaluate(() => [...document.querySelectorAll("#grid .card.selected")].map((el) => Number(el.dataset.id)));
  await cards.nth(1).locator(".sel-cb").click();
  await page.locator(".result-count").click(); // a caret in the toolbar's text
  await cards.nth(5).click({ modifiers: ["Shift"] });
  assert.deepEqual((await picked()).sort(), ids.slice(1, 6).sort(), "the cards from the last pick to this one, in the page's order");
  assert.equal(await page.evaluate(() => String(window.getSelection())), "", "and no text selected");
  assert.deepEqual(page.errors, []);
});
