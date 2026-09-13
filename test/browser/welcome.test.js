// The welcome screen's connect sequence, in a real browser
// (planning/welcome-plan.md Stage 2). The chain is:
//
//   tile click → install the bundled plugin → the card learns which FIELD to
//   draw from the install's reply → type → Connect → three calls → the board
//   button appears
//
// and every link in it only exists in a browser. The middle one is the reason
// this file is not a dom-stub test: the card's field is "Server URL" or "API
// key" depending on a descriptor that does not exist until a click has already
// happened, so a test that calls the render function directly has to be handed
// the very answer the step is supposed to produce.
//
// It is also the failure shape upload.test.js was written for — a step that
// returns early and silently, leaving a page that looks fine and does nothing.
// Only an assertion that the connection ACTUALLY LANDS can see that.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { openApp } from "./harness.js";
import { adminSession, seedUser } from "../helpers.js";
import { setPassword, getSetting, listAiKeys, deleteAiKey, setPluginState, setSetting } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";

let app, admin, pluginsTmp, ollama;

before(async () => {
  // Installs land on disk, so they get a temp dir like plugin-install.test.js.
  // Set before the app boots: pluginsDir() reads it lazily, but an install that
  // beat this would write to the real /data/plugins.
  pluginsTmp = fs.mkdtempSync(path.join(os.tmpdir(), "welcome-plugins-"));
  process.env.PLUGINS_DIR = pluginsTmp;

  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one — /api/me says needs_password
  // and the page bounces to /login.html before rendering anything.
  await setPassword(app.db, admin.id, await hashPassword("welcome-test-pw"));

  // A stand-in for a self-hosted box: the connect sequence's last call is a
  // real probe, and the whole point of the assertion is that it goes green.
  // Answers /v1/models, which is what this provider's `keyTest: "list"` asks.
  ollama = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "llama3.1:8b" }, { id: "nomic-embed-text" }] }));
  });
  await new Promise((r) => ollama.listen(0, "127.0.0.1", r));
});

after(async () => {
  await app?.close();
  await new Promise((r) => ollama?.close(r));
  fs.rmSync(pluginsTmp, { recursive: true, force: true });
  delete process.env.PLUGINS_DIR;
});

const ollamaUrl = () => `http://127.0.0.1:${ollama.address().port}/v1`;

// Stage 1's client rung, for real. It has a dom-stub test (test/welcome-gate)
// that proves the ladder ENDS at the redirect rather than painting the boards
// page behind it — which a stub can prove and a browser can't, since
// location.replace really navigates. What a stub can't prove is that the
// navigation happens at all, or that the page it lands on exists: `replace` is
// a no-op there, so /welcome could have been spelled wrong, or absent, and the
// three assertions would still be green. That was the live state of this tree
// between Stage 1 and Stage 2, and this is the test that would have said so.
//
// First in the file on purpose: it is the only case that needs a genuinely
// untouched instance, and everything below leaves a mark.
test("a fresh admin asking for the boards page is sent here instead", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.waitForURL(/\/welcome$/, { timeout: 15000 });
  // Landed on a real page, not a 404 shaped like one.
  await page.locator(".w-tile").first().waitFor({ timeout: 15000 });
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("the chooser leads with the keyless row, and it is the bundled one", async () => {
  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator(".w-tile").first().waitFor({ timeout: 15000 });

  // Ordering is the stage's one real product decision: the row someone can
  // finish without deciding to spend money goes first. On a fresh instance it
  // is also the only row that is not a vendor account.
  const names = await page.locator(".w-tile .w-name").allTextContents();
  assert.equal(names[0], "Ollama", `keyless first, got: ${names.join(", ")}`);
  assert.ok(names.includes("Anthropic"), "…without hiding the keyed ones");

  // Only the exception carries a line. Five rows that all say "needs a key"
  // carry nothing; the entropy is in the one whose terms differ.
  assert.equal(await page.locator(".w-tile .w-note").count(), 1);
  assert.equal(await page.locator(".w-tile").first().locator(".w-note").textContent(), "on your machine");
  // The monogram comes from label[0] — no vendor assets to keep in step.
  assert.equal(await page.locator(".w-tile").first().locator(".w-mark").textContent(), "O");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("picking a bundled provider installs it, and the card is drawn from the reply", async () => {
  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator(".w-tile").first().waitFor({ timeout: 15000 });
  await page.locator(".w-tile").first().click();

  // The assertion this whole file exists for. "Server URL" is knowable only
  // from the DESCRIPTOR, which does not exist until the install has run — the
  // manifest can say a plugin is called Ollama and nothing about what it wants.
  // A card that said "API key" here would mean the install was skipped or its
  // answer was thrown away.
  const field = page.locator(".w-field label");
  await field.waitFor({ timeout: 15000 });
  assert.equal(await field.textContent(), "Server URL");
  // …and the descriptor's own default is offered rather than invented here.
  assert.match(await page.locator("#w-secret").getAttribute("placeholder"), /^https?:\/\//);

  // The grid is gone: you never look at four vendors you already rejected.
  assert.equal(await page.locator(".w-tiles").isVisible(), false);
  // One dot per call Connect makes. Four would mean one lit before the button
  // existed, since the install already happened on the tile.
  assert.equal(await page.locator(".w-dot").count(), 3);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("a failed connect says why, inline, and leaves what you typed alone", async (t) => {
  // Back to unconfigured whatever happens below. In an `after` and not a last
  // line, because a failing assertion would skip a last line and hand the next
  // test a configured instance — which is a page that has stopped asking, so
  // the next failure would be a timeout with nothing to do with its subject.
  t.after(async () => { for (const k of await listAiKeys(app.db)) await deleteAiKey(app.db, k.id); });

  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator(".w-tile").first().waitFor({ timeout: 15000 });
  await page.locator(".w-tile").first().click();
  await page.locator("#w-secret").waitFor({ timeout: 15000 });
  // A port with nothing on it: the probe is the call that fails, which is the
  // realistic failure (a typo in the URL, a box that is not up yet).
  const typo = "http://127.0.0.1:1/v1";
  await page.locator("#w-secret").fill(typo);
  await page.locator(".w-actions button").click();

  const err = page.locator(".w-err");
  await err.waitFor({ state: "visible", timeout: 15000 });
  // The provider's OWN message, not a sentence this page invented — three
  // calls means three honest failure points, each reporting what its route
  // already writes. Pinned by SHAPE rather than by a phrase: which sentence
  // comes back depends on how the runtime refuses (ECONNREFUSED, a rejected
  // port, a timeout), and any of them is the right answer. What must hold is
  // that it names the provider and the address it actually tried.
  const said = await err.textContent();
  assert.match(said, /^Ollama: /, `the provider's voice, got: ${said}`);
  assert.ok(said.includes(typo), `and the address it tried, got: ${said}`);
  // Still here, still holding the typo. The binding was already stored by the
  // time the probe failed (the order is forced — the probe resolves the
  // capability before calling it), so `setup_pending` is already false and a
  // reload would land on /boards instead of back here. This card is the last
  // cheap chance to fix a character.
  assert.equal(await page.locator("#w-secret").inputValue(), typo);
  assert.equal(await page.locator("#w-next").isVisible(), false);
  // Two of three: the key row and the bind landed, the probe did not.
  assert.equal(await page.locator(".w-dot.is-on").count(), 2);
  // And the finding, stated outright: the redirect is already off. `tag` now
  // RESOLVES — a stored binding resolves whether or not anything answers at
  // the far end — so nothing would send this admin back here.
  const meNow = await fetch(app.base + "/api/me", { headers: { cookie: `sid=${admin.sid}` } });
  assert.equal((await meNow.json()).setup_pending, false);
});


// welcome-plan.md 4.1 — the bug Stage 4 led with, in the place it bit. Every
// test in this file drives OLLAMA, which is a BUNDLED plugin and therefore
// already installed by the time Connect is pressed: 2.3 installs it at
// tile-click so the card can learn which field to draw. A BUILT-IN gets no such
// accident. Before Stage 4 this sequence created a key, bound it, left the
// plugin uninstalled, and resolution's install gate dropped the binding on the
// floor — four of the chooser's five keyed providers, none of them covered,
// because the one that worked (anthropic) worked by a default this stage
// retires.
test("a built-in provider is installed by the act of connecting it", async (t) => {
  t.after(async () => {
    for (const k of await listAiKeys(app.db)) await deleteAiKey(app.db, k.id);
    await setPluginState(app.db, "ai:openai", { installed: false });
  });

  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator(".w-tile").first().waitFor({ timeout: 15000 });

  // The probe is the one call in the sequence that leaves this machine, and a
  // built-in has no base URL to aim at a stand-in the way Ollama does. It is
  // already pinned against a real server below, so here it is answered locally
  // and the subject stays the call BEFORE it.
  await page.route("**/api/admin/capabilities/tag/probe", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ provider: "openai", model: "gpt-5-mini" }),
    }));

  await page.locator('.w-tile[data-plugin="ai:openai"]').click();
  await page.locator("#w-secret").waitFor({ timeout: 15000 });
  await page.locator("#w-secret").fill("sk-not-a-real-key");
  await page.locator(".w-actions button").click();
  await page.locator("#w-next button").waitFor({ timeout: 15000 });

  // Read from the SERVER, not the page. The page would happily show a green
  // card over an instance that cannot tag — that is precisely what it did
  // before, and why no assertion about this screen could have caught it.
  const res = await fetch(app.base + "/api/admin/capabilities/tag", { headers: { cookie: `sid=${admin.sid}` } });
  const tag = await res.json();
  assert.equal(tag.state, "active", `tagging has to actually resolve — got ${tag.state}: ${tag.reason}`);
  assert.equal(tag.running.provider, "openai");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("Connect runs the three calls, and only then does a board become the next step", async () => {
  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator(".w-tile").first().waitFor({ timeout: 15000 });

  // Progressive disclosure with teeth: the step is ABSENT, not disabled. A
  // greyed button here would claim a step exists that does not.
  assert.equal(await page.locator("#w-next").count(), 1);
  assert.equal(await page.locator("#w-next").isVisible(), false);

  await page.locator(".w-tile").first().click();
  await page.locator("#w-secret").waitFor({ timeout: 15000 });
  await page.locator("#w-secret").fill(ollamaUrl());
  await page.locator(".w-actions button").click();

  await page.locator("#w-next button").waitFor({ timeout: 15000 });
  assert.equal(await page.locator("#w-next button").textContent(), "Make your first board");
  // The card's action row is GONE, dots and all: progress for an action that is
  // over is just decoration, and the card has stopped being something you
  // operate. Scoped to the card, because the board button below wears the same
  // class — that is how it gets modal.css's button (see the note there).
  assert.equal(await page.locator("#w-picked .w-actions").count(), 0);
  assert.equal(await page.locator("#w-picked .w-field").count(), 0);
  assert.equal(await page.locator(".w-err").isVisible(), false);

  // The title stops instructing and starts stating, and the footnote answers
  // the question the reader has NOW — where, not whether.
  assert.equal(await page.locator("#w-title").textContent(), "Model connected");
  assert.match(await page.locator("#w-fine").textContent(), /Admin/,
    "where to change it later is Admin → Capabilities; this page is done asking");
  // The provider's LABEL, never its internal name. An installed plugin's is its
  // namespaced manifest id ("community.ollama"), which is a string no reader of
  // this screen has any business seeing — the feed ships names in `running` and
  // labels in `supportedBy` so the lookup stays inside one entry.
  const why = await page.locator("#w-why").textContent();
  assert.match(why, /^Ollama · llama3\.1:8b/, `label, not name: ${why}`);
  // And the way out is gone, because there is nothing left to skip. Leaving
  // "Skip for now — uploads and boards work without it" under a connected model
  // reads as the page not having noticed what just happened.
  assert.equal(await page.locator(".w-foot").isVisible(), false);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// There is no such thing as walking in on a configured instance any more. The
// page spent one release trying to be two things — a first-run guide and a
// place to change your mind — and the second one produced a blank API-key box
// for the provider that was already answering, which added the SAME connection
// a second time and orphaned the first.
//
// So it is a first-run guide and nothing else: if a model is connected, every
// question this page can ask has an answer, and changing one later is Admin →
// Capabilities. Runs straight after the connect test on purpose — that is what
// leaves the instance configured — and hands the instance back unconfigured,
// because everything below needs a chooser to look at.
test("a configured instance has nothing to do here, so it doesn't stay", async (t) => {
  t.after(async () => {
    for (const k of await listAiKeys(app.db)) await deleteAiKey(app.db, k.id);
    await setSetting(app.db, "default_key_id", null);
  });

  const page = await app.open("/welcome", { sid: admin.sid });
  await page.waitForURL(/\/boards$/, { timeout: 15000 });

  // Sent on, not shown a dead end: the chooser never drew, and the boards page
  // it landed on is a real page rather than the gate still spinning.
  assert.equal(await page.locator(".w-tile").count(), 0);
  assert.equal(await page.locator("#gate").isVisible(), false);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

test("the quiet section names them, marks them, and says what the feed says", async () => {
  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator("#w-disclose").waitFor({ timeout: 15000 });

  // Shut, it wears its marks on the right: what is inside, at a glance.
  assert.equal(await page.locator("#w-others").isVisible(), false);
  const marks = page.locator("#w-disclose-marks svg");
  assert.ok(await marks.count() >= 3, "a mark per row while collapsed");

  await page.locator("#w-disclose").click();
  await page.locator("#w-others").waitFor({ state: "visible", timeout: 15000 });
  // One home at a time — the header's copy goes away rather than showing the
  // same glyphs twice on one screen.
  assert.equal(await page.locator("#w-disclose-marks").isVisible(), false);

  const names = await page.locator(".w-other span:not(.w-state)").allTextContents();
  assert.ok(names.includes("Semantic search"), `by their real names, got: ${names.join(", ")}`);
  // Tagging is the decision above, and extraction delegates to it — a row that
  // mirrors the row above it is noise.
  assert.equal(names.includes("Tagging"), false);

  // presentChip verbatim, not a fourth spelling of a state that already has
  // one. On a host with no sidecars the two engines read `unavailable`, while
  // semantic search is already running on the built-in embedder it declares as
  // its floor — which is what `active · built-in` means and why this row can
  // say something true on an instance nobody has configured yet.
  const states = await page.locator(".w-other .w-state").allTextContents();
  assert.ok(states.includes("active · built-in"), `the feed's own words, got: ${states.join(", ")}`);
  assert.ok(states.includes("unavailable"), `the feed's own words, got: ${states.join(", ")}`);

  assert.deepEqual(page.errors, []);
});

test("skip stores the one bit and leaves; a member never gets here at all", async () => {
  // Unconfigured again: skipping is a decision made BEFORE connecting, and on a
  // connected instance the row is correctly gone (asserted above). Cheaper than
  // reordering the file — this case needs a clean instance and the connect
  // cases need each other's leavings.
  for (const k of await listAiKeys(app.db)) await deleteAiKey(app.db, k.id);

  const page = await app.open("/welcome", { sid: admin.sid });
  await page.locator("#w-skip").waitFor({ timeout: 15000 });
  await page.locator("#w-skip").click();
  await page.waitForURL(/\/boards/, { timeout: 15000 });
  assert.equal(await getSetting(app.db, "welcome_skipped"), "1");

  // The page's gate is not a copy of the boot rung in boards.js: that one asks
  // "should this admin be sent here", this one asks "may whoever arrived be
  // here". A member can reach the URL and every route the page calls would
  // refuse them one at a time.
  const member = await seedUser(app.db, "member@welcome.browser");
  await setPassword(app.db, member.id, await hashPassword("welcome-test-pw"));
  const theirs = await app.open("/welcome", { sid: member.sid });
  await theirs.waitForURL(/\/boards/, { timeout: 15000 });
  assert.deepEqual(theirs.errors, []);
});

// The way back is NOT a menu row. It was one for a release: "Setup", always
// present, above Admin. On an instance with nothing left to set up that reads
// as an unfinished task, and it pointed at a page that could no longer help —
// so it is gone, and what remains is the boards page's strip, which appears
// exactly when tagging is broken and says which way it is broken.
//
// Pinned as an ABSENCE because that is the kind of thing that comes back by
// accident: the row is three words and an href, and the argument against it is
// a paragraph.
test("the user menu has no Setup row — the strip is the way back", async () => {
  const page = await app.open("/boards", { sid: admin.sid });
  await page.locator(".user-menu-btn").waitFor({ timeout: 15000 });
  await page.locator(".user-menu-btn").click();
  await page.locator(".user-menu-pop").waitFor({ timeout: 15000 });

  const rows = await page.locator(".user-menu-pop .dd-row").allTextContents();
  assert.deepEqual(rows, ["Admin", "Profile", "Sign out"]);
  assert.equal(await page.locator('.user-menu-pop a.dd-row[href="/welcome"]').count(), 0,
    "nothing in this menu points at the first-run screen");
  assert.deepEqual(page.errors, []);

  // The admin-only rows are still a property of the READER rather than of which
  // page is asking — the reason `me` is an argument to userMenuButton, and the
  // half of that test worth keeping.
  const { user } = await app.signIn({ email: "row@welcome.browser", boardName: "Theirs" });
  const theirs = await app.open("/boards", { sid: user.sid });
  await theirs.locator(".user-menu-btn").waitFor({ timeout: 15000 });
  await theirs.locator(".user-menu-btn").click();
  await theirs.locator(".user-menu-pop").waitFor({ timeout: 15000 });
  assert.deepEqual(await theirs.locator(".user-menu-pop .dd-row").allTextContents(), ["Profile", "Sign out"]);
  assert.deepEqual(theirs.errors, []);
  assert.deepEqual(theirs.failures, [], "and their page asked for nothing it isn’t allowed to have");
});
