// File kinds: how a piece of material shows itself — its face inside the card
// frame, its detail view, its small preview. grid.js owns the card frame and
// chrome; the kind owns only the face. Dispatch is by the item's file kind:
// images get the bare-media face, documents get preview-plus-title (the
// title showing the display label — the stored file name is a random hex).
import { openLightbox } from './lightbox.js';
import { hasIdentity } from './utils.js';

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
    if (!hasIdentity(item)) return im;
    // Mapped identity: same title strip documents carry, under the media.
    const wrap = document.createElement("div");
    wrap.className = "image-face";
    const title = document.createElement("div");
    title.className = "doc-title";
    title.textContent = item.displayLabel;
    title.title = item.displayLabel;
    wrap.append(im, title);
    return wrap;
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
  // A fixed-height (200px) peek at the document — page-1 render cropped from
  // the top with a fade into the title strip — or an extension badge when
  // there's no preview; the original filename as the card title. Height is
  // still content-ish (title strip), so no dataset.ratio: measured lane.
  face(item, card, layout) {
    const wrap = document.createElement("div");
    wrap.className = "doc-face";
    if (item.w && item.h) {
      const preview = document.createElement("div");
      preview.className = "doc-preview";
      const im = document.createElement("img");
      im.src = thumbUrl(item.name);
      im.loading = "lazy";
      im.decoding = "async";
      im.alt = item.displayLabel;
      im.addEventListener("load", () => { im.classList.add("loaded"); layout(); });
      preview.appendChild(im);
      wrap.appendChild(preview);
    } else {
      const badge = document.createElement("div");
      badge.className = "doc-badge";
      badge.textContent = (item.name.match(/\.(\w+)$/)?.[1] || "doc").toUpperCase();
      wrap.appendChild(badge);
    }
    const title = document.createElement("div");
    title.className = "doc-title";
    title.textContent = item.displayLabel;
    title.title = item.displayLabel;
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

  // Same lightbox as images; it renders the document inline (browsers
  // display PDFs and plain text natively in a same-origin frame).
  openDetail(item) {
    openLightbox(item);
  },

  previewUrl(item) {
    return item.w && item.h ? thumbUrl(item.name) : null;
  },
};

// Connector entities have no files. Same card anatomy as documents —
// face area + title strip — with a symbol tile standing in for the preview.
const connectorKind = {
  face(item, card) {
    const wrap = document.createElement("div");
    wrap.className = "doc-face";
    const tile = document.createElement("div");
    tile.className = "connector-face";
    const sym = document.createElement("span");
    sym.className = "connector-symbol";
    sym.textContent = item.symbol || item.identity?.slice(0, 4).toUpperCase() || "?";
    tile.appendChild(sym);
    const title = document.createElement("div");
    title.className = "doc-title";
    title.textContent = item.displayLabel;
    title.title = item.displayLabel;
    wrap.append(tile, title);
    card.classList.add("loaded");
    return wrap;
  },
  openDetail(item) { openLightbox(item); },
  previewUrl() { return null; },
};

export function kindFor(item) {
  if (item?.kind === "connector") return connectorKind;
  return item?.kind && item.kind !== "image" ? docKind : imageKind;
}
