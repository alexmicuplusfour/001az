// Scroll-to-zoom in a real browser (planning/lightbox-zoom-plan.md, Stage 2).
//
// zoom-geometry.js is pure and unit-tested to death, but all of it rests on one
// claim Node cannot check: that the lightbox image's real layout box is the
// contain-fit of the stage — that `max-width/max-height: 100%` on a flex item
// whose `min-width` is `auto` really does shrink it the way fitInfo predicts.
// That is a claim about Chromium's flex and replaced-element sizing, and if it
// is wrong every green unit test in the suite is measuring the wrong rectangle.
//
// The rest is the same class of thing: a wheel event is not a click, and a
// cached image announces its size by a different route than a downloaded one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { openApp } from "./harness.js";
import { fitInfo, nativePercent } from "../../public/zoom-geometry.js";

const SETTLED = "#grid .card[data-id]";
const STAGE_IMG = "#lightbox-stage img";
// Comfortably larger than the 1280x720 viewport's stage, so there is real
// headroom to zoom into. The default 8x8 fixture is the "already fits" case.
const BIG = { width: 2400, height: 1600 };

let app;
before(async () => { app = await openApp(); });
after(() => app?.close());

// Sign in, make a board, upload each file, wait for every card to settle.
async function boardWith(email, files) {
  const { user, boardId } = await app.signIn({ email });
  const page = await app.open(`/?board=${boardId}`, { sid: user.sid });
  const plus = page.locator(".tool-btn.upload");
  await plus.waitFor({ timeout: 15000 });
  for (let i = 0; i < files.length; i++) {
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), plus.click()]);
    await chooser.setFiles(files[i]);
    await page.locator(SETTLED).nth(i).waitFor({ timeout: 15000 });
  }
  return page;
}

// One board, one big image, lightbox open on it — what most of these need.
const openBig = async (email) => boardWith(email, [await app.fixture("big.png", BIG)]);

async function openCard(page) {
  await page.locator(SETTLED).first().click();
  await page.locator(STAGE_IMG).waitFor({ timeout: 15000 });
  // The renderer starts the image at opacity 0 and reveals it on load; waiting
  // for a real natural size is what makes the measurements below meaningful.
  await page.waitForFunction(() => document.querySelector("#lightbox-stage img")?.naturalWidth > 0,
    null, { timeout: 15000 });
}

// Wheel at (x, y) until the image is zoomed, or give up. The retry is not
// papering over a flake: `naturalWidth > 0` can be true a frame or two before
// the image reports the layout the fit is computed from, so a wheel can
// legitimately arrive while there is nothing to zoom yet. A broken zoom still
// fails — it just never becomes zoomed, and this runs out of road.
async function wheelUntilZoomed(page, at = null, ticks = 3) {
  const p = at || await page.evaluate(() => {
    const s = document.getElementById("lightbox-stage").getBoundingClientRect();
    return { x: s.left + s.width / 2, y: s.top + s.height / 2 };
  });
  await page.mouse.move(p.x, p.y);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    for (let i = 0; i < ticks; i++) await page.mouse.wheel(0, -120); // away = in
    if (await page.evaluate(() => document.getElementById("lightbox").classList.contains("zoomed"))) return;
  }
  assert.fail("the wheel never zoomed the image");
}

// Everything the page can tell us about where the image actually is.
const measure = (page) => page.evaluate(() => {
  const img = document.querySelector("#lightbox-stage img");
  const s = document.getElementById("lightbox-stage").getBoundingClientRect();
  const r = img.getBoundingClientRect();
  return {
    stage: { left: s.left, top: s.top, width: s.width, height: s.height },
    img: { x: r.x, y: r.y, w: r.width, h: r.height },
    nw: img.naturalWidth,
    nh: img.naturalHeight,
    transform: img.style.transform,
    zoomed: document.getElementById("lightbox").classList.contains("zoomed"),
    count: document.getElementById("lightbox-count").textContent,
    countShown: getComputedStyle(document.getElementById("lightbox-count")).display !== "none",
  };
});

const close = (a, b, eps, what) =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} is not within ${eps} of ${b}`);

test("fitInfo predicts where the browser actually puts the image", async () => {
  const page = await openBig("zoomfit@test.local");
  await openCard(page);

  const m = await measure(page);
  const fit = fitInfo(m.stage, m.nw, m.nh);

  // Teeth: a fixture that fit inside the stage would make every assertion below
  // true for the wrong reason.
  assert.ok(fit.zoomable, `fixture isn't zoomable at this viewport (maxScale ${fit.maxScale})`);
  close(fit.w, m.img.w, 1, "fitted width");
  close(fit.h, m.img.h, 1, "fitted height");
  close(fit.x, m.img.x, 1, "fitted x");
  close(fit.y, m.img.y, 1, "fitted y");
  assert.equal(m.transform, "", "an untouched image should carry no transform");
  assert.deepEqual(page.errors, []);
});

test("the wheel zooms about the cursor, and does not close the lightbox", async () => {
  const page = await openBig("zoomwheel@test.local");
  await openCard(page);
  const before = await measure(page);

  // Climb away from the fit first. Anchoring is only reversible in the
  // INTERIOR: one notch off a fitted image leaves it barely wider than the
  // stage, where the clamp legitimately owns the position and the point under
  // the cursor is supposed to slide. Asserting the anchor there would be
  // asserting that the clamp is broken.
  await wheelUntilZoomed(page);

  const wide = await measure(page);
  assert.ok(wide.img.w > before.stage.width * 1.3 && wide.img.h > before.stage.height * 1.3,
    "not far enough from the fit for the clamp to have let go");

  // Off-center, so the assertion can tell anchoring from "grow about the
  // middle", and stated as the fraction of the image under the pointer — the
  // thing that must not move, with no reference to tx/ty/s.
  const cx = before.stage.left + before.stage.width * 0.4;
  const cy = before.stage.top + before.stage.height * 0.4;
  const fx = (cx - wide.img.x) / wide.img.w;
  const fy = (cy - wide.img.y) / wide.img.h;

  await page.mouse.move(cx, cy);
  await page.mouse.wheel(0, -120);
  await page.waitForFunction((w) => document.querySelector("#lightbox-stage img").getBoundingClientRect().width > w,
    wide.img.w + 1, { timeout: 5000 });

  const after = await measure(page);
  assert.ok(after.img.w > wide.img.w, "the extra notch did nothing");
  assert.match(after.transform, /scale\(/, "the zoom should ride a transform");
  close(after.img.x + fx * after.img.w, cx, 1, "the point under the cursor moved horizontally");
  close(after.img.y + fy * after.img.h, cy, 1, "the point under the cursor moved vertically");

  // A wheel is not a click. This is the whole premise of the interaction.
  assert.equal(await page.locator("#lightbox").isVisible(), true, "the wheel closed the lightbox");
  assert.deepEqual(page.errors, []);
});

test("arrowing to the next image lands fitted, not still zoomed", async () => {
  // The plan's reset decision, on the path that has no close to lean on: a
  // zoom belongs to the image it was aimed at. Carrying it across a navigation
  // would mean the next image opens at some scale nobody chose, positioned
  // against a frame computed for a picture that is no longer there.
  const page = await boardWith("zoomnav@test.local", [
    await app.fixture("one.png", BIG),
    await app.fixture("two.png", { width: 2000, height: 2000 }),
  ]);
  await openCard(page);
  const fitted = await measure(page);
  await wheelUntilZoomed(page);

  await page.keyboard.press("ArrowRight");
  await page.waitForFunction((w) => {
    const i = document.querySelector("#lightbox-stage img");
    return i && i.naturalWidth > 0 && i.naturalWidth !== w;
  }, fitted.nw, { timeout: 15000 });

  const next = await measure(page);
  assert.equal(next.zoomed, false, "the next image opened wearing the last one's zoom");
  assert.equal(next.transform, "", "the next image opened with a transform on it");
  const fit = fitInfo(next.stage, next.nw, next.nh);
  close(fit.w, next.img.w, 1, "the next image didn't land at its own fit");
  assert.deepEqual(page.errors, []);
});

test("the keyboard can zoom, and 0 puts it back", async () => {
  // Zoom without a mouse (Stage 3). The readout rides the counter pill as a
  // tail, and reads percent of NATIVE size — so it climbs toward 100% and
  // stops there, which is the only thing on screen that explains why the zoom
  // does.
  const page = await openBig("zoomkeys@test.local");
  await openCard(page);

  const rest = await measure(page);
  // One item and not zoomed: neither half of the pill has anything to say, and
  // an empty pill is a blob of background at the bottom of the screen.
  assert.equal(rest.count, "");
  assert.equal(rest.countShown, false, "the empty counter pill is painting");

  for (let i = 0; i < 3; i++) await page.keyboard.press("+");
  await page.waitForFunction(() => document.getElementById("lightbox").classList.contains("zoomed"),
    null, { timeout: 5000 });

  const zoomed = await measure(page);
  assert.ok(zoomed.img.w > rest.img.w, "+ didn't zoom");
  const fit = fitInfo(zoomed.stage, zoomed.nw, zoomed.nh);
  assert.equal(zoomed.count, `${nativePercent(zoomed.img.w / fit.w, fit.maxScale)}%`,
    `the readout disagrees with the geometry (got "${zoomed.count}")`);

  // A key press is one wheel notch by construction, so three of them cannot
  // have reached the ceiling on this image — a readout pinned at 100% would
  // pass the check above for the wrong reason.
  assert.ok(parseInt(zoomed.count, 10) < 100, `already at the ceiling: ${zoomed.count}`);

  await page.keyboard.press("0");
  await page.waitForFunction(() => !document.getElementById("lightbox").classList.contains("zoomed"),
    null, { timeout: 5000 });

  const back = await measure(page);
  close(back.img.w, rest.img.w, 1, "0 didn't return to the fit");
  assert.equal(back.transform, "", "0 left a transform behind");
  assert.equal(back.countShown, false, "the readout outlived the zoom");
  assert.deepEqual(page.errors, []);
});

test("opening the details panel re-fits the image the zoom is measured against", async () => {
  // The panel shrinks the stage by 400px, so every number the zoom depends on
  // moves. Nothing in the lightbox announces that — the stage is simply
  // re-padded by a class — which is why the refit hangs off a ResizeObserver
  // rather than off this click. A stale fit would leave the view clamped to a
  // frame that isn't there any more, and the readout lying about the scale.
  const page = await openBig("zoompanel@test.local");
  await openCard(page);
  await wheelUntilZoomed(page);

  await page.locator("#lightbox-info").click();
  await page.locator("#lightbox-panel").waitFor({ state: "visible", timeout: 15000 });
  await page.waitForFunction(() => !document.getElementById("lightbox").classList.contains("zoomed"),
    null, { timeout: 5000 });

  const m = await measure(page);
  assert.ok(m.stage.width < 900, `the panel didn't narrow the stage (${m.stage.width})`);
  const fit = fitInfo(m.stage, m.nw, m.nh);
  close(fit.w, m.img.w, 1, "the image didn't re-fit to the narrowed stage");
  close(fit.x, m.img.x, 1, "the image didn't re-center in the narrowed stage");

  // And the zoom still works against the new frame, not the old one.
  await wheelUntilZoomed(page);
  const zoomed = await measure(page);
  assert.equal(zoomed.count, `${nativePercent(zoomed.img.w / fit.w, fit.maxScale)}%`,
    `the readout is measured against the old frame (got "${zoomed.count}")`);
  assert.deepEqual(page.errors, []);
});

test("an image that already fits is left alone", async () => {
  // The user's own rule: scroll only if the image is larger than it's shown.
  // 8x8 has nothing to reveal, so the wheel must change nothing at all.
  const page = await boardWith("zoomsmall@test.local", [await app.fixture("small.png")]);
  await openCard(page);

  const before = await measure(page);
  assert.equal(fitInfo(before.stage, before.nw, before.nh).zoomable, false);

  await page.mouse.move(before.img.x + before.img.w / 2, before.img.y + before.img.h / 2);
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(100);

  const after = await measure(page);
  assert.equal(after.transform, "", "a too-small image picked up a transform");
  assert.equal(after.zoomed, false);
  close(after.img.w, before.img.w, 0.5, "width changed");
  assert.deepEqual(page.errors, []);
});

test("reopening starts at the fit, and an image served from cache still zooms", async () => {
  // Two claims in one trip. The first is the plan's reset decision: a zoom
  // belongs to the image you were looking at, and must not outlive it — a
  // reopened lightbox opens fitted, with no leftover transform and no leftover
  // class, and it has to be true from the first frame rather than whenever the
  // next image happens to finish loading.
  //
  // The second is the cache path. The lightbox learns an image's size from
  // `onload`, and a cached image is `complete` before that ever runs —
  // preloadFull warms ±2 neighbours, so a reopened or arrowed-to image is the
  // ordinary case, not the rare one. (Measured: a cached image fires `onload`
  // anyway, which is why the renderer's `complete` branch stays quiet. If that
  // ever stops being true, this is the test that says so.)
  const page = await openBig("zoomcache@test.local");
  await openCard(page);
  const fitted = await measure(page);
  await wheelUntilZoomed(page);

  await page.keyboard.press("Escape");
  await page.locator("#lightbox").waitFor({ state: "hidden", timeout: 15000 });
  await openCard(page); // same URL, now served from cache

  const before = await measure(page);
  // The reset itself is the nav test's claim; here it is only the precondition
  // that makes the cache half mean anything.
  assert.equal(before.zoomed, false, "the reopened lightbox is still wearing the last zoom");

  await wheelUntilZoomed(page, { x: before.img.x + before.img.w * 0.3, y: before.img.y + before.img.h * 0.6 }, 1);
  const after = await measure(page);
  assert.ok(after.img.w > before.img.w, "the cached image never learned its own size");
  assert.deepEqual(page.errors, []);
});
