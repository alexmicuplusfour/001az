// A REAL browser against the REAL app. Everything else under test/ runs the
// front-end in Node against a hand-written fake document (browser-stub.js,
// dom-stub.js) — fine for logic, blind to anything the browser itself does.
// The upload-button bug (4414ac6) lived exactly there: the picker hands over a
// LIVE FileList that empties when the input is cleared, a rule no stub has, in
// a code path — click → dialog → change event — no stub test ever ran. 1,489
// passing tests didn't flinch.
//
// So: Chromium, driven by Playwright, pointed at the same startServer() the API
// tests use (with `frontend: true`, so express serves the actual public/).
// No docker, no dev server, no fixed port — same throwaway Postgres per file
// as every other test here.
//
// These are SLOW (a second or two each) next to the ~1ms unit tests. Spend them
// on paths that are only real in a browser: clicking, typing, drag-drop, file
// dialogs, navigation. Anything you can check by calling a function directly,
// check that way instead — see test/upload.test.js for the cheap kind.
//
// Needs the Chromium binary: `npx playwright install chromium` (once per
// machine; CI does it in .github/workflows/ci.yml). openApp throws with that
// command in the message if it's missing.
import { chromium } from "playwright";
import sharp from "sharp";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { startServer, seedUser } from "../helpers.js";
import { createBoard, setBoardMembers, setPassword } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

// One browser per test FILE, one fresh page per test. Launching Chromium costs
// ~300ms; reusing it across tests in a file keeps that off every case, while a
// new page (its own cookies, its own localStorage) keeps them from leaking into
// each other.
// FRONTEND_DIR points the suite at BUILT assets instead of source:
//   npm run build:frontend && FRONTEND_DIR=public/dist npm run test:browser
// Nothing in the test files changes —
// they all arrive through openApp — and the default stays public/ source, so a
// bare run is exactly what it was. This is the one check that exercises the
// bundled output by CLICKING it rather than by loading it.
export async function openApp({ headed = false } = {}) {
  const srv = await startServer({ frontend: true, staticDir: process.env.FRONTEND_DIR || null });

  let browser;
  try {
    browser = await chromium.launch({ headless: !headed });
  } catch (e) {
    await srv.close();
    throw new Error(
      `Couldn't launch Chromium for the browser tests.\n` +
        `Install it once with:  npx playwright install chromium\n\n` +
        `Original error: ${e.message}`
    );
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gallery-browser-"));
  const pages = [];

  // A signed-in member on their own board, which is the only state most of
  // these tests need to get to. Auto-tagging OFF: with it on every upload is
  // born `pending` and goes looking for an AI key that isn't configured here,
  // which is a different test's subject — off, a file lands finished and the
  // grid shows it as an ordinary card.
  async function signIn({ email = "browser@test.local", boardName = "Browser board" } = {}) {
    const user = await seedUser(srv.db, email);
    // A passwordless account is a half-created one: /api/me reports
    // needs_password and app.js bounces the page to /login.html. seedUser
    // leaves it null because the API tests speak session cookies and never
    // load the page.
    await setPassword(srv.db, user.id, await hashPassword("browser-test-pw"));
    const boardId = await createBoard(srv.db, boardName, [], "", true, null, null, { enabled: false });
    await setBoardMembers(srv.db, boardId, [user.id]);
    return { user, boardId };
  }

  // Open a page already carrying the session cookie. Two watchers ride along,
  // and most tests assert on the first at the end:
  //
  //   page.errors    — JS that went wrong: uncaught exceptions and the app's
  //                    own console.error calls. Empty is the only acceptable
  //                    value. This catches a whole class of breakage no
  //                    assertion was written for.
  //   page.failures  — HTTP responses >= 400, as {status, url}. Kept SEPARATE
  //                    because Chromium logs every one as a console error, and
  //                    some are the correct answer (a signed-out visitor gets
  //                    401s on the way to the login redirect). Assert on it
  //                    only where the request was supposed to succeed.
  async function open(url, { sid } = {}) {
    const ctx = await browser.newContext();
    if (sid) await ctx.addCookies([{ name: "sid", value: sid, url: srv.base }]);
    const page = await ctx.newPage();
    const errors = [];
    const failures = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => {
      // Chromium's automatic "Failed to load resource: … 404" line duplicates
      // what `failures` already records, with none of the detail.
      if (m.type() === "error" && !m.text().startsWith("Failed to load resource")) errors.push(m.text());
    });
    page.on("response", (r) => {
      if (r.status() >= 400) failures.push({ status: r.status(), url: new URL(r.url()).pathname });
    });
    page.errors = errors;
    page.failures = failures;
    pages.push(ctx);
    await page.goto(srv.base + url);
    return page;
  }

  // A real file on disk for the file dialog to hand over. `png` goes through
  // sharp + thumbnailing server-side; the text kinds take the doc path.
  async function fixture(name, { width = 8, height = 8 } = {}) {
    const file = path.join(tmp, name);
    if (/\.png$/i.test(name)) {
      await sharp({
        create: { width, height, channels: 3, background: { r: 200, g: 40, b: 90 } },
      }).png().toFile(file);
    } else {
      fs.writeFileSync(file, `fixture ${name} ${crypto.randomBytes(4).toString("hex")}\n`);
    }
    return file;
  }

  async function close() {
    for (const ctx of pages) await ctx.close().catch(() => {});
    await browser.close().catch(() => {});
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { ...srv, browser, signIn, open, fixture, close };
}
