// Where a dropdown lands (public/dropdown.js `placePop`).
//
// This is the half of the popover that a browser makes awkward to check: the
// interesting answers only appear when the anchor sits low enough to force a
// flip, or hard enough against an edge to force a clamp, and every wrong answer
// is a menu that opens somewhere plausible-looking but off-screen. So the
// arithmetic is pure and pinned here, and reposition() is left with nothing but
// reading rects and setting two styles.
//
// Rects are viewport coordinates, exactly as getBoundingClientRect gives them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { placePop } from "../public/dropdown.js";

const GAP = 6;     // anchor → pop
const MARGIN = 8;  // pop → window edge

const viewport = { width: 1000, height: 800 };
const pop = { width: 200, height: 150 };
// a 100×28 button in the middle of the page
const anchor = (over = {}) => ({ top: 100, bottom: 128, left: 400, right: 500, width: 100, height: 28, ...over });

test("align end hangs the pop's right edge off the anchor's", () => {
  const { left, top } = placePop({ anchor: anchor(), pop, viewport, align: "end" });
  assert.equal(left, 300); // 500 - 200
  assert.equal(top, 128 + GAP);
});

test("align start lines the left edges up instead", () => {
  const { left } = placePop({ anchor: anchor(), pop, viewport, align: "start" });
  assert.equal(left, 400);
});

test("no room below flips it above the anchor", () => {
  const a = anchor({ top: 700, bottom: 728 });
  // below would end at 728 + 6 + 150 = 884, past the 792 the margin allows
  const { top } = placePop({ anchor: a, pop, viewport, align: "end" });
  assert.equal(top, 700 - GAP - pop.height); // 544
});

test("room below is used even when the fit is exact", () => {
  // bottom + gap + height lands exactly on the margin line: still fits
  const a = anchor({ top: 608, bottom: 636 });
  const { top } = placePop({ anchor: a, pop, viewport, align: "end" });
  assert.equal(top, 642); // 636 + 6, and 642 + 150 === 792
});

test("too little room on either side parks it at the bottom margin", () => {
  const tall = { width: 200, height: 280 };
  const short = { width: 1000, height: 300 };
  const a = anchor({ top: 140, bottom: 168 });
  // below overflows, and above would start at -146
  const { top } = placePop({ anchor: a, pop: tall, viewport: short, align: "end" });
  assert.equal(top, short.height - MARGIN - tall.height); // 12
});

test("clamps to the right edge rather than hanging off it", () => {
  const a = anchor({ left: 899, right: 999 });
  const { left } = placePop({ anchor: a, pop, viewport, align: "end" });
  assert.equal(left, viewport.width - MARGIN - pop.width); // 792, not 799
});

test("clamps to the left edge when the anchor sits near it", () => {
  const a = anchor({ left: 12, right: 100 });
  const { left } = placePop({ anchor: a, pop, viewport, align: "end" });
  assert.equal(left, MARGIN); // would have been -100
});

test("a pop wider than the window starts at the near margin", () => {
  // .dropdown's max-width keeps this off the table in practice; the clamp order
  // is what decides which edge wins if it ever does happen, and near beats far
  const wide = { width: 400, height: 150 };
  const { left } = placePop({ anchor: anchor(), pop: wide, viewport: { width: 300, height: 800 }, align: "end" });
  assert.equal(left, MARGIN);
});

test("subpixel rects come back rounded", () => {
  const a = anchor({ right: 500.4, bottom: 128.6 });
  const { left, top } = placePop({ anchor: a, pop, viewport, align: "end" });
  assert.equal(left, 300);
  assert.equal(top, 135); // 134.6
  assert.ok(Number.isInteger(left) && Number.isInteger(top));
});
