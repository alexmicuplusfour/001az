// The whole point, in a real browser: a change someone ELSE made shows up on a
// page that is already open, without a reload
// (planning/board-events-stage-1.md).
//
// This is the only test that proves it. Everything in test/events.test.js is the
// server's half — the frame goes out, to the right people. What cannot be
// asserted anywhere else is that a live page, with its delta poll correctly
// stopped because the board is settled, hears the frame and repaints.
//
// The change is made with `fetch` from node rather than a second browser page
// deliberately: a second page costs another Chromium context for no extra claim,
// and what is under test is "a change this tab did not make" — which a plain
// HTTP request is.
//
// The observable is the heart control APPEARING. grid.js:521 only attaches one
// when `hearts > 0 || favoritedByMe`, so an unhearted card has no `.heart` node
// at all — which makes its arrival unambiguous in a way a changing number is
// not. (Deletion would be the other obvious candidate and is the wrong one: the
// ghost sweep in reconcile() requires a SECOND consecutive absence before it
// drops a card, so one event could never be enough.)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { adminSession, callTool } from "../helpers.js";
import { setPassword, createBoard, createEntity, insertItem, setSetting, setMcpToken } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

let app, admin, boardId;

// A card on a board with NO outstanding work — which is the only state in which
// this test means anything, and is not what a plain seed gives you.
//
// A `tagged` item with no embedding is in the embed lane (db.js
// `needsEmbeddingSql`), so `work.queued` is non-empty, so pollDelay() returns
// 30000 and the delta poll never stops. The worker does not run in tests, so
// nothing ever drains it. Stamping embed_error is what a real instance without
// an embedder ends up with, and it takes the item out of the lane: measured,
// work goes from {queued:[{kind:"embed"}]} to {queued:[]}.
const seedCard = async (identity) => {
  const id = await createEntity(app.db, boardId, { identity });
  const itemId = await insertItem(app.db, boardId, { identity, files: [], fields: {} }, "tagged", id);
  await app.db.query("UPDATE items SET embed_error='no embedder in tests' WHERE id=$1", [itemId]);
  return id;
};

const heart = (entityId) =>
  fetch(`${app.base}/api/items/${entityId}/favorite`, {
    method: "POST",
    headers: { Cookie: `sid=${admin.sid}` },
  });

const heartsOnScreen = (page) =>
  page.evaluate(() => document.querySelectorAll(".card .heart").length);

// Wait until the page has genuinely stopped fetching items, and prove it by
// watching the wire.
//
// This is load-bearing, not hygiene. `ensurePolling()` runs at boot and arms a
// 4s tick before the board's work state is fully known, so for several seconds
// after load there is a delta fetch in flight that will pick up ANY change —
// measured: with the event channel disabled entirely, a heart still landed on
// screen at +1890ms. A test that acts inside that window passes with the feature
// removed, which is exactly what the first version of this file did.
//
// Returns once no /api/items request has been seen for `quietMs`.
async function waitForPollToStop(page, { quietMs = 2500, timeoutMs = 20000 } = {}) {
  let last = Date.now();
  const onReq = (r) => { if (r.url().includes("/api/items")) last = Date.now(); };
  page.on("request", onReq);
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (Date.now() - last >= quietMs) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("the item poll never went quiet — this board is not settled");
  } finally {
    page.off("request", onReq);
  }
}

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  await setPassword(app.db, admin.id, await hashPassword("events-pw"));
  boardId = await createBoard(app.db, "Live board", [], "");
});
after(() => app?.close());

test("someone else's heart lands on an open page, with no reload", async () => {
  const entityId = await seedCard("arrives");
  const page = await app.open(`/?board=${boardId}`, { sid: admin.sid });
  await page.waitForSelector(".card");

  // The board must be SETTLED — the delta poll actually stopped — or the poll
  // explains the result and this test proves nothing. Verified on the wire, not
  // inferred from card classes: see waitForPollToStop.
  await waitForPollToStop(page);
  assert.equal(await heartsOnScreen(page), 0);

  // Somebody else, over HTTP, exactly as another member's browser would.
  assert.equal((await heart(entityId)).status, 200);

  // No reload, no click, no poll. The only thing that can move this is the event.
  await page.waitForFunction(
    () => document.querySelector(".card .heart .hc")?.textContent === "1",
    undefined,
    { timeout: 6000 }
  );

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a hidden tab drops its stream, and catches up when it comes back", async () => {
  // Two claims on one page load, because page loads are the expensive thing.
  //
  // The stream is dropped while hidden because a browser allows six connections
  // per ORIGIN across all tabs and a stream holds one for its whole life — on
  // plain HTTP/1.1 a few background tabs would starve the thumbnails. Dropping
  // it would be a bug on its own, though: what makes it safe is `onopen`
  // refetching, so returning catches up on whatever was missed.
  const entityId = await seedCard("while-away");
  await heart(entityId); // starts hearted, so the change to watch for is it going away

  const page = await app.open(`/?board=${boardId}`, { sid: admin.sid });
  await page.waitForSelector(".card .heart");
  await waitForPollToStop(page);
  const before = await heartsOnScreen(page);
  assert.ok(before > 0, "the card should start hearted");

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  // Unhearted while the tab was away: the event has nowhere to land.
  await heart(entityId);

  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });

  await page.waitForFunction(
    (n) => document.querySelectorAll(".card .heart").length < n,
    before,
    { timeout: 6000 }
  );

  assert.deepEqual(page.errors, []);
});

// The complaint this whole arc started from: an agent saves a crate over MCP
// while a person has the gallery open, and nothing happens until they reload.
//
// The Crates button is the thing to watch because it is gated on
// state.crates.length (toolbar.js:619) — a board's FIRST crate makes a control
// appear, which is why the crate LIST is its own slice and not something the
// cards' payload could carry.
test("an agent saving a crate surfaces the Crates button, live", async () => {
  const entityId = await seedCard("for-the-agent");
  await setSetting(app.db, "mcp_enabled", "1");
  // The token belongs to a PERSON now (planning/mcp-members-plan.md §3), so the
  // agent connects as one — the admin here, which is whose gallery is open
  // below and therefore whose crate has to appear in it.
  await setMcpToken(app.db, admin.id, "browser-test-token");

  const page = await app.open(`/?board=${boardId}`, { sid: admin.sid });
  await page.waitForSelector(".card");
  await waitForPollToStop(page);

  // No crates yet, so no button. This is the state an operator is actually in.
  assert.equal(await page.evaluate(() => document.querySelectorAll(".crates-btn").length), 0);

  const { result } = await callTool(app.base, "save_to_crate", {
    board: boardId,
    crate: "Agent's picks",
    ids: [entityId],
  }, { token: "browser-test-token" });
  assert.equal(result.isError, undefined, JSON.stringify(result));

  // The button appears without a reload — which needs BOTH events: `crates` for
  // the list that gates it, and `items` for the membership that makes it filter
  // to something rather than to nothing.
  await page.waitForFunction(
    () => document.querySelectorAll(".crates-btn").length === 1,
    undefined,
    { timeout: 6000 }
  );

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
