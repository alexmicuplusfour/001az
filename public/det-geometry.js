// Pure geometry/colour helpers for the lightbox object-detection overlay, split
// out so they're unit-testable without a DOM (lightbox.js touches `document` at
// import time, so it can't be imported in node).

// The displayed content box of an `object-fit: contain` image inside its element
// box `rect` ({left, top, width, height}). When the element and image aspect
// ratios differ, the pixels are letterboxed inside the element — this returns the
// true pixel box (centered) so detection boxes land on the image, not the gap.
// Falls back to the element box when the natural size is unknown (image not yet
// loaded).
export function contentRect(rect, naturalW, naturalH) {
  if (!naturalW || !naturalH) return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  const scale = Math.min(rect.width / naturalW, rect.height / naturalH);
  const w = naturalW * scale, h = naturalH * scale;
  return { x: rect.left + (rect.width - w) / 2, y: rect.top + (rect.height - h) / 2, w, h };
}

// Deterministic per-field colour so a field's boxes and its list swatch match,
// and two object fields on one image stay visually distinct.
const DET_PALETTE = ["#e5484d", "#0090ff", "#30a46c", "#f76b15", "#8e4ec6", "#e5a000"];
export function detColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return DET_PALETTE[Math.abs(h) % DET_PALETTE.length];
}
