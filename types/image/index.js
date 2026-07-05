// The image board type, client half: thumbnail card bodies, upload-progress
// placeholders, the lightbox detail view, and drag/drop + file-picker ingest.
import { initUpload, triggerFilePicker } from './upload.js';
import { initLightbox, openLightbox } from './lightbox.js';

export const thumbUrl = (name) => `thumbnails/${encodeURIComponent(name)}.webp`;
export const fullUrl = (name) => `gallery/${encodeURIComponent(name)}`;

export default {
  manifest: { apiVersion: 1, type: "image", name: "Images", version: "1.0.0" },

  // One-time wiring of the type's static DOM (dropzone, file input, lightbox).
  init() {
    initUpload();
    initLightbox();
  },

  // The media inside the card frame; grid.js owns the frame and its chrome.
  renderCardBody(item, card, layout) {
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
  renderProgressBody(p, card, layout) {
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

  // Toolbar "+" button lands here.
  triggerIngest() {
    triggerFilePicker();
  },

  // Small preview for chrome that wants one (tag editor).
  previewUrl(item) {
    return thumbUrl(item.name);
  },
};
