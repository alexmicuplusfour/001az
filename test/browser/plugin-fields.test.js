// The Plugins page's declared fields in a real browser (planning/
// pdf-conversion-plan.md, Stage 2). The PDF card gained its own field, the
// page setting, drawn by the code the connector card's fields were drawn by,
// which moved into one shared function with the AI cards' rate fields. The
// connector and AI tests guard what the move could break; the first ones were
// written before it and passed against the code before it. Each field saves
// itself on change; the tests read what the server stored.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { adminSession, until } from "../helpers.js";
import { setPassword, setPluginState, getPluginRow, getSetting } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";
import { seedSidecarHealth } from "../../server/sidecar-catalog.js";

let app, admin;

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one: the page bounces to /login.
  await setPassword(app.db, admin.id, await hashPassword("plugin-fields-pw"));
  await setPluginState(app.db, "crypto:coingecko", { installed: true });
  await setPluginState(app.db, "stocks:financialmodelingprep", { installed: true });
  await setPluginState(app.db, "ai:openai", { installed: true });
});

after(async () => {
  await app?.close();
});

// /admin#plugins → the card's gear → its modal. A fresh page per test: state
// lives server-side, so each asserts from a clean render.
async function openCard(label) {
  const page = await app.open("/admin#plugins", { sid: admin.sid });
  await page.locator(`.gear[title="Configure ${label}"]`).click();
  await page.locator(".modal-dialog").waitFor();
  return page;
}
const field = (page, label) => page.locator(`.modal-dialog label:has-text("${label}") + input`);
const stored = async (id, key) => (await getPluginRow(app.db, id))?.config?.[key];
// Type a value and leave the box, which is when a field saves.
async function enter(input, value) {
  await input.fill(value);
  await input.press("Tab");
}
const clearPdfCard = () => setPluginState(app.db, "media:pdf", { config: {} });
// Hold the card's first save on its way to the server until release() — so a
// second value can be typed while it's still saving — and count the saves
// that came back.
async function holdFirstSave(page, id) {
  let release;
  const held = new Promise((r) => { release = r; });
  let first = true;
  const answered = { n: 0 };
  page.on("response", (r) => {
    if (r.request().method() === "PATCH" && r.url().endsWith(`/api/admin/plugins/${id}`)) answered.n++;
  });
  await page.route(`**/api/admin/plugins/${id}`, async (route) => {
    if (route.request().method() === "PATCH" && first) {
      first = false;
      await held;
    }
    await route.continue();
  });
  return { release, answered };
}

test("a connector card's number field saves, and a cleared one goes back to its default", async () => {
  const page = await openCard("CoinGecko");
  const rpm = field(page, "Requests / minute");
  await enter(rpm, "42");
  await until(async () => (await stored("crypto:coingecko", "rpm")) === 42, 5000);
  await enter(rpm, "");
  await until(async () => (await stored("crypto:coingecko", "rpm")) === undefined, 5000);
  // A connector paces differently with and without a key, so its blank box
  // names no default.
  assert.equal(await rpm.getAttribute("placeholder"), null);
  assert.deepEqual(page.errors, []);
});

test("a connector card's key saves, and the confirmed remove clears it", async () => {
  const page = await openCard("Financial Modeling Prep");
  await enter(field(page, "API key"), "fmp-browser-key");
  await until(async () => (await getSetting(app.db, "stocks_key_financialmodelingprep")) === "fmp-browser-key", 5000);
  // The card redraws with the key stored, and offers to remove it.
  await page.locator('.modal-dialog input[placeholder^="•••• stored"]').waitFor();
  page.once("dialog", (d) => d.accept());
  await page.locator(".modal-dialog button", { hasText: "remove stored key" }).click();
  await until(async () => (await getSetting(app.db, "stocks_key_financialmodelingprep")) === null, 5000);
  assert.deepEqual(page.errors, []);
});

test("an AI card's rate field saves without rebuilding the card, and a cleared one goes back to its default", async () => {
  const page = await openCard("OpenAI");
  const rpm = field(page, "Requests / minute");
  assert.match(await rpm.getAttribute("placeholder"), /^default \d+$/, "the default, shown when the box is blank");
  const box = await rpm.elementHandle();
  await enter(rpm, "17");
  await until(async () => (await stored("ai:openai", "rpm")) === 17, 5000);
  await enter(rpm, "");
  await until(async () => (await stored("ai:openai", "rpm")) === undefined, 5000);
  // Checked last: a rebuild comes after a save's own fetch, so by now one from
  // the first save would have replaced the box.
  assert.equal(await box.evaluate((n) => n.isConnected), true, "the same box: nothing rebuilt the card");
  assert.deepEqual(page.errors, []);
});

test("the PDF card's page setting: the box says every page when blank, saves a number, and clearing it goes back", async () => {
  await clearPdfCard();
  const page = await openCard("PDF documents");
  const pages = field(page, "Scanned pages to read");
  assert.equal(await pages.inputValue(), "", "nothing set");
  assert.equal(await pages.getAttribute("placeholder"), "All pages (default)");
  await enter(pages, "3");
  await until(async () => (await stored("media:pdf", "ocrPages")) === 3, 5000);
  await enter(pages, "0");
  await until(async () => (await stored("media:pdf", "ocrPages")) === 0, 5000);
  await enter(pages, "");
  await until(async () => (await stored("media:pdf", "ocrPages")) === undefined, 5000);
  assert.equal(await field(page, "Max upload size").count(), 1, "Max upload size is still on the card");
  assert.deepEqual(page.errors, []);
});

test("a value typed while the last one is still saving is saved too", async (t) => {
  // Each save used to mark as saved whatever was in the box when the server
  // answered, so a value typed in the meantime was never sent. The full suite's
  // load first showed it; holding the first save shows it every time.
  await clearPdfCard();
  t.after(clearPdfCard);
  const page = await openCard("PDF documents");
  const pages = field(page, "Scanned pages to read");
  const { release } = await holdFirstSave(page, "media:pdf");
  await enter(pages, "3");
  await enter(pages, "0"); // while 3 is still on its way
  release();
  await until(async () => (await stored("media:pdf", "ocrPages")) === 0, 5000);
  assert.deepEqual(page.errors, []);
});

test("a value set back to the saved one while a save is on its way is saved too", async (t) => {
  // Blank, then 3, then blank again before 3 has landed: the box is blank, and
  // the setting must be every page again, not 3.
  await clearPdfCard();
  t.after(clearPdfCard);
  const page = await openCard("PDF documents");
  const pages = field(page, "Scanned pages to read");
  const { release, answered } = await holdFirstSave(page, "media:pdf");
  await enter(pages, "3");
  await enter(pages, "");
  release();
  await until(() => answered.n === 2, 5000);
  assert.equal(await stored("media:pdf", "ocrPages"), undefined, "every page, as the box says");
});

test("a refused value doesn't wipe the one typed after it", async (t) => {
  await clearPdfCard();
  t.after(clearPdfCard);
  const page = await openCard("PDF documents");
  const pages = field(page, "Scanned pages to read");
  const { release } = await holdFirstSave(page, "media:pdf");
  await enter(pages, "2.5"); // refused: whole pages only
  await enter(pages, "4"); // typed while 2.5 is on its way
  release();
  await until(async () => (await stored("media:pdf", "ocrPages")) === 4, 5000);
  assert.equal(await pages.inputValue(), "4", "the box keeps what was typed last");
});

test("text the box can't read as a number goes back instead of saving the default", async (t) => {
  // A number box reads "e" or a lone "-" as blank — which, saved, would mean
  // every page.
  await setPluginState(app.db, "media:pdf", { config: { ocrPages: 3 } });
  t.after(clearPdfCard);
  const page = await openCard("PDF documents");
  const pages = field(page, "Scanned pages to read");
  await pages.click();
  await pages.press("Control+a");
  await page.keyboard.type("e");
  await pages.press("Tab");
  await until(async () => (await pages.inputValue()) === "3", 5000);
  assert.equal(await stored("media:pdf", "ocrPages"), 3, "still 3, not every page");
});

test("every file plugin's card shows its file types in a tile and its settings under its own title", async (t) => {
  // planning/pdf-conversion-plan.md, D12: "file types doesn't make sense as a
  // big ass title, just to display the supported file types". And the PDF
  // card's switch (Stage 3): on until it's turned off, saved either way.
  await clearPdfCard();
  t.after(clearPdfCard);
  const page = await openCard("PDF documents");
  const dialog = page.locator(".modal-dialog");
  assert.equal(await dialog.locator(".tile .tile-name").textContent(), "File types");
  assert.equal(await dialog.locator(".tile .tile-sum").textContent(), ".pdf · built in, always on");
  assert.deepEqual(await dialog.locator(".section-heading h2").allTextContents(), ["PDF settings"],
    "one title, the type's settings: the file types aren't a section of their own");

  const row = dialog.locator('.switch-row:has-text("Convert PDFs to text")');
  assert.match(await row.textContent(), /The AI reads a text copy instead of the PDF file: usually cheaper, and some AI providers can't read PDF files\./);
  const sw = row.locator('[role="switch"]');
  assert.equal(await sw.getAttribute("aria-checked"), "true", "on by default, with nothing stored");
  await sw.click();
  await until(async () => (await stored("media:pdf", "convert")) === false, 5000);
  await sw.click();
  await until(async () => (await stored("media:pdf", "convert")) === true, 5000);
  // The settings in their order: the upload size, the switch, then the page
  // setting the switch decides whether a read uses, and the language it reads in.
  const order = await dialog.evaluate((d) => [...d.querySelectorAll("label, .switch-row")].map((n) => n.textContent.split(/ ·| The AI/)[0].trim()));
  assert.deepEqual(order, ["Max upload size (MB)", "Convert PDFs to text", "Scanned pages to read", "OCR language"]);
  assert.deepEqual(page.errors, []);

  const audio = await openCard("Audio files");
  const card = audio.locator(".modal-dialog");
  assert.equal(await card.locator(".tile .tile-sum").textContent(), ".mp3 .m4a .aac .wav .ogg .oga .opus .flac · built in, always on");
  assert.deepEqual(await card.locator(".section-heading h2").allTextContents(), ["Audio settings"]);
  assert.equal(await card.locator("input").count(), 1, "Max upload size alone");
  assert.equal(await card.locator(".switch-row").count(), 0);
  assert.deepEqual(audio.errors, []);

  // …and the other three, each under its own title.
  for (const [label, title, exts] of [
    ["Image files", "Image settings", ".jpg .jpeg .png .webp .avif .heif .heic .gif .svg"],
    ["Word documents", "Word document settings", ".docx"],
    ["Text files", "Text file settings", ".txt .md .csv"],
  ]) {
    const other = await openCard(label);
    const box = other.locator(".modal-dialog");
    assert.equal(await box.locator(".tile .tile-name").textContent(), "File types", label);
    assert.equal(await box.locator(".tile .tile-sum").textContent(), `${exts} · built in, always on`, label);
    assert.deepEqual(await box.locator(".section-heading h2").allTextContents(), [title], label);
    assert.deepEqual(other.errors, [], label);
  }
});

test("the PDF card's OCR language lists the extractor image's languages by name, and saves one", async (t) => {
  // planning/pdf-conversion-plan.md, Stage 4. The choices are what the image
  // has, as the sidecar watch last heard it; this test states its answer.
  await clearPdfCard();
  t.after(() => { seedSidecarHealth("media:pdf", null); return clearPdfCard(); });
  const ocrLang = (page) => page.locator('.modal-dialog label:has-text("OCR language") + select');
  const label = (page) => page.locator('.modal-dialog label:has-text("OCR language")').textContent();
  seedSidecarHealth("media:pdf", { ok: true, langs: ["eng", "fra", "deu"] });
  const page = await openCard("PDF documents");
  assert.deepEqual(await ocrLang(page).locator("option").allTextContents(), ["English", "French", "German"]);
  assert.equal(await ocrLang(page).inputValue(), "eng", "English, with nothing stored");
  assert.match(await label(page), /The language scanned pages are written in\./);
  await ocrLang(page).selectOption("fra");
  await until(async () => (await stored("media:pdf", "ocrLang")) === "fra", 5000);

  // A choice the image no longer has (rebuilt with fewer) shows as it is, not
  // as some other language.
  seedSidecarHealth("media:pdf", { ok: true, langs: ["eng", "deu"] });
  const gone = await openCard("PDF documents");
  assert.equal(await ocrLang(gone).inputValue(), "fra");
  assert.equal(await ocrLang(gone).locator("option:checked").textContent(), "French (not available)");

  // The extractor not answering: the saved choice, held, and why.
  seedSidecarHealth("media:pdf", null);
  const down = await openCard("PDF documents");
  assert.equal(await ocrLang(down).isDisabled(), true);
  assert.deepEqual(await ocrLang(down).locator("option").allTextContents(), ["French"]);
  assert.match(await label(down), /The extractor isn't answering, so its languages aren't known\./);
  assert.deepEqual([page.errors, gone.errors, down.errors], [[], [], []]);
});

test("OCR languages picked in quick succession are saved in order, and a refused one goes back", async (t) => {
  // Arrow keys on a closed list change it a step at a time, each a save:
  // Finnish on its way, then French. The list's last pick is what's stored.
  await clearPdfCard();
  t.after(() => { seedSidecarHealth("media:pdf", null); return clearPdfCard(); });
  seedSidecarHealth("media:pdf", { ok: true, langs: ["eng", "fin", "fra", "deu"] });
  const page = await openCard("PDF documents");
  const list = page.locator('.modal-dialog label:has-text("OCR language") + select');
  const { release, answered } = await holdFirstSave(page, "media:pdf");
  await list.selectOption("fin");
  await list.selectOption("fra"); // while Finnish is on its way
  // A save sent beside the held one would land now, before it; one that waits
  // its turn never does, so this gives the first kind its chance and no more.
  await until(() => answered.n === 1, 1000).catch(() => {});
  release();
  await until(() => answered.n === 2, 5000);
  assert.equal(await stored("media:pdf", "ocrLang"), "fra");

  // The image rebuilt without German since the card opened: the save is
  // refused, and the list shows the choice that's saved.
  seedSidecarHealth("media:pdf", { ok: true, langs: ["eng", "fin", "fra"] });
  await list.selectOption("deu");
  await until(async () => (await list.inputValue()) === "fra", 5000);
  assert.equal(await stored("media:pdf", "ocrLang"), "fra");
  assert.deepEqual(page.errors, []);
});
