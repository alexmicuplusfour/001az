// The Add plugin modal in a real browser (planning/plugin-contract-plan.md,
// Stage 4). plugin-modal.test.js drives the config modal; nothing drove this
// one. The image's example plugins are listed after the app's own and tagged
// as examples — and must stay so once added, when an example stops being a
// bundled row and becomes an ordinary catalog entry: its row moves up into the
// payload's AI section, and its tag would otherwise name whatever role it
// serves.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { adminSession } from "../helpers.js";
import { setPassword } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

let app, admin;

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one — /api/me says
  // needs_password and the page bounces to /login.html before rendering.
  await setPassword(app.db, admin.id, await hashPassword("plugin-add-pw"));
});

after(async () => {
  await app?.close();
});

// /admin#plugins → Add plugin. A fresh page per call: the list is drawn from
// the server's payload, so every read starts from a clean render.
async function openAdd() {
  const page = await app.open("/admin#plugins", { sid: admin.sid });
  await page.locator(".plugin-add button").click();
  await page.locator(".modal-dialog .pa-row").first().waitFor();
  return page;
}

const rowsOf = (page) =>
  page.locator(".modal-dialog .pa-row").evaluateAll((rows) => rows.map((r) => ({
    label: r.querySelector(".p-label").textContent,
    tag: r.querySelector(".p-tag").textContent,
    added: r.querySelector("button").textContent === "Added",
  })));

test("the examples come last, tagged as examples — and stay so once one is added", async () => {
  let page = await openAdd();
  let rows = await rowsOf(page);
  // By tag, not by position: which example the image lists first is the
  // directory's order, which the filesystem decides.
  assert.deepEqual(rows.filter((r) => r.tag === "AI · example").map((r) => r.label).sort(), ["DeepSeek", "Ollama"],
    "both examples, and only they, wear the tag");
  assert.deepEqual(rows.slice(-2).map((r) => r.tag), ["AI · example", "AI · example"], "after every row of the app's own");

  await page.locator(".modal-dialog .pa-row", { hasText: "Ollama" }).locator("button").click();
  await page.locator(".modal-dialog .pa-row", { hasText: "Ollama" }).locator("button:text-is('Added')").waitFor();

  page = await openAdd();
  rows = await rowsOf(page);
  assert.deepEqual(rows.slice(-2).map((r) => [r.label, r.tag, r.added]).sort(),
    [["DeepSeek", "AI · example", false], ["Ollama", "AI · example", true]],
    "added, it is the same example: still tagged, still last");
  // …and the card it became on the page underneath says so too.
  assert.equal(await page.locator(".plugin-row", { hasText: "Ollama" }).locator(".p-tag").textContent(), "AI · example");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});
