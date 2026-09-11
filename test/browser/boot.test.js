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
