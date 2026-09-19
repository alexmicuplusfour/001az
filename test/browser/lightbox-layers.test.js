// Who paints on top inside the lightbox.
//
// Every control in there is `position: absolute`, and until this was stated none
// of them carried a z-index — so the order was whatever the DOM happened to be.
// Two things went wrong with that. #lightbox-prev is written before the stage,
// so anything positioned that a renderer mounts covered the left arrow. And a
// renderer reaching for a z-index of its own escaped the stage entirely, because
// `position: relative` with `z-index: auto` is not a stacking context — the
// chart's crosshair readout is that renderer, its z-index of 3 only ever meant
// "above the library's canvases", and it ended up over the details panel.
//
// This measures PIXELS, not hit-testing. The complaint is that the chart appears
// over the chrome, and appearing is not the same question as intercepting a
// click: .lb-chart-readout is `pointer-events: none`, so elementsFromPoint can
// never see it however high it stacks. A probe painted in a colour nothing else
// uses, screenshotted through each control's own box, asks the thing that was
// actually wrong.
//
// It can't drive the real chart — that needs a connector and live market data —
// so it mounts the same classes the chart does.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { openApp } from "./harness.js";

const SETTLED = "#grid .card[data-id]";
const PROBE_RGB = [255, 0, 255]; // nothing in the app is magenta

let app, page;
before(async () => {
  app = await openApp();
  const { user, boardId } = await app.signIn({ email: "layers@test.local" });
  page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  const plus = page.locator(".tool-btn.upload");
  await plus.waitFor({ timeout: 15000 });
  // Three, and we open the middle one: both arrows are visibility:hidden at the
  // ends of a board, and the counter pill is :empty — so display:none — on a
  // board of one. A probe against chrome that isn't rendered proves nothing.
  for (let i = 0; i < 3; i++) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), plus.click()]);
    await chooser.setFiles(await app.fixture(`layers-${i}.png`, { width: 1600, height: 1200 }));
    await page.locator(SETTLED).nth(i).waitFor({ timeout: 15000 });
  }

  // Narrow: below 640px the panel goes full-width and sits directly over the
  // stage, which is the arrangement where a renderer's stray z-index shows at
  // all. On a wide screen the stage is padded clear of the panel.
  await page.setViewportSize({ width: 420, height: 820 });
  await page.locator(SETTLED).nth(1).click(); // the middle one — both arrows live
  await page.locator("#lightbox-stage img").waitFor({ timeout: 15000 });
  // Upload toasts sit where the counter pill does and are legitimately above
  // the lightbox; let them expire before photographing anything.
  await page.waitForFunction(() => !document.querySelector(".toast-wrap")?.childElementCount,
    null, { timeout: 20000 });

  // A stand-in for the chart, wearing its real classes: the media box it lays
  // its canvases into, holding the readout that reaches for a z-index. Both are
  // stretched over the whole lightbox so every control has something to be
  // covered BY — .lb-chart-media's own height clamp would otherwise leave the
  // counter untouched and the assertion about it empty.
  await page.evaluate((rgb) => {
    const media = document.createElement("div");
    media.className = "lb-chart-media";
    media.id = "probe-media";
    media.style.cssText = "position:absolute;inset:0;height:100%";
    const readout = document.createElement("div");
    readout.className = "lb-chart-readout";
    readout.id = "probe-readout";
    readout.style.cssText = `inset:0;width:100%;height:100%;background:rgb(${rgb.join(",")})`;
    media.appendChild(readout);
    document.getElementById("lightbox-stage").appendChild(media);
  }, PROBE_RGB);
});
after(() => app?.close());

// The panel is the widest thing in the lightbox and at this width it covers
// everything, so each test says which arrangement it means rather than
// inheriting one from whichever test ran last. Opened from the chrome, closed
// with Escape — at this width the panel covers the info button it was opened
// from, which is the layering working, not something to route around.
async function panel(open) {
  const now = await page.evaluate(() => !document.getElementById("lightbox-panel").hidden);
  if (now !== open) {
    if (open) await page.locator("#lightbox-info").click();
    else await page.keyboard.press("Escape");
  }
  await page.locator("#lightbox-panel").waitFor({ state: open ? "visible" : "hidden", timeout: 15000 });
}

// What fraction of this control's own box is showing the probe's colour, pure?
// Pure is the point: the arrows are half-transparent, so a probe painting
// UNDER one blends to something else, while a probe painting over it leaves
// the colour untouched.
async function probeCoverage(sel) {
  // The middle of the control, not its bounding box: these are all pills with
  // `border-radius: 999px`, so the corners of the box are genuinely background
  // and would read as the probe winning when it is simply visible beside a
  // rounded edge.
  const box = await page.evaluate((s) => {
    const r = document.querySelector(s).getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: Math.round(r.x + r.width * 0.25),
      y: Math.round(r.y + r.height * 0.25),
      width: Math.max(1, Math.round(r.width * 0.5)),
      height: Math.max(1, Math.round(r.height * 0.5)),
    };
  }, sel);
  assert.ok(box, `${sel} has no box on screen — it isn't rendered, so nothing is proven`);
  const shot = await page.screenshot({ clip: box });
  const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true });
  let hit = 0;
  for (let i = 0; i < data.length; i += info.channels) {
    if (data[i] === PROBE_RGB[0] && data[i + 1] === PROBE_RGB[1] && data[i + 2] === PROBE_RGB[2]) hit++;
  }
  return hit / (info.width * info.height);
}

async function assertClear(sel) {
  const covered = await probeCoverage(sel);
  assert.ok(covered < 0.02,
    `${sel} is ${Math.round(covered * 100)}% painted over by something mounted in the stage`);
}

test("a renderer does not paint over the navigation arrows", async () => {
  await panel(false);
  // The left arrow is the one that loses on DOM order alone: it is written
  // before the stage, so with both at z-index auto the stage wins.
  for (const arrow of ["#lightbox-prev", "#lightbox-next"]) await assertClear(arrow);
});

test("a renderer does not paint over the counter or the action pills", async () => {
  await panel(false);
  for (const el of ["#lightbox-count", "#lightbox-info"]) await assertClear(el);
});

test("a renderer does not paint over the details panel", async () => {
  await panel(true);
  await assertClear("#lightbox-panel");
});

test("a renderer cannot climb out of its own box, whatever number it picks", async () => {
  // The chrome ladder alone would pass the three tests above for a lucky
  // reason: the readout's 3 ties with the arrows' 3 and loses the tie on DOM
  // order. That is not a guarantee, it is one bumped constant from breaking.
  // The rule that holds is that a renderer's layering stays inside the
  // renderer — `isolation: isolate` on .lb-chart-media — and a number that
  // would outrank every control in the lightbox is the only way to ask.
  await page.evaluate(() => { document.getElementById("probe-readout").style.zIndex = "99"; });
  await panel(false);
  for (const el of ["#lightbox-prev", "#lightbox-next", "#lightbox-count", "#lightbox-info"]) {
    await assertClear(el);
  }
  await panel(true);
  await assertClear("#lightbox-panel");
  await page.evaluate(() => { document.getElementById("probe-readout").style.zIndex = ""; });
  assert.deepEqual(page.errors, []);
});
