// File kinds: how a piece of material shows itself — its face inside the card
// frame, its detail view, its small preview. grid.js owns the card frame and
// chrome; the kind owns only the face. Dispatch is by the item's file kind:
// images get the bare-media face, documents get preview-plus-title (the
// title showing the display label — the stored file name is a random hex).
import { hasIdentity } from './utils.js';

export const thumbUrl = (name) => `thumbnails/${encodeURIComponent(name)}.webp`;
export const fullUrl = (name) => `gallery/${encodeURIComponent(name)}`;

// The title strip under a face: the display label plus, for entities with
// several instances, a small count chip (filter-pill styling).
function titleStrip(text, count = 0) {
  const title = document.createElement("div");
  title.className = "face-title";
  title.title = text;
  const label = document.createElement("span");
  label.className = "face-title-text";
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

// The placeholder tile every kind falls back to when it has no picture: an
// extension for a document, ♪ for audio, the ticker for a connector entity.
// One grey tile with three legends — the variant only changes the lettering.
function faceBadge(legend, variant) {
  const badge = document.createElement("div");
  badge.className = variant ? `face-badge ${variant}` : "face-badge";
  badge.textContent = legend;
  return badge;
}

// The band that gives a rendered face the shared shape: `doc-preview` crops a
// page peek, `face-fit` shows a waveform or a price chart whole.
function band(cls, node) {
  const el = document.createElement("div");
  el.className = cls;
  el.appendChild(node);
  return el;
}

// A rendered face in its band. No relayout on decode — the band's height comes
// from the card's width, so the arriving bytes cannot move the masonry; only
// the fade-in is left.
function bandedFace(cls, item) {
  const img = document.createElement("img");
  img.src = thumbUrl(item.name);
  img.loading = "lazy";
  img.decoding = "async";
  img.alt = item.displayLabel;
  img.addEventListener("load", () => img.classList.add("loaded"));
  return band(cls, img);
}

// The wrapper a titled face lives in — a media region plus the title strip.
function titledFace(media, text, count) {
  const wrap = document.createElement("div");
  wrap.className = "card-face";
  wrap.append(faceMedia(media), titleStrip(text, count));
  return wrap;
}

const imageKind = {
  // The face inside the card frame.
  face(item, card, layout) {
    const img = document.createElement("img");
    img.src = thumbUrl(item.name);
    img.loading = "lazy";
    img.decoding = "async";
    // A drawn face (a connector chart) doesn't get to set the card's height —
    // it goes in the shared band below, so its own proportions are irrelevant.
    if (item.w && item.h && !item.generated) {
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
      // Only a photo with no stored dimensions can move the masonry when it
      // decodes; anything with a ratio (stamped on the card or on the img) or
      // in a band already has its exact height. Skipping the relayout matters
      // when a fresh board view trickles in hundreds of lazy thumbnails.
      if (!card.dataset.ratio && !(item.w && item.h)) layout();
    });
    if (img.complete && img.naturalWidth > 0) { img.classList.add("loaded"); card.classList.add("loaded"); }
    if (!hasIdentity(item)) return faceMedia(img);
    // Mapped identity: same title strip documents carry, under the media.
    // A face the app produced for itself — a connector's price chart, with no
    // upload behind it — goes in the shared band like every other rendered
    // face. Only the user's own picture gets to set the card's height.
    return titledFace(item.generated ? band("face-fit", img) : img, item.displayLabel, item.instances?.length);
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

  // Small preview for chrome that wants one (tag editor).
  previewUrl(item) {
    return thumbUrl(item.name);
  },
};

const ext = (name) => (name?.match(/\.(\w+)$/)?.[1] || "doc").toUpperCase();

// Documents and audio are the same card: a rendered face in the shared band,
// or a placeholder badge in that same band when nothing was rendered (no
// poppler, no ffmpeg, or not yet) — which is why neither ever changes height.
// They differ in the band their face wants and in what the badge says, so
// that is all each one states. A file title strip under both; height is
// content-ish, so no dataset.ratio and they take the measured lane.
const bandedKind = (bandClass, legend) => ({
  face(item, card) {
    card.classList.add("loaded"); // nothing here shimmers: the box is already sized
    const media = item.w && item.h ? bandedFace(bandClass, item) : faceBadge(...legend(item.name));
    return titledFace(media, item.displayLabel, item.instances?.length);
  },
  progressFace(p, card) {
    card.classList.add("loaded");
    return titledFace(faceBadge(...legend(p.name)), p.name || "uploading");
  },
  previewUrl(item) { return item.w && item.h ? thumbUrl(item.name) : null; },
});

// Page 1, cropped from the top with a fade into the title strip; the stored
// name's extension when there's no render.
const docKind = bandedKind("doc-preview", (name) => [ext(name)]);

// The ffmpeg waveform (server/faces/waveform.js), shown whole rather than
// cover-cropped — it is wide and short and all of it is content. Detail view
// is the player (lightbox.js showMedia branches on kind === "audio").
const audioKind = bandedKind("face-fit", () => ["♪", "audio"]);

// Connector entities have no files. Same card anatomy as documents — face area
// + title strip — with the ticker on the same placeholder badge a document's
// extension gets; a priced entity swaps it for the rendered chart (an image
// face) as soon as one exists.
const connectorKind = {
  face(item, card) {
    const legend = item.symbol || item.identity?.slice(0, 4).toUpperCase() || "?";
    card.classList.add("loaded");
    return titledFace(faceBadge(legend, "symbol"), item.displayLabel, item.instances?.length);
  },
  // No media to load: the symbol tile is ready at creation, so the full face
  // doubles as the progress face. Without this, a just-added coin renders as a
  // bodyless (zero-height) card with only the floating spinner.
  progressFace(item, card, layout) { return connectorKind.face(item, card, layout); },
  previewUrl() { return null; },
};

export function kindFor(item) {
  if (item?.kind === "connector") return connectorKind;
  if (item?.kind === "audio") return audioKind;
  return item?.kind && item.kind !== "image" ? docKind : imageKind;
}
