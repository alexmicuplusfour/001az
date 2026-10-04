import { state } from './state.js';
import { itemsChanged, itemsVersion } from './state-signals.js';
import { signal, effect, batch } from './vendor/signals.mjs';
import { ICONS } from './utils.js';
import { toast } from './toast.js';
import { taggedFiltered } from './filters.js';
import { openCratePop } from './crates.js';
import { showItem } from './batches.js';
import { fullUrl } from './kinds.js';
import { lockScroll, unlockScroll } from './modal.js';
import { closeDropdown } from './dropdown.js';
import { focusOwnsKeys } from './shortcuts.js';
import { detailsOf, followFile, drawPanel, resetPanel } from './lightbox-panel.js';

import { selectFace } from './face-select.js';
import { mountDetail } from './detail-view.js';
import { contentRect, detColor } from './det-geometry.js';
import { fitInfo, zoomAt, wheelFactor, nativePercent, clipInset } from './zoom-geometry.js';

const elLightbox = document.getElementById("lightbox");
const elLightboxStage = document.getElementById("lightbox-stage");
const elLightboxFav = document.getElementById("lightbox-fav");
const elLightboxCrate = document.getElementById("lightbox-crate");
const elLightboxPrev = document.getElementById("lightbox-prev");
const elLightboxNext = document.getElementById("lightbox-next");
const elLightboxCount = document.getElementById("lightbox-count");
const elLightboxInfo = document.getElementById("lightbox-info");
const elLightboxPanel = document.getElementById("lightbox-panel");
const elLightboxPanelBody = document.getElementById("lightbox-panel-body");
const elLightboxPin = document.getElementById("lightbox-panel-pin");

// What the lightbox shows: the open item, and its selected file by id
// (planning/lightbox-panel-plan.md, D2 and D3). Opening, paging and picking a
// file write them; the effect (draw, below) draws from them and the items.
const lightboxItem = signal(null);
const lightboxFile = signal(null);
const panelOpen = signal(false); // the Details panel, which the effect draws while it's open (D2)
let lightboxList = [];
let lightboxIndex = -1;
let elDetOverlay = null; // object-detection box layer over the lightbox image
let currentHandle = null; // the mounted detail renderer's handle (detail-view.js)

// A pick in the panel's file list: the effect puts the file on the stage.
const pickFile = (id) => { lightboxFile.value = id; };

// The file an item opens on: the one its card shows, as the rows view finds
// its face (rows.js).
const faceFile = (item) => selectFace(item.instances, state.boardMapping?.face)?.id ?? null;

// A button's insides, written only when they change. The effect draws on
// every change to any item, and a poll that brought nothing for this one
// leaves them be, and with them a tooltip under the pointer (Details').
const written = new WeakMap();
function write(el, html) {
  if (written.get(el) === html) return;
  written.set(el, html);
  el.innerHTML = html;
}

function renderLightboxFav(item) {
  elLightboxFav.className = "lightbox-action lightbox-fav" + (item.favoritedByMe ? " on" : "");
  write(elLightboxFav, `${ICONS.heart}<span>${item.hearts || 0}</span>`);
  // Its name is "Favorite" (index.html); whether it's on is said here.
  elLightboxFav.setAttribute("aria-pressed", String(!!item.favoritedByMe));
}

function renderLightboxCrate(item) {
  const n = item.crateIds.size;
  elLightboxCrate.className = "lightbox-action lightbox-crate" + (n > 0 ? " on" : "");
  write(elLightboxCrate, n > 0 ? `${ICONS.crate}<span>${n}</span>` : ICONS.crate);
}

// The info button carries an instance-count badge when the entity is multi-file,
// so the "this has more inside" cue is visible without opening the panel.
function renderLightboxInfo(item) {
  const n = item.instances?.length || 0;
  write(elLightboxInfo, n >= 2 ? `${ICONS.info}<span>${n}</span>` : ICONS.info);
}

// ── Object-detection overlay (Slice 3) ──────────────────────────────────────
// Boxes drawn over the lightbox image for `object` AI-fields, linked by a
// `key:idx` handle to the hoverable list in the AI-extracted-fields panel cell.
// Each box is positioned as PERCENTAGES of the overlay, which is itself sized to
// the displayed image content rect — so a resize only re-sizes the overlay and
// the boxes follow. `contentRect`/`detColor` live in det-geometry.js (pure,
// unit-tested).
function displayedContentRect(img) {
  return contentRect(img.getBoundingClientRect(), img.naturalWidth, img.naturalHeight);
}
// A non-empty array `v` is the object-field discriminator — the same one the
// server's objectKeysOf reads — minus a LIST field (`kind: "list"`, an array
// of option spellings, no boxes to draw).
function objectFieldsOf(fields) {
  const out = [];
  for (const [key, f] of Object.entries(fields || {})) if (Array.isArray(f?.v) && f.kind !== "list") out.push({ key, dets: f.v });
  return out;
}
// Size + place the overlay over the current displayed image; hidden when there's
// nothing to show or the stage isn't showing a ready image (repositioned on
// load/resize/toggle). The image element belongs to whichever detail renderer is
// mounted — an image-bearing renderer exposes it as handle.imgEl; any other
// renderer (doc, audio) has none and the overlay stays hidden.
function positionDetOverlay() {
  if (!elDetOverlay) return;
  const img = readyImage();
  if (!elDetOverlay.childElementCount || !img) {
    elDetOverlay.hidden = true;
    return;
  }
  // Every measurement first, every write after: this runs once per zoom frame,
  // and a rect read placed below the writes forces a synchronous layout flush
  // on each one.
  const r = displayedContentRect(img);
  const host = elLightbox.getBoundingClientRect();
  // The overlay hangs off the LIGHTBOX, not the stage, so the stage's `clip`
  // never reaches it — zoomed in, its boxes would paint over the nav arrows and
  // the count pill. Clip it to the same frame by hand. (Moving it into the
  // stage instead would put it in front of mountDetail's replaceChildren, which
  // would delete it on the next navigation and never rebuild it.)
  const clip = clipInset(r, elLightboxStage.getBoundingClientRect());
  elDetOverlay.style.left = (r.x - host.left) + "px";
  elDetOverlay.style.top = (r.y - host.top) + "px";
  elDetOverlay.style.width = r.w + "px";
  elDetOverlay.style.height = r.h + "px";
  elDetOverlay.style.clipPath = clip;
  elDetOverlay.hidden = false;
}
// Rebuild the boxes for the given fields (percentage-positioned children), then
// place the overlay. Empty/invalid boxes are skipped; a non-image or fieldless
// panel clears to nothing.
function drawDetOverlay(fields) {
  if (!elDetOverlay) return;
  elDetOverlay.replaceChildren();
  for (const { key, dets } of objectFieldsOf(fields)) {
    const color = detColor(key);
    dets.forEach((d, idx) => {
      const box = d?.box;
      if (!Array.isArray(box) || box.length !== 4 || box.some((n) => typeof n !== "number")) return;
      const [x0, y0, x1, y1] = box;
      const el = document.createElement("div");
      el.className = "lb-det-box";
      el.dataset.det = `${key}:${idx}`;
      el.style.cssText = `left:${x0 * 100}%;top:${y0 * 100}%;width:${(x1 - x0) * 100}%;height:${(y1 - y0) * 100}%;border-color:${color};`;
      const lab = document.createElement("span");
      lab.className = "lb-det-label";
      lab.style.background = color;
      lab.textContent = d.label + (typeof d.score === "number" ? ` ${Math.round(d.score * 100)}%` : "");
      el.appendChild(lab);
      elDetOverlay.appendChild(el);
    });
  }
  positionDetOverlay();
}
function clearDetOverlay() {
  if (!elDetOverlay) return;
  elDetOverlay.replaceChildren();
  elDetOverlay.hidden = true;
}
function highlightDet(detKey, on) {
  elDetOverlay?.querySelector(`[data-det="${CSS.escape(detKey)}"]`)?.classList.toggle("det-hi", on);
}

// ── Scroll-to-zoom (planning/lightbox-zoom-plan.md) ─────────────────────────
// The wheel scales the image about the cursor. Nothing else changes: a click
// still closes, there is no drag, and an image that already fits is left
// exactly as it was. All the arithmetic is in zoom-geometry.js; what lives here
// is when to re-measure and when to paint.
//
// Two pieces of state. `zoomView` is meaningless except against the `zoomFit`
// it was computed for — which is why a fit carries its own frame and the two
// are replaced together, in refitZoom().
const ZOOM_REST = { s: 1, tx: 0, ty: 0 };
let zoomFit = null;
let zoomView = ZOOM_REST;
let zoomFrame = 0; // pending paint

// "The stage is showing an image we can measure." Shared with
// positionDetOverlay so the overlay and the zoom can never disagree about
// whether there is an image — `imgEl` is the handle contract's single hook for
// both (detail-view.js), and a gate written twice is a gate that drifts. A
// renderer with no image (doc, audio, chart) has none, which is also what hands
// the chart's own wheel zoom-pan through untouched.
function readyImage() {
  const img = currentHandle?.imgEl;
  return img?.isConnected && img.naturalWidth ? img : null;
}

// Send the view home without re-measuring — for a media swap, a close, or the
// `0` key, none of which need a new frame to know the answer is "fitted".
function resetZoom() {
  if (zoomFrame) { cancelAnimationFrame(zoomFrame); zoomFrame = 0; }
  zoomView = ZOOM_REST;
  paintZoom();
}

// Re-measure the frame and the resting box inside it, then reset. Called when
// the frame moves (the stage's ResizeObserver) and when a size first exists
// (onImageLayout).
function refitZoom() {
  const img = readyImage();
  zoomFit = img
    ? fitInfo(elLightboxStage.getBoundingClientRect(), img.naturalWidth, img.naturalHeight)
    : null;
  resetZoom();
}

function paintZoom() {
  const img = readyImage();
  const zoomed = zoomView.s > 1;
  if (img && zoomed) {
    // transform-origin lives in the .zoomed rule, which lands with the class
    // below — writing a constant here would re-parse it every frame.
    img.style.transform = `translate(${zoomView.tx}px, ${zoomView.ty}px) scale(${zoomView.s})`;
  } else if (img) {
    // Removed, not set to an identity transform: a transformed element is a
    // containing block and a stacking context, and at rest it should be
    // neither.
    img.style.removeProperty("transform");
  }
  elLightbox.classList.toggle("zoomed", zoomed);
  renderLightboxCount();
  positionDetOverlay();
}

// One paint per frame however many events arrive in it — a wheel outruns
// frames, and a trackpad fling badly so.
function schedulePaint() {
  if (!zoomFrame) zoomFrame = requestAnimationFrame(() => { zoomFrame = 0; paintZoom(); });
}

// Scale about a point: the only thing that moves the view. The wheel and the
// keys differ in where they aim and how far, and in nothing else.
function applyZoom(cursor, factor) {
  if (!zoomFit?.zoomable) return;
  const next = zoomAt(zoomView, cursor, factor, zoomFit);
  if (next.s === zoomView.s && next.tx === zoomView.tx && next.ty === zoomView.ty) return;
  zoomView = next; // compound synchronously, so events sharing a frame each count
  schedulePaint();
}

// Zoom from the keyboard, about the middle of the stage — the only anchor there
// is without a pointer. One press is one wheel notch BY CONSTRUCTION
// (wheelFactor past its own cap), so the two can never drift apart.
function zoomByKey(factor) {
  if (!zoomFit?.zoomable) return;
  const f = zoomFit.frame;
  applyZoom({ x: f.left + f.width / 2, y: f.top + f.height / 2 }, factor);
}

function onStageWheel(e) {
  if (!readyImage()) return; // a chart's wheel bubbles through here; it's not ours
  if (!zoomFit?.zoomable) {
    // Nothing to zoom into — but a trackpad pinch arrives as ctrl+wheel, and
    // letting it page-zoom the browser UNDER a position:fixed overlay is its
    // own mess. Refuse that much and do nothing else.
    if (e.ctrlKey) e.preventDefault();
    return;
  }
  e.preventDefault(); // browser page zoom, and macOS option+wheel history nav
  applyZoom({ x: e.clientX, y: e.clientY }, wheelFactor(e.deltaY, e.deltaMode));
}

// The pill at the bottom of the stage. Two things want to speak through it —
// where you are in the board, and how far into the picture you are — and either
// can be absent, so one function composes it instead of two writers racing for
// the same textContent. The scale rides as a TAIL (`3 / 461 · 72%`), the
// modeChip idiom, rather than as a second pill: .lightbox-count is
// center-anchored with its own panel-open offset, and a neighbour would have to
// duplicate both and then negotiate against a width that changes with the item
// count. `:empty` in the stylesheet hides it when neither part speaks.
let countText = null;
function renderLightboxCount() {
  const parts = [];
  if (lightboxList.length > 1) parts.push(`${lightboxIndex + 1} / ${lightboxList.length}`);
  // Percent of NATIVE size, so 100% means actual pixels — and the reader can
  // see why the wheel stops there instead of guessing.
  if (zoomView.s > 1 && zoomFit) parts.push(`${nativePercent(zoomView.s, zoomFit.maxScale)}%`);
  const text = parts.join(" · ");
  // This runs per painted frame, and the pill blurs the backdrop behind it —
  // an unconditional write re-rasterizes that blur for a string that mostly
  // hasn't changed (the board position never does mid-gesture, and the percent
  // is rounded).
  if (text === countText) return;
  countText = text;
  elLightboxCount.textContent = text;
}

// Pinning the panel — per viewer, per board (the boardSort pattern). The
// stored bit only decides the state a fresh lightbox open starts in; closing
// the panel by hand doesn't unpin.
const pinKey = () => `lbPanelPin:${state.boardId}`;
function panelPinned() {
  try { return localStorage.getItem(pinKey()) === "1"; } catch { return false; }
}

function setPanel(open) {
  // Closed with focus inside it (its ×, Escape): the panel hides, and the
  // browser drops focus from a control it hides. Back to the button that
  // opens it. Likewise when a move has just taken the button the focus was
  // on, and the next file's details haven't brought it back yet (D11).
  const active = document.activeElement;
  if (!open && (elLightboxPanel.contains(active) || active === document.body)) elLightboxInfo.focus({ preventScroll: true });
  elLightbox.classList.toggle("panel-open", open); // shows the panel too (styles.css)
  elLightboxInfo.classList.toggle("on", open);
  // The class first: drawing the panel reads layout (its file list's
  // scroll), and a pinned panel read closed would slide in (open, below).
  panelOpen.value = open; // the effect draws it (D2)
  if (!open) clearDetOverlay();
  // .panel-open shifts the stage padding, so the stage resizes — which the
  // ResizeObserver in initLightbox hears, after layout, without this function
  // having to know it moved anything.
}

const isDocItem = (it) => it.kind && it.kind !== "image";

function preloadFull(i) {
  if (i >= 0 && i < lightboxList.length && !isDocItem(lightboxList[i])) {
    const img = new Image();
    img.src = fullUrl(lightboxList[i].name);
  }
}

// Render a file-carrying thing (an instance, or the entity's face fields as
// a fallback) into the main lightbox view, by mounting whichever detail
// renderer claims it (detail-view.js) into the stage. The previous renderer's
// unmount releases its resources first — playback, listeners, its nodes — so
// navigating away from an audio clip stops it, exactly as before the registry.
function showMedia(f) {
  currentHandle?.unmount?.();
  currentHandle = mountDetail(elLightboxStage, f, lightboxItem.value, {
    root: elLightbox,
    onImageLayout: refitZoom,
  });
  // Forget the previous image's zoom the moment the media is swapped, rather
  // than whenever the new one finishes loading — otherwise navigating away from
  // a zoomed image leaves it zoomed for the length of the next load. A reset,
  // deliberately not a refit: measuring here would be wasted on a cold image
  // (no naturalWidth yet) and redundant on a warm one, since onImageLayout
  // fires either way.
  resetZoom();
}

// The next card along in the list it pages through, past any that has left
// the page since the lightbox opened (D12), or -1 when there's none.
function step(delta) {
  for (let n = lightboxIndex + delta; n >= 0 && n < lightboxList.length; n += delta) {
    if (state.items.includes(lightboxList[n])) return n;
  }
  return -1;
}

function preloadAround() {
  for (let d = 1; d <= 2; d++) {
    preloadFull(lightboxIndex + d);
    preloadFull(lightboxIndex - d);
  }
}

// While the lightbox is open this draws it from what it shows
// (planning/lightbox-panel-plan.md, D4): the heart, crate and file-count
// buttons, the arrows and the dialog's name, from the item, whose changes
// arrive in place (itemsVersion); the stage when it moves to another item or
// file, and only then, so a poll never restarts a clip or drops a zoom (D3);
// the boxes over the picture; and while it's open, the Details panel, a
// component (lightbox-panel.js), on every run, which Preact leaves alone where
// nothing changed. It moves the selection off a file that left the item (D3),
// and closes the lightbox when the item leaves the page (D12).
//
// It runs inside whatever wrote what it reads, the poll's merge among them,
// so it reports its own errors rather than throw them back there, as app.js's
// draw does. And whatever it calls subscribes it: the stage's mount reads the
// board's mapping, the panel the facets, the catalog its fields print by and
// the file's details. A run for any of those leaves the stage alone.
let stopDrawing = null;
let drawn = { item: null, file: null }; // what the stage shows
let lastPlace = 0; // where the selected file sat in its item's list
let detsFor = null; // the details the boxes over the picture were drawn from

function draw() {
  try {
    const item = lightboxItem.value;
    void itemsVersion.value;
    if (!item) return;
    if (!state.items.includes(item)) {
      closeLightbox();
      toast("That card isn't on this board any more");
      return;
    }
    const files = item.instances || [];
    const selected = lightboxFile.value;
    const at = files.findIndex((f) => f.id === selected);
    if (at < 0 && files.length) {
      // The file that took its place, or the new last one. Writing the
      // selection runs this again, on that file.
      lightboxFile.value = files[Math.min(lastPlace, files.length - 1)].id;
      return;
    }
    lastPlace = Math.max(at, 0);
    elLightboxFav.hidden = elLightboxCrate.hidden = !state.me;
    if (state.me) {
      renderLightboxFav(item);
      renderLightboxCrate(item);
    }
    renderLightboxInfo(item);
    elLightbox.setAttribute("aria-label", item.displayLabel); // the dialog's name (index.html)
    elLightboxPrev.style.visibility = step(-1) >= 0 ? "visible" : "hidden";
    elLightboxNext.style.visibility = step(1) >= 0 ? "visible" : "hidden";
    const file = files[at] || null;
    if (drawn.item !== item || drawn.file !== (file?.id ?? null)) {
      // A menu open on the lightbox was for what it showed: a pick in
      // Retag's scope would retag the file left behind. Another file of the
      // same item closes only the panel's, since the crate menu is the item's.
      closeDropdown("manual", drawn.item === item ? elLightboxPanel : null);
      drawn = { item, file: file?.id ?? null };
      // The count is not written here: showMedia's reset paints, and that
      // paint is the pill's single writer (index and list are current by then).
      // The panel keeps its place (D11): paging through stocks, the field
      // you were reading stays in view.
      showMedia(file || item);
    }
    const panel = panelOpen.value;
    if (file) followFile(file, panel);
    // The boxes over the picture, from the shown file's details (D1), and
    // drawn only here: a move to another file changes them, and one to
    // another card showing the same file (a board that classifies) keeps them.
    // Before the panel, so a panel that fails to draw can't leave the last
    // file's boxes over this picture.
    const snap = panel ? detailsOf(file) : null;
    if (snap !== detsFor) {
      detsFor = snap;
      if (snap) drawDetOverlay(snap.fields);
      else clearDetOverlay();
    }
    if (panel) drawPanel(elLightboxPanelBody, { item, file, snap, onPick: pickFile, onDetHover: highlightDet });
  } catch (e) {
    reportError(e);
  }
}

// Open on an item, on the file its card shows (D3) or on a given one (a
// rows-mode tile click). Not on an item that has left the page: the effect's
// first run would close the lightbox before effect() returns, with no
// stopDrawing yet to stop it, and the rest of this would show an empty
// lightbox.
function open(item, fileId) {
  if (!state.items.includes(item)) return;
  stopDrawing?.();
  lightboxList = taggedFiltered();
  lightboxIndex = lightboxList.indexOf(item);
  if (lightboxIndex < 0) { lightboxList = [item]; lightboxIndex = 0; }
  batch(() => {
    lightboxItem.value = item;
    lightboxFile.value = fileId ?? faceFile(item);
  });
  stopDrawing = effect(draw); // its first run draws the stage, buttons and arrows
  preloadAround();
  elLightbox.hidden = false;
  elLightboxPin.classList.toggle("on", panelPinned());
  // Before anything reads layout (lockScroll does): a pinned panel is part of
  // how the lightbox opens, and set after a style pass it would slide in.
  if (panelPinned()) setPanel(true);
  lockScroll();
  holdPage(true);
  elLightbox.focus({ preventScroll: true });
}

export function openLightboxAt(item, instId) {
  open(item, (item.instances || []).some((f) => f.id === instId) ? instId : null);
}

// While the lightbox is open the page behind it is out of reach: `inert`, so no
// Tab stop, click or screen reader lands there (planning/list-view-plan.md,
// Stage 2b). What opens over the lightbox, a menu or a modal, is added to the
// page after this and stays live, and so do the toasts, the top layer by
// design (toast.css).
let heldBack = [];
function holdPage(on) {
  for (const el of heldBack) el.inert = false;
  heldBack = on
    ? [...document.body.children].filter((el) => el !== elLightbox && el.id !== "toast-wrap" && !el.inert)
    : [];
  for (const el of heldBack) el.inert = true;
}

export function openLightbox(item) {
  open(item, null);
}

export function navLightbox(delta) {
  const n = step(delta);
  if (n < 0) return;
  lightboxIndex = n;
  const item = lightboxList[n];
  batch(() => {
    lightboxItem.value = item;
    lightboxFile.value = faceFile(item);
  });
  preloadAround();
}

export function closeLightbox() {
  stopDrawing?.();
  stopDrawing = null;
  // Any menu open on the lightbox, its crate menu or Retag's scope: the other
  // ways to close close a menu first, and a close for a card that left the
  // page (D12) doesn't wait for anyone.
  closeDropdown();
  setPanel(false);
  // Back to the item the lightbox ended on, which can sit past what the view
  // has drawn: the view showing draws far enough, then the page scrolls to it.
  const shown = showItem(lightboxItem.value);
  elLightbox.hidden = true;
  unlockScroll();
  holdPage(false);
  // And focus goes to its open control where its view has one (List's name),
  // so the keyboard carries on from the row on screen, not the one it opened
  // from. Cards and tiles have none: a click opens them, and a click focuses
  // nothing, so there's nothing to give back.
  shown?.querySelector("[data-open]")?.focus({ preventScroll: true });
  elLightbox.classList.remove("loading");
  currentHandle?.unmount?.();
  currentHandle = null;
  elLightboxStage.replaceChildren();
  resetZoom(); // drop the view and any pending paint; nothing left to measure
  resetPanel(elLightboxPanelBody); // its details, its buttons' state, its tree
  lightboxItem.value = null;
  lightboxFile.value = null;
  drawn = { item: null, file: null };
  detsFor = null;
  lightboxList = [];
  lightboxIndex = -1;
}

export function initLightbox() {
  elDetOverlay = document.createElement("div");
  elDetOverlay.className = "lb-det-overlay";
  elDetOverlay.hidden = true;
  elLightbox.appendChild(elDetOverlay);
  // Observe the box rather than enumerating what moves it — the house idiom
  // (grid.js, header-scroll.js). A window resize is only one of the ways this
  // frame changes: the panel opening re-pads it, a stylesheet could, browser
  // page zoom does. It also fires AFTER layout, which is what the panel toggle
  // otherwise needed a rAF and a comment to arrange.
  new ResizeObserver(refitZoom).observe(elLightboxStage);
  // passive:false — the handler preventDefaults, and Chrome would ignore it
  // otherwise. On the STAGE, not the lightbox: the panel body and the
  // instances list are outside it and keep scrolling normally.
  elLightboxStage.addEventListener("wheel", onStageWheel, { passive: false });

  elLightbox.addEventListener("click", closeLightbox);

  // The arrows come from the icon set like every other button's, rather than
  // being characters in the markup — index.html carries the aria-label, which
  // is the part a caret can't say.
  elLightboxPrev.innerHTML = ICONS.chevronLeft;
  elLightboxNext.innerHTML = ICONS.chevronRight;
  elLightboxPrev.addEventListener("click", (e) => { e.stopPropagation(); navLightbox(-1); });
  elLightboxNext.addEventListener("click", (e) => { e.stopPropagation(); navLightbox(1); });

  elLightboxFav.addEventListener("click", async (e) => {
    e.stopPropagation();
    const item = lightboxItem.value;
    if (!item) return;
    try {
      const r = await fetch(`/api/items/${item.id}/favorite`, { method: "POST" });
      // Session gone (expired, or revoked by a password change elsewhere).
      if (r.status === 401) return location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
      const { favorited, count } = await r.json();
      item.favoritedByMe = favorited;
      item.hearts = count;
      itemsChanged(); // the grid's card follows, and so does this heart
    } catch {
      toast.error("Couldn't update favorite");
    }
  });

  elLightboxCrate.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!lightboxItem.value) return;
    openCratePop(elLightboxCrate, lightboxItem.value);
  });

  elLightboxInfo.addEventListener("click", (e) => {
    e.stopPropagation();
    setPanel(!panelOpen.value);
  });
  elLightboxPanel.addEventListener("click", (e) => e.stopPropagation());
  const elPanelClose = document.getElementById("lightbox-panel-close");
  elPanelClose.innerHTML = ICONS.x;
  elPanelClose.addEventListener("click", () => setPanel(false));
  elLightboxPin.innerHTML = ICONS.pin;
  elLightboxPin.addEventListener("click", () => {
    const on = !panelPinned();
    try { on ? localStorage.setItem(pinKey(), "1") : localStorage.removeItem(pinKey()); }
    catch { /* private mode / quota — the pin just won't stick */ }
    elLightboxPin.classList.toggle("on", on);
  });

  document.addEventListener("keydown", (e) => {
    if (elLightbox.hidden) return;
    if (e.key === "Escape") panelOpen.value ? setPanel(false) : closeLightbox();
    // A focused text field or player takes the rest itself: a crate's name
    // being typed keeps its caret keys, the audio player its seek and volume.
    else if (focusOwnsKeys()) return;
    else if (e.key === "ArrowLeft") navLightbox(-1);
    else if (e.key === "ArrowRight") navLightbox(1);
    // Zoom without a mouse. `=` as well as `+` because the unshifted key is
    // what most layouts actually offer; with ctrl/meta held these belong to the
    // browser's own page zoom and we keep our hands off them. `0` returns to
    // the fit — which is also why Escape doesn't grow a third meaning: the
    // zoom has a key of its own to undo it.
    else if (e.ctrlKey || e.metaKey) return;
    else if (e.key === "+" || e.key === "=") zoomByKey(wheelFactor(-100));
    else if (e.key === "-" || e.key === "_") zoomByKey(wheelFactor(100));
    else if (e.key === "0") resetZoom();
  });
}
