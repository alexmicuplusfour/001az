# Browser tests

Tests that drive a **real Chromium** against the **real app**. Everything else
under `test/` runs in Node — the server tests hit real HTTP routes and a real
Postgres, and the front-end tests import one module at a time against a
hand-written fake `document` (`test/browser-stub.js`, `test/dom-stub.js`).

That fake browser is fine for logic and blind to the browser itself. These
tests exist to cover what only a browser does: clicking, typing, drag-drop,
file dialogs, navigation, redirects.

## Running them

```
npm run test:browser     # just these, ~3s
npm test                 # the whole suite, these included
```

One-time setup per machine (CI does it itself):

```
npx playwright install chromium
```

Without it, every browser test fails with that command in the error message.

To watch one happen in a visible window instead of headless, change the
`openApp()` call in the test file to `openApp({ headed: true })`.

## Why they exist

The toolbar's upload button broke and 1,489 passing tests didn't notice
(fixed in `4414ac6`). The failing chain was: click **+** → `input.click()` →
the browser's file dialog → the `change` event → `handleFiles`. Two reasons
nothing caught it:

1. **No test ran that chain.** The unit tests called `handleFiles` directly —
   a function from the middle of it.
2. **The bug was a browser rule no stub has.** `input.files` is live; clearing
   the input empties the list you already handed off. You'd have to know the
   quirk to fake it.

And the failure was *silent* — the code returned early, no exception — so only
a test asserting that a file **actually lands** could see it.

`upload.test.js` is that test. It fails if you undo the fix.

## Writing one

```js
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";

let app;
before(async () => { app = await openApp(); });   // real server + Chromium
after(() => app?.close());

test("what should happen", async () => {
  const { user, boardId } = await app.signIn();            // member + empty board
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });

  await page.locator(".tool-btn.upload").click();

  assert.deepEqual(page.errors, []);   // nothing threw in the page
});
```

What `openApp()` hands you — on top of everything `startServer()` returns
(`base`, `db`, `close`, …):

| | |
|---|---|
| `signIn({ email, boardName })` | a member with a password, on their own empty board (auto-tagging off) |
| `open(url, { sid })` | a page already carrying the session cookie |
| `fixture(name)` | a real file on disk to upload — `.png` goes through sharp, anything else is text |

Every page also carries two watchers:

- **`page.errors`** — uncaught exceptions and the app's own `console.error`
  calls. Assert it's empty at the end of every test. This one line catches
  breakage nobody thought to write an assertion for.
- **`page.failures`** — HTTP responses ≥ 400, as `{status, url}`. Separate
  because Chromium logs every failed response as a console error and some are
  correct (a signed-out visitor *should* get 401s on the way to login). Assert
  on it only where the request was meant to succeed.

## When NOT to write one

These cost a second or two each; the Node tests cost about a millisecond. If
you can check the thing by calling a function directly, do that instead —
`test/upload.test.js` is the cheap kind of the same subject. Reach for a
browser test when the behavior only exists in a browser, or when the bug lives
in the seam between two pieces rather than inside either one.
