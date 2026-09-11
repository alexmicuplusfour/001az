// The toolbar's + button, end to end in a real browser: click it, let the real
// file dialog hand over a real file, watch the card land in the grid.
//
// This is the test that was missing when the picker broke (4414ac6). The unit
// tests called handleFiles directly and passed; nothing ran click → input.click()
// → change → handleFiles, and the break lived in that chain — the browser's live
// FileList emptying under a code path no stub reproduced. The failure was silent
// (`if (!files.length) return`), so only an assertion that a file ACTUALLY LANDS
// can catch it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";

// A SETTLED card: the optimistic upload placeholder is also a `.card` (with a
// spinner and no id), so counting bare `.card` would pass on a placeholder the
// server never accepted. `[data-id]` means the POST came back and the row
// merged into the grid.
const SETTLED = "#grid .card[data-id]";

let app;
before(async () => { app = await openApp(); });
after(() => app?.close());

test("the + button uploads the file the dialog hands back", async () => {
  const { user, boardId } = await app.signIn();
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });

  const plus = page.locator(".tool-btn.upload");
  await plus.waitFor();
  assert.equal(await page.locator(SETTLED).count(), 0, "board starts empty");

  // The real path: clicking + opens the OS file dialog (Playwright intercepts
  // it as a filechooser event), and choosing a file fires the input's change.
  // setInputFiles on #file-input directly would skip the click and the dialog —
  // most of what broke last time.
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser"),
    plus.click(),
  ]);
  await chooser.setFiles(await app.fixture("picked.png"));

  await page.locator(SETTLED).first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator(SETTLED).count(), 1);
  assert.deepEqual(page.errors, [], "no uncaught errors in the page");

  // And the server really has it — a card can render optimistically before the
  // upload lands, so the grid alone isn't proof.
  const { rows } = await app.db.query("SELECT payload FROM items WHERE board_id=$1", [boardId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.files[0].original_name, "picked.png");
});

test("picking the same file twice uploads it twice", async () => {
  // Why the change handler clears `value` at all: without it the second pick of
  // an identical path fires no change event. That clear is what emptied the live
  // FileList mid-upload — so the fix has to keep BOTH true, and only a real
  // browser can tell you it does.
  const { user, boardId } = await app.signIn({ email: "twice@test.local" });
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  const plus = page.locator(".tool-btn.upload");
  await plus.waitFor();

  const file = await app.fixture("same.png");
  for (const n of [1, 2]) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), plus.click()]);
    await chooser.setFiles(file);
    await page.locator(SETTLED).nth(n - 1).waitFor({ timeout: 15000 });
  }

  assert.equal(await page.locator(SETTLED).count(), 2);
  assert.deepEqual(page.errors, []);
});

test("dropping a file on the page uploads it", async () => {
  // The path that kept working while the button was dead — and the reason the
  // breakage read as "uploads are fine, the button is weird". It had no
  // coverage of its own: window's drop listener, the overlay, and the
  // DataTransfer file list only exist in a browser.
  const { user, boardId } = await app.signIn({ email: "drop@test.local" });
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  await page.locator(".tool-btn.upload").waitFor();

  // Build the drop the way the browser would: a real File in a real
  // DataTransfer, dispatched at window.
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(["dropped text"], "dropped.txt", { type: "text/plain" }));
    window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true }));
    window.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true }));
  });

  await page.locator(SETTLED).first().waitFor({ timeout: 15000 });
  assert.equal(await page.locator(SETTLED).count(), 1);
  assert.deepEqual(page.errors, []);
  // The overlay must go away with the drop, or it eats every later click.
  assert.equal(await page.locator("#drop-overlay").isHidden(), true);
});
