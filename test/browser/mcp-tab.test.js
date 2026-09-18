// The MCP tab in a real browser (planning/mcp-stage-1.md §6).
//
// This file exists because of a bug the node suite could not see. The pane
// re-renders from whatever a write ANSWERS, and PATCH/rotate used to answer the
// bare config triple while GET answered the full payload — so the very first
// click on the switch painted `undefined` for the endpoint and threw on a
// missing tool list. Every route test passed; the tab was blank. `page.errors`
// is what catches that, and asserting it is the point of the file.
//
// THREE tests, not one per behaviour, because page loads are the expensive
// thing here. Written as seven (nine page loads), this file tipped the parallel
// `npm test` run over and started failing timing-sensitive tests in OTHER
// files — the harness's own warning that these are slow, made concrete. Each
// test below drives one page through a whole arc instead.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { openApp } from "./harness.js";
import { adminSession } from "../helpers.js";
import { setPassword, createBoard, setSetting } from "../../server/db.js";
import { toolSpecs } from "../../server/mcp-tools.js";
import { hashPassword } from "../../server/password.js";

let app, admin;

before(async () => {
  app = await openApp();
  admin = await adminSession(app.db);
  // A passwordless account is a half-created one — /api/me says needs_password
  // and the page bounces to /login.html before rendering.
  await setPassword(app.db, admin.id, await hashPassword("mcp-tab-pw"));
  // Named, not held by id: the scope popover is addressed by board NAME now.
  await createBoard(app.db, "Scope A", [], "");
  await createBoard(app.db, "Scope B", [], "");
});
after(() => app?.close());

async function openTab() {
  const page = await app.open("/admin.html", { sid: admin.sid });
  // Every confirm() on this pane is destructive by design; a browser test that
  // never answers them would hang on the first.
  page.on("dialog", (d) => d.accept());
  await page.click('[data-tab="mcp"]');
  await page.waitForSelector("#mcp-content h2");
  return page;
}

// Both switches are switch.js's `.switch` button — a real <button role=switch>
// rather than a checkbox, so state is aria-checked and not `.checked`.
const switchOn = async (page, sel) => (await page.getAttribute(`${sel} .switch`, "aria-checked")) === "true";
const flip = (page, sel) => page.click(`${sel} .switch`);

const turnOn = async (page) => {
  if (!(await switchOn(page, "#mcp-on"))) await flip(page, "#mcp-on");
  await page.waitForSelector("#mcp-cmd");
};

// The tool list's machine names — what a caller actually types.
const toolNames = (page) => page.$$eval(".mcp-t code", (els) => els.map((e) => e.textContent));

test("off by default, and switching on paints a complete, copyable command", async () => {
  const page = await openTab();
  // The tab and its heading name the protocol. "Agents" said nothing about what
  // this speaks, which is the one thing an operator needs in order to use it.
  assert.equal(await page.textContent('[data-tab="mcp"]'), "MCP");
  assert.equal(await page.textContent("#mcp-content h2"), "MCP");
  assert.equal(await switchOn(page, "#mcp-on"), false);
  // The body stays hidden while it is off — there is no command to give out.
  assert.equal(await page.isHidden("#mcp-body"), true);

  await turnOn(page);
  const cmd = await page.textContent("#mcp-cmd");
  // The exact failure the paneState fix was for: a re-render from the PATCH
  // answer must know the endpoint and must carry the freshly minted token.
  assert.match(cmd, /claude mcp add --transport http boards/);
  assert.doesNotMatch(cmd, /undefined/, "the write's answer carried the endpoint");
  assert.match(cmd, /Authorization: Bearer \S+/, "enabling minted a token");

  // The tool list — served, not hardcoded — rendered its rows. Compared against
  // the registry itself, so adding a tool cannot make this test wrong.
  assert.deepEqual((await toolNames(page)).sort(), toolSpecs().map((t) => t.name).sort());
  // Each row carries the human title the server has always sent and this pane
  // used to throw away. It does NOT carry the tool's `description`, which is
  // written for the model and cost half the page to say nothing an operator
  // acts on — the regression this asserts against is putting it back.
  const titles = await page.$$eval(".mcp-t .t", (els) => els.map((e) => e.textContent));
  assert.deepEqual(titles.sort(), toolSpecs().map((t) => t.title).sort());
  assert.doesNotMatch(
    await page.textContent(".mcp-tools"),
    /Call this before|Prefer ONE composed call/,
    "the model-facing description stays out of the operator's pane"
  );
  // Read and write are groups with counts, so the saving switch has a
  // structural readout rather than one row leaving a list of five.
  assert.deepEqual(
    await page.$$eval(".mcp-group", (els) => els.map((e) => e.textContent.trim())),
    [`read${toolSpecs(false).length}`, "write1"]
  );

  // The saving switch is ON with nothing stored — absence is not a choice —
  // and the table below it is its readout: untick it and the write tool leaves
  // the vocabulary.
  //
  // ONE round trip, not two. Whether the pane and tools/list agree in both
  // positions is pinned at the route level (mcp-admin.test.js), and what only
  // a browser can say is that the checkbox is wired to anything at all — the
  // shape of the bug this whole file exists for. Ticking it back afterwards
  // proved nothing and cost another PATCH, and the second one was enough to
  // start failing welcome.test.js in the parallel run again.
  assert.equal(await switchOn(page, "#mcp-write"), true);
  await flip(page, "#mcp-write");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".mcp-t code").length === n,
    toolSpecs(false).length
  );
  assert.deepEqual((await toolNames(page)).sort(), toolSpecs(false).map((t) => t.name).sort());
  // The whole `write` group went with it, not just its row.
  assert.deepEqual(await page.$$eval(".mcp-group", (els) => els.length), 1);

  // Switching back off hides the body again. waitForSelector waits for VISIBLE
  // by default and the claim is that it went away, so ask the element itself.
  await flip(page, "#mcp-on");
  await page.waitForFunction(() => document.getElementById("mcp-body")?.hidden === true);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// The command IS the token surface now — there is no second place it appears,
// which is what makes masking it mean anything. It used to be dotted out in a
// Token section while printed in full in the command directly above.
test("the token: masked in the command, revealed, rotated, cleared", async () => {
  const page = await openTab();
  await turnOn(page);

  const bearer = async () => (await page.textContent("#mcp-cmd")).match(/Bearer (\S+)/)?.[1];
  assert.match(await bearer(), /·{6,}/, "masked until asked for");
  await page.click("#mcp-show");
  const shown = await bearer();
  assert.doesNotMatch(shown, /·/, "show reveals the whole token, in place");

  await page.click("#mcp-rotate");
  await page.waitForFunction(
    (old) => !document.getElementById("mcp-cmd")?.textContent.includes(old),
    shown
  );
  const rotated = await bearer();
  assert.notEqual(rotated, shown);
  // A rotate that left the token hidden would hand back something unpastable.
  assert.doesNotMatch(rotated, /·/);

  await page.click("#mcp-clear");
  await page.waitForSelector("#mcp-rotate:has-text('create')");
  const cmd = await page.textContent("#mcp-cmd");
  assert.doesNotMatch(cmd, /Authorization/, "no token, no header — the local-only shape");
  assert.doesNotMatch(cmd, /\\\s*$/, "and no dangling line continuation");
  assert.match(await page.textContent("#mcp-content"), /loopback/);
  assert.deepEqual(page.errors, []);
});

// The MCP App view (planning/mcp-stage-4.md §3). It lives in this file, not its
// own, on purpose: a new browser FILE is a new Chromium and a new Postgres
// clone, and that cost is what made welcome.test.js and ingest-sweep.test.js
// start failing twice in this arc. The view needs neither — it is a
// self-contained HTML string and a stub host — so it costs one page load here
// and nothing anywhere else.
test("the view: renders the grid, picks tiles, and calls save_to_crate", async () => {
  const html = fs.readFileSync(new URL("../../server/mcp-app.html", import.meta.url), "utf8");
  // The browser directly, not app.open: the view talks to its host and to
  // nothing else, so this costs a page object and NO navigation against the
  // server at all — which is the whole reason it can live in this file.
  const page = await app.browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.errors = errors;

  // A stub host: an iframe with the real view inside, and just enough
  // JSON-RPC-over-postMessage on the outside to answer ui/initialize and
  // record what the view asks for.
  // The listener goes up BEFORE the iframe exists. Written the other way round
  // the view's ui/initialize lands before anything is listening and is simply
  // lost — which is also why a real host attaches first and frames second.
  const srcdoc = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  await page.setContent(`<script>
      window.calls = [];
      addEventListener("message", (e) => {
        const m = e.data;
        if (!m || m.jsonrpc !== "2.0") return;
        window.calls.push(m);
        const reply = (result) => e.source.postMessage({ jsonrpc: "2.0", id: m.id, result }, "*");
        if (m.method === "ui/initialize") reply({});
        if (m.method === "tools/call") reply({ content: [{ type: "text", text: "Saved 2 cards to \\"Picks\\"." }] });
      });
    <\/script>
    <iframe id="v" srcdoc="${srcdoc}" style="width:600px;height:400px;border:0"></iframe>`);

  const view = page.frameLocator("#v");
  await page.waitForFunction(() => window.calls.some((c) => c.method === "ui/initialize"));

  // The host hands over a tool result the way a real one does.
  await page.evaluate(() => {
    const cards = Array.from({ length: 4 }, (_, i) => ({
      id: 100 + i,
      // A data: URI, so the test needs no server and no signed link — the view
      // does not care where a thumb URL points.
      thumb: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
      w: 4, h: 3, caption: "theme/dark",
    }));
    document.getElementById("v").contentWindow.postMessage({
      jsonrpc: "2.0",
      method: "ui/notifications/tool-result",
      params: { structuredContent: { board: { id: "b1", name: "UI board" }, matched: 9, canSave: true, cards } },
    }, "*");
  });

  await view.locator(".tile").first().waitFor();
  assert.equal(await view.locator(".tile").count(), 4);
  assert.match(await view.locator("#head").textContent(), /UI board.*9 matched · showing 4/);
  // The save bar stays out of the way until there is something to save.
  assert.equal(await view.locator("#bar.on").count(), 0);

  await view.locator('.tile[data-i="0"]').click();
  await view.locator('.tile[data-i="2"]').click();
  await view.locator("#bar.on").waitFor();
  assert.equal(await view.locator("#count").textContent(), "2 picked");

  await view.locator("#crate").fill("Picks");
  await view.locator("#save").click();
  await page.waitForFunction(() => window.calls.some((c) => c.method === "tools/call"));

  const call = await page.evaluate(() => window.calls.find((c) => c.method === "tools/call"));
  assert.equal(call.params.name, "save_to_crate");
  // The ids the tiles carry, not their positions — the one thing a grid can
  // silently get wrong and still look right.
  assert.deepEqual(call.params.arguments, { board: "b1", crate: "Picks", ids: [100, 102] });

  // A successful save reports what the tool said and clears the selection, so
  // a second click cannot re-save the same cards by accident.
  await view.locator("#note").filter({ hasText: "Saved 2 cards" }).waitFor();
  assert.equal(await view.locator("#bar.on").count(), 0);
  assert.deepEqual(page.errors, []);
});

// mcp-stage-4.md §8.5, question 1 — and the only one of the two that can be
// answered without a real host.
//
// A ui:// view runs under a CSP the host derives from `_meta.ui.csp`. We put
// this instance's own origin in `resourceDomains` so the grid can load signed
// thumbnails, and on a dev box that origin is plain `http://127.0.0.1:<port>`.
// Nothing in the node suite can tell whether a browser HONOURS that — a CSP is
// enforced by the browser or it is not enforced at all — so this builds the
// policy from what the server ACTUALLY SERVES and asks Chromium.
//
// The distinction that matters is blocked-by-policy versus merely-404: an image
// that CSP refuses fires securitypolicyviolation, and a missing one does not.
test("a host's CSP, built from what we serve, admits our thumbnails", async () => {
  await setSetting(app.db, "mcp_enabled", "1");
  const read = await fetch(app.base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "ui://001az-boards/board-grid" } }),
  }).then((r) => r.json());
  const { resourceDomains } = read.result.contents[0]._meta.ui.csp;
  assert.equal(resourceDomains.length, 1);

  // The spec's WHOLE default policy, widened by exactly what we declared —
  // which is what a conforming host composes. Writing only the img-src
  // directive was the first attempt and it blocked this test's own probe
  // script, because `script-src` then falls back to `default-src 'none'`: a
  // useful reminder that the view's inline <script> lives or dies by that one
  // `'unsafe-inline'`.
  const policy = [
    "default-src 'none'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: ${resourceDomains.join(" ")}`,
    "connect-src 'none'",
  ].join("; ");
  const page = await app.browser.newPage();
  await page.setContent(`<meta http-equiv="Content-Security-Policy" content="${policy}" />
    <script>
      window.blocked = [];
      addEventListener("securitypolicyviolation", (e) => window.blocked.push(e.blockedURI));
    <\/script>
    <img id="ours" src="${resourceDomains[0]}/mcp/thumb/nope.png/1/x" />
    <img id="other" src="https://example.invalid/x.png" />`);

  await page.waitForFunction(() => window.blocked.length > 0, null, { timeout: 5000 });
  const blocked = await page.evaluate(() => window.blocked);
  // The foreign origin is refused — which proves the policy is live, not that
  // Chromium ignored a malformed one.
  assert.ok(blocked.some((u) => u.includes("example.invalid")), "an undeclared origin is blocked");
  // Ours is not. The request 404s (that path is unsigned), and a 404 is a
  // request the browser was ALLOWED to make.
  assert.ok(
    !blocked.some((u) => u.includes(new URL(resourceDomains[0]).host)),
    `a host CSP built from our own metadata blocked us: ${JSON.stringify(blocked)}`
  );
  await setSetting(app.db, "mcp_enabled", null);
});

test("board scope persists, and last used renders both states", async () => {
  await setSetting(app.db, "mcp_last_used", null);
  const page = await openTab();
  await turnOn(page);

  assert.match(await page.textContent("#mcp-body"), /never used yet/);

  // Scope is the Members tab's chip + access popover, so the closed state is a
  // SENTENCE, not a row of boxes: the two ways of saying everything (all ticked,
  // none ticked) have one readout, which they could not have as checkboxes.
  assert.equal(await page.textContent("#mcp-scope"), "All boards");

  await page.click("#mcp-scope");
  await page.waitForSelector(".dd-check");
  const labels = await page.$$eval(".dd-check .cb-text", (els) => els.map((e) => e.textContent.trim()));
  assert.ok(labels.includes("Scope A") && labels.includes("Scope B"));
  // An empty scope reads as everything ticked, because that is what empty MEANS.
  assert.equal(await page.$$eval(".dd-check .cb-input:not(:checked)", (e) => e.length), 0);

  // Untick one and Save. The popover batches, so this is ONE PATCH and one
  // repaint — as checkboxes it was a PATCH and a full pane rebuild per tick.
  // The row IS the <label>; .cb-box is pointer-events:none by design.
  await page.click(`.dd-check:has-text("Scope A")`);
  await page.click(".dd-footer .dd-action");
  await page.waitForFunction(() => document.getElementById("mcp-scope")?.textContent === "1 of 2 boards");

  // Persistence and the "last used" copy in ONE reload rather than two: both
  // are facts about what a freshly loaded pane says.
  await setSetting(app.db, "mcp_last_used", String(Date.now() - 3 * 3600 * 1000));
  const again = await openTab();
  await again.waitForSelector("#mcp-scope");
  assert.equal(await again.textContent("#mcp-scope"), "1 of 2 boards", "the untick survived");
  // relTime's vocabulary — the admin shell's one phrasing for "when", not a
  // sixth private copy of it (utils.js:458 says so in as many words).
  assert.match(await again.textContent("#mcp-body"), /last used 3h ago/);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(again.errors, []);
});
