// File kinds: how a piece of material shows itself — its face inside the card
// frame, its detail view, its small preview. grid.js owns the card frame and
// chrome; the kind owns only the face. Dispatch is by the item's file kind:
// images get the bare-media face, documents get preview-plus-title (the
// title showing the display label — the stored file name is a random hex).
import { openLightbox } from './lightbox.js';
import { hasIdentity } from './utils.js';

export const thumbUrl = (name) => `thumbnails/${encodeURIComponent(name)}.webp`;
export const fullUrl = (name) => `gallery/${encodeURIComponent(name)}`;

// The title strip under a face: the display label plus, for entities with
// several instances, a small count chip (filter-pill styling).
function titleStrip(text, count = 0) {
  const title = document.createElement("div");
  title.className = "doc-title";
  title.title = text;
  const label = document.createElement("span");
  label.className = "doc-title-text";
  label.textContent = text;
  title.appendChild(label);
  if (count > 1) {
    const chip = document.createElement("span");
    chip.className = "inst-count";
    chip.textContent = count;
    chip.title = `${count} instances`;
    title.appendChild(chip);
  }
  return title;
}

// Media-only region of the face — overlays (heart, select) anchor here, not
// on the title strip below.
function faceMedia(...nodes) {
  const wrap = document.createElement("div");
  wrap.className = "face-media";
  wrap.append(...nodes);
  return wrap;
}

const imageKind = {
  // The face inside the card frame.
  face(item, card, layout) {
    const img = document.createElement("img");
    img.src = thumbUrl(item.name);
    img.loading = "lazy";
    img.decoding = "async";
    if (item.w && item.h) {
      img.width = item.w;
      img.height = item.h;
      // Pin the ratio to the border box (box-sizing: border-box) so selection
      // padding cover-crops the image without changing the card's height.
      img.style.aspectRatio = `${item.w} / ${item.h}`;
    }
    img.alt = item.tags.length ? item.tags.join(", ") : item.name;
    img.addEventListener("error", () => card.remove());
    img.addEventListener("load", () => {
      img.classList.add("loaded");
      card.classList.add("loaded");
      // Ratio-stamped cards already have their exact height — the loaded
      // bytes can't move the masonry. Skipping the relayout matters when a
      // fresh board view trickles in hundreds of lazy thumbnails.
      if (!card.dataset.ratio) layout();
    });
    if (img.complete && img.naturalWidth > 0) { img.classList.add("loaded"); card.classList.add("loaded"); }
    if (!hasIdentity(item)) return faceMedia(img);
    // Mapped identity: same title strip documents carry, under the media.
    const wrap = document.createElement("div");
    wrap.className = "image-face";
    wrap.append(faceMedia(img), titleStrip(item.displayLabel, item.instances?.length));
    return wrap;
  },

  // Upload placeholders: the local object URL until the server row exists.
  progressFace(p, card, layout) {
    const img = document.createElement("img");
    img.src = p.objURL || thumbUrl(p.name);
    img.alt = p.name || "uploading";
    img.addEventListener("error", () => card.remove());
    // 'loaded' stops the card shimmer — an infinite background animation that
    // repaints every frame; the dimmed image + spinner already say "working".
    img.addEventListener("load", () => { card.classList.add("loaded"); layout(); });
    if (img.complete && img.naturalWidth > 0) card.classList.add("loaded");
    return img;
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
      const img = document.createElement("img");
      img.src = thumbUrl(item.name);
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = item.displayLabel;
      img.addEventListener("load", () => { img.classList.add("loaded"); layout(); });
      preview.appendChild(img);
      wrap.appendChild(faceMedia(preview));
    } else {
      const badge = document.createElement("div");
      badge.className = "doc-badge";
      badge.textContent = (item.name.match(/\.(\w+)$/)?.[1] || "doc").toUpperCase();
      wrap.appendChild(faceMedia(badge));
    }
    wrap.appendChild(titleStrip(item.displayLabel, item.instances?.length));
    card.classList.add("loaded");
    return wrap;
  },

  progressFace(p, card) {
    const wrap = document.createElement("div");
    wrap.className = "doc-face";
    const badge = document.createElement("div");
    badge.className = "doc-badge";
    badge.textContent = (p.name?.match(/\.(\w+)$/)?.[1] || "doc").toUpperCase();
    wrap.append(badge, titleStrip(p.name || "uploading"));
    // Badge face is ready at creation — no shimmer needed (see imageKind).
    card.classList.add("loaded");
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

// Audio items carry a waveform face (server/faces/waveform.js) — wide and short,
// so it's shown WHOLE (object-fit: contain) rather than cover-cropped like a doc
// page. No waveform (ffmpeg absent at ingest) → a ♪ badge. Detail view is the
// player (lightbox.js showMedia branches on kind === "audio").
const audioKind = {
  face(item, card, layout) {
    const wrap = document.createElement("div");
    wrap.className = "audio-face";
    if (item.w && item.h) {
      const wave = document.createElement("div");
      wave.className = "audio-wave";
      const img = document.createElement("img");
      img.src = thumbUrl(item.name);
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = item.displayLabel;
      img.addEventListener("load", () => { img.classList.add("loaded"); layout(); });
      wave.appendChild(img);
      wrap.appendChild(faceMedia(wave));
    } else {
      const badge = document.createElement("div");
      badge.className = "doc-badge audio-badge";
      badge.textContent = "♪";
      wrap.appendChild(faceMedia(badge));
    }
    wrap.appendChild(titleStrip(item.displayLabel, item.instances?.length));
    card.classList.add("loaded");
    return wrap;
  },
  progressFace(p, card) {
    const wrap = document.createElement("div");
    wrap.className = "audio-face";
    const badge = document.createElement("div");
    badge.className = "doc-badge audio-badge";
    badge.textContent = "♪";
    wrap.append(faceMedia(badge), titleStrip(p.name || "uploading"));
    card.classList.add("loaded");
    return wrap;
  },
  openDetail(item) { openLightbox(item); },
  previewUrl(item) { return item.w && item.h ? thumbUrl(item.name) : null; },
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
    wrap.append(faceMedia(tile), titleStrip(item.displayLabel, item.instances?.length));
    card.classList.add("loaded");
    return wrap;
  },
  // No media to load: the symbol tile is ready at creation, so the full face
  // doubles as the progress face. Without this, a just-added coin renders as a
  // bodyless (zero-height) card with only the floating spinner.
  progressFace(item, card, layout) { return connectorKind.face(item, card, layout); },
  openDetail(item) { openLightbox(item); },
  previewUrl() { return null; },
};

export function kindFor(item) {
  if (item?.kind === "connector") return connectorKind;
  if (item?.kind === "audio") return audioKind;
  return item?.kind && item.kind !== "image" ? docKind : imageKind;
}
