// The List view in a real browser (planning/list-view-plan.md, Stage 2a), for
// what jsdom can't do. Its column header sticks under the page header, which
// folds away as you scroll down and comes back as you scroll up, so the column
// header has to follow it frame by frame (header-scroll.js --header-bottom).
// And the next batch draws as the page nears the end, which is an
// IntersectionObserver's call (batches.js).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { seedInstance } from "../helpers.js";

let app, user, boardId;

before(async () => {
  app = await openApp();
  ({ user, boardId } = await app.signIn({ boardName: "List board" }));
  for (let i = 0; i < 70; i++) await seedInstance(app.db, boardId, "tagged", { tags: [] });
});
after(() => app?.close());

// The board in a fresh page, in List: the viewer's saved choice for it.
async function openList() {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await page.evaluate((id) => localStorage.setItem(`boardView:${id}`, "list"), boardId);
  await page.reload();
  await page.waitForSelector("#grid tr.list-row[data-id]");
  return page;
}

test("List's column header sticks under the page header, and follows it as it folds away and comes back", async () => {
  const page = await openList();
  const gap = () => page.evaluate(() => Math.round(
    document.querySelector("#grid thead th").getBoundingClientRect().top - document.querySelector("header").getBoundingClientRect().bottom));
  // The fold is a 0.28s transition (styles.css); the header is measured again
  // on every frame of it.
  const settled = () => page.waitForTimeout(450);

  await page.evaluate(() => window.scrollBy(0, 900));
  await page.waitForSelector("header.header-collapsed");
  await settled();
  const folded = await gap();
  await page.evaluate(() => window.scrollBy(0, -200));
  await page.waitForSelector("header:not(.header-collapsed)");
  await settled();
  const back = await gap();
  assert.ok(Math.abs(folded - 6) <= 1, `6px under the folded header (${folded}px)`);
  assert.ok(Math.abs(back - 6) <= 1, `6px under the header come back (${back}px)`);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("List draws its next batch as the page nears the end", async () => {
  const page = await openList();
  const rows = () => page.evaluate(() => document.querySelectorAll("#grid tr.list-row[data-id]").length);
  assert.equal(await rows(), 60, "setup: the first batch");
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForFunction(() => document.querySelectorAll("#grid tr.list-row[data-id]").length === 70, null, { timeout: 5000 });
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
