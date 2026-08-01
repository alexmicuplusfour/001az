// The one piece of the lightbox object-detection overlay with real logic: the
// object-fit:contain letterbox math that places boxes on the pixels, not the
// gap. Pure, so it's testable without a DOM.
import test from "node:test";
import assert from "node:assert/strict";
import { contentRect, detColor } from "../public/det-geometry.js";

test("contentRect: matching aspect → fills the element box, no offset", () => {
  // element 200x100 (2:1), image 400x200 (2:1)
  assert.deepEqual(contentRect({ left: 10, top: 20, width: 200, height: 100 }, 400, 200),
    { x: 10, y: 20, w: 200, h: 100 });
});

test("contentRect: wide element, square image → horizontal letterbox, centered", () => {
  // scale = min(200/100, 100/100) = 1 → 100x100 centered in 200x100
  const r = contentRect({ left: 0, top: 0, width: 200, height: 100 }, 100, 100);
  assert.deepEqual(r, { x: 50, y: 0, w: 100, h: 100 });
});

test("contentRect: tall element, wide image → vertical letterbox, centered", () => {
  // scale = min(100/100, 200/50) = 1 → 100x50, y offset (200-50)/2 = 75
  const r = contentRect({ left: 0, top: 0, width: 100, height: 200 }, 100, 50);
  assert.deepEqual(r, { x: 0, y: 75, w: 100, h: 50 });
});

test("contentRect: image scaled down preserves aspect and centers", () => {
  // element 100x100, image 200x100 (2:1) → scale min(0.5,1)=0.5 → 100x50, y=25
  const r = contentRect({ left: 0, top: 0, width: 100, height: 100 }, 200, 100);
  assert.deepEqual(r, { x: 0, y: 25, w: 100, h: 50 });
});

test("contentRect: unknown natural size → element box unchanged (image not loaded)", () => {
  assert.deepEqual(contentRect({ left: 5, top: 6, width: 30, height: 40 }, 0, 0),
    { x: 5, y: 6, w: 30, h: 40 });
});

test("detColor: deterministic, stable, and within the palette", () => {
  assert.equal(detColor("logos"), detColor("logos"));
  assert.match(detColor("logos"), /^#[0-9a-f]{6}$/);
  assert.match(detColor(""), /^#[0-9a-f]{6}$/); // empty key doesn't throw
});
