// The math behind lightbox scroll-to-zoom: where an image rests, where a zoom
// about the cursor puts it, and what holds it inside the stage. Pure, so it's
// testable without a DOM (planning/lightbox-zoom-plan.md).
import test from "node:test";
import assert from "node:assert/strict";
import { fitInfo, clampView, zoomAt, wheelFactor, nativePercent, clipInset } from "../public/zoom-geometry.js";

const STAGE = { left: 0, top: 0, width: 1000, height: 800 };
// Offset stage — the one that catches a coordinate space confused with another.
const OFFSET_STAGE = { left: 100, top: 50, width: 1000, height: 800 };
const REST = { s: 1, tx: 0, ty: 0 };

const close = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !≈ ${b}`);

// The image-local point sitting under the cursor, which is what a zoom about
// the cursor must leave alone.
const localUnder = (view, fit, cursor) => ({
  x: (cursor.x - fit.x - view.tx) / view.s,
  y: (cursor.y - fit.y - view.ty) / view.s,
});

test("fitInfo: a large image is contained and centered, with the headroom it has", () => {
  // 4000x2000 (2:1) into 1000x800 → k = min(0.25, 0.4, 1) = 0.25
  const fit = fitInfo(STAGE, 4000, 2000);
  assert.deepEqual(fit, { x: 0, y: 150, w: 1000, h: 500, maxScale: 4, zoomable: true, frame: STAGE });
});

test("fitInfo: a small image is NOT upscaled — max-width:100% shrinks, it doesn't grow", () => {
  // The whole difference from det-geometry's contentRect, which would scale
  // this up to fill the stage and report headroom that doesn't exist.
  const fit = fitInfo(STAGE, 400, 200);
  assert.deepEqual(fit, { x: 300, y: 300, w: 400, h: 200, maxScale: 1, zoomable: false, frame: STAGE });
});

test("fitInfo: an image barely bigger than its frame isn't worth calling zoomable", () => {
  assert.equal(fitInfo(STAGE, 1005, 804).zoomable, false); // <1% headroom
  assert.equal(fitInfo(STAGE, 1100, 880).zoomable, true);
});

test("fitInfo: no natural size yet (image not loaded) → the stage, and nothing to zoom", () => {
  const fit = fitInfo(OFFSET_STAGE, 0, 0);
  assert.deepEqual(fit, { x: 100, y: 50, w: 1000, h: 800, maxScale: 1, zoomable: false, frame: OFFSET_STAGE });
});

test("zoomAt: the point under the cursor stays under the cursor", () => {
  const fit = fitInfo(OFFSET_STAGE, 4000, 2000); // x:100 y:200 w:1000 h:500
  const cursor = { x: 700, y: 450 };
  const before = localUnder(REST, fit, cursor);
  const after = zoomAt(REST, cursor, 2, fit);
  assert.equal(after.s, 2);
  const now = localUnder(after, fit, cursor);
  close(now.x, before.x);
  close(now.y, before.y);
});

test("zoomAt: round trip returns the view it started from — away from the clamps", () => {
  // Stated without that qualifier this is simply false: near an edge the clamp
  // eats the offset and it never comes back. The interior is where the
  // anchoring identity is reversible, and that's what's being pinned.
  const fit = fitInfo(STAGE, 4000, 2000);
  const cursor = { x: 600, y: 400 };
  const start = zoomAt(REST, cursor, 2, fit); // s:2, interior on both axes
  const inward = zoomAt(start, cursor, 1.5, fit);
  assert.equal(inward.s, 3);
  const back = zoomAt(inward, cursor, 1 / 1.5, fit);
  close(back.s, start.s);
  close(back.tx, start.tx);
  close(back.ty, start.ty);
});

test("clampView: the centered and covering branches meet at the crossover", () => {
  // 2000x2000 into 1000x800 → 800x800 at x:100. The x axis crosses from
  // letterboxed to covering at s = 1000/800 = 1.25, and both branches must
  // give the same number there or the image jumps as it passes through.
  const fit = fitInfo(STAGE, 2000, 2000);
  assert.deepEqual({ w: fit.w, x: fit.x, maxScale: fit.maxScale }, { w: 800, x: 100, maxScale: 2.5 });
  const at = clampView({ s: 1.25, tx: 9999, ty: 0 }, fit);
  assert.equal(at.tx, -100); // covering, pinned to the only position that covers
  const just_under = clampView({ s: 1.25 - 1e-9, tx: 9999, ty: 0 }, fit);
  close(just_under.tx, -100, 1e-6); // centered, landing on the same place
});

test("clampView: an axis with room to spare stays centered while the other covers", () => {
  // 1000x4000 into 1000x800 → 200x800 at x:400. At 1.5x it's 300 wide (room to
  // spare) and 1200 tall (overflowing): centered horizontally, held vertically.
  const fit = fitInfo(STAGE, 1000, 4000);
  const v = clampView({ s: 1.5, tx: 350, ty: -9999 }, fit);
  assert.equal(v.tx, -50); // visible box 350..650, centered on the stage's 500
  assert.equal(v.tx, (fit.w * (1 - v.s)) / 2); // the closed form in the plan
  assert.equal(v.ty, -400); // bottom edge held against the stage
});

test("clampView: a scale that comes home snaps all the way home", () => {
  // Float drift would otherwise leave s just above 1 forever, and the chrome
  // that keys off "am I zoomed" would never switch off.
  const fit = fitInfo(STAGE, 4000, 2000);
  assert.deepEqual(clampView({ s: 1.0000001, tx: -3, ty: 7 }, fit), REST);
});

test("zoomAt: the stops are hard at both ends", () => {
  const fit = fitInfo(STAGE, 4000, 2000); // maxScale 4
  const cursor = { x: 700, y: 400 };
  let v = REST;
  for (let i = 0; i < 50; i++) v = zoomAt(v, cursor, 1.5, fit);
  assert.equal(v.s, 4);
  for (let i = 0; i < 50; i++) v = zoomAt(v, cursor, 0.5, fit);
  assert.deepEqual(v, REST);
});

test("zoomAt: zooming out from rest is a no-op, not a negative", () => {
  const fit = fitInfo(STAGE, 4000, 2000);
  assert.deepEqual(zoomAt(REST, { x: 600, y: 400 }, 0.5, fit), REST);
});

test("nativePercent: 100% is one image pixel per CSS pixel, and it's the ceiling", () => {
  // 4000x2000 into 1000x800 fits at 1000 wide — 25% of the file. The number a
  // reader cares about is how much of the ORIGINAL they're seeing, so the fit
  // reads 25% and the top of the range reads 100%, which is also where zoomAt
  // stops. Percent-of-fit would call the first one 100% and the second 400%.
  const fit = fitInfo(STAGE, 4000, 2000);
  assert.equal(nativePercent(REST.s, fit.maxScale), 25);
  assert.equal(nativePercent(fit.maxScale, fit.maxScale), 100);
  assert.equal(nativePercent(2, fit.maxScale), 50);
});

test("nativePercent: an image that already fits is showing all of itself", () => {
  assert.equal(nativePercent(REST.s, fitInfo(STAGE, 400, 200).maxScale), 100);
});

test("clipInset: a rect inside its frame is not clipped at all", () => {
  // The empty string is load-bearing, not a micro-optimisation: `inset(0)`
  // would crop .lb-det-label, which deliberately sits above its own box.
  assert.equal(clipInset({ x: 100, y: 100, w: 200, h: 200 }, STAGE), "");
  // Flush against all four edges is still inside.
  assert.equal(clipInset({ x: 0, y: 0, w: 1000, h: 800 }, STAGE), "");
});

test("clipInset: each side reports only its own overhang", () => {
  // 40 past the left edge and 25 past the bottom, nothing past top or right:
  // CSS order is top right bottom left, and a sign flipped between the two
  // pairs is exactly how this arithmetic goes wrong.
  assert.equal(clipInset({ x: -40, y: 300, w: 500, h: 525 }, STAGE),
    "inset(0px 0px 25px 40px)");
  assert.equal(clipInset({ x: 600, y: -10, w: 500, h: 100 }, STAGE),
    "inset(10px 100px 0px 0px)");
});

test("clipInset: the frame's own position counts, not just its size", () => {
  // OFFSET_STAGE starts at (100, 50) — a rect at the origin hangs off its top
  // and left even though both numbers are positive.
  assert.equal(clipInset({ x: 0, y: 0, w: 200, h: 200 }, OFFSET_STAGE),
    "inset(50px 0px 0px 100px)");
});

test("wheelFactor: up zooms in, down zooms out", () => {
  // The direction convention, written down: a wheel away from the reader
  // (negative deltaY) magnifies.
  assert.ok(wheelFactor(-10) > 1);
  assert.ok(wheelFactor(10) < 1);
  assert.equal(wheelFactor(0), 1);
});

test("wheelFactor: a delta and its negation are exact inverses", () => {
  // Not decoration: it's what makes a wheel down and back up return the same
  // scale instead of drifting a little every time.
  for (const d of [1, 5, 24, 100, 1000]) close(wheelFactor(d) * wheelFactor(-d), 1, 1e-12);
});

test("wheelFactor: line-mode and pixel-mode deltas of equal intent agree", () => {
  assert.equal(wheelFactor(3, 1), wheelFactor(24, 0)); // Firefox lines → 8px each
  assert.equal(wheelFactor(-3, 1), wheelFactor(-24, 0));
});

test("wheelFactor: one event can't run away with the zoom", () => {
  // Chrome and Safari emit hundreds of pixels per notch; uncapped, a single
  // event would cross the whole range.
  assert.equal(wheelFactor(1000), wheelFactor(24));
  assert.equal(wheelFactor(-1000), wheelFactor(-24));
  assert.equal(wheelFactor(-5, 2), wheelFactor(-24)); // page mode, likewise capped
});
