// File kinds: how a piece of material shows itself — its face inside the card
// frame, its detail view, its small preview. grid.js owns the card frame and
// chrome; the kind owns only the face. Dispatch is by the item's file kind:
// images get the bare-media face, documents get preview-plus-title (the
// title showing the original filename — the stored identity is random hex).
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

const docKind = {
  // Preview (PDF page-1 render, when the server has one) or an extension
  // badge, plus the original filename as the card title. Content-dependent
  // height, so grid.js must NOT stamp dataset.ratio for these — they take
  // the measured layout lane.
  face(item, card, layout) {
    const wrap = document.createElement("div");
    wrap.className = "doc-face";
    if (item.w && item.h) {
      const im = document.createElement("img");
      im.src = thumbUrl(item.name);
      im.loading = "lazy";
      im.decoding = "async";
      im.width = item.w;
      im.height = item.h;
      im.style.aspectRatio = `${item.w} / ${item.h}`;
      im.alt = item.label || item.name;
      im.addEventListener("load", () => { im.classList.add("loaded"); layout(); });
      wrap.appendChild(im);
    } else {
      const badge = document.createElement("div");
      badge.className = "doc-badge";
      badge.textContent = (item.name.match(/\.(\w+)$/)?.[1] || "doc").toUpperCase();
      wrap.appendChild(badge);
    }
    const title = document.createElement("div");
    title.className = "doc-title";
    title.textContent = item.label || item.name;
    title.title = item.label || item.name;
    wrap.appendChild(title);
    card.classList.add("loaded");
    return wrap;
  },

  progressFace(p) {
    const wrap = document.createElement("div");
    wrap.className = "doc-face";
    const badge = document.createElement("div");
    badge.className = "doc-badge";
    badge.textContent = (p.name?.match(/\.(\w+)$/)?.[1] || "doc").toUpperCase();
    const title = document.createElement("div");
    title.className = "doc-title";
    title.textContent = p.name || "uploading";
    wrap.append(badge, title);
    return wrap;
  },

  // The original opens in a new tab (browsers render PDFs and text natively).
  openDetail(item) {
    window.open(fullUrl(item.name), "_blank", "noopener");
  },

  previewUrl(item) {
    return item.w && item.h ? thumbUrl(item.name) : null;
  },
};

export function kindFor(item) {
  return item?.kind && item.kind !== "image" ? docKind : imageKind;
}
