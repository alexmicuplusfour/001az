// The App-defaults modal in a real browser (plugin-modal-drawer-plan.md,
// stage 4). The arc moved every choice out of the modal body and into drawer
// tasks whose whole behavior — arming, placeholders, fact lines, Esc
// layering, in-place status flips — only exists rendered. The node suite
// pins the PLANS (capability-present.test.js); this file proves the
// mounting: that clicking actually stages, commits actually flip the row,
// and dismissal actually posts nothing. Fake keys throughout — the bind
// route validates against DECLARED catalogs, never the wire, so promotes
// succeed while probes would not (none are clicked here).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { adminSession } from "../helpers.js";
import { setPassword, setPluginState } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

let app, admin, savedEnv;

before(async () => {
  // The env rung (ANTHROPIC_API_KEY) must not leak in from the dev shell —
  // it would turn the guard and no-default states below into active ones.
  savedEnv = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one — /api/me says
  // needs_password and the page bounces to /login.html before rendering.
  await setPassword(app.db, admin.id, await hashPassword("plugin-modal-pw"));
  await setPluginState(app.db, "ai:openai", { installed: true });
});

after(async () => {
  await app?.close();
  if (savedEnv !== undefined) process.env.ANTHROPIC_API_KEY = savedEnv;
});

// /admin#plugins → the provider's gear → the modal. A fresh page per call:
// state lives server-side, so every test asserts from a clean render.
async function openModal(label) {
  const page = await app.open("/admin#plugins", { sid: admin.sid });
  await page.locator(`.gear[title="Configure ${label}"]`).click();
  await page.locator(".modal-dialog").waitFor();
  return page;
}

const row = (page, name) => page.locator(`.tile:has(.tile-name:text-is("${name}"))`);
const sum = (page, name) => row(page, name).locator(".tile-sum");
const sumHas = (page, name, text) => sum(page, name).filter({ hasText: text });
const group = (page, label) => page.locator(`.drawer-body .dw-group:has(.dw-label:text-is("${label}"))`);
const drawerPrimary = (page) => page.locator(".drawer-foot button:not(.ghost)");
// The first real option — skipping the placeholder and, when given,
// `not` — read at runtime so no catalog id is hardcoded here.
const firstReal = (sel, not = null) =>
  sel.evaluate((s, x) => [...s.options].find((o) => !o.disabled && o.value && o.value !== x)?.value, not);

test("no keys: every keyed row is a guard with zero acts", async () => {
  const page = await openModal("OpenAI");
  await page.locator('h2:text-is("App defaults")').waitFor();
  assert.match(await sum(page, "Tagging").textContent(), /^Add a key above to serve tagging/);
  assert.equal(await row(page, "Tagging").locator(".tile-actions button").count(), 0);
  assert.deepEqual(page.errors, []);
});

test("Add key…: the drawer gates until name + key, then the row lands", async () => {
  const page = await openModal("OpenAI");
  await page.getByRole("button", { name: "Add key…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const primary = drawerPrimary(page);
  assert.equal(await primary.textContent(), "Add key");
  assert.equal(await primary.isDisabled(), true, "nothing typed yet");
  await group(page, "Name").locator("input").fill("Personal");
  assert.equal(await primary.isDisabled(), true, "a keyed provider needs the secret too");
  await group(page, "Key").locator("input").fill("sk-test-not-real");
  await primary.click();
  await page.locator(".drawer.open").waitFor({ state: "hidden" });
  await page.locator(".modal-dialog tbody tr:has-text('Personal')").waitFor();
  assert.deepEqual(page.errors, []);
});

test("one key: the drawer states it as a fact; the placeholder gates; the promote flips the row", async () => {
  const page = await openModal("OpenAI");
  assert.equal((await sum(page, "Tagging").textContent()).trim(), "No app default yet");
  // extract, unbound, reports its delegation — not a default of its own
  assert.match(await sum(page, "Field extraction").textContent(), /Follows each board's tagger/);
  await row(page, "Tagging").getByRole("button", { name: "Make default…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  // one row asks no question: a stated fact, not a select
  assert.equal(await group(page, "Key").locator("select").count(), 0);
  assert.match(await group(page, "Key").textContent(), /Personal/);
  const primary = drawerPrimary(page);
  assert.equal(await primary.textContent(), "Make default tagger");
  assert.equal(await primary.isDisabled(), true, "the model placeholder is not an answer");
  const modelSel = group(page, "Model").locator("select");
  await modelSel.selectOption(await firstReal(modelSel));
  await primary.click();
  await page.locator(".drawer.open").waitFor({ state: "hidden" });
  await sumHas(page, "Tagging", "App default —").waitFor();
  assert.match(await sum(page, "Tagging").textContent(), /^App default — "Personal" key · /);
  // …and the key row wears the role
  await page.locator('.modal-dialog .badge:text-is("default tagger")').waitFor();
  assert.deepEqual(page.errors, []);
});

test("Change…: opens prefilled and disarmed; an edit arms (requiresChange)", async () => {
  const page = await openModal("OpenAI");
  await row(page, "Tagging").getByRole("button", { name: "Change…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const primary = drawerPrimary(page);
  assert.equal(await primary.textContent(), "Save changes");
  assert.equal(await primary.isDisabled(), true, "unchanged = nothing to save");
  const modelSel = group(page, "Model").locator("select");
  const saved = await modelSel.inputValue();
  assert.ok(saved, "the saved model prefills, not the placeholder");
  await modelSel.selectOption(await firstReal(modelSel, saved));
  assert.equal(await primary.isDisabled(), false);
  await page.locator(".drawer-foot button.ghost").click(); // Cancel — stage nothing
  await page.locator(".drawer.open").waitFor({ state: "hidden" });
});

test("Esc mid-draft dismisses the task, not the modal, and posts nothing", async () => {
  const page = await openModal("OpenAI");
  const before = await sum(page, "Tagging").textContent();
  await row(page, "Tagging").getByRole("button", { name: "Change…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const modelSel = group(page, "Model").locator("select");
  await modelSel.selectOption(await firstReal(modelSel, await modelSel.inputValue()));
  await page.keyboard.press("Escape");
  await page.locator(".drawer.open").waitFor({ state: "hidden" });
  await page.locator(".modal-dialog").waitFor(); // still up — the drawer captured the press
  assert.equal(await sum(page, "Tagging").textContent(), before);
  assert.deepEqual(page.errors, []);
});

test("embed: elect via drawer; Turn off keeps the binding; the off drawer opens armed and re-elects", async () => {
  const page = await openModal("OpenAI");
  await row(page, "Semantic search").getByRole("button", { name: "Make default…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const modelSel = group(page, "Model").locator("select");
  const model = await firstReal(modelSel);
  await modelSel.selectOption(model);
  await drawerPrimary(page).click();
  await sumHas(page, "Semantic search", "App default —").waitFor();
  // the serving card's acts, in planSection's order, then the open button
  assert.deepEqual(await row(page, "Semantic search").locator(".tile-actions button").allTextContents(),
    ["Test", "Turn off", "Use the built-in embeddings instead", "Change…"]);
  await row(page, "Semantic search").getByRole("button", { name: "Turn off", exact: true }).click();
  await sumHas(page, "Semantic search", "Off — binding kept").waitFor();
  assert.ok((await sum(page, "Semantic search").textContent())
    .startsWith(`Off — binding kept ("Personal" key · ${model})`));
  await row(page, "Semantic search").getByRole("button", { name: "Change…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const primary = drawerPrimary(page);
  assert.equal(await primary.textContent(), "Make default embedder");
  assert.equal(await primary.isDisabled(), false, "the unchanged re-post IS the act — enabled:true rides it");
  await primary.click();
  await sumHas(page, "Semantic search", "App default —").waitFor();
  assert.deepEqual(page.errors, []);
});

test("the re-embed warning live-syncs with the picked model", async () => {
  const page = await openModal("OpenAI");
  await row(page, "Semantic search").getByRole("button", { name: "Change…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const warn = page.locator(".drawer-body .warn-box");
  assert.equal(await warn.isVisible(), false, "the saved model warns about nothing");
  const modelSel = group(page, "Model").locator("select");
  const saved = await modelSel.inputValue();
  await modelSel.selectOption(await firstReal(modelSel, saved));
  assert.equal(await warn.isVisible(), true);
  assert.match(await warn.textContent(), /re-embeds every item/);
  await modelSel.selectOption(saved);
  assert.equal(await warn.isVisible(), false);
  await page.locator(".drawer-foot button.ghost").click();
});

test("a choiceless promote is one click — no drawer rises", async () => {
  const page = await openModal("Local Transcriber (Whisper)");
  await row(page, "Transcription").getByRole("button", { name: "Make default transcriber", exact: true }).click();
  await page.locator('.toast:has-text("Default transcriber saved")').waitFor();
  assert.equal(await page.locator(".drawer.open").count(), 0);
  assert.deepEqual(page.errors, []);
});

test("edit…: opens armed, retitles live, and a blank secret keeps the stored one", async () => {
  const page = await openModal("OpenAI");
  const hintBefore = await page.locator(".modal-dialog tbody tr:has-text('Personal') td").nth(1).textContent();
  await page.getByRole("button", { name: "edit…", exact: true }).click();
  await page.locator(".drawer.open").waitFor();
  const nameIn = group(page, "Name").locator("input");
  assert.equal(await nameIn.inputValue(), "Personal");
  assert.equal(await group(page, "Key").locator("input").getAttribute("placeholder"),
    "•••• stored — leave blank to keep");
  const primary = drawerPrimary(page);
  assert.equal(await primary.textContent(), "Save changes");
  assert.equal(await primary.isDisabled(), false, "an edit opens armed — the name is real");
  await nameIn.fill("");
  assert.equal(await primary.isDisabled(), true, "a nameless row is not a row");
  await nameIn.fill("Work");
  assert.equal(await page.locator(".drawer-title").textContent(), "Work", "the head follows the rename live");
  await primary.click();
  await page.locator(".modal-dialog tbody tr:has-text('Work')").waitFor();
  assert.equal(await page.locator(".modal-dialog tbody tr:has-text('Work') td").nth(1).textContent(), hintBefore,
    "blank secret = the stored key survives");
  // the role badges ride the row id through the rename
  await page.locator('tbody tr:has-text("Work") .badge:text-is("default tagger")').waitFor();
  assert.deepEqual(page.errors, []);
});

test("remove: the consequence-confirm names the roles, then the guard returns", async () => {
  const page = await openModal("OpenAI");
  let confirmMsg = null;
  page.once("dialog", (d) => { confirmMsg = d.message(); return d.accept(); });
  await page.getByRole("button", { name: "remove", exact: true }).click();
  await sumHas(page, "Tagging", "Add a key above").waitFor();
  assert.match(confirmMsg, /default tagger/);
  assert.match(confirmMsg, /default embedder/);
  assert.equal(await page.locator(".modal-dialog tbody tr").count(), 0);
  assert.deepEqual(page.errors, []);
});
