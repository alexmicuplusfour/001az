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
import { adminSession, seedUser, mcpToken, ADMIN_EMAIL } from "../helpers.js";
import { setPassword, createBoard, setSetting, setMcpToken, setUserName } from "../../server/db.js";
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
  // A burner connection for the Connections list to revoke. NOT the admin's:
  // that token is what every other call in this file defaults to (helpers.js),
  // and §10.8 recorded three tests that broke by disturbing it.
  const victim = await seedUser(app.db, "revoked@test.local");
  await setMcpToken(app.db, victim.id, "browser-revoke-token-vvvvv");
  // Named with markup on purpose. A member sets their own name from Account ->
  // Profile and the server stores it verbatim, so the person cell is the one
  // place on an admin page where member-controlled text meets innerHTML.
  await setUserName(app.db, victim.id, '<img src=x onerror="window.__xss = 1">');
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
  // The saving switch, which is this tab's and inside the body the enable
  // switch hides. It used to wait on the command — that moved to the account
  // page with the token it carries.
  await page.waitForSelector("#mcp-write");
};

// The tool list's machine names — what a caller actually types.
const toolNames = (page) => page.$$eval(".mcp-t code", (els) => els.map((e) => e.textContent));

test("off by default, and switching on paints the instance's controls", async () => {
  const page = await openTab();
  // The tab and its heading name the protocol. "Agents" said nothing about what
  // this speaks, which is the one thing an operator needs in order to use it.
  assert.equal(await page.textContent('[data-tab="mcp"]'), "MCP");
  assert.equal(await page.textContent("#mcp-content h2"), "MCP");
  assert.equal(await switchOn(page, "#mcp-on"), false);
  // The body stays hidden while it is off — there is nothing to set up yet.
  assert.equal(await page.isHidden("#mcp-body"), true);

  await turnOn(page);
  // NO COMMAND HERE. A token belongs to a person, so this tab points at the
  // page where every member reads their own — carrying a second copy would be
  // one connection with two rotate buttons (§10.14).
  assert.equal(await page.$$eval("#mcp-cmd", (e) => e.length), 0, "no command on the instance tab");
  const body = await page.textContent("#mcp-body");
  assert.match(body, /Account → MCP/);
  assert.equal(await page.getAttribute('#mcp-body a[href^="/account.html"]', "href"), "/account.html#mcp");

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

  // The Connections list — the oversight half of this tab, and the only thing
  // here that acts on somebody else. Two rows: the admin's own (the token every
  // other call in this file rides on) and the burner seeded above.
  const connected = () => page.$$eval("#mcp-connections .email", (els) => els.map((e) => e.textContent));
  const before = await connected();
  assert.ok(before.includes("revoked@test.local"), "the burner's connection is listed");
  assert.ok(before.includes(ADMIN_EMAIL), "and the admin's own, not hidden from itself");
  // No token anywhere on the page, masked or otherwise (§3) — an admin reads
  // who is connected, never what with. outerHTML rather than textContent: a
  // token parked in a data- attribute or a title would pass the softer check.
  const tableHtml = await page.$eval("#mcp-connections", (el) => el.outerHTML);
  assert.doesNotMatch(tableHtml, /browser-revoke-token/);

  // And the person cell renders a member's name as TEXT. Before utils.js owned
  // this cell, the Members tab interpolated it raw and a name like the one
  // seeded above became an ELEMENT in the admin's DOM — only CSP's
  // `script-src 'self'` stood between that and script execution.
  assert.equal(await page.$$eval("#mcp-connections .name-cell img", (els) => els.length), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.match(await page.textContent("#mcp-connections"), /<img src=x/, "shown, not parsed");

  // Addressed by row INDEX off the rendered order rather than a :has-text
  // selector, so this says what it means when the list grows a row.
  await page.click(
    `#mcp-connections tbody tr:nth-child(${before.indexOf("revoked@test.local") + 1}) button.danger`
  );
  await page.waitForFunction(
    (n) => document.querySelectorAll("#mcp-connections tbody tr").length === n,
    before.length - 1
  );
  const after = await connected();
  assert.ok(!after.includes("revoked@test.local"), "the row that was clicked went");
  assert.ok(after.includes(ADMIN_EMAIL), "and the one that was not did not");

  // Switching back off hides the body again. waitForSelector waits for VISIBLE
  // by default and the claim is that it went away, so ask the element itself.
  await flip(page, "#mcp-on");
  await page.waitForFunction(() => document.getElementById("mcp-body")?.hidden === true);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
});

// The account page's MCP tab — a NON-ADMIN doing the whole thing for
// themselves, which is what stage 2 is for. In this file rather than its own
// because a new browser FILE is a new Chromium and a new Postgres clone, and
// that cost is what made welcome.test.js flake in the parallel run.
test("a member mints their own token on the account page", async () => {
  // The test above leaves the instance switched off (it checks that hiding the
  // body works), and a member's pane correctly says so rather than offering a
  // token that could not connect. Switch it on directly: whether the admin's
  // switch works is the subject up there, not here.
  await setSetting(app.db, "mcp_enabled", "1");
  const { user } = await app.signIn({ email: "member@test.local", boardName: "Their board" });
  const page = await app.open("/account.html", { sid: user.sid });
  page.on("dialog", (d) => d.accept());

  // The page is Account, and the tab that used to be its only one is Profile.
  assert.equal(await page.textContent("h1"), "Account");
  assert.equal(await page.textContent('[data-tab="profile"]'), "Profile");
  // The older half still works after the rename.
  assert.equal(await page.inputValue("#name-input"), "");

  await page.click('[data-tab="mcp"]');
  await page.waitForSelector("#mcp-cmd");
  // No token yet: a line asking for one, not a command that cannot connect.
  assert.match(await page.textContent("#mcp-cmd"), /Create a token/);
  // Their board, from the same rule the tools apply.
  assert.match(await page.textContent(".mcp-boards"), /Their board/);

  await page.click("#mcp-rotate");
  await page.waitForSelector("#mcp-copy");
  const cmd = await page.textContent("#mcp-cmd");
  assert.match(cmd, /claude mcp add --transport http boards/);
  assert.match(cmd, /Authorization: Bearer \S+/, "minted, and in the command");
  assert.doesNotMatch(cmd, /undefined/, "the write's answer carried the endpoint");
  // Freshly minted is revealed, not masked — a token you cannot see is a token
  // you cannot paste.
  assert.doesNotMatch(cmd.match(/Bearer (\S+)/)[1], /·/);

  await page.click("#mcp-show");
  assert.match((await page.textContent("#mcp-cmd")).match(/Bearer (\S+)/)[1], /·{6,}/, "hide masks it again");

  await page.click("#mcp-clear");
  await page.waitForSelector("#mcp-rotate:has-text('create')");
  assert.doesNotMatch(await page.textContent("#mcp-cmd"), /Authorization/);

  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.failures, []);
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
    headers: {
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2025-06-18",
      // A bearer names a person now, and there is no tokenless path left for a
      // caller on the machine itself (planning/mcp-members-plan.md §4).
      Authorization: `Bearer ${await mcpToken(app.base)}`,
    },
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

test("board scope persists across a reload", async () => {
  const page = await openTab();
  await turnOn(page);

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
  //
  // Counted off the chip rather than written down: other tests in this file
  // seed boards of their own, and a hardcoded "1 of 2" makes this test depend
  // on how many of them ran first.
  const want = `${labels.length - 1} of ${labels.length} boards`;
  await page.click(`.dd-check:has-text("Scope A")`);
  await page.click(".dd-footer .dd-action");
  await page.waitForFunction((t) => document.getElementById("mcp-scope")?.textContent === t, want);

  // Persistence, on a freshly loaded pane.
  const again = await openTab();
  await again.waitForSelector("#mcp-scope");
  assert.equal(await again.textContent("#mcp-scope"), want, "the untick survived");

  assert.deepEqual(page.errors, []);
  assert.deepEqual(again.errors, []);
});
