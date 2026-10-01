// Copy and Paste on the board editor's section headings, through the real
// clipboard (planning/templates-plan.md, Stage 1). Extract Fields gained the
// pair Tagging Guidance already had, and both now come from one builder,
// modal.js clipBar. Nothing had clicked either in a browser before: the
// guidance document's rules are pinned in Node (guidance-json.test.js), the
// fields rules too (template-core.test.js), and what only a browser shows is
// here. The clipboard is read a task after the click, so the save gate has to
// be told; focus has to survive the redraw; a page with no clipboard has to
// say so on the button.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { seedUser } from "../helpers.js";
import { createBoard, setBoardMembers, updateBoard, getBoard, setPassword } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

const CLIPBOARD = ["clipboard-read", "clipboard-write"];
const brand = {
  key: "brand", source: "extract", kind: "text", instruction: "the maker's name",
  options: [{ value: "Acme", hint: "the red logo" }, { value: "Globex" }],
};
const year = { key: "year", source: "extract", kind: "number" };
// What the source board's Copy writes, to the character.
const COPIED = JSON.stringify([brand, year], null, 2);
// The clipboard as text. Windows' clipboard hands it back with CRLF line
// breaks where it was written with LF.
const clipboardText = (page) => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"));

let app, admin, manager;
const boards = {};

before(async () => {
  app = await openApp();
  const { user, boardId } = await app.signIn({ email: "admin@test.local", boardName: "Source" });
  await app.db.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [user.id]);
  admin = user;

  // The board the fields are copied from: one field of its own files, two
  // extracted, one of them the card key. Its guidance too, for the other bar.
  boards.source = boardId;
  await updateBoard(app.db, boardId, {
    context: "Product photos.",
    facets: [{ key: "shade", label: "Shade", values: ["light", "dark"] }],
    mapping: {
      fields: [{ key: "file_size", source: "file", kind: "number", fn: "file_size" }, brand, year],
      card: { by: "brand" },
    },
  });

  // The board they're pasted into: a file field that must stay, an extracted
  // field the paste replaces, and that field is its card key.
  boards.target = await createBoard(app.db, "Target", [], "", true, null, null, { enabled: false });
  await updateBoard(app.db, boards.target, {
    mapping: {
      fields: [{ key: "extension", source: "file", kind: "text", fn: "extension" }, { key: "old", source: "extract", kind: "text" }],
      card: { by: "old" },
    },
  });

  // A board whose own file field answers to "size".
  boards.clash = await createBoard(app.db, "Clash", [], "", true, null, null, { enabled: false });
  await updateBoard(app.db, boards.clash, {
    mapping: { fields: [{ key: "size", source: "file", kind: "number", fn: "file_size" }] },
  });

  // A board manager: edits the source board's content, reads its mapping.
  manager = await seedUser(app.db, "manager@test.local");
  await setPassword(app.db, manager.id, await hashPassword("browser-test-pw"));
  await setBoardMembers(app.db, boards.source, [admin.id, manager.id], [manager.id]);
  for (const b of [boards.target, boards.clash]) await setBoardMembers(app.db, b, [admin.id]);
});
after(() => app?.close());

// The editor from the toolbar's pencil, on its Mapping pane. An admin's editor
// takes its baseline when the AI strip lands (save-gate.js rebase), so wait
// for that before anything is changed.
async function openMapping(page, { isAdmin = true } = {}) {
  await page.click("#toolbar .board-edit-btn");
  await page.waitForSelector("#board-edit-modal");
  if (isAdmin) await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="mapping"]');
  await page.waitForSelector("#board-modal-mapping .clip-toolbar");
}
const tileNames = (page) => page.$$eval("#board-modal-mapping .tile-name", (els) => els.map((e) => e.textContent));
const clipButtons = (page, where) => page.$$eval(`${where} .clip-btn`, (els) => els.map((e) => e.textContent));
const saveOff = (page) => page.getAttribute("#board-modal-save", "aria-disabled");

test("Copy writes the extracted fields; Paste puts them on another board, and Save keeps them", async () => {
  const page = await app.open(`/?board=${boards.source}`, { sid: admin.sid, permissions: CLIPBOARD });
  await openMapping(page);
  await page.click('#board-modal-mapping .clip-btn:text-is("Copy")');
  await page.waitForSelector('#board-modal-mapping .clip-btn:text-is("copied!")');
  // What a save would send for the two extracted fields, and not the board's
  // own file field: the same text, not only the same values. The options come
  // back from the database with their keys in its own order (hint first), and
  // a save writes each one value first.
  assert.equal(await clipboardText(page), COPIED);

  await page.goto(`${app.base}/?board=${boards.target}`);
  await openMapping(page);
  assert.equal(await saveOff(page), "true", "setup: nothing to save yet");
  await page.click('#board-modal-mapping .clip-btn:text-is("Paste")');
  await page.waitForSelector('#board-modal-mapping .tile-name:text-is("brand")');

  assert.deepEqual(await tileNames(page), ["extension", "brand", "year"],
    "the board's own field stays first; the pasted ones follow; the old extracted one is gone");
  await page.waitForSelector('.toast-msg:text-is("One card per file again — old was the card key")');
  // The paste was the only edit, and it landed after the click: Save has to
  // have heard of it anyway.
  assert.equal(await saveOff(page), null, "Save turns on for a paste alone");
  assert.equal(await page.evaluate(() => {
    const a = document.activeElement;
    return !!a?.closest("#board-modal-mapping") && a.textContent === "Paste";
  }), true, "focus is back on Paste after the redraw");

  await page.click("#board-modal-save");
  await page.waitForSelector("#board-modal-save", { state: "detached" });
  const saved = (await getBoard(app.db, boards.target)).mapping;
  assert.deepEqual(saved.fields, [{ key: "extension", source: "file", kind: "text", fn: "extension" }, brand, year]);
  assert.equal(saved.card ?? null, null);
  assert.deepEqual(page.errors, []);
});

test("a pasted key the board already has refuses the paste, and nothing changes", async () => {
  const page = await app.open(`/?board=${boards.clash}`, { sid: admin.sid, permissions: CLIPBOARD });
  await openMapping(page);
  await page.evaluate((t) => navigator.clipboard.writeText(t), JSON.stringify([{ key: "size", kind: "text" }]));
  await page.click('#board-modal-mapping .clip-btn:text-is("Paste")');
  await page.waitForSelector('.toast--warn .toast-msg:text-is("Two fields would share the key \\"size\\" — nothing was pasted")');
  assert.deepEqual(await tileNames(page), ["size"]);
  assert.equal(await saveOff(page), "true");
  assert.deepEqual(page.errors, []);
});

test("Tagging Guidance's Copy and Paste still carry the context and the taxonomy", async () => {
  const page = await app.open(`/?board=${boards.source}`, { sid: admin.sid, permissions: CLIPBOARD });
  await page.click("#toolbar .board-edit-btn");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('#board-modal-guidance-head .clip-btn:text-is("Copy")');
  await page.waitForSelector('#board-modal-guidance-head .clip-btn:text-is("copied!")');
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  assert.equal(copied.context, "Product photos.");
  assert.deepEqual(copied.facets.map((f) => f.key), ["shade"]);

  await page.goto(`${app.base}/?board=${boards.clash}`);
  await page.click("#toolbar .board-edit-btn");
  await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
  await page.click('#board-modal-guidance-head .clip-btn:text-is("Paste")');
  await page.waitForFunction(() => document.getElementById("board-modal-context").value === "Product photos.");
  const facets = JSON.parse(await page.inputValue("#board-modal-facets"));
  assert.deepEqual(facets.map((f) => f.key), ["shade"]);
  assert.equal(await saveOff(page), null);
  assert.deepEqual(page.errors, []);
});

test("a reader who can't edit the mapping can copy its fields and can't paste them", async () => {
  const page = await app.open(`/?board=${boards.source}`, { sid: manager.sid, permissions: CLIPBOARD });
  await openMapping(page, { isAdmin: false });
  assert.deepEqual(await clipButtons(page, "#board-modal-mapping"), ["Copy"]);
  await page.click('#board-modal-mapping .clip-btn:text-is("Copy")');
  await page.waitForSelector('#board-modal-mapping .clip-btn:text-is("copied!")');
  assert.equal(await clipboardText(page), COPIED);
  assert.deepEqual(page.errors, []);
});

// Both bars' documents are bare lists of keyed objects, so each Paste checks
// it was handed its own. And a kind nobody offers passes Paste, as a
// misspelled key does, for Save to name: it used to go out as "text" without
// a word. A field pasted without a kind reads as text, as it saves.
test("each Paste refuses the other's document, and Save names a kind nobody offers", async () => {
  const page = await app.open(`/?board=${boards.clash}`, { sid: admin.sid, permissions: CLIPBOARD });
  await openMapping(page);
  const paste = async (where, doc) => {
    await page.evaluate((t) => navigator.clipboard.writeText(t), typeof doc === "string" ? doc : JSON.stringify(doc));
    await page.click(`${where} .clip-btn:text-is("Paste")`);
  };
  const warned = (text) => page.waitForSelector(`.toast--warn .toast-msg:text-is(${JSON.stringify(text)})`);

  await paste("#board-modal-mapping", "brand, year");
  await warned("Clipboard doesn't contain AI-extracted fields JSON (a list of fields)");
  await paste("#board-modal-mapping", [{ key: "season", label: "Season", values: ["summer"] }]);
  await warned("Can't paste those fields: that's a taxonomy, not a list of fields");
  assert.deepEqual(await tileNames(page), ["size"]);

  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="tagging"]');
  const facets = await page.inputValue("#board-modal-facets");
  await paste("#board-modal-guidance-head", COPIED);
  await warned(`Clipboard doesn't contain tagging guidance JSON ({ "context", "facets" })`);
  assert.equal(await page.inputValue("#board-modal-facets"), facets);
  assert.equal(await saveOff(page), "true", "nothing was pasted anywhere");

  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="mapping"]');
  await paste("#board-modal-mapping", [{ key: "price", kind: "integer" }, { key: "maker", instruction: "the maker's name" }]);
  await page.waitForSelector('#board-modal-mapping .tile-name:text-is("maker")');
  const sums = await page.$$eval("#board-modal-mapping .tile", (els) =>
    Object.fromEntries(els.map((t) => [t.querySelector(".tile-name").textContent, t.querySelector(".tile-sum").textContent])));
  assert.equal(sums.maker, "AI extraction · text · “the maker's name”");
  assert.equal(sums.price, "AI extraction · integer");
  await page.click("#board-modal-save");
  await page.waitForSelector(`.toast--error .toast-msg:text-is('invalid kind "integer" for field "price"')`);
  assert.deepEqual((await getBoard(app.db, boards.clash)).mapping.fields.map((f) => f.key), ["size"], "nothing was saved");
  assert.deepEqual(page.errors, []);
});

// Over plain http there is no navigator.clipboard at all. Paste used to blame
// the clipboard's contents for that, which nobody had read. A clipboard that's
// there but won't be read (no permission) says the same.
test("with no clipboard, or one that won't be read, both Paste buttons say so on the button", async () => {
  const refused = await app.open(`/?board=${boards.source}`, { sid: admin.sid });
  await openMapping(refused);
  await refused.click('#board-modal-mapping .clip-btn:text-is("Paste")');
  await refused.waitForSelector('#board-modal-mapping .clip-btn:text-is("couldn\'t paste")');
  assert.deepEqual(refused.errors, []);

  const page = await app.open(`/?board=${boards.source}`, { sid: admin.sid });
  await page.addInitScript(() => Object.defineProperty(navigator, "clipboard", { value: undefined }));
  await page.reload();
  await openMapping(page);
  await page.click('#board-modal-mapping .clip-btn:text-is("Paste")');
  await page.waitForSelector('#board-modal-mapping .clip-btn:text-is("couldn\'t paste")');
  await page.click('#board-edit-modal .pane-toggle-btn[data-pane="tagging"]');
  await page.click('#board-modal-guidance-head .clip-btn:text-is("Paste")');
  await page.waitForSelector('#board-modal-guidance-head .clip-btn:text-is("couldn\'t paste")');
  await page.click('#board-modal-guidance-head .clip-btn:text-is("Copy")');
  await page.waitForSelector('#board-modal-guidance-head .clip-btn:text-is("couldn\'t copy")');
  assert.equal(await page.locator(".toast--warn").count(), 0, "no complaint about the clipboard's contents");
  assert.deepEqual(page.errors, []);
});
