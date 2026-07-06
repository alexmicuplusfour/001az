// File kinds: how a piece of material shows itself — its face inside the card
// frame, its detail view, its small preview. grid.js owns the card frame and
// chrome; the kind owns only the face. Today every item's material is a single
// image, so there is exactly one kind; kindFor is the seam new kinds (docs,
// generated chart faces) plug into.
import { openLightbox } from './lightbox.js';

export const thumbUrl = (name) => `thumbnails/${encodeURIComponent(name)}.webp`;
export const fullUrl = (name) => `gallery/${encodeURIComponent(name)}`;

const imageKind = {
  // The face inside the card frame.
  face(item, card, layout) {
    const im = document.createElement("img");
    im.src = thumbUrl(item.name);
    im.loading = "lazy";
    im.decoding = "async";
    if (item.w && item.h) {
      im.width = item.w;
      im.height = item.h;
      // Pin the ratio to the border box (box-sizing: border-box) so selection
      // padding cover-crops the image without changing the card's height.
      im.style.aspectRatio = `${item.w} / ${item.h}`;
    }
    im.alt = item.tags.length ? item.tags.join(", ") : item.name;
    im.addEventListener("error", () => card.remove());
    im.addEventListener("load", () => { im.classList.add("loaded"); card.classList.add("loaded"); layout(); });
    if (im.complete && im.naturalWidth > 0) { im.classList.add("loaded"); card.classList.add("loaded"); }
    return im;
  },

  // Upload placeholders: the local object URL until the server row exists.
  progressFace(p, card, layout) {
    const im = document.createElement("img");
    im.src = p.objURL || thumbUrl(p.name);
    im.alt = p.name || "uploading";
    im.addEventListener("error", () => card.remove());
    im.addEventListener("load", () => layout());
    return im;
  },

  openDetail(item) {
    openLightbox(item);
  },

  // Small preview for chrome that wants one (tag editor).
  previewUrl(item) {
    return thumbUrl(item.name);
  },
};

export function kindFor(_item) {
  return imageKind;
}
