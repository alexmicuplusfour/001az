// A switch between views keeps your place, in a real browser
// (planning/list-view-plan.md, Stage 4): the item first in sight comes back at
// the height it showed at, in the other view. Only a browser lays the pages
// out: the grid's masonry, List's column header stuck under the page header,
// and the page header folding as the page moves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { createBoard, createEntity, insertItem, setBoardMembers } from "../../server/db.js";

let app, user;
const boards = {};
// Thumbnails the grid's cards can show: a card whose picture fails draws
// nothing. The masonry takes each card's height from the photo's own shape.
const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SHAPES = [[1200, 800], [800, 1200], [1000, 1000], [1600, 900], [900, 1600]];

before(async () => {
  app = await openApp();
  ({ user } = await app.signIn({ boardName: "unused" }));
  const board = async (name, count, filesEach = 1) => {
    const id = await createBoard(app.db, name, [], "", true, null, null, { enabled: false });
    await setBoardMembers(app.db, id, [user.id]);
    for (let i = 1; i <= count; i++) {
      const n = String(i).padStart(3, "0");
      const eid = await createEntity(app.db, id, { identity: `${name}-${n}` });
      for (let f = 0; f < filesEach; f++) {
        const [w, h] = SHAPES[(i + f) % SHAPES.length];
        const file = { name: `${name}-${n}-${f}.jpg`, original_name: `Photo ${n}.jpg`, kind: "image", w, h };
        await insertItem(app.db, id, { identity: `${name}-${n}`, files: [file], fields: {} }, "tagged", eid);
      }
    }
    return id;
  };
  boards.photos = await board("photos", 150); // past the grid's and List's first batch of 60
  boards.few = await board("few", 50); // all in the first batch
  boards.stacks = await board("stacks", 60, 2); // two files each: the rows view
});
after(() => app?.close());

async function openBoard(boardId, view) {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await page.route(/\/(thumbnails|gallery)\//, (r) => r.fulfill({ status: 200, contentType: "image/png", body: PIXEL }));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(([id, view]) => { if (view) localStorage.setItem(`boardView:${id}`, view); }, [boardId, view]);
  await page.reload();
  await page.waitForSelector("#grid [data-id]");
  return page;
}

// Down the page a step at a time, so the next batches draw as a reader's
// scroll would draw them, and the header folds.
async function scrollDown(page, steps) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, 1100));
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(500);
}

// The page as the reader sees it: what covers its top (the page header, and
// List's column header, whose cells stick under it), whether the header is
// folded, and the first item in sight: of the items whose element shows below
// the covered top, the top-most, then the left-most, and the height its top
// shows at. With an id, where that item's top is.
const look = (page, id) => page.evaluate((id) => {
  const header = document.querySelector("header");
  const edge = Math.max(header.getBoundingClientRect().bottom, document.querySelector("#grid thead th")?.getBoundingClientRect().bottom ?? 0);
  let first = null;
  for (const el of document.querySelectorAll("#grid [data-id]")) {
    const r = el.getBoundingClientRect();
    if (r.bottom <= edge || r.top >= innerHeight) continue;
    if (!first || r.top < first.top - 1 || (Math.abs(r.top - first.top) <= 1 && r.left < first.left)) first = { id: el.dataset.id, top: r.top, left: r.left };
  }
  return {
    edge: Math.round(edge), scrollY: Math.round(scrollY), folded: header.classList.contains("header-collapsed"),
    id: first?.id, y: Math.round(Math.max(first?.top, edge)),
    top: id ? Math.round(document.querySelector(`#grid [data-id="${id}"]`)?.getBoundingClientRect().top ?? NaN) : undefined,
  };
}, id);

// A switch from the toolbar's List toggle (List on, or back to the grid), and
// a moment for the header to fold or unfold if it was going to.
async function toggleList(page) {
  await page.click('.view-btn[aria-label="Toggle list view"]');
  await page.waitForTimeout(600);
}

// A board opened in one view, scrolled down, switched: the item first in sight
// before is back at the height it showed at, never under what covers the page,
// and the header, folded down the page, stays folded.
async function assertPlaceKept(boardId, view, steps, label) {
  const page = await openBoard(boardId, view);
  await scrollDown(page, steps);
  const before = await look(page);
  assert.ok(before.folded, `setup: ${label}, the header folded down the page`);
  await toggleList(page);
  const now = await look(page, before.id);
  assert.ok(Math.abs(now.top - Math.max(before.y, now.edge)) <= 1,
    `${label}: the item first in sight is back at its height (${now.top}px; it showed at ${before.y}, the page covered to ${now.edge})`);
  assert.ok(now.folded, `${label}: the header stays folded`);
  assert.deepEqual(page.errors, []);
}

test("grid to List: the card first in sight comes back as its row, at the height it showed at", async () => {
  await assertPlaceKept(boards.photos, null, 10, "grid to List");
});

test("List to grid: the row first in sight comes back as its card, at the height it showed at", async () => {
  await assertPlaceKept(boards.photos, "list", 5, "List to grid");
});

test("List to grid on a board its first batch holds whole: the cards are placed before the page scrolls to one", async () => {
  await assertPlaceKept(boards.few, "list", 2, "List to grid, one batch");
});

test("rows to List: the card first in sight comes back as its row, at the height it showed at", async () => {
  await assertPlaceKept(boards.stacks, "rows", 6, "rows to List");
});

test("from the top of the page, the other view starts at its top", async () => {
  const page = await openBoard(boards.photos);
  await toggleList(page);
  assert.equal((await look(page)).scrollY, 0, "grid to List");
  await toggleList(page);
  assert.equal((await look(page)).scrollY, 0, "and back");
  assert.deepEqual(page.errors, []);
});
