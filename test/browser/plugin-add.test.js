// The Add plugin modal in a real browser (planning/plugin-contract-plan.md,
// Stage 4). plugin-modal.test.js drives the config modal; nothing drove this
// one. The image's example plugins are listed after the app's own and tagged
// as examples — and must stay so once added, when an example stops being a
// bundled row and becomes an ordinary catalog entry: its row moves up into the
// payload's AI section, and its tag would otherwise name whatever role it
// serves.
//
// And its Community tab (community-index-plan.md, Stage 4). The index is a
// jsonBox, and the server's downloads — GitHub's archive, npm's packument and
// tarball — are answered in this process, where the server runs, so an Add
// from the Community tab installs for real with nothing leaving the machine.
//
// And Install from a URL, the footer's drawer: a path on this machine is a
// source the server installs from without the network.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { openApp } from "./harness.js";
import { adminSession, req, jsonBox, tgzOf, npmAnswers } from "../helpers.js";
import { setPassword } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

let app, admin, box, realFetch, indexUrlBefore;

// The listings, and the archives their pins resolve to.
const SHA = "3f2a9c1e7b0d4a5f6c8e9d0b1a2c3d4e5f6a7b8c";
const SHA2 = "9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d";
const fixture = (name, file) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/plugins/${name}/${file}`, import.meta.url)), "utf8");
const withVersion = (name, version) => JSON.stringify({ ...JSON.parse(fixture(name, "manifest.json")), version });
const gecko = (sha = SHA, version = "1.0.0") => ({
  id: "acme.gecko", kind: "connector-provider", domain: "crypto", label: "Acme Gecko", description: "Crypto prices from Acme.",
  author: "acme", version, apiVersion: 1, source: `github:acme/gecko@${sha}`,
});
const brain = {
  id: "acme.model", kind: "ai-provider", label: "Acme AI", description: "Models from Acme.",
  author: "acme", version: "2.0.0", apiVersion: 1, source: "npm:acme-ai@2.0.0",
};
const later = {
  id: "acme.later", kind: "source", label: "Acme Later", description: "For a newer app.",
  author: "acme", version: "3.0.0", apiVersion: 2, source: "npm:acme-later@3.0.0",
};
const index = (...plugins) => ({ apiVersion: 1, plugins });

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one — /api/me says
  // needs_password and the page bounces to /login.html before rendering.
  await setPassword(app.db, admin.id, await hashPassword("plugin-add-pw"));

  box = await jsonBox(index());
  indexUrlBefore = process.env.PLUGIN_INDEX_URL;
  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json"); // read per request
  // GitHub's archive for each pin, its top directory named for the commit as
  // GitHub names one; npm's packument, with the integrity hash the installer
  // checks, and its tarball. Everything else — the index, the app's own
  // calls — goes through.
  const geckoAt = (sha, version) => tgzOf([
    [`acme-gecko-${sha.slice(0, 7)}/manifest.json`, withVersion("acme-gecko", version)],
    [`acme-gecko-${sha.slice(0, 7)}/index.js`, fixture("acme-gecko", "index.js")],
  ]);
  const npmTgz = await tgzOf([["package/manifest.json", withVersion("acme-ai", "2.0.0")], ["package/index.js", fixture("acme-ai", "index.js")]]);
  const answers = {
    [`https://api.github.com/repos/acme/gecko/tarball/${SHA}`]: await geckoAt(SHA, "1.0.0"),
    [`https://api.github.com/repos/acme/gecko/tarball/${SHA2}`]: await geckoAt(SHA2, "1.1.0"),
    ...npmAnswers("acme-ai", "2.0.0", npmTgz),
  };
  realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (answers[String(url)] ? Promise.resolve(new Response(answers[String(url)])) : realFetch(url, opts));
});

after(async () => {
  if (realFetch) globalThis.fetch = realFetch;
  if (indexUrlBefore === undefined) delete process.env.PLUGIN_INDEX_URL;
  else process.env.PLUGIN_INDEX_URL = indexUrlBefore;
  box?.close();
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

// The tab named, clicked.
const tab = (page, name) => page.locator(".modal-dialog .pane-toggle-btn", { hasText: name }).click();

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
  // A switch to Community and back puts the same row back, still "Added".
  await tab(page, "Community");
  await tab(page, "Included");
  assert.equal(await page.locator(".modal-dialog .pa-row", { hasText: "Ollama" }).locator("button").textContent(), "Added");

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

// --- the Community tab (community-index-plan.md, Stage 4) ---

const community = (page) => tab(page, "Community");
const listing = (page, label) => page.locator(".modal-dialog .pa-row", { hasText: label });
// Accept the next confirm, handing back what it asked — within Playwright's
// timeout, so a question that never comes fails the test that waited for it.
const accepting = (page) => page.waitForEvent("dialog").then(async (d) => { await d.accept(); return d.message(); });
const LOCKED = "Installing plugins is turned off on this server";
const NEWER = "Written for plugin API version 2, which this version of the app doesn't run";

test("the tabs are drawn only with the index on, at the top, and Included is the list as before", async () => {
  process.env.PLUGIN_INDEX_URL = "";
  let page = await openAdd();
  assert.equal(await page.locator(".modal-dialog .pane-toggle").count(), 0, "no tabs with the index off");
  const without = (await rowsOf(page)).map((r) => r.label);

  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json");
  page = await openAdd();
  assert.deepEqual(await page.locator(".modal-dialog .pane-toggle-btn").allTextContents(), ["Included", "Community"]);
  assert.equal(await page.locator(".modal-dialog .pane-toggle-btn.active").textContent(), "Included");
  assert.equal(await page.locator(".modal-dialog .modal-body > .pane-toggle:first-child").count(), 1, "the tabs open the dialog");
  assert.deepEqual((await rowsOf(page)).map((r) => r.label), without, "Included is the list as it was");
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Community lists the index; Add installs a listing from its pin after the install warning, and its card prints each part once", async (t) => {
  box.payload = index(gecko(), brain, later);
  // A URL of its own: the server keeps each URL's answer ten minutes, and the
  // first test's switch has already read this box empty.
  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json?listed");
  // Undone however the test ends, so a failure can't leave a plugin installed
  // for the tests after it to trip over.
  t.after(async () => {
    for (const id of ["crypto:acme.gecko", "ai:acme.model"]) await req(app.base, "DELETE", `/api/admin/plugins/${id}`, { sid: admin.sid });
    process.env.PLUGIN_INDEX_URL = box.url("/plugins.json");
  });
  const page = await openAdd();
  await community(page);
  await listing(page, "Acme Gecko").waitFor();
  assert.equal(await page.locator(".modal-dialog .pane-toggle-btn.active").textContent(), "Community", "the tab clicked is the one raised");
  const rows = await page.locator(".modal-dialog .pa-row").evaluateAll((rs) => rs.map((r) => {
    const b = r.querySelector("button");
    return [r.querySelector(".p-label").textContent, r.querySelector(".p-src").textContent, r.querySelector(".p-tag").textContent, b.textContent, b.disabled];
  }));
  assert.deepEqual(rows, [
    ["Acme Gecko", `by acme · 1.0.0 · github:acme/gecko@${SHA}`, "Data · crypto", "Add", false],
    ["Acme AI", "by acme · 2.0.0 · npm:acme-ai@2.0.0", "AI", "Add", false],
    ["Acme Later", "by acme · 3.0.0 · npm:acme-later@3.0.0", "Source · remote", "Needs a newer app", true],
  ]);
  assert.equal(await listing(page, "Acme Later").locator("button").getAttribute("title"), NEWER);

  // Each installs from the source its listing pins — a real download,
  // answered in this process — and the card underneath prints each part of
  // its provenance once: a pin's sha and an npm version already end the source.
  for (const [label, source, provenance] of [
    ["Acme Gecko", `github:acme/gecko@${SHA}`, `github:acme/gecko@${SHA} · 1.0.0`],
    ["Acme AI", "npm:acme-ai@2.0.0", "npm:acme-ai@2.0.0"],
  ]) {
    const asked = accepting(page);
    await listing(page, label).locator("button").click();
    assert.equal((await asked).split("\n\n")[0], `Install ${label} from:\n${source}`);
    await listing(page, label).locator("button:text-is('Added')").waitFor();
    const card = page.locator(".plugin-row", { hasText: label }).locator(".p-src");
    await card.waitFor();
    assert.equal(await card.textContent(), provenance);
  }
  // A switch to Included and back puts the same rows back, still "Added".
  await tab(page, "Included");
  await community(page);
  for (const label of ["Acme Gecko", "Acme AI"])
    assert.equal(await listing(page, label).locator("button").textContent(), "Added", label);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a listing whose pin moved reads Update to its version; updating asks about the new source, keeps the plugin's settings and moves its card", async () => {
  const installed = await req(app.base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: `github:acme/gecko@${SHA}` } });
  assert.equal(installed.status, 200, JSON.stringify(installed.json));
  assert.equal((await req(app.base, "PATCH", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid, body: { config: { rpm: 7 } } })).status, 200);
  // The author moved the pin. The server keeps each URL's answer ten
  // minutes, so a new URL is a fresh read.
  box.payload = index(gecko(SHA2, "1.1.0"));
  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json?moved");
  try {
    const page = await openAdd();
    await community(page);
    const button = listing(page, "Acme Gecko").locator("button:text-is('Update to 1.1.0')");
    await button.waitFor();
    assert.equal(await button.getAttribute("title"), `Installed from github:acme/gecko@${SHA}`);
    const asked = accepting(page);
    await button.click();
    assert.equal((await asked).split("\n\n")[0], `Update Acme Gecko to 1.1.0 from:\ngithub:acme/gecko@${SHA2}`);
    await listing(page, "Acme Gecko").locator("button:text-is('Added')").waitFor();
    const card = page.locator(".plugin-row", { hasText: "Acme Gecko" }).locator(".p-src");
    await card.filter({ hasText: SHA2 }).waitFor();
    assert.equal(await card.textContent(), `github:acme/gecko@${SHA2} · 1.1.0`, "the card moved to the new pin");
    const after = (await req(app.base, "GET", "/api/admin/plugins", { sid: admin.sid })).json.plugins.find((p) => p.id === "crypto:acme.gecko");
    assert.equal(after.state.config.rpm, 7, "its settings stayed");
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.failures, []);
  } finally {
    process.env.PLUGIN_INDEX_URL = box.url("/plugins.json");
    await req(app.base, "DELETE", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid });
  }
});

test("with installs locked, the footer says installing from a URL is off, and a listing's Add and Update are held and say why", async () => {
  assert.equal((await req(app.base, "POST", "/api/admin/plugins/install", { sid: admin.sid, body: { url: `github:acme/gecko@${SHA}` } })).status, 200);
  box.payload = index(gecko(SHA2, "1.1.0"), brain, later);
  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json?locked");
  process.env.PLUGIN_INSTALL_DISABLE = "1";
  try {
    const page = await openAdd();
    await community(page);
    await listing(page, "Acme Later").waitFor();
    assert.deepEqual(await page.locator(".modal-dialog .pa-row button").evaluateAll((bs) => bs.map((b) => [b.textContent, b.disabled, b.title])), [
      ["Update to 1.1.0", true, LOCKED],
      ["Add", true, LOCKED],
      ["Needs a newer app", true, NEWER],
    ]);
    // In words, where a held button could say it only on hover.
    assert.equal(await page.locator(".modal-dialog .modal-footer").textContent(),
      "Installing plugins from a URL, a package or a path is turned off on this server.");
    assert.deepEqual(page.errors, []);
  } finally {
    delete process.env.PLUGIN_INSTALL_DISABLE;
    process.env.PLUGIN_INDEX_URL = box.url("/plugins.json");
    await req(app.base, "DELETE", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid });
  }
});

test("the list's states: none listed, a failure with nothing to show, and rows gone stale behind a failed refresh", async () => {
  box.payload = index();
  process.env.PLUGIN_INDEX_URL = box.url("/plugins.json?empty");
  try {
    let page = await openAdd();
    await community(page);
    await page.locator(".modal-dialog .pa-empty", { hasText: "None listed yet" }).waitFor();
    // The dialog keeps its floor: an empty tab used to fold it to the tabs
    // and this one line.
    assert.ok((await page.locator(".modal-dialog").boundingBox()).height >= 500, "the empty tab keeps the dialog's height");

    // Failed: nothing answers at the index's address, and there is no
    // earlier answer to show.
    const gone = await jsonBox({});
    const goneUrl = gone.url("/plugins.json");
    await new Promise((r) => gone.close(r));
    process.env.PLUGIN_INDEX_URL = goneUrl;
    page = await openAdd();
    await community(page);
    const failed = page.locator(".modal-dialog .pa-empty.p-err");
    await failed.waitFor();
    assert.equal(await failed.textContent(), `Couldn't read the community list: the plugin index: ECONNREFUSED — ${goneUrl}`);

    // Stale: the server gets there only after ten real minutes, so this one
    // answer is handed to the page — a real one, marked stale. The server's
    // side of it is plugin-index.test.js's.
    box.payload = index(gecko());
    process.env.PLUGIN_INDEX_URL = box.url("/plugins.json?stale");
    const real = (await req(app.base, "GET", "/api/admin/plugins/community", { sid: admin.sid })).json;
    page = await openAdd();
    await page.route("**/api/admin/plugins/community", (route) => route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ ...real, fetchedAt: Date.now() - 12 * 60000, stale: true, error: "HTTP 500 from http://index.test/plugins.json" }),
    }));
    await community(page);
    await listing(page, "Acme Gecko").waitFor();
    assert.equal(await page.locator(".modal-dialog .p-err").textContent(),
      "Fetched 12m ago; the refresh failed: HTTP 500 from http://index.test/plugins.json");
    assert.deepEqual(page.errors, []);
    assert.deepEqual(page.failures, []);
  } finally {
    process.env.PLUGIN_INDEX_URL = box.url("/plugins.json");
  }
});

// --- Install from a URL: the footer's drawer ---

test("Install from a URL opens a drawer: Install waits for a source, Enter asks the install question, a failure stays in the drawer with its source, and an install closes the dialog", async (t) => {
  t.after(() => req(app.base, "DELETE", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid }));
  const page = await openAdd();
  await page.locator(".modal-dialog .modal-footer button", { hasText: "Install from a URL" }).click();
  const drawer = page.locator(".drawer.open");
  const input = drawer.locator("input");
  const install = drawer.locator(".drawer-foot button", { hasText: "Install" });
  await drawer.waitFor();
  assert.ok(await install.isDisabled(), "nothing to install yet");

  await input.fill("/no/such/plugin");
  assert.ok(await install.isEnabled(), "a source arms it");
  let asked = accepting(page);
  await input.press("Enter");
  assert.equal((await asked).split("\n\n")[0], "Install a plugin from:\n/no/such/plugin");
  await drawer.locator(".pa-install-err", { hasText: "local plugin path not found" }).waitFor();
  assert.equal(await input.inputValue(), "/no/such/plugin", "the source stays, to be fixed");
  assert.ok(await input.evaluate((el) => el === document.activeElement), "with the cursor in it");

  // A directory on this machine: the server installs it without the network.
  await input.fill(fileURLToPath(new URL("../fixtures/plugins/acme-gecko", import.meta.url)));
  asked = accepting(page);
  await install.click();
  await asked;
  await page.locator(".modal-overlay").waitFor({ state: "detached" });
  await page.locator(".plugin-row", { hasText: "Acme Gecko" }).waitFor();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, [{ status: 400, url: "/api/admin/plugins/install" }], "the missing path, and nothing else");
});

test("an install outlives its drawer: the footer holds until it ends, the end arrives as a toast, and a success leaves the dialog open", async (t) => {
  // An archive whose download waits for the test, so the install is still
  // running when the drawer — or the whole dialog — goes.
  const good = await tgzOf([["acme-gecko/manifest.json", withVersion("acme-gecko", "1.0.0")], ["acme-gecko/index.js", fixture("acme-gecko", "index.js")]]);
  const inner = globalThis.fetch;
  let held, release;
  globalThis.fetch = (url, opts) => (String(url).startsWith("https://held.test/")
    ? held.then(() => new Response(String(url).endsWith("good.tgz") ? good : "not an archive"))
    : inner(url, opts));
  t.after(async () => {
    globalThis.fetch = inner;
    await req(app.base, "DELETE", "/api/admin/plugins/crypto:acme.gecko", { sid: admin.sid });
  });
  // Install `source` from the footer's drawer, up to the moment it's running.
  const start = async (page, source) => {
    held = new Promise((r) => { release = r; });
    await page.locator(".modal-dialog .modal-footer button").click();
    const drawer = page.locator(".drawer.open");
    await drawer.locator("input").fill(source);
    const asked = accepting(page);
    await drawer.locator(".drawer-foot button", { hasText: "Install" }).click();
    await asked;
    await drawer.locator(".drawer-foot button.is-busy").waitFor();
  };
  const footer = (page) => page.locator(".modal-dialog .modal-footer button");

  // A failure, the drawer dismissed: the footer holds, then the reason is a toast.
  let page = await openAdd();
  await start(page, "https://held.test/bad.tgz");
  await page.keyboard.press("Escape");
  await page.locator(".drawer.open").waitFor({ state: "detached" });
  assert.ok(await footer(page).isDisabled(), "no second install while the first runs");
  release();
  await page.locator(".toast--error").waitFor();
  assert.ok(await footer(page).isEnabled(), "the footer lets go when it ends");

  // A success, the drawer dismissed: toasted, the card appears, the dialog stays.
  await start(page, "https://held.test/good.tgz");
  await page.keyboard.press("Escape");
  release();
  await page.locator(".toast", { hasText: "Acme Gecko installed" }).waitFor();
  await page.locator(".plugin-row", { hasText: "Acme Gecko" }).waitFor();
  assert.equal(await page.locator(".modal-overlay").count(), 1, "the dialog stays: its reader moved on");
  assert.deepEqual(page.errors, []);

  // A failure after the whole dialog closed around the drawer: a toast still.
  page = await openAdd();
  await start(page, "https://held.test/bad.tgz");
  await page.mouse.click(5, 5); // outside the dialog
  await page.locator(".modal-overlay").waitFor({ state: "detached" });
  release();
  await page.locator(".toast--error").waitFor();
  assert.deepEqual(page.errors, []);
});
