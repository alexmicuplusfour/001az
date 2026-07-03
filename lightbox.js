import { state } from './state.js';
import { fullUrl, ICONS } from './utils.js';
import { toast } from './toast.js';
import { taggedFiltered } from './filters.js';
import { openCratePop, closeCratePop } from './crates.js';

const elLightbox = document.getElementById("lightbox");
const elLightboxImg = document.getElementById("lightbox-img");
const elLightboxFav = document.getElementById("lightbox-fav");
const elLightboxCrate = document.getElementById("lightbox-crate");
const elLightboxPrev = document.getElementById("lightbox-prev");
const elLightboxNext = document.getElementById("lightbox-next");
const elLightboxTags = document.getElementById("lightbox-tags");
const elLightboxCount = document.getElementById("lightbox-count");

let lightboxImg = null;
let lightboxList = [];
let lightboxIndex = -1;

function renderLightboxFav() {
  if (!lightboxImg) return;
  elLightboxFav.className = "lightbox-action lightbox-fav" + (lightboxImg.favoritedByMe ? " on" : "");
  elLightboxFav.innerHTML = `${ICONS.heart}<span>${lightboxImg.hearts || 0}</span>`;
}

function renderLightboxCrate() {
  if (!lightboxImg) return;
  const n = lightboxImg.crateIds.size;
  elLightboxCrate.className = "lightbox-action lightbox-crate" + (n > 0 ? " on" : "");
  elLightboxCrate.innerHTML = `${ICONS.crate}<span>${n > 0 ? n : ""}</span>`;
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
  elLightboxTags.replaceChildren();
  for (const t of lightboxImg.tags) {
    const s = document.createElement("span");
    s.className = "ltp";
    s.textContent = t;
    elLightboxTags.appendChild(s);
  }
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
  elLightbox.hidden = true;
  elLightbox.classList.remove("loading");
  elLightboxImg.onload = null;
  elLightboxImg.src = "";
  elLightboxImg.alt = "";
  elLightboxTags.replaceChildren();
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
      const r = await fetch(`/api/images/${lightboxImg.id}/favorite`, { method: "POST" });
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

  document.addEventListener("keydown", (e) => {
    if (elLightbox.hidden) return;
    if (e.key === "Escape") closeLightbox();
    else if (e.key === "ArrowLeft") navLightbox(-1);
    else if (e.key === "ArrowRight") navLightbox(1);
  });

  // Crates module dispatches this when a crate membership changes while the lightbox is open.
  document.addEventListener('app:lightbox-crate-changed', renderLightboxCrate);
}
