// The lightbox's Comments view (planning/comments-plan.md, Stage 2): the
// bubble beside the heart, the panel's two views, and the thread with its
// text box (D10-D12). And the count on cards and List rows (Stage 3, D13).
//
// Real triggers only, as in lightbox-panel.test.js: a click, a key, or a
// change made through the API by another member, the way their own page would
// make it, reaching this page through its own poll or the board's events.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp, servePixels, panelSettled, holdPolls } from "./harness.js";
import { req, seedUser } from "../helpers.js";
import { createEntity, insertItem, addComment, deleteUser, setBoardMembers, toggleFavorite } from "../../server/db.js";

let app, me, sam, boardId;
const ents = new Map(); // a card's name → its entity id

const photo = (name) => ({ name, w: 1200, h: 800, kind: "image" });

// A card with its files, and its comments as [author, text], oldest first.
async function add(name, { files = 1, fields = {}, comments = [] } = {}) {
  const eid = await createEntity(app.db, boardId, { identity: name });
  const slug = name.toLowerCase().replace(/\W+/g, "-");
  for (let i = 0; i < files; i++) {
    await insertItem(app.db, boardId, { identity: name, files: [photo(`${slug}-${i}.jpg`)], fields }, "tagged", eid);
  }
  for (const [who, text] of comments) await addComment(app.db, eid, who.id, text);
  ents.set(name, eid);
}

before(async () => {
  app = await openApp();
  ({ user: me, boardId } = await app.signIn({ boardName: "Comments board" }));
  sam = await seedUser(app.db, "sam@test.local");
  await app.db.query("UPDATE users SET name='Sam Rivera' WHERE id=$1", [sam.id]);
  const leaver = await seedUser(app.db, "leaver@test.local");
  await setBoardMembers(app.db, boardId, [me.id, sam.id, leaver.id]);

  await add("Toggled", { files: 2 });
  await add("Pinned");
  await add("Pinned next");
  await add("Posted", { comments: [[sam, "One before."], [sam, "Two before."]] });
  await add("Mixed", { comments: [[leaver, "From someone who left."], [sam, "From Sam."], [me, "From me."]] });
  await add("Edited", { comments: [[me, "Before the edit"]] });
  await add("Deleted", { comments: [[me, "First"], [me, "Second"]] });
  // Side by side, newest first in the list: on Draft A, the next card is B.
  await add("Draft B");
  await add("Draft A");
  await add("Live", { comments: Array.from({ length: 12 }, (_, i) => [sam, `Earlier comment ${i + 1}, long enough to take up a line or so of the panel.`]) });
  await add("Quiet", { fields: { objects: { v: [{ label: "cat", score: 0.91, box: [0.1, 0.1, 0.6, 0.5] }], why: "Detected: cat" } } });
  await add("Long", { comments: Array.from({ length: 25 }, (_, i) => [sam, `Comment ${i + 1} in a thread far longer than the panel.`]) });
  await add("Escaped");
  await add("Refused");
  await add("Unreachable");
  await add("Counted", { comments: [[sam, "One."], [sam, "Two."]] });
  await add("Uncounted");
  // The second pass (Stage 4). Side by side again where a test pages: on A,
  // the next card is B.
  await add("Paged B");
  await add("Paged A");
  await add("Back B", { comments: [[sam, "On B."]] });
  await add("Back A", { comments: [[sam, "On A."]] });
  await add("Two edits", { comments: [[me, "First of mine"], [me, "Second of mine"]] });
  await add("Escaped edit", { comments: [[me, "Keep me"]] });
  await add("Refused edits", { comments: [[me, "Stays as it is"]] });
  await add("Keyboard");
  await add("Crossed");
  await add("Moves", { comments: [[sam, "Before it moved."]] });
  await add("Hearted");
  for (const [i, name] of ["Avery Lindqvist-Moreau", "Blake Okonkwo-Hartley", "Casey Vandermeer", "Devon Abernathy-Quinn"].entries()) {
    const fan = await seedUser(app.db, `fan${i}@test.local`);
    await app.db.query("UPDATE users SET name=$1 WHERE id=$2", [name, fan.id]);
    await toggleFavorite(app.db, fan.id, ents.get("Hearted"));
  }
  // Their comments stay, signed Former member (D3).
  await deleteUser(app.db, leaver.id);
});
after(() => app?.close());

// A page of my own, the last test's closed first. Left open, a page keeps the
// board's events, so every comment a later test writes would have each page
// still open fetch the whole board again: hundreds of fetches by the end of
// the file, slow enough under the full suite to time a page's load out.
let last = null;
async function fresh(device) {
  await last?.context().close().catch(() => {});
  last = await app.open("/api/me", { sid: me.sid, device });
  return last;
}

// The board in a fresh page, a pixel for every picture.
async function openBoard() {
  const page = await fresh();
  await servePixels(page, { thumbnails: true });
  await page.goto(`${app.base}/?board=${boardId}`);
  await page.waitForSelector("#grid .card[data-id]");
  return page;
}

async function openCard(page, name) {
  await page.locator(`#grid .card[data-id="${ents.get(name)}"]`).click();
  await page.waitForSelector("#lightbox:not([hidden])");
}

// The thread, once its comments have come.
const threadIn = (page) => page.waitForFunction(() => {
  const t = document.querySelector("#lightbox-panel-body .cm-thread");
  return t && !t.textContent.includes("Loading…");
}, null, { timeout: 10000 });

async function openComments(page) {
  await page.click("#lightbox-comments");
  await panelSettled(page, true);
  await threadIn(page);
}

// The thread as it shows: each comment's author, its text, and how many of
// the pencil and bin it has.
const thread = (page) => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel-body .cm")].map((c) => ({
  author: c.querySelector(".cm-author").textContent,
  text: c.querySelector(".cm-text")?.textContent ?? null,
  tools: c.querySelectorAll(".cm-acts button").length,
})));
const bubble = (page) => page.evaluate(() => document.getElementById("lightbox-comments").textContent.trim());
const composer = (page) => page.locator("#lightbox-panel-body .cm-compose textarea");
const card = (page) => page.getAttribute("#lightbox", "aria-label");
const focused = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el === document.body ? "body" : el.id || el.getAttribute("aria-label") || el.textContent.trim();
});
const stored = (name) => app.db.query("SELECT body, edited_at FROM comments WHERE entity_id=$1 ORDER BY id", [ents.get(name)]).then((r) => r.rows);
// Whether a toast saying this comes up in the time given, as a yes or no.
const toastSays = (page, text, timeout = 5000) => page.waitForFunction(
  (text) => [...document.querySelectorAll("#toast-wrap .toast-msg")].some((t) => t.textContent.includes(text)),
  text, { timeout },
).then(() => true, () => false);
// The page's own answers only from here on: no poll, no refetch for the
// board's events, and no second ask for the thread. What changes after this
// is the page's own doing.
async function ownAnswersOnly(page) {
  await holdPolls(page);
  await page.route(/\/api\/items\/\d+\/comments$/, (route) => (route.request().method() === "GET" ? undefined : route.fallback()));
}
// The thread's scroll, at its newest comment or not.
const atNewest = (page) => page.evaluate(() => {
  const t = document.querySelector("#lightbox-panel-body .cm-thread");
  return t.scrollHeight > t.clientHeight && t.scrollHeight - t.scrollTop - t.clientHeight < 4;
});

test("the bubble opens Comments and (i) switches to Details, each lit in turn, and each closes its own view", async () => {
  const page = await openBoard();
  await openCard(page, "Toggled");
  const look = () => page.evaluate(() => ({
    open: document.getElementById("lightbox").classList.contains("panel-open"),
    title: document.getElementById("lightbox-panel-title").textContent,
    lit: [...document.querySelectorAll("#lightbox-controls .on")].map((b) => b.id),
    pressed: [...document.querySelectorAll("#lightbox-controls [aria-pressed=true]")].map((b) => b.id),
    view: document.querySelector("#lightbox-panel-body .cm-thread") ? "comments"
      : document.querySelector("#lightbox-panel-body .lbp-file-half") ? "details" : null,
  }));
  await openComments(page);
  assert.deepEqual(await look(), { open: true, title: "Comments", lit: ["lightbox-comments"], pressed: ["lightbox-comments"], view: "comments" },
    "the bubble opens the panel on Comments");
  assert.equal(await page.textContent("#lightbox-panel-body .cm-thread .lbp-meta"), "Toggled2 files, one thread",
    "under the card's name, a line saying its files share one thread");
  await page.click("#lightbox-info");
  assert.deepEqual(await look(), { open: true, title: "Details", lit: ["lightbox-info"], pressed: ["lightbox-info"], view: "details" },
    "(i) switches it to Details");
  await page.click("#lightbox-info");
  await panelSettled(page, false);
  const closed = await look();
  assert.deepEqual([closed.open, closed.lit, closed.pressed], [false, [], []], "(i) again closes it");
  await page.click("#lightbox-comments");
  await panelSettled(page, true);
  assert.deepEqual((await look()).view, "comments", "the bubble opens it on Comments again");
  await page.click("#lightbox-comments");
  await panelSettled(page, false);
  assert.equal((await look()).open, false, "and the bubble again closes it");
  assert.deepEqual(page.errors, []);
});

test("a pinned panel reopens on the view it last showed", async () => {
  const page = await openBoard();
  await openCard(page, "Pinned");
  await openComments(page);
  await page.click("#lightbox-panel-pin");
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await openCard(page, "Pinned next");
  await panelSettled(page, true);
  assert.deepEqual(await page.evaluate(() => [document.getElementById("lightbox-panel-title").textContent,
    document.getElementById("lightbox-comments").classList.contains("on")]), ["Comments", true], "pinned on Comments, it opens on Comments");
  await threadIn(page);
  await page.click("#lightbox-info"); // Details, still pinned
  await page.keyboard.press("Escape");
  await panelSettled(page, false);
  await page.keyboard.press("Escape");
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await openCard(page, "Pinned");
  await panelSettled(page, true);
  assert.deepEqual(await page.evaluate(() => [document.getElementById("lightbox-panel-title").textContent,
    document.getElementById("lightbox-info").classList.contains("on")]), ["Details", true], "switched to Details, it opens on Details");
  assert.equal(await page.evaluate((b) => localStorage.getItem(`lbPanelPin:${b}`), boardId), "1",
    "stored as a Details pin always was");
  assert.deepEqual(page.errors, []);
});

test("posting with the button and with Ctrl+Enter: the comment comes last, the box empties, the count goes up", async () => {
  const page = await openBoard();
  await openCard(page, "Posted");
  await openComments(page);
  assert.equal(await bubble(page), "2", "setup: the bubble counts the card's two comments");
  assert.equal(await page.locator(".cm-compose button", { hasText: "Post" }).isDisabled(), true, "nothing to post yet");
  await ownAnswersOnly(page);
  const last = () => page.evaluate(() => {
    const all = document.querySelectorAll("#lightbox-panel-body .cm");
    const c = all[all.length - 1];
    return { n: all.length, author: c.querySelector(".cm-author").textContent, time: c.querySelector(".cm-time").textContent, text: c.querySelector(".cm-text").textContent };
  });
  await composer(page).fill("Posted with the button");
  await page.click(".cm-compose button");
  await page.waitForFunction(() => document.querySelectorAll("#lightbox-panel-body .cm").length === 3);
  assert.deepEqual(await last(), { n: 3, author: "browser@test.local", time: "just now", text: "Posted with the button" }, "it comes last, yours, just now");
  assert.deepEqual([await composer(page).inputValue(), await bubble(page)], ["", "3"], "the box empties and the count goes up");
  await composer(page).fill("Posted with the keys");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.waitForFunction(() => document.querySelectorAll("#lightbox-panel-body .cm").length === 4);
  assert.equal((await last()).text, "Posted with the keys");
  assert.deepEqual([await composer(page).inputValue(), await bubble(page)], ["", "4"]);
  assert.deepEqual((await stored("Posted")).map((c) => c.body), ["One before.", "Two before.", "Posted with the button", "Posted with the keys"]);
  assert.deepEqual(page.errors, []);
});

test("your comment has the pencil and bin, another member's has neither, and a deleted account's is signed Former member", async () => {
  const page = await openBoard();
  await openCard(page, "Mixed");
  await openComments(page);
  assert.deepEqual(await thread(page), [
    { author: "Former member", text: "From someone who left.", tools: 0 },
    { author: "Sam Rivera", text: "From Sam.", tools: 0 },
    { author: "browser@test.local", text: "From me.", tools: 2 },
  ]);
  assert.deepEqual(page.errors, []);
});

test("Escape in the edit box cancels it, changing nothing; Save, or Ctrl+Enter, saves and marks it edited", async () => {
  const page = await openBoard();
  await openCard(page, "Edited");
  await openComments(page);
  const pencil = page.locator(".cm-acts button[aria-label='Edit your comment']");
  await pencil.click();
  const box = page.locator(".cm textarea");
  assert.equal(await box.inputValue(), "Before the edit", "setup: the box holds the comment");
  await page.keyboard.type(" and more");
  await page.keyboard.press("Escape");
  assert.deepEqual(await thread(page), [{ author: "browser@test.local", text: "Before the edit", tools: 2 }], "the edit is cancelled, the text as it was");
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open")), true, "and the panel stays open");
  assert.equal(await focused(page), "Edit your comment", "the keyboard is back on the pencil");
  await ownAnswersOnly(page);
  const text = () => page.evaluate(() => document.querySelector("#lightbox-panel-body .cm-text")?.textContent);
  await pencil.click();
  await box.fill("After the edit");
  await page.click(".cm-row button:has-text('Save')");
  await page.waitForFunction(() => document.querySelector("#lightbox-panel-body .cm-text")?.textContent === "After the edit", null, { timeout: 5000 })
    .catch(() => {});
  assert.equal(await text(), "After the edit", "Save shows the new text at once");
  assert.equal(await page.textContent(".cm-time"), "just now · edited", "marked edited");
  await pencil.click();
  await box.fill("After the second edit");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.waitForFunction(() => document.querySelector("#lightbox-panel-body .cm-text")?.textContent === "After the second edit", null, { timeout: 5000 })
    .catch(() => {});
  assert.equal(await text(), "After the second edit", "so does Ctrl+Enter");
  const [row] = await stored("Edited");
  assert.equal(row.body, "After the second edit");
  assert.ok(row.edited_at, "and stored as edited");
  assert.deepEqual(page.errors, []);
});

test("delete asks first: Cancel keeps the comment, so does Escape, and Delete removes it as the count drops", async () => {
  const page = await openBoard();
  await openCard(page, "Deleted");
  await openComments(page);
  assert.equal(await bubble(page), "2", "setup: two comments");
  const bin = page.locator(".cm", { hasText: "Second" }).locator("button[aria-label='Delete your comment']");
  const asking = () => page.locator(".cm-ask").count();
  await bin.click();
  assert.equal(await asking(), 1, "it asks");
  assert.equal(await page.getByRole("group", { name: "Delete this comment?" }).count(), 1,
    "in a group its question names, which a screen reader says on the way in");
  assert.equal(await focused(page), "Cancel", "the keyboard on the safe answer");
  await page.click(".cm-row button:has-text('Cancel')");
  assert.deepEqual([await asking(), (await thread(page)).length], [0, 2], "Cancel keeps it");
  assert.equal(await focused(page), "Delete your comment", "and gives the keyboard back to the bin");
  await bin.click();
  await page.keyboard.press("Escape");
  assert.deepEqual([await asking(), (await thread(page)).length], [0, 2], "Escape keeps it too");
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open")), true, "and leaves the panel open");
  assert.equal(await focused(page), "Delete your comment");
  await ownAnswersOnly(page);
  await bin.click();
  await page.click(".cm-row button:has-text('Delete')");
  await page.waitForFunction(() => document.querySelectorAll("#lightbox-panel-body .cm").length === 1);
  assert.deepEqual([(await thread(page))[0].text, await bubble(page)], ["First", "1"], "Delete removes it, and the count drops");
  assert.deepEqual((await stored("Deleted")).map((c) => c.body), ["First"]);
  assert.deepEqual(page.errors, []);
});

test("a draft stays with its card while paging away and back, and the arrows typed in the box don't page", async () => {
  const page = await openBoard();
  await openCard(page, "Draft A");
  await openComments(page);
  await composer(page).click();
  await page.keyboard.type("Unsent on A");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await card(page), "Draft A", "the arrow moved the caret, not the lightbox");
  await page.keyboard.press("Escape"); // out of the box
  await page.keyboard.press("ArrowRight");
  assert.equal(await card(page), "Draft B", "setup: paged on");
  await threadIn(page);
  assert.equal(await composer(page).inputValue(), "", "the next card's box is its own");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await card(page), "Draft A", "setup: back");
  await threadIn(page);
  assert.equal(await composer(page).inputValue(), "Unsent on A", "the draft waited on its card");
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await openCard(page, "Draft A");
  await openComments(page);
  assert.equal(await composer(page).inputValue(), "Unsent on A", "and through closing the lightbox");
  assert.deepEqual(page.errors, []);
});

test("Escape in the text box leaves it with the draft kept, and the next closes the panel with the keyboard on the bubble", async () => {
  const page = await openBoard();
  await openCard(page, "Escaped");
  await openComments(page);
  await composer(page).click();
  await page.keyboard.type("Kept");
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open")), true, "the panel stays open");
  assert.deepEqual([await focused(page), await composer(page).inputValue()], ["body", "Kept"], "out of the box, the draft kept");
  await page.keyboard.press("Escape");
  await panelSettled(page, false);
  assert.equal(await focused(page), "lightbox-comments", "the next closes the panel, and the keyboard is on the bubble");
  assert.equal(await page.isVisible("#lightbox"), true, "the lightbox stays");
  assert.deepEqual(page.errors, []);
});

test("a comment another member posts reaches the open thread with no reload, and keeps the reader at the newest", async () => {
  const page = await openBoard();
  await openCard(page, "Live");
  await openComments(page);
  assert.equal(await atNewest(page), true, "setup: a thread that scrolls, open at its newest");
  const samPosts = async (text) => {
    const r = await req(app.base, "POST", `/api/items/${ents.get("Live")}/comments`, { sid: sam.sid, body: { body: text } });
    assert.equal(r.status, 200, "setup: Sam posted");
    await page.waitForFunction((text) => {
      const all = document.querySelectorAll("#lightbox-panel-body .cm-text");
      return all[all.length - 1]?.textContent === text;
    }, text, { timeout: 15000 });
  };
  await samPosts("Posted elsewhere");
  assert.equal(await atNewest(page), true, "it came, and the thread is still at its newest");
  assert.equal(await bubble(page), "13", "with the count");
  await page.evaluate(() => { document.querySelector("#lightbox-panel-body .cm-thread").scrollTop = 0; });
  await samPosts("Posted while you read");
  assert.equal(await page.evaluate(() => document.querySelector("#lightbox-panel-body .cm-thread").scrollTop), 0,
    "scrolled up to read, the next one leaves you where you were");
  assert.deepEqual(page.errors, []);
});

test("while Comments shows, no file details are fetched and the boxes over the picture wait", async () => {
  const page = await openBoard();
  const asked = [];
  page.on("request", (r) => { if (r.url().endsWith("/reasoning")) asked.push(r.url()); });
  const boxes = () => page.evaluate(() => !document.querySelector(".lb-det-overlay").hidden);
  await openCard(page, "Quiet");
  await openComments(page);
  assert.deepEqual([asked.length, await boxes()], [0, false], "Comments first: no file details asked for, no boxes over the picture");
  await page.click("#lightbox-info");
  await page.waitForSelector(".lb-det-overlay:not([hidden]) .lb-det-box", { timeout: 10000 });
  assert.equal(asked.length, 1, "setup: Details asks, and draws the box");
  await page.click("#lightbox-comments");
  await threadIn(page);
  assert.equal(await boxes(), false, "back on Comments, the box goes with Details");
  assert.deepEqual(page.errors, []);
});

test("a thread that can't be fetched says so, not Loading… for good, and is asked again when you come back to it", async () => {
  const page = await openBoard();
  const comments = /\/api\/items\/\d+\/comments$/;
  await page.route(comments, (route) => route.fulfill({ status: 500, body: "" }));
  await openCard(page, "Unreachable");
  await openComments(page);
  const hint = () => page.textContent("#lightbox-panel-body .cm-thread .lbp-hint");
  assert.equal(await hint(), "Couldn't load the comments.");
  await page.unroute(comments);
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await openCard(page, "Unreachable");
  await openComments(page);
  await page.waitForFunction(() => document.querySelector("#lightbox-panel-body .cm-thread .lbp-hint")?.textContent === "No comments yet.",
    null, { timeout: 5000 }).catch(() => {});
  assert.equal(await hint(), "No comments yet.", "opened again, it asks again, and this time it loads");
  assert.deepEqual(page.errors, []);
});

test("a long thread opens on its newest comment, with the text box in view under it", async () => {
  const page = await openBoard();
  await openCard(page, "Long");
  await openComments(page);
  assert.equal(await atNewest(page), true, "the thread scrolls, and opens at its newest comment");
  const box = await page.evaluate(() => {
    const rect = (s) => document.querySelector(s).getBoundingClientRect();
    const panel = rect("#lightbox-panel");
    const last = [...document.querySelectorAll("#lightbox-panel-body .cm")].pop().getBoundingClientRect();
    const compose = rect("#lightbox-panel-body .cm-compose");
    const body = document.getElementById("lightbox-panel-body");
    return {
      lastShows: last.bottom <= compose.top + 1 && last.top >= rect("#lightbox-panel-body .cm-thread").top,
      composeAtBottom: Math.abs(compose.bottom - panel.bottom) <= 1,
      bodyStill: body.scrollHeight <= body.clientHeight,
    };
  });
  assert.deepEqual(box, { lastShows: true, composeAtBottom: true, bodyStill: true },
    "the newest comment shows above the text box, which sits at the panel's bottom, and only the thread scrolls");
  await composer(page).fill("A reply\nthat runs\nto several\nlines\nas it's\ntyped");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  assert.equal(await atNewest(page), true, "the box grew over the thread, and the newest comment is still in view above it");
  assert.deepEqual(page.errors, []);
});

test("a post the server refuses toasts its sentence and keeps the text", async () => {
  const page = await openBoard();
  await openCard(page, "Refused");
  await openComments(page);
  const long = "x".repeat(10001);
  const height = () => composer(page).evaluate((b) => ({ px: b.offsetHeight, scrolls: b.scrollHeight > b.clientHeight }));
  const one = (await height()).px;
  await composer(page).fill(long);
  assert.deepEqual(await height(), { px: 168, scrolls: true }, `the box grew from one line (${one}px) to its cap, and scrolls past it`);
  await page.click(".cm-compose button");
  assert.equal(await toastSays(page, "A comment can be at most 10,000 characters."), true, "the server's sentence");
  assert.deepEqual([(await composer(page).inputValue()).length, (await thread(page)).length, await bubble(page)], [10001, 0, ""],
    "the text stays, and nothing was added");
  assert.deepEqual(page.errors, []);
});

// ── The count on cards and List rows (Stage 3, D13) ───────────────────────

const chip = (page, name) => page.locator(`#grid [data-id="${ents.get(name)}"] .comment-chip`);
// Whether the lightbox is open on Comments, on the card named.
const onComments = async (page, name) => {
  await page.waitForSelector("#lightbox:not([hidden])");
  await panelSettled(page, true);
  await threadIn(page);
  return page.evaluate(() => [document.getElementById("lightbox").getAttribute("aria-label"),
    document.getElementById("lightbox-panel-title").textContent,
    document.getElementById("lightbox-comments").classList.contains("on")]).then((got) => got.join(" / ") === `${name} / Comments / true`);
};
async function inView(page, view) {
  await page.evaluate(([b, v]) => localStorage.setItem(`boardView:${b}`, v), [boardId, view]);
  await page.reload();
  await page.waitForSelector("#grid [data-id]");
}

test("a card shows its comment count only once it has comments, in the heart's corner, and hovering doesn't move it", async () => {
  const page = await openBoard();
  assert.deepEqual([(await chip(page, "Counted").textContent()).trim(), await chip(page, "Uncounted").count()], ["2", 0],
    "the count where there are comments, and none where there aren't");
  const place = () => page.evaluate((id) => {
    const card = document.querySelector(`#grid .card[data-id="${id}"]`);
    const media = card.querySelector(".face-media").getBoundingClientRect();
    const heart = card.querySelector(".heart").getBoundingClientRect();
    const count = card.querySelector(".comment-chip").getBoundingClientRect();
    return { heartLeft: heart.left - media.left, heartBottom: media.bottom - heart.bottom, countLeft: count.left - media.left, afterHeart: count.left > heart.right };
  }, ents.get("Counted"));
  const before = await place();
  assert.deepEqual([before.heartLeft, before.heartBottom, before.afterHeart], [8, 8, true],
    "the heart holds its corner, faded, with the count after it");
  await page.hover(`#grid .card[data-id="${ents.get("Counted")}"]`);
  await page.waitForFunction((id) => getComputedStyle(document.querySelector(`#grid .card[data-id="${id}"] .heart`)).opacity === "1",
    ents.get("Counted"));
  assert.equal((await place()).countLeft, before.countLeft, "the heart came into view and the count stayed where it was");
  await page.hover(`#grid .card[data-id="${ents.get("Uncounted")}"]`);
  await page.waitForSelector(`#grid .card[data-id="${ents.get("Uncounted")}"] .heart`);
  assert.equal(await chip(page, "Uncounted").count(), 0, "hovered, a card with no comments draws its heart, and no count");
  assert.deepEqual(page.errors, []);
});

test("a card's count follows a post made in the lightbox, the first one bringing it", async () => {
  const page = await openBoard();
  assert.equal(await chip(page, "Uncounted").count(), 0, "setup: no count yet");
  await openCard(page, "Uncounted");
  await openComments(page);
  await ownAnswersOnly(page); // the post's own answer moves the card, not a refetch
  await composer(page).fill("The first one");
  await page.click(".cm-compose button");
  await page.waitForFunction(() => document.querySelectorAll("#lightbox-panel-body .cm").length === 1);
  await chip(page, "Uncounted").waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
  assert.equal(await chip(page, "Uncounted").count() ? (await chip(page, "Uncounted").textContent()).trim() : null, "1",
    "the card behind the lightbox has its count");
  assert.deepEqual(page.errors, []);
});

test("the count opens the lightbox on Comments, from a card and from a List row", async () => {
  const page = await openBoard();
  await chip(page, "Counted").click();
  assert.equal(await onComments(page, "Counted"), true, "from the card");
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  await inView(page, "list");
  await chip(page, "Counted").click();
  assert.equal(await onComments(page, "Counted"), true, "from its List row");
  assert.deepEqual(page.errors, []);
});

test("in List the count sits beside the heart, the hearts under their column's icon, and a rows-view card has its count too", async () => {
  const page = await openBoard();
  await inView(page, "list");
  const row = await page.evaluate((id) => {
    const r = document.querySelector(`#grid tr[data-id="${id}"]`);
    const heart = r.querySelector(".heart").getBoundingClientRect();
    const count = r.querySelector(".comment-chip").getBoundingClientRect();
    const icon = (el) => el.querySelector("svg").getBoundingClientRect().left;
    return { sameLine: Math.abs(count.top - heart.top) <= 2, after: count.left >= heart.right,
      fits: count.right <= r.querySelector("td.list-heart").getBoundingClientRect().right,
      underHead: Math.abs(icon(r.querySelector(".heart")) - icon(document.querySelector("th.list-heart"))) <= 1 };
  }, ents.get("Counted"));
  assert.deepEqual(row, { sameLine: true, after: true, fits: true, underHead: true });
  assert.equal(await page.locator(`#grid tr[data-id="${ents.get("Toggled")}"] .comment-chip`).count(), 0,
    "and a row with no comments has none");
  await inView(page, "rows");
  assert.equal((await chip(page, "Counted").textContent()).trim(), "2", "the rows view's card is the grid's");
  assert.deepEqual(page.errors, []);
});

test("bulk mode hides the count with the heart", async () => {
  const page = await openBoard();
  await page.hover(`#grid .card[data-id="${ents.get("Uncounted")}"]`);
  await page.click(`#grid .card[data-id="${ents.get("Uncounted")}"] .sel-cb`);
  await page.waitForSelector("body.bulk-mode");
  assert.equal(await chip(page, "Counted").isVisible(), false);
  assert.deepEqual(page.errors, []);
});

// ── The second pass (Stage 4) ─────────────────────────────────────────────

// Requests the page sends that `matches` picks, held until the release this
// answers is called.
async function holding(page, url, matches) {
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route(url, async (route) => (matches(route.request()) ? held.then(() => route.fallback()) : route.fallback()));
  return release;
}
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

test("a post still out when you page away and back isn't offered to send again", async () => {
  const page = await openBoard();
  await openCard(page, "Paged A");
  await openComments(page);
  const release = await holding(page, /\/api\/items\/\d+\/comments$/, (r) => r.method() === "POST");
  await composer(page).fill("Sent once");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.keyboard.type(" and more");
  assert.equal(await composer(page).inputValue(), "Sent once", "read-only while it's sent, so nothing typed meanwhile goes with it");
  await page.keyboard.press("Escape"); // out of the box
  await page.keyboard.press("ArrowRight");
  assert.equal(await card(page), "Paged B", "setup: paged on while it was out");
  await threadIn(page);
  await page.keyboard.press("ArrowLeft");
  assert.equal(await card(page), "Paged A", "setup: and back");
  await threadIn(page);
  const post = page.locator(".cm-compose button", { hasText: "Post" });
  assert.deepEqual([await composer(page).inputValue(), await post.isDisabled()], ["", true], "the box is empty, with nothing to post");
  release();
  await page.waitForFunction(() => [...document.querySelectorAll("#lightbox-panel-body .cm-text")].some((t) => t.textContent === "Sent once"));
  assert.equal(await composer(page).inputValue(), "", "and stays so once it lands");
  assert.deepEqual((await stored("Paged A")).map((c) => c.body), ["Sent once"]);
  assert.deepEqual(page.errors, []);
});

test("paging away and straight back keeps the thread on screen, and the other card's late answer doesn't take it", async () => {
  const page = await openBoard();
  await openCard(page, "Back A");
  await openComments(page);
  const other = ents.get("Back B");
  const release = await holding(page, new RegExp(`/api/items/${other}/comments$`), () => true);
  await page.keyboard.press("ArrowRight");
  assert.equal(await card(page), "Back B", "setup: on B, its thread asked for");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await card(page), "Back A", "setup: back on A before B's answer");
  await threadIn(page);
  assert.deepEqual((await thread(page)).map((c) => c.text), ["On A."], "A's thread, at once");
  await page.evaluate(() => {
    window.flashed = false;
    const body = document.getElementById("lightbox-panel-body");
    new MutationObserver(() => {
      if (body.querySelector(".cm-thread .lbp-hint")?.textContent === "Loading…") window.flashed = true;
    }).observe(body, { subtree: true, childList: true, characterData: true });
  });
  const answered = page.waitForResponse((r) => r.url().endsWith(`/api/items/${other}/comments`));
  release();
  await (await answered).finished();
  await frames(page);
  assert.deepEqual([await page.evaluate(() => window.flashed), (await thread(page)).map((c) => c.text)], [false, ["On A."]],
    "B's answer came and went, and A's thread never flickered to Loading…");
  assert.deepEqual(page.errors, []);
});

test("a Save that lands late closes its own box, never one opened since", async () => {
  const page = await openBoard();
  await openCard(page, "Two edits");
  await openComments(page);
  const release = await holding(page, /\/api\/items\/\d+\/comments\/\d+$/, (r) => r.method() === "PATCH");
  await page.locator(".cm", { hasText: "First of mine" }).locator("button[aria-label='Edit your comment']").click();
  await page.locator(".cm textarea").fill("First, edited");
  await page.click(".cm-row button:has-text('Save')");
  await page.locator(".cm", { hasText: "Second of mine" }).locator("button[aria-label='Edit your comment']").click();
  await page.keyboard.type(" and more");
  release();
  await page.waitForFunction(() => [...document.querySelectorAll("#lightbox-panel-body .cm-text")].some((t) => t.textContent === "First, edited"));
  assert.equal(await page.locator(".cm textarea").inputValue({ timeout: 1000 }).catch(() => null), "Second of mine and more",
    "the first one saved, and the second one's box is still open with what was typed in it");
  assert.deepEqual(page.errors, []);
});

test("Escape on the edit's buttons cancels the edit too, and the panel stays", async () => {
  const page = await openBoard();
  await openCard(page, "Escaped edit");
  await openComments(page);
  await page.click(".cm-acts button[aria-label='Edit your comment']");
  await page.keyboard.type(" or not");
  await page.keyboard.press("Tab"); // Cancel
  await page.keyboard.press("Tab"); // Save
  assert.equal(await focused(page), "Save", "setup: on Save");
  await page.keyboard.press("Escape");
  assert.deepEqual(await thread(page), [{ author: "browser@test.local", text: "Keep me", tools: 2 }], "the edit is cancelled");
  assert.equal(await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open")), true, "the panel stays open");
  assert.equal(await focused(page), "Edit your comment", "and the keyboard is back on the pencil");
  assert.deepEqual(page.errors, []);
});

test("after posting with the Post button or deleting with the keyboard, the keyboard is in the text box", async () => {
  const page = await openBoard();
  await openCard(page, "Keyboard");
  await openComments(page);
  await composer(page).fill("By the button");
  await page.focus(".cm-compose button");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#lightbox-panel-body .cm").length === 1);
  await frames(page);
  assert.equal(await focused(page), "Add a comment", "posted, the keyboard is back in the box, not lost with the button");
  await page.click(".cm-acts button[aria-label='Delete your comment']");
  await page.keyboard.press("Tab"); // Cancel → Delete
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll("#lightbox-panel-body .cm").length === 0);
  await frames(page);
  assert.equal(await focused(page), "Add a comment", "deleted, it goes to the box, not lost with the comment");
  assert.deepEqual(page.errors, []);
});

test("a Save or a Delete the server refuses gives the keyboard back to the box or the question, where Escape still works", async () => {
  const page = await openBoard();
  await openCard(page, "Refused edits");
  await openComments(page);
  await page.route(/\/api\/items\/\d+\/comments\/\d+$/, (route) => route.fulfill({ status: 500, body: "" }));
  const inBox = () => page.evaluate(() => document.activeElement.tagName === "TEXTAREA" && document.activeElement.closest(".cm") !== null);
  await page.click(".cm-acts button[aria-label='Edit your comment']");
  await page.keyboard.type(" now");
  await page.click(".cm-row button:has-text('Save')");
  assert.equal(await toastSays(page, "Couldn't save the comment"), true, "setup: refused");
  await frames(page);
  assert.equal(await inBox(), true, "still editing, the keyboard back in the box");
  await page.keyboard.press("Escape");
  assert.deepEqual([await page.locator(".cm textarea").count(), await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open"))],
    [0, true], "so Escape cancels the edit, and the panel stays");
  await page.click(".cm-acts button[aria-label='Delete your comment']");
  await page.keyboard.press("Tab"); // Cancel → Delete
  await page.keyboard.press("Enter");
  assert.equal(await toastSays(page, "Couldn't delete the comment"), true, "setup: refused");
  await frames(page);
  assert.equal(await focused(page), "Cancel", "still asking, the keyboard back on the safe answer");
  await page.keyboard.press("Escape");
  assert.deepEqual([await page.locator(".cm-ask").count(), await page.evaluate(() => document.getElementById("lightbox").classList.contains("panel-open"))],
    [0, true], "so Escape cancels the question, and the panel stays");
  assert.deepEqual((await stored("Refused edits")).map((c) => c.body), ["Stays as it is"]);
  assert.deepEqual(page.errors, []);
});

test("your post shows once, though a refetch that crossed it brought it first", async () => {
  const page = await openBoard();
  await openCard(page, "Crossed");
  await openComments(page);
  // The post reaches the server, and its answer is held while the post's own
  // announcement has the page fetch the thread, which already has it.
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route(/\/api\/items\/\d+\/comments$/, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  const mine = () => page.evaluate(() => [...document.querySelectorAll("#lightbox-panel-body .cm-text")]
    .filter((t) => t.textContent === "Crossed once").length);
  await composer(page).fill("Crossed once");
  await page.keyboard.press("ControlOrMeta+Enter");
  await page.waitForFunction(() => [...document.querySelectorAll("#lightbox-panel-body .cm-text")].some((t) => t.textContent === "Crossed once"),
    null, { timeout: 15000 });
  assert.equal(await mine(), 1, "setup: the refetch brought it");
  const answered = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith(`/api/items/${ents.get("Crossed")}/comments`));
  release();
  await (await answered).finished();
  await frames(page);
  assert.equal(await mine(), 1, "the post's own answer didn't add it a second time");
  assert.deepEqual(page.errors, []);
});

test("on a touch screen, a tap beside a card's count opens the card, not the heart kept faded there", async () => {
  const page = await fresh({ viewport: { width: 820, height: 1180 }, isMobile: true, hasTouch: true });
  await servePixels(page, { thumbnails: true });
  await page.goto(`${app.base}/?board=${boardId}`);
  await page.waitForSelector("#grid .card[data-id]");
  const hearted = [];
  page.on("request", (r) => { if (r.url().endsWith("/favorite")) hearted.push(r.url()); });
  const heart = page.locator(`#grid .card[data-id="${ents.get("Counted")}"] .heart`);
  await heart.scrollIntoViewIfNeeded();
  const box = await heart.boundingBox();
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForSelector("#lightbox:not([hidden])", { timeout: 5000 }).catch(() => {});
  assert.deepEqual([await page.isVisible("#lightbox"), hearted.length], [true, 0], "the tap opened the card, and hearted nothing");
  assert.deepEqual(page.errors, []);
});

test("a count opened from the keyboard has the keyboard back when the lightbox closes", async () => {
  const page = await openBoard();
  await chip(page, "Counted").focus();
  await page.keyboard.press("Enter");
  assert.equal(await onComments(page, "Counted"), true, "setup: open on Comments");
  await page.keyboard.press("Escape"); // the panel
  await panelSettled(page, false);
  await page.keyboard.press("Escape"); // the lightbox
  await page.waitForSelector("#lightbox", { state: "hidden" });
  assert.equal(await page.evaluate((id) => document.activeElement === document.querySelector(`#grid .card[data-id="${id}"] .comment-chip`),
    ents.get("Counted")), true, "back on the count it opened from");
  assert.deepEqual(page.errors, []);
});

test("in List, the names behind a heart wrap inside their box", async () => {
  const page = await openBoard();
  await inView(page, "list");
  const heart = `#grid tr[data-id="${ents.get("Hearted")}"] .heart`;
  await page.hover(heart);
  await page.waitForFunction((s) => document.querySelector(`${s} .heart-pop`)?.textContent.includes("Devon"), heart);
  const pop = await page.evaluate((s) => {
    const el = document.querySelector(`${s} .heart-pop`);
    return { spills: el.scrollWidth - el.clientWidth, width: el.getBoundingClientRect().width };
  }, heart);
  assert.ok(pop.spills <= 1 && pop.width <= 220, `the names fit their box, wrapped (spill ${pop.spills}px, ${pop.width}px wide)`);
  assert.deepEqual(page.errors, []);
});

test("in List, a count with the keyboard on it keeps it when its row moves", async () => {
  // The least recently updated card, so the comment takes its row up past
  // every other: a move Preact makes by moving the row itself, which takes
  // the keyboard off what's in it. One row up, Preact moves its neighbour
  // instead, and the keyboard never leaves.
  const id = ents.get("Moves");
  await app.db.query("UPDATE entities SET updated_at = 1 WHERE id = $1", [id]);
  const page = await fresh();
  await servePixels(page, { thumbnails: true });
  await page.goto(`${app.base}/?board=${boardId}`);
  await page.evaluate((b) => {
    localStorage.setItem(`boardView:${b}`, "list");
    localStorage.setItem(`boardSort:${b}`, JSON.stringify({ by: "updated", dir: "desc" }));
  }, boardId);
  await page.reload();
  await page.waitForSelector("#grid tr[data-id]");
  assert.equal(await page.evaluate(() => [...document.querySelectorAll("#grid tr[data-id]")].pop().dataset.id), String(id),
    "setup: the bottom row");
  await chip(page, "Moves").focus();
  const r = await req(app.base, "POST", `/api/items/${id}/comments`, { sid: sam.sid, body: { body: "Moved it." } });
  assert.equal(r.status, 200, "setup: Sam commented");
  await page.waitForFunction((id) => document.querySelector("#grid tr[data-id]").dataset.id === String(id), id, { timeout: 15000 });
  await frames(page);
  assert.equal(await page.evaluate((id) => document.activeElement === document.querySelector(`#grid tr[data-id="${id}"] .comment-chip`), id), true,
    "the row went to the top, and the keyboard went with it");
  assert.deepEqual(page.errors, []);
});
