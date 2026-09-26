// File kinds: how a piece of material shows itself — its face inside the card
// frame, its detail view, its small preview. grid.js owns the card frame and
// chrome; the kind owns only the face. Dispatch is by the item's file kind:
// images get the bare-media face, documents get preview-plus-title (the
// title showing the display label — the stored file name is a random hex).
//
// A face is a component (planning/ui-updates-plan.md, Stage 4). It draws from
// the props the card hands it and never touches the card: what it learns
// about its picture (loaded, or failed) it reports up through onLoaded and
// onBroken, and the card owns the classes that follow. `overlay` is the
// card's select button and heart, which sit inside the face's media region.
import { html, useState, useRef, useLayoutEffect } from './vendor/preact.mjs';

export const thumbUrl = (name) => `thumbnails/${encodeURIComponent(name)}.webp`;
export const fullUrl = (name) => `gallery/${encodeURIComponent(name)}`;

// The title strip under a face: the display label plus, for entities with
// several instances, a small count chip (filter-pill styling).
function TitleStrip({ text, count = 0 }) {
  return html`<div class="face-title" title=${text}>
    <span class="face-title-text">${text}</span>
    ${count > 1 && html`<span class="inst-count" title=${`${count} instances`}>${count}</span>`}
  </div>`;
}

// Media-only region of the face — overlays (heart, select) anchor here, not
// on the title strip below.
const FaceMedia = ({ children, overlay }) => html`<div class="face-media">${children}${overlay}</div>`;

// The placeholder tile every kind falls back to when it has no picture: an
// extension for a document, ♪ for audio, the ticker for a connector entity.
// One grey tile with three legends — the variant only changes the lettering.
const FaceBadge = ({ legend, variant }) => html`<div class=${variant ? `face-badge ${variant}` : "face-badge"}>${legend}</div>`;

// A rendered face in its band: `doc-preview` crops a page peek, `face-fit`
// shows a waveform or a price chart whole. No relayout on decode — the band's
// height comes from the card's width, so the arriving bytes cannot move the
// masonry; only the fade-in is left. Keyed by its file where it's drawn, so a
// new picture fades in afresh (grid.js Card resets its own state the same
// way).
function BandedFace({ cls, name, label }) {
  const [loaded, setLoaded] = useState(false);
  return html`<div class=${cls}>
    <img src=${thumbUrl(name)} loading="lazy" decoding="async" alt=${label} class=${loaded ? "loaded" : undefined} onLoad=${() => setLoaded(true)} />
  </div>`;
}

// The wrapper a titled face lives in — a media region plus the title strip.
const TitledFace = ({ media, overlay, text, count }) => html`<div class="card-face">
  <${FaceMedia} overlay=${overlay}>${media}</${FaceMedia}>
  <${TitleStrip} text=${text} count=${count} />
</div>`;

// A picture that was already in the cache is complete before any load event
// fires: say so at mount, or a cached thumbnail would stay faded out.
function useCompleteAtMount(ref, onLoaded, name) {
  useLayoutEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth > 0) onLoaded();
  }, [name]);
}

const imageKind = {
  // The face inside the card frame.
  Face({ name, w, h, generated, tags, label, titled, count, loaded, overlay, onLoaded, onBroken, onLayout }) {
    const ref = useRef(null);
    useCompleteAtMount(ref, onLoaded, name);
    // A drawn face (a connector chart) doesn't get to set the card's height —
    // it goes in the shared band below, so its own proportions are irrelevant.
    // Pinning the ratio to the border box (box-sizing: border-box) lets the
    // selection padding cover-crop the image without changing the card's
    // height.
    const sized = !!(w && h && !generated);
    // Only a photo with no stored dimensions can move the masonry when it
    // decodes; anything with a ratio (stamped on the card or on the img) or
    // in a band already has its exact height. Skipping the relayout matters
    // when a fresh board view trickles in hundreds of lazy thumbnails.
    const onLoad = () => { onLoaded(); if (!(w && h)) onLayout(); };
    const img = html`<img ref=${ref} src=${thumbUrl(name)} loading="lazy" decoding="async"
      width=${sized ? w : undefined} height=${sized ? h : undefined} style=${sized ? `aspect-ratio: ${w} / ${h}` : undefined}
      alt=${tags?.length ? tags.join(", ") : name} class=${loaded ? "loaded" : undefined}
      onLoad=${onLoad} onError=${onBroken} />`;
    if (!titled) return html`<${FaceMedia} overlay=${overlay}>${img}</${FaceMedia}>`;
    // Mapped identity: same title strip documents carry, under the media.
    // A face the app produced for itself — a connector's price chart, with no
    // upload behind it — goes in the shared band like every other rendered
    // face. Only the user's own picture gets to set the card's height.
    return html`<${TitledFace} media=${generated ? html`<div class="face-fit">${img}</div>` : img} overlay=${overlay} text=${label} count=${count} />`;
  },

  // Upload placeholders: the local object URL until the server row exists.
  ProgressFace({ name, objURL, onLoaded, onBroken, onLayout }) {
    const ref = useRef(null);
    useCompleteAtMount(ref, onLoaded, objURL || name);
    // 'loaded' stops the card shimmer — an infinite background animation that
    // repaints every frame; the dimmed image + spinner already say "working".
    return html`<img ref=${ref} src=${objURL || thumbUrl(name)} alt=${name || "uploading"}
      onLoad=${() => { onLoaded(); onLayout(); }} onError=${onBroken} />`;
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
// content-ish, so no dataset.ratio and they take the measured lane. Nothing
// here shimmers (the box is already sized): the card is `loaded` at once.
const bandedKind = (bandClass, legend) => ({
  instant: true,
  Face({ name, w, h, label, count, overlay }) {
    const media = w && h
      ? html`<${BandedFace} key=${name} cls=${bandClass} name=${name} label=${label} />`
      : html`<${FaceBadge} legend=${legend(name)[0]} variant=${legend(name)[1]} />`;
    return html`<${TitledFace} media=${media} overlay=${overlay} text=${label} count=${count} />`;
  },
  ProgressFace({ name }) {
    return html`<${TitledFace} media=${html`<${FaceBadge} legend=${legend(name)[0]} variant=${legend(name)[1]} />`} text=${name || "uploading"} />`;
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
  instant: true,
  Face({ symbol, identity, label, count, overlay }) {
    const legend = symbol || identity?.slice(0, 4).toUpperCase() || "?";
    return html`<${TitledFace} media=${html`<${FaceBadge} legend=${legend} variant="symbol" />`} overlay=${overlay} text=${label} count=${count} />`;
  },
  // No media to load: the symbol tile is ready at creation, so the full face
  // doubles as the progress face. Without this, a just-added coin renders as a
  // bodyless (zero-height) card with only the floating spinner.
  ProgressFace(props) { return connectorKind.Face(props); },
  previewUrl() { return null; },
};

export function kindFor(item) {
  if (item?.kind === "connector") return connectorKind;
  if (item?.kind === "audio") return audioKind;
  return item?.kind && item.kind !== "image" ? docKind : imageKind;
}
