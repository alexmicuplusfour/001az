// List from the keyboard, in a real browser (planning/list-view-plan.md,
// Stage 2b): Tab, focus and `inert` exist only in one. A row's name opens its
// item; the lightbox takes the focus and keeps the keyboard in, and closing
// gives the focus back to the row it closed on; a redraw keeps the focus on
// its row; and nothing the keyboard lands on is hidden.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, servePixels, panelSettled } from "./harness.js";
import { seedUser, req } from "../helpers.js";
import { updateBoard, createEntity, insertItem, setBoardMembers } from "../../server/db.js";

let app, user, boardId;
const ids = new Map(); // a row's name → its entity id

before(async () => {
  app = await openApp();
  ({ user, boardId } = await app.signIn({ boardName: "Keyboard board" }));
  // A facet, so the Details panel has its Retag button.
  await updateBoard(app.db, boardId, { facets: [{ key: "color", label: "Color", values: ["red", "blue"] }] });
  const add = async (name, files) => {
    const eid = await createEntity(app.db, boardId, { identity: name });
    for (const file of files) {
      const id = await insertItem(app.db, boardId, { identity: name, files: [file], fields: {} }, "tagged", eid);
      await app.db.query("UPDATE items SET tags=$1 WHERE id=$2", [JSON.stringify(["color/red"]), id]);
    }
    ids.set(name, eid);
  };
  const photo = (name) => ({ name, w: 1200, h: 800, kind: "image" });
  // Oldest first, so the list, newest first, starts Pair, Clip, Notes, Item 40.
  for (let i = 1; i <= 40; i++) {
    const n = String(i).padStart(2, "0");
    await add(`Item ${n}`, [photo(`item-${n}.jpg`)]);
  }
  await add("Notes", [{ name: "notes.txt", kind: "text" }]);
  await add("Clip", [{ name: "clip.wav", kind: "audio" }]);
  await add("Pair", [photo("pair-a.jpg"), photo("pair-b.jpg")]);
});
after(() => app?.close());

// The board in a fresh page, in List (the viewer's saved choice), with a pixel
// for any file the lightbox asks for. The rows' small pictures aren't served:
// each falls back to its badge, and they aren't what these tests are about.
async function openList() {
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await servePixels(page);
  await page.evaluate((id) => localStorage.setItem(`boardView:${id}`, "list"), boardId);
  await page.reload();
  await page.waitForSelector("#grid tr.list-row[data-id]");
  return page;
}

const nameOf = (page, name) => page.locator(`#grid .list-open[title="${name}"]`);

// Enter on a row's name, and the lightbox open on its item.
async function openFromName(page, name) {
  await nameOf(page, name).focus();
  await page.keyboard.press("Enter");
  await page.waitForSelector("#lightbox:not([hidden])");
}

// What has keyboard focus, in words a failure message can use: the lightbox
// itself, or a control by its name, and the row it sits in.
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return "<body>";
  if (el.id === "lightbox") return "the lightbox";
  const name = el.getAttribute("aria-label") || el.textContent.trim() || el.title;
  const row = el.closest("#grid tr[data-id]")?.querySelector(".list-open")?.textContent;
  return `${el.tagName.toLowerCase()}${name ? ` "${name}"` : ""}${row && row !== name ? ` in ${row}` : ""}`;
});

test("Enter on a row's name opens its item with the focus in the lightbox, a dialog named by the item, and Tab stays in it", async () => {
  const page = await openList();
  await openFromName(page, "Item 30");
  assert.equal(await focused(page), "the lightbox", "the focus is in the lightbox");
  assert.equal(await page.getByRole("dialog", { name: "Item 30" }).count(), 1, "a dialog, named by its item");
  // Tab goes round the lightbox's controls and out to the browser's own
  // toolbar, which the page sees as nothing focused, and round again: never
  // into the page behind.
  const stops = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => {
      const a = document.activeElement;
      if (a === document.body) return "<body>";
      return document.getElementById("lightbox").contains(a) ? "lightbox" : a.outerHTML.slice(0, 90);
    }));
  }
  assert.deepEqual(stops.filter((s) => s !== "lightbox" && s !== "<body>"), [], "no Tab stop behind the lightbox");
  assert.ok(stops.filter((s) => s === "lightbox").length >= 8, `round the lightbox and round again: ${stops.join(", ")}`);
  // The toasts are the one layer above the lightbox by design (an upload's
  // Cancel among them), so they stay live.
  assert.deepEqual(await page.evaluate(() => ({
    page: document.querySelector("header").inert && document.getElementById("grid").inert,
    toasts: document.getElementById("toast-wrap").inert,
  })), { page: true, toasts: false }, "the page behind is inert, the toasts aren't");
  assert.deepEqual(page.errors, []);
});

test("closing after paging puts the focus on the name of the row it closed on", async () => {
  const page = await openList();
  await openFromName(page, "Item 30");
  for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Escape");
  await page.waitForSelector("#lightbox", { state: "hidden" });
  assert.equal(await focused(page), 'button "Item 27"', "the name of the row it closed on");
  assert.deepEqual(page.errors, []);
});

test("the focus stays on a row's name, or its select button, when someone else's heart moves the row up", async () => {
  // Preact moves a row that goes up the list, and the browser takes the focus
  // off an element it moves. A row going down, or a row passing it, keeps the
  // focus without help (the close look's probes); this case needs it.
  const page = await openList();
  await page.locator("#grid th.list-heart .list-sort").focus();
  await page.keyboard.press("Enter"); // hearts, most first: none yet, so the order stands
  await page.waitForSelector('#grid th.list-heart[aria-sort="descending"]');
  const other = await seedUser(app.db, "hearts@test.local");
  await setBoardMembers(app.db, boardId, [user.id, other.id]);
  // The other member hearts a row; resolves once the row has reached `at`.
  const heart = async (name, at) => {
    const hearted = await req(app.base, "POST", `/api/items/${ids.get(name)}/favorite`, { sid: other.sid });
    assert.equal(hearted.status, 200, `setup: the other member's heart on ${name}`);
    await page.waitForFunction(([name, at]) => document.querySelectorAll("#grid .list-open")[at]?.textContent === name,
      [name, at], { timeout: 12000 });
  };
  await nameOf(page, "Item 30").focus();
  assert.equal(await focused(page), 'button "Item 30"', "setup: the row's name has the focus");
  await heart("Item 30", 0);
  assert.equal(await focused(page), 'button "Item 30"', "its name");
  await nameOf(page, "Item 20").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(page), 'button "Select" in Item 20', "setup: a select button has the focus");
  await heart("Item 20", 1); // tied with Item 30, which is newer
  assert.equal(await focused(page), 'button "Select" in Item 20', "its select button");
  assert.deepEqual(page.errors, []);
});

test("a row's select circle shows when the keyboard lands on it", async () => {
  const page = await openList();
  await nameOf(page, "Item 30").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await focused(page), 'button "Select" in Item 30', "setup: its select button");
  await page.waitForTimeout(250); // the circle fades in over 0.12s
  assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).opacity), "1", "the circle shows");
  assert.deepEqual(page.errors, []);
});

test("Shift+Tab up the list never leaves the focus under the page header or the column header", async () => {
  const page = await openList();
  // Where the focused control sits against the column header, once the page
  // and the page header have settled (a fold or unfold is 0.28s).
  const place = async () => {
    await page.waitForTimeout(500);
    return page.evaluate(() => ({
      row: document.activeElement.closest("tr")?.querySelector(".list-open")?.textContent,
      top: Math.round(document.activeElement.getBoundingClientRect().top),
      under: Math.round(document.querySelector("#grid thead th").getBoundingClientRect().bottom),
    }));
  };
  // From a row's name, Shift+Tab `presses` times: its select button, the name
  // of the row above, and on up. Returns where that name started out, and
  // each stop.
  const upFrom = async (name, presses) => {
    const start = await nameOf(page, name).evaluate((b) => {
      b.focus({ preventScroll: true });
      return {
        above: Math.round(b.closest("tr").previousElementSibling.querySelector(".list-open").getBoundingClientRect().top),
        under: Math.round(document.querySelector("#grid thead th").getBoundingClientRect().bottom),
        padding: parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0,
      };
    });
    const stops = [];
    for (let i = 0; i < presses; i++) {
      await page.keyboard.press("Shift+Tab");
      stops.push(await place());
    }
    return { start, stops };
  };
  // A row's name set 30px under the column header, scrolling one way only:
  // down keeps the page header folded, up keeps it open.
  const setName = (way) => page.evaluate((way) => {
    const mark = document.querySelector("#grid thead th").getBoundingClientRect().bottom + 30;
    const names = [...document.querySelectorAll("#grid .list-open")];
    const b = way === "down"
      ? names.find((x) => x.getBoundingClientRect().top >= mark)
      : names.filter((x) => x.getBoundingClientRect().top <= mark).pop();
    window.scrollBy(0, b.getBoundingClientRect().top - mark);
    return b.title;
  }, way);

  // The page header folded. The row above starts under the column header,
  // within the page header's open height: the page's padding has to see it.
  // Two rows up, the scrolling has unfolded the header, which is why the
  // padding is the header's open height: a control placed clear of the folded
  // one ends up under the header as it opens.
  await page.evaluate(() => window.scrollTo(0, 1000));
  await page.waitForSelector("header.header-collapsed");
  await page.waitForTimeout(450);
  const folded = await upFrom(await setName("down"), 4);
  assert.ok(folded.start.above < folded.start.under, `setup, header folded: the row above starts under the column header (${JSON.stringify(folded.start)})`);
  for (const p of folded.stops) {
    assert.ok(p.top >= p.under, `header folded: ${p.row}'s control at ${p.top}px, under the column header's ${p.under}px`);
  }
  // The page header open. The row above starts under the column header but
  // clear of the page's padding: only List's own margin keeps it in sight.
  await page.evaluate(() => window.scrollBy(0, -150));
  await page.waitForSelector("header:not(.header-collapsed)");
  await page.waitForTimeout(450);
  const open = await upFrom(await setName("up"), 2);
  assert.ok(open.start.above < open.start.under && open.start.above >= open.start.padding,
    `setup, header open: the row above starts under the column header and clear of the page's padding (${JSON.stringify(open.start)})`);
  for (const p of open.stops) {
    assert.ok(p.top >= p.under, `header open: ${p.row}'s control at ${p.top}px, under the column header's ${p.under}px`);
  }
  assert.deepEqual(page.errors, []);
});

test("Tab past the last row doesn't land in the closed filter drawer", async () => {
  const page = await openList();
  await page.locator("#grid .list-open").last().focus();
  const stops = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => {
      const a = document.activeElement;
      return document.getElementById("filter-drawer").contains(a) ? `the drawer's ${a.id || a.textContent.trim()}` : "elsewhere";
    }));
  }
  assert.deepEqual(stops, ["elsewhere", "elsewhere", "elsewhere"], "no stop in the closed drawer");
  assert.deepEqual(page.errors, []);
});

test("the Details panel gives the focus back to its button when it closes, by Escape or by its ×", async () => {
  const page = await openList();
  await openFromName(page, "Item 30");
  await page.focus("#lightbox-info");
  await page.keyboard.press("Enter");
  await panelSettled(page, true);
  await page.keyboard.press("Tab");
  assert.equal(await focused(page), 'button "Keep panel open"', "setup: the focus is in the panel");
  await page.keyboard.press("Escape");
  await panelSettled(page, false);
  assert.equal(await focused(page), 'button "Details"', "Escape");
  await page.keyboard.press("Enter");
  await panelSettled(page, true);
  await page.focus("#lightbox-panel-close");
  await page.keyboard.press("Enter");
  await panelSettled(page, false);
  assert.equal(await focused(page), 'button "Details"', "its ×");
  assert.deepEqual(page.errors, []);
});

test("the Details panel keeps the focus through its repaints: a file switched to, its fetch landing, and paging on", async () => {
  const page = await openList();
  // The panel's file half draws when the file's fetch lands
  // (planning/lightbox-panel-plan.md, D11); the switch's fetch is held back
  // here until the keyboard has moved on, so it lands with the focus
  // somewhere else.
  let held = null;
  await page.route("**/api/instances/*/reasoning", async (r) => {
    await held;
    await r.continue().catch(() => {}); // a page closed in the meantime
  });
  await openFromName(page, "Pair");
  await page.focus("#lightbox-info");
  await page.keyboard.press("Enter");
  await panelSettled(page, true);
  const retag = page.locator("#lightbox-panel button", { hasText: "Retag" });
  await retag.waitFor(); // the open's own fetch, landed and drawn
  const on = () => page.evaluate(() => ({
    name: document.activeElement.classList.contains("lbp-file-name") ? document.activeElement.textContent : null,
    active: !!document.activeElement.closest(".lbp-file-active"),
  }));
  const second = page.locator(".lbp-file-name").nth(1);
  const name = await second.textContent();
  await second.focus();
  let release;
  held = new Promise((done) => (release = done));
  await page.keyboard.press("Enter"); // the switch, painted at once, its fetch held
  assert.deepEqual(await on(), { name, active: true }, "the file switched to");
  await page.keyboard.press("Tab"); // its download, before the fetch lands
  const onDownload = () => page.evaluate(() => ({
    download: document.activeElement.classList.contains("lbp-file-download"),
    active: !!document.activeElement.closest(".lbp-file-active"),
  }));
  assert.deepEqual(await onDownload(), { download: true, active: true }, "setup: its download");
  held = null;
  release();
  await retag.waitFor(); // the switch's fetch, landed and drawn
  assert.deepEqual(await onDownload(), { download: true, active: true }, "its download, through the fetch's paint");
  // Paging on with the focus on Retag: the next item's panel has one too,
  // drawn when its details land, and the focus goes back to it then.
  await retag.focus();
  await page.keyboard.press("ArrowRight");
  await retag.waitFor();
  assert.equal(await focused(page), 'button "Retag"', "Retag, on the next item");
  assert.deepEqual(page.errors, []);
});

test("the lightbox's arrow keys stand back for a text field and a player with the focus", async () => {
  const page = await openList();
  const count = () => page.textContent("#lightbox-count");
  // A new crate's name being typed: ← moves the caret, not the lightbox.
  await openFromName(page, "Item 30");
  const onItem = await count();
  await page.focus("#lightbox-crate");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.activeElement?.matches(".crate-pop .dd-input"));
  await page.keyboard.type("Trips");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => ({
    count: document.getElementById("lightbox-count").textContent,
    typed: document.querySelector(".crate-pop:not(.is-closing) .dd-input")?.value ?? "(the pop closed)",
  })), { count: onItem, typed: "Trips" }, "the crate's name");
  await page.keyboard.press("Escape"); // the pop
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  // The audio player: → is its seek.
  await openFromName(page, "Clip");
  await page.waitForSelector(".lightbox-audio-el");
  const onClip = await count();
  await page.focus(".lightbox-audio-el");
  assert.equal(await focused(page), "audio", "setup: the player has the focus");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(100);
  assert.equal(await count(), onClip, "the player's →");
  assert.deepEqual(page.errors, []);
});

test("paging with the Next button keeps the focus on it, onto audio and onto a document", async () => {
  const page = await openList();
  await openFromName(page, "Pair");
  await page.focus("#lightbox-next");
  await page.keyboard.press("Enter"); // Clip
  await page.waitForSelector(".lightbox-audio-el");
  assert.equal(await focused(page), 'button "Next"', "onto audio");
  await page.keyboard.press("Enter"); // Notes
  await page.waitForFunction(() => document.querySelector("iframe.lightbox-doc")?.contentDocument?.readyState === "complete");
  await page.waitForTimeout(100); // its load handler
  assert.equal(await focused(page), 'button "Next"', "onto a document, once its frame has loaded");
  assert.deepEqual(page.errors, []);
});

test("D1's keyboard reach as one walk: a row, the lightbox, its Details panel, and back to the row", async () => {
  const page = await openList();
  await openFromName(page, "Item 30");
  // One lap: Tab until the focus leaves for the browser's own toolbar.
  const lap = async () => {
    const stops = [];
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("Tab");
      const f = await focused(page);
      if (f === "<body>") break;
      stops.push(f);
    }
    return stops;
  };
  assert.deepEqual(await lap(), ['button "Previous"', 'button "Next"', 'button "Add to crate"', 'button "Favorite"', 'button "Details"'],
    "the lightbox");
  await page.focus("#lightbox-info");
  await page.keyboard.press("Enter");
  await panelSettled(page, true);
  // Retag comes with the file's details (planning/lightbox-panel-plan.md, D11).
  await page.locator("#lightbox-panel button", { hasText: "Retag" }).waitFor();
  // A one-file item's download sits at the end of its name, under the header.
  assert.deepEqual(await lap(), ['button "Keep panel open"', 'button "Close panel"', 'a "Download item-30.jpg"', 'button "Retag"'],
    "its Details panel");
  // The heart says whether it's on: off, and on once pressed.
  await page.focus("#lightbox-fav");
  assert.equal(await page.getAttribute("#lightbox-fav", "aria-pressed"), "false", "the heart says it's off");
  await page.keyboard.press("Enter");
  await page.waitForSelector('#lightbox-fav[aria-pressed="true"]');
  await page.keyboard.press("Escape"); // the panel
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  assert.equal(await focused(page), 'button "Item 30"', "back on the row");
  assert.deepEqual(page.errors, []);
});
