import { state } from '../../state.js';
import { ICONS } from '../../utils.js';
import { toast } from '../../toast.js';
import { taggedFiltered } from '../../filters.js';
import { openCratePop, closeCratePop } from '../../crates.js';
import { scrollToCard } from '../../grid.js';
import { fullUrl } from './index.js';

const elLightbox = document.getElementById("lightbox");
const elLightboxImg = document.getElementById("lightbox-img");
const elLightboxFav = document.getElementById("lightbox-fav");
const elLightboxCrate = document.getElementById("lightbox-crate");
const elLightboxPrev = document.getElementById("lightbox-prev");
const elLightboxNext = document.getElementById("lightbox-next");
const elLightboxCount = document.getElementById("lightbox-count");
const elLightboxInfo = document.getElementById("lightbox-info");
const elLightboxPanel = document.getElementById("lightbox-panel");
const elLightboxPanelBody = document.getElementById("lightbox-panel-body");

let lightboxImg = null;
let lightboxList = [];
let lightboxIndex = -1;
let panelOpen = false;
let reasoningReq = 0; // stale-response guard for the reasoning fetch

function renderLightboxFav() {
  if (!lightboxImg) return;
  elLightboxFav.className = "lightbox-action lightbox-fav" + (lightboxImg.favoritedByMe ? " on" : "");
  elLightboxFav.innerHTML = `${ICONS.heart}<span>${lightboxImg.hearts || 0}</span>`;
}

function renderLightboxCrate() {
  if (!lightboxImg) return;
  const n = lightboxImg.crateIds.size;
  elLightboxCrate.className = "lightbox-action lightbox-crate" + (n > 0 ? " on" : "");
  elLightboxCrate.innerHTML = n > 0 ? `${ICONS.crate}<span>${n}</span>` : ICONS.crate;
}

// Paint the reasoning panel for img. reasoning is null while the fetch is in
// flight — tags render immediately, reasoning lines fill in when it lands.
function paintPanel(img, reasoning) {
  elLightboxPanelBody.replaceChildren();
  const byFacet = new Map();
  for (const t of img.tags) {
    const i = t.indexOf("/");
    if (i <= 0) continue;
    const k = t.slice(0, i);
    if (!byFacet.has(k)) byFacet.set(k, []);
    byFacet.get(k).push(t.slice(i + 1));
  }
  const why = reasoning || {};

  if (img.status === "held") {
    const note = document.createElement("div");
    note.className = "lbp-undecided";
    note.textContent = "Not tagged yet — this board's auto-tagging is off. Tag it by hand, or turn auto-tagging back on.";
    elLightboxPanelBody.appendChild(note);
  } else if (img.undecided) {
    const note = document.createElement("div");
    note.className = "lbp-undecided";
    note.textContent = why.fit || "The AI couldn't apply this board's facets to this image.";
    elLightboxPanelBody.appendChild(note);
  }

  if (why.description) {
    const p = document.createElement("p");
    p.className = "lbp-desc";
    p.textContent = why.description;
    elLightboxPanelBody.appendChild(p);
  }

  let rows = 0;
  for (const f of state.facets) {
    const vals = byFacet.get(f.key) || [];
    const text = why[f.key];
    if (!vals.length && !text) continue;
    rows++;
    const row = document.createElement("div");
    row.className = "lbp-facet";
    const head = document.createElement("div");
    head.className = "lbp-facet-head";
    const label = document.createElement("span");
    label.className = "lbp-facet-label";
    label.textContent = f.label;
    head.appendChild(label);
    if (vals.length) {
      for (const v of vals) {
        const chip = document.createElement("span");
        chip.className = "lbp-chip";
        chip.textContent = v;
        head.appendChild(chip);
      }
    } else {
      const none = document.createElement("span");
      none.className = "lbp-none";
      none.textContent = "—";
      head.appendChild(none);
    }
    row.appendChild(head);
    if (text) {
      const p = document.createElement("p");
      p.className = "lbp-why";
      p.textContent = text;
      row.appendChild(p);
    }
    elLightboxPanelBody.appendChild(row);
  }

  if (!rows && !img.undecided && img.status !== "held") {
    const empty = document.createElement("p");
    empty.className = "lbp-hint";
    empty.textContent = reasoning === null ? "Loading…" : "No AI tags for this image.";
    elLightboxPanelBody.appendChild(empty);
  } else if (reasoning !== null && img.tags.length && !Object.keys(why).length) {
    const hint = document.createElement("p");
    hint.className = "lbp-hint";
    hint.textContent = state.aiReasoning
      ? "No reasoning recorded — this image was tagged before reasoning was captured. Retag it to record one."
      : "AI reasoning is turned off for this board.";
    elLightboxPanelBody.appendChild(hint);
  }
}

async function renderPanel() {
  if (!panelOpen || !lightboxImg) return;
  const img = lightboxImg;
  paintPanel(img, null);
  const token = ++reasoningReq;
  let reasoning = {};
  try {
    const r = await fetch(`/api/items/${img.id}/reasoning`);
    if (r.ok) reasoning = (await r.json()).reasoning || {};
  } catch { /* panel just shows tags without reasoning */ }
  if (token !== reasoningReq || lightboxImg !== img || !panelOpen) return;
  paintPanel(img, reasoning);
}

function setPanel(open) {
  panelOpen = open;
  elLightboxPanel.hidden = !open;
  elLightbox.classList.toggle("panel-open", open);
  elLightboxInfo.classList.toggle("on", open);
  if (open) renderPanel();
}

function preloadFull(i) {
  if (i >= 0 && i < lightboxList.length) {
    const im = new Image();
    im.src = fullUrl(lightboxList[i].name);
  }
}

function showLightbox() {
  lightboxImg = lightboxList[lightboxIndex];
  elLightboxImg.style.opacity = "0";
  elLightbox.classList.add("loading");
  elLightboxImg.onload = () => {
    elLightbox.classList.remove("loading");
    elLightboxImg.style.opacity = "1";
  };
  elLightboxImg.src = fullUrl(lightboxImg.name);
  if (elLightboxImg.complete && elLightboxImg.naturalWidth > 0) {
    elLightbox.classList.remove("loading");
    elLightboxImg.style.opacity = "1";
  }
  elLightboxImg.alt = lightboxImg.tags.length ? lightboxImg.tags.join(", ") : lightboxImg.name;
  if (state.me) {
    renderLightboxFav();
    elLightboxFav.hidden = false;
    renderLightboxCrate();
    elLightboxCrate.hidden = false;
  } else {
    elLightboxFav.hidden = true;
    elLightboxCrate.hidden = true;
  }
  elLightboxCount.textContent =
    lightboxList.length > 1 ? `${lightboxIndex + 1} / ${lightboxList.length}` : "";
  if (panelOpen) renderPanel();
  elLightboxPrev.style.visibility = lightboxIndex > 0 ? "visible" : "hidden";
  elLightboxNext.style.visibility = lightboxIndex < lightboxList.length - 1 ? "visible" : "hidden";
  for (let d = 1; d <= 2; d++) {
    preloadFull(lightboxIndex + d);
    preloadFull(lightboxIndex - d);
  }
}

export function openLightbox(img) {
  lightboxList = taggedFiltered();
  lightboxIndex = lightboxList.indexOf(img);
  if (lightboxIndex < 0) { lightboxList = [img]; lightboxIndex = 0; }
  showLightbox();
  elLightbox.hidden = false;
  document.body.style.overflow = "hidden";
}

export function navLightbox(delta) {
  const n = lightboxIndex + delta;
  if (n < 0 || n >= lightboxList.length) return;
  closeCratePop();
  lightboxIndex = n;
  showLightbox();
}

export function closeLightbox() {
  closeCratePop();
  setPanel(false);
  scrollToCard(lightboxImg);
  elLightbox.hidden = true;
  document.body.style.overflow = "";
  elLightbox.classList.remove("loading");
  elLightboxImg.onload = null;
  elLightboxImg.src = "";
  elLightboxImg.alt = "";
  lightboxImg = null;
  lightboxList = [];
  lightboxIndex = -1;
}

export function initLightbox() {
  elLightbox.addEventListener("click", closeLightbox);

  elLightboxPrev.addEventListener("click", (e) => { e.stopPropagation(); navLightbox(-1); });
  elLightboxNext.addEventListener("click", (e) => { e.stopPropagation(); navLightbox(1); });

  elLightboxFav.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!lightboxImg) return;
    try {
      const r = await fetch(`/api/items/${lightboxImg.id}/favorite`, { method: "POST" });
      if (r.status === 401) return toast.info("Sign in to favorite");
      const { favorited, count } = await r.json();
      lightboxImg.favoritedByMe = favorited;
      lightboxImg.hearts = count;
      renderLightboxFav();
      document.dispatchEvent(new Event('app:render')); // keep grid card in sync
    } catch {
      toast.error("Couldn't update favorite");
    }
  });

  elLightboxCrate.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!lightboxImg) return;
    openCratePop(elLightboxCrate, lightboxImg);
  });

  elLightboxInfo.innerHTML = ICONS.info;
  elLightboxInfo.addEventListener("click", (e) => {
    e.stopPropagation();
    setPanel(!panelOpen);
  });
  elLightboxPanel.addEventListener("click", (e) => e.stopPropagation());
  document.getElementById("lightbox-panel-close").addEventListener("click", () => setPanel(false));

  document.addEventListener("keydown", (e) => {
    if (elLightbox.hidden) return;
    if (e.key === "Escape") panelOpen ? setPanel(false) : closeLightbox();
    else if (e.key === "ArrowLeft") navLightbox(-1);
    else if (e.key === "ArrowRight") navLightbox(1);
  });

  // Crates module dispatches this when a crate membership changes while the lightbox is open.
  document.addEventListener('app:lightbox-crate-changed', renderLightboxCrate);
}
