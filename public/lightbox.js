import { state } from './state.js';
import { ICONS, refreshEntityTags, fmtDuration } from './utils.js';
import { toast } from './toast.js';
import { taggedFiltered } from './filters.js';
import { openCratePop, closeCratePop } from './crates.js';
import { scrollToCard } from './grid.js';
import { fullUrl, thumbUrl, kindFor } from './kinds.js';
import { ensurePolling } from './data.js';

// MIRROR of server/faces/select.js — which instance backs an entity's card face,
// per the board's mapping.face { prefer, pick }. Kept byte-identical to the
// server so the client re-derives the same face after an instance changes here;
// change both together (test/faces.test.js asserts parity).
const FACE_FAMILY = { image: "image", pdf: "document", docx: "document", text: "document", audio: "audio" };
function selectFace(instances, faceCfg) {
  if (!instances || !instances.length) return null;
  const isFile = faceCfg?.from === "file";
  const prefer = isFile ? faceCfg.prefer || "any" : "any";
  const pick = isFile ? faceCfg.pick || "first" : "first";
  let pool = instances;
  if (prefer !== "any") {
    const matched = instances.filter((i) => FACE_FAMILY[i.kind] === prefer);
    if (matched.length) pool = matched; // a preference, not a filter — else keep all
  }
  return pick === "latest" ? pool[pool.length - 1] : pool[0];
}

// Format numeric field values readably based on key conventions.
function formatFieldNumber(key, v) {
  if (v === null || v === undefined) return "—";
  if (/change|pct|percent/.test(key)) {
    return (v >= 0 ? "+" : "") + v.toFixed(2) + "%";
  }
  // File-metadata fields (server/media) — plain magnitudes, not currency.
  if (key === "file_size") {
    const u = ["B", "KB", "MB", "GB", "TB"];
    let n = v, i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(n < 10 ? 1 : 0)) + " " + u[i];
  }
  if (key === "megapixels") return v + " MP";
  if (/^(width|height|pages|word_count|line_count)$/.test(key)) return v.toLocaleString();
  // Audio file fields (server/media/audio.js) — human units, not the currency
  // the v>=1 fallback below would otherwise apply.
  if (key === "duration") {
    const s = Math.max(0, Math.round(v));
    const pad = (n) => String(n).padStart(2, "0");
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }
  if (key === "bitrate") return Math.round(v / 1000) + " kbps";
  if (key === "sample_rate") return (v / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 }) + " kHz";
  if (key === "channels") return v === 1 ? "mono" : v === 2 ? "stereo" : String(v);
  if (/market_cap|volume/.test(key)) {
    const abs = Math.abs(v);
    if (abs >= 1e12) return "$" + (v / 1e12).toFixed(2) + "T";
    if (abs >= 1e9)  return "$" + (v / 1e9).toFixed(2) + "B";
    if (abs >= 1e6)  return "$" + (v / 1e6).toFixed(2) + "M";
    return "$" + v.toLocaleString();
  }
  if (/price/.test(key) || v >= 1) {
    return "$" + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return v.toPrecision(6).replace(/\.?0+$/, "");
}

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
const elLightboxAudio = document.getElementById("lightbox-audio");
const elLightboxAudioEl = document.getElementById("lightbox-audio-el");
const elLightboxAudioWave = document.getElementById("lightbox-audio-wave");
const elLightboxAudioText = document.getElementById("lightbox-audio-transcript");

let lightboxImg = null;
let lightboxList = [];
let lightboxIndex = -1;
let panelOpen = false;
let reasoningReq = 0; // stale-response guard for the reasoning fetch
let currentInstIndex = 0; // which instance is shown in the main view (multi-instance entities)

// The instance on screen; entities always have at least one, but guard the
// transient states (mid-reconcile) with the entity's own face fields.
function selectedInst() {
  const list = lightboxImg?.instances || [];
  if (currentInstIndex >= list.length) currentInstIndex = 0;
  return list[currentInstIndex] || null;
}

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

// The info button carries an instance-count badge when the entity is multi-file,
// so the "this has more inside" cue is visible without opening the panel.
function renderLightboxInfo() {
  const n = lightboxImg?.instances?.length || 0;
  elLightboxInfo.innerHTML = n >= 2 ? `${ICONS.info}<span>${n}</span>` : ICONS.info;
}

// Relative age from a field's fetch/refresh timestamp (connector fields carry
// `at`; live ones advance it each refresh, static ones keep the add time).
function relTime(ms) {
  const d = Date.now() - ms;
  if (d < 45000) return "just now";
  return `${fmtDuration(d)} ago`;
}

// One "Fields" section: key/value rows with src badges and why-sentences.
// Used twice — entity-level (connector-bound data, no re-extract) and
// instance-level (AI extraction, with the Re-extract button).
function fieldsSection(fields, { label = "Fields", reextract = null } = {}) {
  const fieldKeys = fields && typeof fields === "object" ? Object.keys(fields) : [];
  if (!fieldKeys.length) return null;
  const sec = document.createElement("div");
  sec.className = "lbp-fields";
  const secHead = document.createElement("div");
  secHead.className = "lbp-fields-head";
  const secLabel = document.createElement("span");
  secLabel.className = "lbp-fields-label";
  secLabel.textContent = label;
  secHead.appendChild(secLabel);
  if (reextract) secHead.appendChild(reextract);
  sec.appendChild(secHead);
  for (const key of fieldKeys) {
    const { v, why, src, kind: fieldKind, at } = fields[key] || {};
    const row = document.createElement("div");
    row.className = "lbp-field-row";
    const kv = document.createElement("div");
    kv.className = "lbp-field-kv";
    const k = document.createElement("span");
    k.className = "lbp-field-key";
    const keyMain = document.createElement("span");
    keyMain.className = "lbp-field-key-main";
    keyMain.textContent = key;
    if (src) {
      const badge = document.createElement("span");
      badge.className = "lbp-field-src";
      badge.textContent = src;
      keyMain.appendChild(badge);
    }
    k.appendChild(keyMain);
    if (at) {
      const t = document.createElement("span");
      t.className = "lbp-field-at";
      const age = relTime(at);
      t.innerHTML = `${ICONS.redo}<span>${age}</span>`;
      t.title = `Updated ${new Date(at).toLocaleString()}`;
      t.setAttribute("aria-label", `Updated ${age}`);
      k.appendChild(t);
    }
    let val;
    const vStr = v !== null && v !== undefined ? String(v) : null;
    if (vStr && /^https?:\/\//.test(vStr)) {
      val = document.createElement("a");
      val.href = vStr;
      val.target = "_blank";
      val.rel = "noopener noreferrer";
      val.textContent = vStr;
    } else if (vStr !== null && fieldKind === "number" && typeof v === "number") {
      val = document.createElement("span");
      val.textContent = formatFieldNumber(key, v);
    } else {
      val = document.createElement("span");
      val.textContent = vStr ?? "—";
    }
    val.className = "lbp-field-val";
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
  return sec;
}

// Paint the Details panel: the identity zone on top (entity name, reference
// rows, instance switcher, provisional warning, connector-bound fields), then
// the selected instance's zone (its extracted fields, its tags + reasoning).
// reasoning/fields are null while the per-instance fetch is in flight — tags
// render immediately, details fill in when it lands.
function paintPanel(img, inst, reasoning, fields) {
  // Same-origin link, so the download attribute names the saved file — the
  // instance's original name, not the hashed store name.
  elLightboxDownload.href = fullUrl(inst?.name || img.name);
  elLightboxDownload.download = inst?.label || inst?.name || img.label || img.name;

  elLightboxPanelBody.replaceChildren();

  // ── identity zone ──────────────────────────────────────────────────────
  // Entity title; when the entity has several instances the switcher lives
  // right under it — it's entity-level navigation.
  const meta = document.createElement("div");
  meta.className = "lbp-meta";
  const metaName = document.createElement("div");
  metaName.className = "lbp-meta-name";
  metaName.textContent = img.displayLabel;
  metaName.title = img.displayLabel;
  meta.appendChild(metaName);

  const instances = img.instances || [];
  if (instances.length >= 2) {
    const filesSec = document.createElement("div");
    filesSec.className = "lbp-files";
    const filesLabel = document.createElement("div");
    filesLabel.className = "lbp-fields-label";
    filesLabel.textContent = `Instances (${instances.length})`;
    filesSec.appendChild(filesLabel);
    instances.forEach((f, i) => {
      const row = document.createElement("div");
      row.className = "lbp-file-row" + (i === currentInstIndex ? " lbp-file-active" : "");
      row.addEventListener("click", () => showInstance(i));
      // Thumbnail when the store has one (images always; docs when a preview
      // rendered); otherwise a mini extension badge.
      const preview = kindFor(f).previewUrl?.(f);
      let thumb;
      if (preview) {
        thumb = document.createElement("img");
        thumb.className = "lbp-file-thumb";
        thumb.src = preview;
        thumb.loading = "lazy";
        thumb.alt = "";
      } else {
        thumb = document.createElement("div");
        thumb.className = "lbp-file-thumb";
        thumb.textContent = (f.name?.match(/\.(\w+)$/)?.[1] || "?").toUpperCase();
      }
      const fname = document.createElement("button");
      fname.className = "lbp-file-name";
      fname.textContent = f.label || f.name;
      fname.title = "View this file";
      const rmBtn = document.createElement("button");
      rmBtn.className = "lbp-file-remove";
      rmBtn.title = "Remove this file";
      rmBtn.textContent = "×";
      rmBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        rmBtn.disabled = true;
        try {
          const r = await fetch(`/api/instances/${f.id}`, { method: "DELETE" });
          if (!r.ok) throw new Error();
          img.instances = img.instances.filter((x) => x.id !== f.id);
          refreshEntityTags(img);
          // The face may have changed; re-pick per the board's face config.
          const face = selectFace(img.instances, state.boardMapping?.face);
          if (face) { img.name = face.name; img.w = face.w; img.h = face.h; img.kind = face.kind; img.label = face.label; }
          if (currentInstIndex >= img.instances.length) currentInstIndex = 0;
          document.dispatchEvent(new Event('app:render'));
          showInstance(Math.min(currentInstIndex, img.instances.length - 1));
          toast("File removed");
        } catch {
          toast.error("Couldn't remove file");
        } finally { rmBtn.disabled = false; }
      });
      row.append(thumb, fname, rmBtn);
      filesSec.appendChild(row);
    });
    meta.appendChild(filesSec);
  }
  elLightboxPanelBody.appendChild(meta);

  // Provisional identity warning — shown when the AI couldn't derive an identity.
  if (img.identityProvisional) {
    const warn = document.createElement("div");
    warn.className = "lbp-provisional-warn";
    warn.textContent = "Identity not derived — AI couldn't identify this entity. Re-extract or remove the item.";
    elLightboxPanelBody.appendChild(warn);
  }

  // Connector-bound entity fields (live data — not extraction output).
  const entityFields = fieldsSection(img.fields, { label: "Connector fields" });
  if (entityFields) {
    elLightboxPanelBody.appendChild(entityFields);
    const d = document.createElement("hr");
    d.className = "lbp-divider";
    elLightboxPanelBody.appendChild(d);
  }

  // ── instance zone ──────────────────────────────────────────────────────
  // The selected instance's reference rows; values are click-to-select.
  const instMeta = document.createElement("div");
  instMeta.className = "lbp-meta";
  const metaRows = [
    ["file", inst?.name || img.name],
    ["kind", inst?.kind || img.kind || "image"],
    ["id", String(inst?.id ?? img.id)],
  ];
  for (const [k, v] of metaRows) {
    const row = document.createElement("div");
    row.className = "lbp-meta-row";
    const key = document.createElement("span");
    key.textContent = k;
    const val = document.createElement("span");
    val.className = "lbp-meta-val";
    val.textContent = v;
    row.append(key, val);
    instMeta.appendChild(row);
  }
  elLightboxPanelBody.appendChild(instMeta);

  // The selected instance's extracted fields, with per-instance re-extract.
  const reextractBtn = document.createElement("button");
  reextractBtn.className = "lbp-reextract";
  reextractBtn.textContent = "Re-extract";
  reextractBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!inst) return;
    reextractBtn.disabled = true;
    try {
      const r = await fetch(`/api/instances/${inst.id}/reextract`, { method: "POST" });
      if (r.ok) {
        inst.status = "pending_extract";
        img.status = "pending_extract";
        reextractBtn.textContent = "Queued";
        document.dispatchEvent(new Event('app:render'));
        ensurePolling();
        toast("Re-extraction queued");
      } else {
        reextractBtn.disabled = false;
        toast.error("Re-extract failed");
      }
    } catch {
      reextractBtn.disabled = false;
      toast.error("Re-extract failed");
    }
  });
  const fileFields = {};
  const aiFields = {};
  for (const [key, field] of Object.entries(fields || {})) {
    (field?.src === "file" ? fileFields : aiFields)[key] = field;
  }
  const fileFieldsSection = fieldsSection(fileFields, { label: "File fields" });
  const aiFieldsSection = fieldsSection(aiFields, {
    label: "AI-extracted fields",
    reextract: inst ? reextractBtn : null,
  });
  if (fileFieldsSection || aiFieldsSection) {
    if (fileFieldsSection) elLightboxPanelBody.appendChild(fileFieldsSection);
    if (aiFieldsSection) elLightboxPanelBody.appendChild(aiFieldsSection);
    const d = document.createElement("hr");
    d.className = "lbp-divider";
    elLightboxPanelBody.appendChild(d);
  }

  // The selected instance's tags + reasoning (per-instance judgment), with a
  // per-instance Retag: re-tag just this file, leaving identity/fields as-is
  // (the tag-only counterpart to the card-level full reprocess).
  const subject = inst || img;
  if (inst && state.me && state.facets.length) {
    const tagsHead = document.createElement("div");
    tagsHead.className = "lbp-fields-head";
    const tagsLabel = document.createElement("span");
    tagsLabel.className = "lbp-fields-label";
    tagsLabel.textContent = "Tags";
    tagsHead.appendChild(tagsLabel);
    const retagBtn = document.createElement("button");
    retagBtn.className = "lbp-reextract";
    retagBtn.textContent = "Retag";
    retagBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      retagBtn.disabled = true;
      try {
        const r = await fetch(`/api/instances/${inst.id}/retag`, { method: "POST" });
        if (r.ok) {
          inst.status = "pending";
          img.status = "pending";
          retagBtn.textContent = "Queued";
          document.dispatchEvent(new Event('app:render'));
          ensurePolling();
          toast("Retag queued");
        } else {
          retagBtn.disabled = false;
          toast.error("Retag failed");
        }
      } catch {
        retagBtn.disabled = false;
        toast.error("Retag failed");
      }
    });
    tagsHead.appendChild(retagBtn);
    elLightboxPanelBody.appendChild(tagsHead);
  }
  const byFacet = new Map();
  for (const t of subject.tags) {
    const i = t.indexOf("/");
    if (i <= 0) continue;
    const k = t.slice(0, i);
    if (!byFacet.has(k)) byFacet.set(k, []);
    byFacet.get(k).push(t.slice(i + 1));
  }
  const why = reasoning || {};

  if (subject.status === "held") {
    const note = document.createElement("div");
    note.className = "lbp-undecided";
    note.textContent = "Not tagged yet — this board's auto-tagging is off. Tag it by hand, or turn auto-tagging back on.";
    elLightboxPanelBody.appendChild(note);
  } else if (subject.undecided) {
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

  if (!rows && !subject.undecided && subject.status !== "held") {
    const empty = document.createElement("p");
    empty.className = "lbp-hint";
    empty.textContent = reasoning === null ? "Loading…" : "No AI tags for this item.";
    elLightboxPanelBody.appendChild(empty);
  } else if (reasoning !== null && subject.tags.length && !Object.keys(why).length) {
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
  const inst = selectedInst();
  if (!inst) { paintPanel(img, null, {}, {}); return; }
  paintPanel(img, inst, null, null);
  const token = ++reasoningReq;
  let reasoning = {};
  let fields = {};
  try {
    const r = await fetch(`/api/instances/${inst.id}/reasoning`);
    if (r.ok) {
      const data = await r.json();
      reasoning = data.reasoning || {};
      fields = data.fields || {};
    }
  } catch { /* panel just shows tags without reasoning */ }
  if (token !== reasoningReq || lightboxImg !== img || selectedInst() !== inst || !panelOpen) return;
  paintPanel(img, inst, reasoning, fields);
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

// Detach the audio player: pause, drop its source, reset — so it stops playing
// and buffering when you navigate away or close. Safe to call when already hidden.
function hideAudio() {
  if (elLightboxAudio.hidden) return;
  elLightboxAudioEl.pause();
  elLightboxAudioEl.removeAttribute("src");
  elLightboxAudioEl.load();
  elLightboxAudioWave.removeAttribute("src");
  elLightboxAudioText.hidden = true;
  elLightboxAudioText.textContent = "";
  elLightboxAudio.hidden = true;
}

// The transcript replaces the waveform in the audio view when there's speech.
// Fetched per open (independent of the side panel); the waveform stays as the
// fallback while a fresh upload is still transcribing (null) or for a clip with
// no discernible speech (""). Tokened so fast navigation can't paint a stale one.
let audioTextReq = 0;
async function showAudioText(f) {
  const token = ++audioTextReq;
  const showWave = () => {
    elLightboxAudioText.hidden = true;
    if (f.w && f.h) { elLightboxAudioWave.src = thumbUrl(f.name); elLightboxAudioWave.hidden = false; }
    else { elLightboxAudioWave.removeAttribute("src"); elLightboxAudioWave.hidden = true; }
  };
  showWave(); // immediate fallback while the transcript loads
  try {
    const r = await fetch(`/api/instances/${f.id}/transcript`);
    if (token !== audioTextReq) return; // superseded by a newer open
    const { transcript } = r.ok ? await r.json() : {};
    if (transcript && transcript.trim()) {
      elLightboxAudioWave.hidden = true;
      elLightboxAudioWave.removeAttribute("src");
      elLightboxAudioText.textContent = transcript;
      elLightboxAudioText.hidden = false;
    }
  } catch { /* keep the waveform fallback */ }
}

// Render a file-carrying thing (an instance, or the entity's face fields as
// a fallback) into the main lightbox view. Documents render inline in a
// same-origin frame; the frame paints progressively, so no loading spinner.
// docx can't render in a frame; its formatted-HTML sidecar can.
function showMedia(f) {
  // Audio: the waveform face (when it rendered) above a native <audio> player;
  // no waveform → just the player (the card badge covered the visual).
  if (f.kind === "audio") {
    elLightboxImg.onload = null;
    elLightboxImg.removeAttribute("src");
    elLightboxImg.hidden = true;
    if (!elLightboxDoc.hidden) { elLightboxDoc.hidden = true; elLightboxDoc.removeAttribute("src"); }
    elLightbox.classList.remove("loading");
    const url = fullUrl(f.name);
    if (elLightboxAudioEl.getAttribute("src") !== url) elLightboxAudioEl.src = url;
    elLightboxAudio.hidden = false;
    // Transcript replaces the waveform when there's speech; the waveform is the
    // fallback while still transcribing or when the clip has no speech.
    showAudioText(f);
    // Keep keyboard nav (arrows/Escape) on the lightbox, not the player.
    elLightbox.focus({ preventScroll: true });
    return;
  }
  hideAudio();
  const isDoc = f.kind && f.kind !== "image";
  if (isDoc) {
    elLightboxImg.onload = null;
    elLightboxImg.removeAttribute("src");
    elLightboxImg.hidden = true;
    elLightbox.classList.remove("loading");
    const url = fullUrl(f.kind === "docx" ? f.name + ".html" : f.name);
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
    elLightboxImg.onload = () => { elLightbox.classList.remove("loading"); elLightboxImg.style.opacity = "1"; };
    elLightboxImg.src = fullUrl(f.name);
    if (elLightboxImg.complete && elLightboxImg.naturalWidth > 0) {
      elLightbox.classList.remove("loading");
      elLightboxImg.style.opacity = "1";
    }
    elLightboxImg.alt = f.tags?.length ? f.tags.join(", ") : f.name;
  }
}

// Switch the main lightbox view to another instance of the current entity
// (picked from the Details panel's file switcher). The panel re-renders so
// its fields/tags zone follows the selection.
function showInstance(index) {
  currentInstIndex = index;
  const inst = selectedInst();
  if (!inst) return;
  elLightboxDownload.href = fullUrl(inst.name);
  elLightboxDownload.download = inst.label || inst.name;
  showMedia(inst);
  renderLightboxInfo(); // instance count may have changed (e.g. after a removal)
  if (panelOpen) renderPanel();
}

function showLightbox() {
  lightboxImg = lightboxList[lightboxIndex];
  currentInstIndex = 0; // reset to the face instance on entity navigation
  showMedia(selectedInst() || lightboxImg);
  if (state.me) {
    renderLightboxFav();
    elLightboxFav.hidden = false;
    renderLightboxCrate();
    elLightboxCrate.hidden = false;
  } else {
    elLightboxFav.hidden = true;
    elLightboxCrate.hidden = true;
  }
  renderLightboxInfo();
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
  hideAudio();
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
  // Player clicks (play/scrub/volume) must not bubble to the lightbox close.
  elLightboxAudio.addEventListener("click", (e) => e.stopPropagation());
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
