// The gallery's top toolbar row fits any width by folding, a step at a time,
// in a real browser (planning/toolbar-fold-plan.md). There's no breakpoint to
// test: what the row holds depends on the board, on who's looking and on live
// figures. So the board here is shaped like the one that broke on a phone,
// "stocks test": an admin, Stocks' starting mapping, a big token chip and a
// 23h ingest countdown. It wants 744px, and the header gives it the window's
// width less 54px.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { createBoard, setBoardMembers, updateBoard, meter, createEntity, insertItem, setFacetDiagnostic, setPassword } from "../../server/db.js";
import { hashPassword } from "../../server/password.js";
import { facetStamp, questionOf } from "../../server/facet-diagnosis.js";
import { manifest as stocks } from "../../server/connectors/stocks/index.js";
import { seedUser } from "../helpers.js";

// The steps, in toolbar.js's order, and what each one hides.
const FOLDS = ["coin", "type", "edit", "logo", "countdown", "names", "ingest", "usage"];
const HIDES = {
  coin: ".token-chip .odo",
  type: ".type-chip",
  edit: ".board-edit-btn",
  logo: ".toolbar-logo",
  countdown: ".ingest-chip-eta",
  ingest: ".ingest-chip",
  usage: ".token-chip",
};
const DESKTOP = (width) => ({ viewport: { width, height: 800 } });
const PHONE = (width) => ({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });

let app, alex, longName;
const boards = {};

before(async () => {
  app = await openApp();
  const { user, boardId } = await app.signIn({ email: "alex@test.local", boardName: "stocks test" });
  await app.db.query("UPDATE users SET is_admin = TRUE, name = 'alex' WHERE id = $1", [user.id]);
  alex = user;
  boards.stocks = boardId;
  await updateBoard(app.db, boardId, {
    mapping: { ...stocks.template },
    ingest: { enabled: true, trigger: { mode: "interval", every_min: 1440 } },
    ingestNextRunAt: Date.now() + 23 * 3600e3,
  });
  // ↑15,823k ↓8,638k $136.60
  await meter(app.db, { boardId, capability: "tag", provider: "anthropic", model: "m" },
    { input_tokens: 15823000, output_tokens: 8638000 }, { input_tokens: 3, output_tokens: 10.318 });

  // A second admin whose menu shows a long address (no name), capped at 130px.
  longName = await seedUser(app.db, "alexandra.longname@example.com");
  await app.db.query("UPDATE users SET is_admin = TRUE WHERE id = $1", [longName.id]);
  await setPassword(app.db, longName.id, await hashPassword("browser-test-pw")); // or the page bounces to login

  // A vote board with a tagging-consistency finding its reader hasn't seen:
  // 25 tagged items, 10 of them split, and the finding stored for the facet.
  const facets = [{ key: "shape", label: "Shape", single: true, description: "the silhouette", values: ["round", "wide"] }];
  boards.votes = await createBoard(app.db, "votes board", facets, "", true, null, null, { enabled: false });
  await setBoardMembers(app.db, boards.votes, [user.id]);
  await updateBoard(app.db, boards.votes, { aiVotes: 3 });
  const d = facetStamp(facets[0], false);
  for (let i = 0; i < 25; i++) {
    const eid = await createEntity(app.db, boards.votes, { identity: `v${i}` });
    const id = await insertItem(app.db, boards.votes, { identity: `v${i}`, files: [], fields: {} }, "pending", eid);
    const split = i >= 15;
    await app.db.query("UPDATE items SET status = 'tagged', tag_confidence = $1 WHERE id = $2", [
      JSON.stringify({ shape: { of: 3, agreed: split ? 2 : 3, votes: split ? { round: 2, wide: 1 } : { round: 3 }, d } }), id,
    ]);
  }
  await setFacetDiagnostic(app.db, boards.votes, "shape", {
    verdict: "overlapping-values", explanation: "round and wide overlap", values: ["round"], rewrite: "prefer wide",
    stats: { items: 25, unanimous: 15 }, split: ["wide"], d, scoped: false, k: questionOf({ d }), at: Date.now(),
  });
});
after(() => app?.close());

// The board page, its top row drawn and the web font in.
async function openBoard(boardId, { device = DESKTOP(1200), sid = alex.sid } = {}) {
  const page = await app.open(`/?board=${boardId}`, { sid, device });
  await page.waitForSelector("#toolbar .board-btn");
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  return page;
}
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// The top row as the reader sees it: the steps taken, how far anything spills
// past the row or over its neighbour, which of each step's controls show,
// and the two name buttons.
const readRow = (page) => page.evaluate((HIDES) => {
  const row = document.getElementById("toolbar");
  const shown = (el) => !!el && el.getClientRects().length > 0;
  const rect = (sel) => { const el = row.querySelector(sel); return shown(el) ? el.getBoundingClientRect() : null; };
  const controls = [...row.querySelectorAll(".toolbar-logo, .tool-btn, .mapping-chip")].filter(shown)
    .map((el) => el.getBoundingClientRect()).sort((a, b) => a.left - b.left);
  let overlap = 0;
  for (let i = 1; i < controls.length; i++) overlap = Math.max(overlap, controls[i - 1].right - controls[i].left);
  const name = row.querySelector(".board-name");
  return {
    fold: row.dataset.fold,
    overflow: row.scrollWidth - row.clientWidth,
    overlap: Math.round(overlap * 10) / 10,
    hidden: Object.fromEntries(Object.entries(HIDES).map(([step, sel]) => [step, !shown(row.querySelector(sel))])),
    board: Math.round(rect(".board-btn").width),
    nameCut: name.scrollWidth > name.clientWidth,
    user: Math.round(rect(".user-menu-btn").width),
    // the right-hand controls hold the row's right edge
    userToEdge: Math.round(row.getBoundingClientRect().right - rect(".user-menu-btn").right),
  };
}, HIDES);

async function rowAt(page, width) {
  await page.setViewportSize({ width, height: 800 });
  await frames(page);
  return readRow(page);
}

const stepsOf = (fold) => (fold ? fold.split(" ") : []);

test("the top row folds a step at a time as the window narrows, in order, and unfolds the same way", async () => {
  const page = await openBoard(boards.stocks);
  const widths = [];
  for (let w = 1200; w >= 320; w -= 10) widths.push(w);
  const down = new Map();
  for (const w of widths) down.set(w, await rowAt(page, w));
  const up = new Map();
  for (const w of [...widths].reverse()) up.set(w, await rowAt(page, w));

  const wide = down.get(1200);
  assert.equal(wide.fold, "", "room to spare: no steps");
  assert.equal(wide.nameCut, false);
  let taken = 0;
  for (const w of widths) {
    const r = down.get(w);
    const steps = stepsOf(r.fold);
    const at = `at ${w}px (${r.fold})`;
    assert.deepEqual(steps, FOLDS.slice(0, steps.length), `the steps go in order ${at}`);
    assert.ok(steps.length >= taken, `a narrower window never takes a step back ${at}`);
    taken = steps.length;
    assert.ok(r.overflow <= 0, `nothing spills past the row ${at}: ${r.overflow}px`);
    assert.ok(r.overlap <= 0, `no control slides over the next ${at}: ${r.overlap}px`);
    assert.equal(r.userToEdge, 0, `the user menu holds the right edge ${at}`);
    for (const [step, hidden] of Object.entries(r.hidden)) {
      assert.equal(hidden, steps.includes(step), `${step}'s control ${hidden ? "hidden" : "shown"} ${at}`);
    }
    if (!steps.includes("names")) assert.equal(r.nameCut, false, `the board name is whole until the names step ${at}`);
    assert.ok(r.board >= 80, `the board button never goes under 80px ${at}: ${r.board}`);
    assert.equal(r.user, wide.user, `"alex" never shrinks or grows ${at}`);
    assert.deepEqual(up.get(w), r, `growing back gives the same row ${at}`);
  }
  assert.equal(taken, FOLDS.length, "by 320px every step is taken");
  assert.ok(down.get(320).nameCut, "and the board name gives way");
  assert.deepEqual(page.errors, []);
});

test("the spacing is the row's old spacing: 14px after the logo, 6px in the board's cluster, 10px on the right", async () => {
  const page = await openBoard(boards.stocks);
  const gaps = await page.evaluate(() => {
    const row = document.getElementById("toolbar");
    const box = (sel) => row.querySelector(sel).getBoundingClientRect();
    const gap = (a, b) => Math.round(box(b).left - box(a).right);
    return {
      logo: gap(".toolbar-logo", ".board-btn"),
      pencil: gap(".board-btn", ".board-edit-btn"),
      type: gap(".board-edit-btn", ".type-chip"),
      token: gap(".type-chip", ".token-chip"),
      jobs: gap(".token-chip", ".jobs-chip"),
      plus: gap(".ingest-chip", ".upload"),
      caret: gap(".upload", ".plus-caret"),
      user: gap(".plus-caret", ".user-menu-btn"),
    };
  });
  assert.deepEqual(gaps, { logo: 14, pencil: 6, type: 6, token: 6, jobs: 6, plus: 10, caret: 6, user: 10 });

  // The boards page wears the same header and row.
  const boardsPage = await app.open("/boards", { sid: alex.sid, device: DESKTOP(1200) });
  await boardsPage.waitForSelector("#toolbar .user-menu-btn");
  const row = await boardsPage.evaluate(() => {
    const row = document.getElementById("toolbar").getBoundingClientRect();
    const user = document.querySelector("#toolbar .user-menu-btn").getBoundingClientRect();
    const create = document.querySelector("#toolbar .auth > .tool-btn:not(.user-menu-btn)").getBoundingClientRect();
    return { userToEdge: Math.round(row.right - user.right), createToUser: Math.round(user.left - create.right) };
  });
  assert.deepEqual(row, { userToEdge: 0, createToUser: 10 });
  assert.deepEqual([...page.errors, ...boardsPage.errors], []);
});

test("a long address gives way too, beside the board's name, and both hold 80px", async () => {
  // Fitted down to 340px. Under that, with every step taken and both names at
  // 80px, this row is out of room: its right end clips, and nothing slides
  // over its neighbour.
  const page = await openBoard(boards.stocks, { sid: longName.sid });
  const wide = await rowAt(page, 1200);
  let squeezed = null;
  for (let w = 1200; w >= 320 && !squeezed; w -= 10) {
    const r = await rowAt(page, w);
    if (r.user < wide.user) squeezed = { w, ...r };
  }
  assert.ok(squeezed, "the long address gives way somewhere");
  assert.ok(stepsOf(squeezed.fold).includes("names"), `only from the names step: ${squeezed.fold}`);
  const fits = await rowAt(page, 340);
  assert.ok(fits.overflow <= 0 && fits.overlap <= 0, `fits at 340: ${fits.overflow}px over, ${fits.overlap}px overlap`);
  const narrow = await rowAt(page, 320);
  assert.deepEqual([narrow.user, narrow.board], [80, 80], "both at 80px at 320");
  assert.ok(narrow.overlap <= 0, "the row clips at its end; nothing slides over its neighbour");
  assert.deepEqual(page.errors, []);
});

test("the pencil and the ticks come back in the boards menu when they fold, the ticks' dot riding the board button", async () => {
  const page = await openBoard(boards.votes);
  const look = () => page.evaluate(() => {
    const shown = (sel) => !!document.querySelector(sel)?.getClientRects().length;
    return {
      pencil: shown("#toolbar .board-edit-btn"),
      ticks: shown("#toolbar .board-diag-btn"),
      ticksDot: shown("#toolbar .board-diag-btn > .btn-dot"),
      boardDot: shown("#toolbar .board-btn > .btn-dot"),
    };
  });
  const menu = async () => {
    await page.click("#toolbar .board-btn");
    const rows = await page.$$eval(".board-pop .dd-footer .dd-action", (els) => els.map((el) => ({
      label: el.textContent, dot: !!el.querySelector(".dd-icon > .btn-dot"),
    })));
    await page.keyboard.press("Escape");
    await page.waitForSelector(".board-pop", { state: "detached" });
    return rows;
  };
  await page.waitForSelector("#toolbar .board-diag-btn > .btn-dot");
  assert.deepEqual(await look(), { pencil: true, ticks: true, ticksDot: true, boardDot: false }, "room: both on the row, the dot on the ticks");
  assert.deepEqual(await menu(), [{ label: "All boards", dot: false }, { label: "New board", dot: false }]);

  let r;
  for (let w = 1200; w >= 320; w -= 10) {
    r = await rowAt(page, w);
    if (stepsOf(r.fold).includes("edit")) break;
  }
  assert.deepEqual(await look(), { pencil: false, ticks: false, ticksDot: false, boardDot: true }, `folded (${r.fold}): the dot rides the board button`);
  assert.deepEqual(await menu(), [
    { label: "Edit board", dot: false },
    { label: "Tagging consistency", dot: true },
    { label: "All boards", dot: false },
    { label: "New board", dot: false },
  ]);

  await page.click("#toolbar .board-btn");
  await page.click(".board-pop .dd-action:has-text('Edit board')");
  await page.waitForSelector(".modal-title:has-text('Edit board')");
  assert.deepEqual(page.errors, []);
});

test("the coin opens the usage breakdown: on hover under a mouse, and on a tap it stays", async () => {
  const breakdown = (page) => page.$$eval(".usage-pop:not(.is-closing) :is(.dd-head, .dd-row, .dd-empty)", (els) => els.map((el) => el.textContent));
  const want = ["AI usage", "15.8M input tokens", "8.6M output tokens", "$136.60 at the rates known when each call ran"];

  const desk = await openBoard(boards.stocks);
  await desk.hover("#toolbar .token-chip");
  await desk.waitForSelector(".usage-pop");
  assert.deepEqual(await breakdown(desk), want);
  assert.equal(await desk.getAttribute("#toolbar .token-chip", "title"), null, "the pop replaces the tooltip");
  await desk.mouse.move(600, 700);
  await desk.waitForSelector(".usage-pop", { state: "detached" });

  const phone = await openBoard(boards.stocks, { device: PHONE(390) });
  const r = await readRow(phone);
  assert.ok(stepsOf(r.fold).includes("coin") && !r.hidden.usage, `a phone shows the coin alone (${r.fold})`);
  await phone.tap("#toolbar .token-chip");
  await phone.waitForSelector(".usage-pop");
  await phone.waitForTimeout(400); // past a hover pop's close delay and fade
  assert.deepEqual(await breakdown(phone), want, "the tap's pop stays");
  await phone.tap("#grid", { position: { x: 20, y: 20 } });
  await phone.waitForSelector(".usage-pop", { state: "detached" });
  assert.deepEqual([...desk.errors, ...phone.errors], []);
});

test("the countdown folds to its icon and its tooltip keeps the time", async () => {
  const page = await openBoard(boards.stocks);
  let r;
  for (let w = 1200; w >= 320; w -= 10) {
    r = await rowAt(page, w);
    if (stepsOf(r.fold).includes("countdown")) break;
  }
  assert.equal(r.hidden.countdown, true);
  assert.equal(r.hidden.ingest, false, "the chip itself stays");
  const title = await page.getAttribute("#toolbar .ingest-chip", "title");
  assert.match(title, /next run in 23h/);
  assert.deepEqual(page.errors, []);
});

test("the fold follows what the row draws, not only the window: renamed longer, the board folds more", async () => {
  const page = await openBoard(boards.stocks);
  let r;
  for (let w = 1200; w >= 320; w -= 10) {
    r = await rowAt(page, w);
    if (r.fold === "coin") break;
  }
  assert.equal(r.fold, "coin", "setup: a width where only the coin has folded");
  // Renamed in the board editor, the way a manager does it, at the same width:
  // from the pencil, or from the boards menu once the pencil has folded.
  const rename = async (name) => {
    if (await page.isVisible("#toolbar .board-edit-btn")) await page.click("#toolbar .board-edit-btn");
    else {
      await page.click("#toolbar .board-btn");
      await page.click(".board-pop .dd-action:has-text('Edit board')");
    }
    // The AI strip lands after the editor opens, and the editor takes what it
    // shows as its baseline (save-gate.js rebase): type before that and the
    // new name is swallowed into the baseline, leaving Save with nothing to do.
    await page.waitForSelector("#board-edit-modal .glyph-btn:not(:empty)");
    await page.fill("#board-modal-name", name);
    await page.click("#board-modal-save");
    await page.waitForSelector("#board-modal-save", { state: "detached" });
    await frames(page);
    return readRow(page);
  };
  const longer = await rename("stocks test, the long-running one with the long name");
  assert.ok(stepsOf(longer.fold).includes("edit"), `the longer name takes more steps: ${longer.fold}`);
  assert.ok(longer.overflow <= 0);
  assert.equal((await rename("stocks test")).fold, "coin", "and the old name gives them back");
  assert.deepEqual(page.errors, []);
});

test("the fold waits for the web font, which is wider than the stand-in the row is first drawn in", async () => {
  // Inter is font-display: swap, so the row is drawn and folded in a
  // stand-in font first. At 790px the stand-in fits with no steps and Inter
  // doesn't, and when Inter swaps in, nothing in the row changes and neither
  // does its width.
  const page = await openBoard(boards.stocks, { device: DESKTOP(790) });
  let release;
  const held = new Promise((r) => { release = r; });
  // public/fonts/, or the build's /_/ with hashed names
  await page.route("**/*.woff2", async (route) => { await held; await route.continue(); });
  await page.reload({ waitUntil: "domcontentloaded" }); // "load" waits for the held fonts
  await page.waitForSelector("#toolbar .token-chip");
  await frames(page);
  assert.equal((await readRow(page)).fold, "", "setup: in the stand-in font the row fits as it is");
  release();
  await page.evaluate(() => document.fonts.ready);
  await frames(page);
  const r = await readRow(page);
  assert.equal(r.fold, "coin", "in Inter it needs the coin step");
  assert.ok(r.overflow <= 0);
  assert.deepEqual(page.errors, []);
});

test("on a phone the whole row fits the screen, down to 320px", async () => {
  for (const width of [430, 390, 375, 360, 320]) {
    const page = await openBoard(boards.stocks, { device: PHONE(width) });
    const r = await readRow(page);
    const screen = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: innerWidth }));
    assert.ok(r.overflow <= 0 && r.overlap <= 0, `${width}: fits (${r.fold})`);
    assert.equal(screen.page, screen.screen, `${width}: the page stays the screen's width`);
    assert.equal(r.userToEdge, 0, `${width}: the user menu holds the right edge`);
    assert.ok(r.board >= 80, `${width}: the board button holds 80px`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
});
