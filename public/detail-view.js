// Detail renderers — how one kind of content shows itself on the lightbox STAGE.
// The card grid already dispatches this way (kinds.js: each kind owns its face);
// this is the same move for the detail view, so a new content type is a registry
// entry rather than another branch in showMedia — which is exactly how the three
// renderers below used to exist, as one if/else chain over fixed index.html nodes.
//
// A renderer:
//   { name, matches(inst, entity) → bool, mount(stage, ctx) → handle }
//   ctx    = { inst, entity, root, onImageLayout }
//            root = the lightbox element (focus target, `loading` class host);
//            onImageLayout = "my media just laid out" — the det-overlay repositions.
//   handle = { unmount(), imgEl? }
//            unmount releases everything the mount acquired (playback, listeners,
//            nodes); imgEl is exposed by image-bearing renderers so the
//            object-detection overlay can measure the displayed content rect.
//
// First match wins and registration order IS specificity order — image is the
// deliberate catch-all, exactly like `kindFor`'s fallthrough. A plugin-shipped
// renderer would register ahead of the built-ins (the connectors registry's
// register-last pattern); until one exists the array is the registry.
import { fullUrl, thumbUrl } from './kinds.js';
import { chartDetail } from './detail-chart.js';
import { transcriptParagraphs } from './transcript-paragraphs.js';

// ── audio ───────────────────────────────────────────────────────────────────
// The waveform face (when it rendered) above a native <audio> player; the
// transcript replaces the waveform when there's speech — as clickable-to-seek
// paragraphs when the item carries structured turns, as flat text for items
// transcribed before turns shipped. Fetched per mount; the waveform stays as
// the fallback while a fresh upload is still transcribing (null) or for a
// clip with no discernible speech ("" flat / [] turns).
// Media-timestamp format (1:05, 1:02:05) — deliberately NOT utils.fmtDuration,
// which rounds to a coarse "2m"/"1h" and can't label a seek target.
const mmss = (s) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(Math.floor(s % 60)).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
};
const audioDetail = {
  name: "audio",
  matches: (inst) => inst?.kind === "audio",
  mount(stage, { inst, root }) {
    const wrap = document.createElement("div");
    wrap.className = "lightbox-audio";
    // Player clicks (play/scrub/volume) must not bubble to the lightbox close.
    wrap.addEventListener("click", (e) => e.stopPropagation());

    const wave = document.createElement("img");
    wave.className = "lightbox-audio-wave";
    wave.alt = "";
    const text = document.createElement("div");
    text.className = "lightbox-audio-transcript";
    text.hidden = true;
    const player = document.createElement("audio");
    player.className = "lightbox-audio-el";
    player.controls = true;
    player.preload = "metadata";
    player.src = fullUrl(inst.name);
    wrap.append(wave, text, player);
    stage.appendChild(wrap);

    const showWave = () => {
      text.hidden = true;
      if (inst.w && inst.h) { wave.src = thumbUrl(inst.name); wave.hidden = false; }
      else { wave.removeAttribute("src"); wave.hidden = true; }
    };
    showWave(); // immediate fallback while the transcript loads
    (async () => {
      try {
        const r = await fetch(`/api/instances/${inst.id}/transcript`);
        // Unmounted (or superseded — a new mount detaches this wrap) → drop it.
        if (!wrap.isConnected) return;
        const { transcript, turns } = r.ok ? await r.json() : {};
        const paras = transcriptParagraphs(turns);
        if (paras.length) {
          wave.hidden = true;
          wave.removeAttribute("src");
          for (const p of paras) {
            const el = document.createElement("p");
            el.textContent = p.text;
            el.title = `Jump to ${mmss(p.start)}`;
            // Seek only — play state is untouched: playing continues from the
            // new spot, paused just moves the playhead. No autoplay surprises.
            // A click that ends a text selection is copying, not seeking.
            el.addEventListener("click", () => {
              if (getSelection().isCollapsed) player.currentTime = p.start;
            });
            text.appendChild(el);
          }
          text.hidden = false;
        } else if (transcript && transcript.trim()) {
          wave.hidden = true;
          wave.removeAttribute("src");
          text.textContent = transcript;
          text.hidden = false;
        }
      } catch { /* keep the waveform fallback */ }
    })();

    // Keep keyboard nav (arrows/Escape) on the lightbox, not the player.
    root.focus({ preventScroll: true });
    return {
      unmount() {
        // Detach fully: stop playback AND buffering when navigating away.
        player.pause();
        player.removeAttribute("src");
        player.load();
        wrap.remove();
      },
    };
  },
};

// ── documents ───────────────────────────────────────────────────────────────
// Same-origin frame; the browser renders PDFs and plain text natively, and the
// frame paints progressively, so no loading spinner. docx can't render in a
// frame; its formatted-HTML sidecar can.
const docDetail = {
  name: "doc",
  matches: (inst) => !!inst?.kind && inst.kind !== "image" && inst.kind !== "audio",
  mount(stage, { inst, root }) {
    const frame = document.createElement("iframe");
    frame.className = "lightbox-doc";
    frame.title = "Document";
    // The embedded viewer steals focus as it loads; take it back so keyboard
    // nav keeps working right after opening. Clicking into the document
    // refocuses the viewer — fine, that's how you scroll it.
    frame.addEventListener("load", () => {
      if (frame.isConnected) root.focus({ preventScroll: true });
    });
    frame.src = fullUrl(inst.kind === "docx" ? inst.name + ".html" : inst.name);
    stage.appendChild(frame);
    root.focus({ preventScroll: true });
    return { unmount() { frame.remove(); } };
  },
};

// ── images (the catch-all) ──────────────────────────────────────────────────
const imageDetail = {
  name: "image",
  matches: () => true,
  mount(stage, { inst, root, onImageLayout }) {
    const img = document.createElement("img");
    img.style.opacity = "0";
    root.classList.add("loading");
    img.onload = () => {
      root.classList.remove("loading");
      img.style.opacity = "1";
      onImageLayout?.();
    };
    img.src = fullUrl(inst.name);
    if (img.complete && img.naturalWidth > 0) {
      root.classList.remove("loading");
      img.style.opacity = "1";
    }
    img.alt = inst.tags?.length ? inst.tags.join(", ") : inst.name;
    stage.appendChild(img);
    return {
      imgEl: img,
      unmount() {
        img.onload = null;
        root.classList.remove("loading");
        img.remove();
      },
    };
  },
};

const renderers = [chartDetail, audioDetail, docDetail, imageDetail];

// Mount whichever renderer claims this instance into the (cleared) stage.
// Returns the live handle, or null when nothing matched (never happens while
// image is the catch-all — kept for a future registry where it could).
export function mountDetail(stage, inst, entity, ctx = {}) {
  stage.replaceChildren();
  const renderer = renderers.find((r) => r.matches(inst, entity));
  return renderer ? renderer.mount(stage, { inst, entity, ...ctx }) : null;
}
