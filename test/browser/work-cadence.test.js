// The jobs chip over an embed backlog, in a real browser against the real
// server (planning/embed-work-plan.md Stage 1).
//
// The bug: a tag lands, the next check finds its embedding still due and
// nothing running, and the page drops to checking every 30s. The embedding
// lands a few seconds later (the sweep polls every 3s), but the chip keeps
// counting it until that 30s
// check. In the real app it happens on some runs and not others, because it
// depends on where the 4s check falls. Here it happens every time: the suite
// runs no worker, so a tagged card with no vector stays due until the test
// writes the vector itself.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { adminSession, seedInstance } from "../helpers.js";
import { setPassword, createBoard, setItemEmbedding, addJobLog } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";
import { resolveEmbedder } from "../../server/worker.js";

let app, admin, boardId;

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  await setPassword(app.db, admin.id, await hashPassword("cadence-pw"));
  boardId = await createBoard(app.db, "Cadence board", [], "");
});
after(() => app?.close());

// `message` is a function so it reads the state at the timeout, not at the call.
async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(message());
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("an embed backlog is checked every 4s, and the chip clears one check after the vector lands", async () => {
  const embedder = await resolveEmbedder(app.db);
  assert.ok(embedder, "precondition: the test server serves the embed lane, or there is no backlog to watch");
  const { id: itemId } = await seedInstance(app.db, boardId, "tagged"); // due to embed

  const page = await app.open(`/?board=${boardId}`, { sid: admin.sid });
  const checks = []; // when each delta poll went out
  page.on("request", (r) => { if (/\/api\/items\?.*since=/.test(r.url())) checks.push(Date.now()); });
  await page.waitForSelector(".card");
  await page.waitForSelector(".jobs-chip.busy");
  assert.equal(await page.textContent(".jobs-chip .jobs-chip-count"), "1", "the chip counts the card waiting to embed");

  // The rate the page follows the backlog at is the gap between two checks.
  // Boot arms the first at 4s whatever the work is, so the gap after it shows
  // the rate. Measured: 3.7s then 7.8s with the fix, 3.7s then 33.8s without.
  await waitFor(() => checks.length >= 2, 14000,
    () => `only ${checks.length} check(s) in 14s with just an embed waiting — the page fell back to the 30s rate`);
  const gap = checks[1] - checks[0];
  // 10s, not 6: the claim is 4s against 30s, and CI runs eight files at once.
  assert.ok(gap < 10000, `checked ${gap}ms apart with just an embed waiting; expected about 4000`);

  // The embedding lands, written the way the worker writes it, and the chip
  // goes dark within one check.
  await setItemEmbedding(app.db, itemId, new Float32Array([1, 0]), embedder.model);
  const landed = Date.now();
  await page.waitForSelector(".jobs-chip:not(.busy)", { timeout: 10000 });
  const cleared = Date.now() - landed;
  assert.ok(cleared < 10000, `the chip kept counting ${cleared}ms after the embedding landed`);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a running embed batch counts as its items on the chip, and the log shows it running and in History", async () => {
  // planning/embed-work-plan.md Stage 2, rendered by the real page off the real
  // payload. The rows are written the way embedGroup writes them; no worker
  // runs here, so nothing moves while the test reads.
  const board = await createBoard(app.db, "Embed log board", [], "");
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await seedInstance(app.db, board, "tagged")).id);
  // A batch in the air holding the first two; the third is still waiting.
  await addJobLog(app.db, { boardId: board, kind: "embed", detail: { items: 2, item_ids: [ids[0], ids[1]] }, startedAt: Date.now() - 1500 });
  // Two settled batches: one item, named by its file; five, with one skipped.
  const t = Date.now() - 60000;
  const engine = "local:Xenova/bge-small-en-v1.5";
  await addJobLog(app.db, { boardId: board, kind: "embed", target: "only.png", outcome: "ok",
    detail: { items: 1, embedded: 1, engine }, startedAt: t, endedAt: t + 6 });
  await addJobLog(app.db, { boardId: board, kind: "embed", outcome: "ok",
    detail: { items: 5, embedded: 4, skipped: 1, engine }, startedAt: t - 1000, endedAt: t - 500 });

  const page = await app.open(`/?board=${board}`, { sid: admin.sid });
  await page.waitForSelector(".jobs-chip.busy");
  assert.equal(await page.textContent(".jobs-chip .jobs-chip-count"), "3", "two running in the batch + one waiting");
  assert.match(await page.getAttribute(".jobs-chip", "title"), /Embedding: 2 running, 1 waiting/);

  await page.click(".jobs-chip");
  await page.waitForSelector(".jobs-list .job-row.job-running");
  await page.waitForSelector(".jobs-list .job-row:not(.job-running)");
  const { live, notes, history, pills } = await page.evaluate(() => {
    const [liveList, histList] = document.querySelectorAll(".jobs-list");
    const texts = (row) => [...row.children].map((c) => c.textContent);
    return {
      live: [...liveList.querySelectorAll(".job-row")].map(texts),
      notes: [...liveList.querySelectorAll(".jobs-note")].map((n) => n.textContent),
      history: [...histList.querySelectorAll(".job-row")].map(texts),
      pills: document.querySelector(".jobs-filters")?.textContent || "",
    };
  });
  assert.equal(live.length, 1);
  assert.deepEqual(live[0].slice(0, 3), ["Embedding", "2 items", "embedding"], "the batch, running, named by its count");
  assert.deepEqual(notes, ["1 waiting — Embedding"], "only the third item waits");
  assert.deepEqual(history.map((r) => r.slice(0, 4)), [
    ["Embedding", "only.png", "done", ""],
    ["Embedding", "5 items", "done", "1 skipped"],
  ]);
  assert.match(pills, /Embedding/, "History gets an Embedding pill");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
