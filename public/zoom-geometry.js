// Pure geometry for the lightbox's scroll-to-zoom (planning/lightbox-zoom-plan.md),
// split out so it's unit-testable without a DOM — the same split as
// det-geometry.js, for the same reason (lightbox.js touches `document` at import
// time and can't be imported in node).
//
// ONE COORDINATE SPACE: client pixels. Rects arrive as DOMRects, the cursor as
// the wheel event's clientX/clientY, and a view's `tx`/`ty` are a pixel offset
// applied to the image's own resting position. With `transform-origin: 0 0` the
// element's local origin IS its fit box's top-left, so the visible box is
// always exactly
//
//     { fit.x + tx, fit.y + ty, fit.w * s, fit.h * s }
//
// and `{ s: 1, tx: 0, ty: 0 }` is rest. No conversions anywhere.
//
// A fit carries the `frame` it was measured against, because a view means
// nothing except against that frame — passing the two separately would be an
// invariant held together by whoever remembers to pass both.

// A scale this close to 1 IS 1. Without the snap, float drift parks a
// zoomed-out view at s = 1.0000001, `s > 1` stays true forever, and the chrome
// that keys off "am I zoomed" never goes away.
const SNAP = 1e-3;
// Below this much headroom the image isn't worth calling zoomable — a 1%
// difference is a rounding artifact, not detail anyone can see.
const MIN_HEADROOM = 1.01;

// The resting box of the lightbox image inside its stage, COMPUTED, never
// measured: getBoundingClientRect() on a transformed element returns the
// transformed rect, so a measured fit box is only correct at rest, and "only
// correct at rest" is a rule someone eventually breaks.
//
// Deliberately NOT det-geometry.js contentRect, which describes
// `object-fit: contain` inside a FIXED element box and therefore scales a small
// image UP. Here the element is sized by `max-width/max-height: 100%`, which
// shrinks a large image but never grows a small one — that's the `, 1`, and
// it's the whole difference. Unifying the two would make every small image
// claim to be zoomable.
export function fitInfo(stage, naturalW, naturalH) {
  if (!naturalW || !naturalH) {
    // Not loaded yet: the stage itself, and nothing to zoom into.
    return { x: stage.left, y: stage.top, w: stage.width, h: stage.height, maxScale: 1, zoomable: false, frame: stage };
  }
  const k = Math.min(stage.width / naturalW, stage.height / naturalH, 1);
  const w = naturalW * k, h = naturalH * k;
  // 1/k is "undo the fit" — the scale at which one image pixel is one CSS
  // pixel. Never below 1, because k never exceeds 1.
  const maxScale = 1 / k;
  return {
    x: stage.left + (stage.width - w) / 2, // flex centering, in closed form
    y: stage.top + (stage.height - h) / 2,
    w,
    h,
    maxScale,
    zoomable: maxScale > MIN_HEADROOM,
    frame: stage,
  };
}

// One axis of the clamp. `t` is the offset from the fit box's own position,
// `gap` is where that box sits inside the frame at rest (its letterbox margin).
//
// Two branches, and the scaled size alone decides which: an axis with room to
// spare stays CENTERED (a portrait photo at 1.5× covers vertically while still
// needing to be centered horizontally — which is why the frame size alone can't
// express this), an axis that overflows is held COVERING, with no gap allowed
// at either end.
//
// They meet exactly at scaled === frameSize, where both yield -gap: that
// continuity is what keeps the image from jumping as an axis crosses over.
function clampAxis(t, scaled, gap, frameSize) {
  if (scaled <= frameSize) return (frameSize - scaled) / 2 - gap;
  return Math.min(Math.max(t, frameSize - scaled - gap), -gap);
}

// Hold a view inside its frame: centered where it fits, covering where it
// doesn't, and snapped to rest when the scale comes home.
export function clampView(view, fit) {
  if (view.s <= 1 + SNAP) return { s: 1, tx: 0, ty: 0 };
  const f = fit.frame;
  return {
    s: view.s,
    tx: clampAxis(view.tx, fit.w * view.s, fit.x - f.left, f.width),
    ty: clampAxis(view.ty, fit.h * view.s, fit.y - f.top, f.height),
  };
}

// Scale by `factor` about `cursor`, so the image point under the pointer stays
// under the pointer. With P the cursor relative to the fit box's origin and
// r the ratio of the new scale to the old:
//
//     t' = P - (P - t) * r
//
// Near an edge the clamp wins and the anchored point drifts off the cursor.
// That's correct — it's what every viewer does, and it's what makes zooming
// back out settle into fit instead of sliding.
export function zoomAt(view, cursor, factor, fit) {
  const s = Math.min(Math.max(view.s * factor, 1), fit.maxScale);
  const r = s / view.s;
  return clampView({
    s,
    tx: (cursor.x - fit.x) - ((cursor.x - fit.x) - view.tx) * r,
    ty: (cursor.y - fit.y) - ((cursor.y - fit.y) - view.ty) * r,
  }, fit);
}

// The scale as a reader would name it: percent of the image's NATIVE size, so
// 100% means one image pixel per CSS pixel — the same 100% every desktop viewer
// shows, and the same place `maxScale` stops. Percent of the FIT would print
// "100%" over an image displaying 41% of its pixels, which is the opposite of
// informative.
export function nativePercent(s, maxScale) {
  return Math.round((s / maxScale) * 100);
}

// How much of `rect` hangs outside `frame`, as a CSS `inset()` — the four sides
// in CSS order (top right bottom left). Used to clip the detection overlay,
// which lives outside the stage and so isn't reached by the stage's own `clip`.
// Returns "" when nothing hangs out, and that emptiness is load-bearing: a flat
// `inset(0)` would crop `.lb-det-label`, which sits above its box by design.
export function clipInset(rect, frame) {
  const ins = [
    Math.max(0, frame.top - rect.y),
    Math.max(0, (rect.x + rect.w) - (frame.left + frame.width)),
    Math.max(0, (rect.y + rect.h) - (frame.top + frame.height)),
    Math.max(0, frame.left - rect.x),
  ];
  return ins.some((n) => n > 0) ? `inset(${ins.map((n) => n + "px").join(" ")})` : "";
}

// Wheel deltas are not comparable across browsers, OSes or devices: Firefox
// reports lines, Chrome and Safari report pixels and can emit hundreds at once,
// and every trackpad has its own sensitivity. Normalize the mode, cap the
// event, then convert to a multiplicative factor.
const DELTA_PX = { 1: 8, 2: 24 }; // 1 = DOM_DELTA_LINE, 2 = DOM_DELTA_PAGE
const MAX_DELTA = 24;
// How fast one capped event zooms. At 1, a mouse-wheel notch (which arrives
// well past the cap) is ~24%, so a typical 3× image is about five notches end
// to end. This is the tuning knob; nothing else in the module is.
const SPEEDUP = 1;

export function wheelFactor(deltaY, deltaMode = 0) {
  const px = deltaY * (DELTA_PX[deltaMode] || 1);
  const d = Math.max(-MAX_DELTA, Math.min(MAX_DELTA, px));
  // Written as a magnitude and its reciprocal so "a delta and its negation are
  // exact inverses" is visible rather than something you have to derive.
  const m = 1 + (SPEEDUP * Math.abs(d)) / 100;
  return d <= 0 ? m : 1 / m;
}
