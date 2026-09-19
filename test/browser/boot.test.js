// Every page, loaded for real, must come up without throwing. Cheap to write
// and it covers a class no assertion names: a typo in an import, a module that
// reaches for an element that got renamed, a dead call in a render path. Those
// throw in the browser and stop the rest of the page dead, while the Node
// tests — which import modules one at a time against a fake document — never
// see them.
//
// If one of these starts failing, read the error text: it's the real exception,
// with the real file and line.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { createBoard, setBoardMembers } from "../../server/db.js";

let app, session;
before(async () => {
  app = await openApp();
  session = await app.signIn({ email: "boot@test.local", boardName: "Boot board" });
});
after(() => app?.close());

const PAGES = [
  { name: "a board", url: () => `/?board=${session.boardId}`, ready: ".tool-btn.upload" },
  { name: "the boards page", url: () => "/boards", ready: ".toolbar-logo" },
];

for (const p of PAGES) {
  test(`${p.name} loads clean`, async () => {
    const page = await app.open(p.url(), { sid: session.user.sid });
    await page.locator(p.ready).waitFor({ timeout: 15000 });
    assert.deepEqual(page.errors, [], `${p.name} threw while loading`);
    // A signed-in member's page should ask for nothing it isn't allowed to
    // have — a stray 404 here is a missing asset or a dead route.
    assert.deepEqual(page.failures, [], `${p.name} made a request that failed`);
  });
}

test("a signed-out visitor is sent to login, not left on a broken page", async () => {
  const page = await app.open(`/?board=${session.boardId}`); // no cookie
  await page.waitForURL(/login/, { timeout: 15000 });
  // The 401s on the way there are the right answer, so only JS errors matter.
  assert.deepEqual(page.errors, []);
  assert.ok(page.failures.every((f) => f.status === 401), `unexpected failures: ${JSON.stringify(page.failures)}`);
});

// The landing rule — arriving with no ?board=. Worth its own coverage twice
// over: it is where every sign-in lands (login.js) and where the "Gallery"
// back-link on the admin and account pages goes, and until now nothing
// exercised it at all — every test above opens a board, a page, or login
// directly. planning/app-loading-plan.md, Stage 3.
test("landing on / adopts a board without a second page load", async () => {
  const page = await app.open(`/?board=${session.boardId}`, { sid: session.user.sid });
  await page.locator(".tool-btn.upload").waitFor({ timeout: 15000 });

  // Count real document fetches, not framenavigated: replaceState fires that
  // event too, and the whole point of this stage is that it replaces a
  // navigation. A document request is the thing that costs.
  const docs = [];
  page.on("request", (r) => {
    if (r.resourceType() === "document") docs.push(new URL(r.url()).pathname);
  });

  await page.evaluate(() => { location.href = "/"; });
  await page.waitForURL(/\?board=/, { timeout: 15000 });
  await page.locator(".tool-btn.upload").waitFor({ timeout: 15000 });

  assert.equal(docs.length, 1, `landing on / cost ${docs.length} document loads (${docs.join(" -> ")})`);
  assert.match(page.url(), new RegExp(`board=${session.boardId}`));
  assert.deepEqual(page.errors, [], "landing on / threw");
});

test("landing on / returns to the board last opened, not the first one", async () => {
  const second = await createBoard(app.db, "Second board", [], "", true, null, null, { enabled: false });
  await setBoardMembers(app.db, second, [session.user.id]);

  const page = await app.open(`/?board=${second}`, { sid: session.user.sid });
  await page.locator(".tool-btn.upload").waitFor({ timeout: 15000 });

  // Teeth: the fallback is the first accessible board, so this only proves
  // anything while the board we just opened is NOT that one.
  const first = await page.evaluate(async () => (await (await fetch("/api/boards")).json())[0]?.id);
  assert.notEqual(first, second, "fixture no longer distinguishes last-opened from first");

  await page.evaluate(() => { location.href = "/"; });
  await page.waitForURL(/\?board=/, { timeout: 15000 });
  assert.match(page.url(), new RegExp(`board=${second}`), `expected the last-opened board, got ${page.url()}`);
  assert.deepEqual(page.errors, []);
});

// The lazy modal door (planning/app-loading-plan.md, Stage 2). The toolbar's
// modals are no longer in the boot payload — they arrive on the click that
// opens them — and nothing else here would notice if that chunk stopped
// resolving: the page would load perfectly and the button would do nothing.
test("a toolbar modal still opens, now that its code arrives on the click", async () => {
  const page = await app.open(`/?board=${session.boardId}`, { sid: session.user.sid });
  await page.locator(".jobs-chip").waitFor({ timeout: 15000 });

  await page.locator(".jobs-chip").click();
  await page.locator(".modal-overlay .modal-title").waitFor({ timeout: 15000 });
  assert.equal(await page.locator(".modal-overlay .modal-title").first().textContent(), "Jobs");
  assert.deepEqual(page.errors, [], "opening a lazily-loaded modal threw");
});

// A shared ?f= link outliving a value the board has since dropped
// (planning/stale-filters-plan.md). Only a real load orders the three things
// this depends on: the URL is decoded at the top of boot, the board's
// vocabulary lands ~100 lines later, and the gate has to run between that and
// the first paint. Every other test of it calls the function directly, which
// is exactly the ordering a stub can't have wrong.
test("a link naming a value the board dropped loses that filter and keeps the rest", async () => {
  const boardId = await createBoard(app.db, "Filter board",
    [{ key: "color", label: "Colour", values: ["red", "blue"] }], "", true, null, null, { enabled: false });
  await setBoardMembers(app.db, boardId, [session.user.id]);

  const page = await app.open(`/?board=${boardId}&f=color:red,purple`, { sid: session.user.sid });
  await page.locator(".tool-btn.upload").waitFor({ timeout: 15000 });

  const clear = await page.locator(".tool-btn.clear").textContent();
  assert.match(clear, /Clear filters \(1\)/, `red survived and purple didn't — got "${clear}"`);
  assert.match(await page.locator(".toast-msg").first().textContent(), /Skipped "purple"/);
  // …and the address stops carrying the dead half, so re-sharing the link
  // doesn't pass the problem along.
  assert.ok(!page.url().includes("purple"), `the URL still names it: ${page.url()}`);
  assert.deepEqual(page.errors, [], "the gate threw during boot");
});
