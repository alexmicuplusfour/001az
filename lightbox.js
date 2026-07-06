import { state } from './state.js';
import { ICONS } from './utils.js';
import { toast } from './toast.js';
import { taggedFiltered } from './filters.js';
import { openCratePop, closeCratePop } from './crates.js';
import { scrollToCard } from './grid.js';
import { fullUrl } from './kinds.js';

const elLightbox = document.getElementById("lightbox");
const elLightboxImg = document.getElementById("lightbox-img");
const elLightboxDoc = document.getElementById("lightbox-doc");
const elLightboxFav = document.getElementById("lightbox-fav");
const elLightboxCrate = document.getElementById("lightbox-crate");
const elLightboxPrev = document.getElementById("lightbox-prev");
const elLightboxNext = document.getElementById("lightbox-next");
const elLightboxCount = document.getElementById("lightbox-count");
const elLightboxInfo = document.getElementById("lightbox-info");
const elLightboxPanel = document.getElementById("lightbox-panel");
const elLightboxPanelBody = document.getElementById("lightbox-panel-body");
const elLightboxDownload = document.getElementById("lightbox-download");

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

// Paint the reasoning panel for img. reasoning/fields are null while the
// fetch is in flight — tags render immediately, details fill in when it lands.
// identityProvisional is true when the AI couldn't derive an identity.
function paintPanel(img, reasoning, fields, identityProvisional, files) {
  // Same-origin link, so the download attribute names the saved file — the
  // item's original name, not the hashed store name.
  elLightboxDownload.href = fullUrl(img.name);
  elLightboxDownload.download = img.label || img.name;

  elLightboxPanelBody.replaceChildren();

  // Item reference block: whatever the item carries. Values are
  // click-to-select for easy copying.
  const meta = document.createElement("div");
  meta.className = "lbp-meta";
  const metaName = document.createElement("div");
  metaName.className = "lbp-meta-name";
  metaName.textContent = img.displayLabel;
  metaName.title = img.displayLabel;
  meta.appendChild(metaName);
  const metaRows = [["file", img.name], ["kind", img.kind || "image"], ["id", String(img.id)]];
  for (const [k, v] of metaRows) {
    const row = document.createElement("div");
    row.className = "lbp-meta-row";
    const key = document.createElement("span");
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "lbp-meta-val";
    val.textContent = v;
    row.append(key, val);
    meta.appendChild(row);
  }
  elLightboxPanelBody.appendChild(meta);

  // Multi-file list with per-file remove (shown when entity has ≥2 files).
  // `files` comes from the reasoning fetch (payload.files); null while loading.
  const allFiles = Array.isArray(files) ? files : [];
  if (allFiles.length >= 2) {
    const filesSec = document.createElement("div");
    filesSec.className = "lbp-files";
    const filesLabel = document.createElement("div");
    filesLabel.className = "lbp-fields-label";
    filesLabel.textContent = "Files";
    filesSec.appendChild(filesLabel);
    allFiles.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "lbp-file-row";
      const fname = document.createElement("span");
      fname.className = "lbp-file-name";
      fname.textContent = f.original_name || f.name;
      const rmBtn = document.createElement("button");
      rmBtn.className = "lbp-file-remove";
      rmBtn.title = "Remove this file";
      rmBtn.textContent = "×";
      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        rmBtn.disabled = true;
        try {
          const r = await fetch(`/api/items/${img.id}/files/${i}`, { method: "DELETE" });
          if (r.ok) {
            img.status = (await r.json()).status;
            document.dispatchEvent(new Event('app:render'));
            renderPanel();
          }
        } finally { rmBtn.disabled = false; }
      });
      row.append(fname, rmBtn);
      filesSec.appendChild(row);
    });
    elLightboxPanelBody.appendChild(filesSec);
  }

  // Provisional identity warning — shown when the AI couldn't derive an identity.
  if (identityProvisional) {
    const warn = document.createElement("div");
    warn.className = "lbp-provisional-warn";
    warn.textContent = "Identity not derived — AI couldn't identify this entity. Re-extract or remove the item.";
    elLightboxPanelBody.appendChild(warn);
  }

  // Fields section: shown when extraction has run (fields object has keys).
  const fieldKeys = fields && typeof fields === "object" ? Object.keys(fields) : [];
  if (fieldKeys.length > 0) {
    const sec = document.createElement("div");
    sec.className = "lbp-fields";
    const secHead = document.createElement("div");
    secHead.className = "lbp-fields-head";
    const secLabel = document.createElement("span");
    secLabel.className = "lbp-fields-label";
    secLabel.textContent = "Fields";
    secHead.appendChild(secLabel);
    const reextractBtn = document.createElement("button");
    reextractBtn.className = "lbp-reextract";
    reextractBtn.textContent = "Re-extract";
    reextractBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      reextractBtn.disabled = true;
      try {
        const r = await fetch(`/api/items/${img.id}/reextract`, { method: "POST" });
        if (r.ok) {
          img.status = "pending_extract";
          document.dispatchEvent(new Event('app:render'));
        }
      } finally {
        reextractBtn.disabled = false;
      }
    });
    secHead.appendChild(reextractBtn);
    sec.appendChild(secHead);
    for (const key of fieldKeys) {
      const { v, why } = fields[key] || {};
      const row = document.createElement("div");
      row.className = "lbp-field-row";
      const kv = document.createElement("div");
      kv.className = "lbp-field-kv";
      const k = document.createElement("span");
      k.className = "lbp-field-key";
      k.textContent = key;
      const val = document.createElement("span");
      val.className = "lbp-field-val";
      val.textContent = v !== null && v !== undefined ? String(v) : "—";
      kv.append(k, val);
      row.appendChild(kv);
      if (why) {
        const p = document.createElement("p");
        p.className = "lbp-why";
        p.textContent = why;
        row.appendChild(p);
      }
      sec.appendChild(row);
    }
    elLightboxPanelBody.appendChild(sec);
  }

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
    note.textContent = why.fit || "The AI couldn't apply this board's facets to this item.";
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
    empty.textContent = reasoning === null ? "Loading…" : "No AI tags for this item.";
    elLightboxPanelBody.appendChild(empty);
  } else if (reasoning !== null && img.tags.length && !Object.keys(why).length) {
    const hint = document.createElement("p");
    hint.className = "lbp-hint";
    hint.textContent = state.aiReasoning
      ? "No reasoning recorded — this item was tagged before reasoning was captured. Retag it to record one."
      : "AI reasoning is turned off for this board.";
    elLightboxPanelBody.appendChild(hint);
  }
}

async function renderPanel() {
  if (!panelOpen || !lightboxImg) return;
  const img = lightboxImg;
  paintPanel(img, null, null, null);
  const token = ++reasoningReq;
  let reasoning = {};
  let fields = {};
  let files = [];
  let identityProvisional = false;
  try {
    const r = await fetch(`/api/items/${img.id}/reasoning`);
    if (r.ok) {
      const data = await r.json();
      reasoning = data.reasoning || {};
      fields = data.fields || {};
      files = data.files || [];
      identityProvisional = !!data.identity_provisional;
    }
  } catch { /* panel just shows tags without reasoning */ }
  if (token !== reasoningReq || lightboxImg !== img || !panelOpen) return;
  paintPanel(img, reasoning, fields, identityProvisional, files);
}

function setPanel(open) {
  panelOpen = open;
  elLightboxPanel.hidden = !open;
  elLightbox.classList.toggle("panel-open", open);
  elLightboxInfo.classList.toggle("on", open);
  if (open) renderPanel();
}

const isDocItem = (it) => it.kind && it.kind !== "image";

function preloadFull(i) {
  if (i >= 0 && i < lightboxList.length && !isDocItem(lightboxList[i])) {
    const im = new Image();
    im.src = fullUrl(lightboxList[i].name);
  }
}

function showLightbox() {
  lightboxImg = lightboxList[lightboxIndex];
  if (isDocItem(lightboxImg)) {
    // Documents render inline in a same-origin frame; the frame paints
    // progressively, so no loading spinner.
    elLightboxImg.onload = null;
    elLightboxImg.removeAttribute("src");
    elLightboxImg.hidden = true;
    elLightbox.classList.remove("loading");
    // docx can't render in a frame; its extracted-text sidecar can.
    const url = fullUrl(lightboxImg.kind === "docx" ? lightboxImg.name + ".txt" : lightboxImg.name);
    if (elLightboxDoc.getAttribute("src") !== url) elLightboxDoc.src = url;
    elLightboxDoc.hidden = false;
    // The embedded viewer grabs keyboard focus; keep it on the lightbox so
    // arrows/Escape work. Clicking into the document refocuses the viewer —
    // fine, that's how you scroll it.
    elLightbox.focus({ preventScroll: true });
  } else {
    if (!elLightboxDoc.hidden) { elLightboxDoc.hidden = true; elLightboxDoc.removeAttribute("src"); }
    elLightboxImg.hidden = false;
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
  elLightboxImg.hidden = false;
  elLightboxDoc.hidden = true;
  elLightboxDoc.removeAttribute("src");
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
  elLightboxDownload.innerHTML = ICONS.download;
  document.getElementById("lightbox-panel-close").addEventListener("click", () => setPanel(false));

  document.addEventListener("keydown", (e) => {
    if (elLightbox.hidden) return;
    if (e.key === "Escape") panelOpen ? setPanel(false) : closeLightbox();
    else if (e.key === "ArrowLeft") navLightbox(-1);
    else if (e.key === "ArrowRight") navLightbox(1);
  });

  // The document viewer steals focus as it loads; take it back so keyboard
  // nav keeps working right after opening.
  elLightboxDoc.addEventListener("load", () => {
    if (!elLightbox.hidden && !elLightboxDoc.hidden) elLightbox.focus({ preventScroll: true });
  });

  // Crates module dispatches this when a crate membership changes while the lightbox is open.
  document.addEventListener('app:lightbox-crate-changed', renderLightboxCrate);
}
