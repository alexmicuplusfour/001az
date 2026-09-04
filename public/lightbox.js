import { state } from './state.js';
import { ICONS, refreshEntityTags, fmtDuration, scopableInstance, facetName } from './utils.js';
import { toast } from './toast.js';
import { taggedFiltered } from './filters.js';
import { openCratePop, closeCratePop } from './crates.js';
import { scrollToCard } from './grid.js';
import { fullUrl, kindFor } from './kinds.js';
import { requeueToast } from './data.js';
import { sectionHeading, busy, claim } from './modal.js';
import { openFacetScopePop } from './dropdown.js';

import { selectFace } from './face-select.js';
import { mountDetail } from './detail-view.js';
import { contentRect, detColor } from './det-geometry.js';

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
const elLightboxStage = document.getElementById("lightbox-stage");
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
let elDetOverlay = null; // object-detection box layer over the lightbox image
let currentHandle = null; // the mounted detail renderer's handle (detail-view.js)
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

// Start the instances list with the current file in view rather than at the
// top — nudged only as far as needed (mirrors the dropdown's revealActive), so
// clicking through the list doesn't snap the scroll back to the top on each
// rebuild. offsetParent is the fixed panel shell for both row and list, so the
// difference is the row's position within the list's own scroll space.
function revealActiveInstance(list) {
  if (!list || list.scrollHeight <= list.clientHeight) return;
  const row = list.querySelector(".lbp-file-active");
  if (!row) return;
  const top = row.offsetTop - list.offsetTop;
  const bottom = top + row.offsetHeight;
  // Keep a couple of rows of context past the active one so you can click
  // straight through neighbours without scrolling — capped so it never
  // overscrolls past either end of the list.
  const margin = row.offsetHeight * 2;
  const max = list.scrollHeight - list.clientHeight;
  if (top < list.scrollTop) list.scrollTop = Math.max(top - margin, 0);
  else if (bottom > list.scrollTop + list.clientHeight) {
    list.scrollTop = Math.min(bottom - list.clientHeight + margin, max);
  }
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
function objectFieldsOf(fields) {
  const out = [];
  for (const [key, f] of Object.entries(fields || {})) if (Array.isArray(f?.v)) out.push({ key, dets: f.v });
  return out;
}
// Size + place the overlay over the current displayed image; hidden when there's
// nothing to show or the stage isn't showing a ready image (repositioned on
// load/resize/toggle). The image element belongs to whichever detail renderer is
// mounted — an image-bearing renderer exposes it as handle.imgEl; any other
// renderer (doc, audio) has none and the overlay stays hidden.
function positionDetOverlay() {
  if (!elDetOverlay) return;
  const img = currentHandle?.imgEl;
  if (!elDetOverlay.childElementCount || !img?.isConnected || !img.naturalWidth) {
    elDetOverlay.hidden = true;
    return;
  }
  const r = displayedContentRect(img);
  const host = elLightbox.getBoundingClientRect();
  elDetOverlay.style.left = (r.x - host.left) + "px";
  elDetOverlay.style.top = (r.y - host.top) + "px";
  elDetOverlay.style.width = r.w + "px";
  elDetOverlay.style.height = r.h + "px";
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

// One panel cell: the light-gray card that holds a single facet or field — a
// header line plus an optional why-sentence. Both the facet loop and
// fieldsSection() build their header into it, so the card treatment (padding,
// background, radius) lives in one place instead of being duplicated per kind.
function panelCell(head, why) {
  const cell = document.createElement("div");
  cell.className = "panel-cell";
  cell.appendChild(head);
  if (why) {
    const p = document.createElement("p");
    p.className = "lbp-why";
    p.textContent = why;
    cell.appendChild(p);
  }
  return cell;
}

// One "Fields" section: key/value cells with src badges and why-sentences.
// Used twice — entity-level (connector-bound data, no re-extract) and
// instance-level (AI extraction, with the Re-extract button).
function fieldsSection(fields, { label = "Fields", reextract = null } = {}) {
  const fieldKeys = fields && typeof fields === "object" ? Object.keys(fields) : [];
  if (!fieldKeys.length) return null;
  const sec = document.createElement("div");
  sec.className = "lbp-fields";
  const secHead = document.createElement("div");
  secHead.className = "lbp-fields-head";
  secHead.innerHTML = sectionHeading(label);
  if (reextract) secHead.appendChild(reextract);
  sec.appendChild(secHead);
  for (const key of fieldKeys) {
    const { v, why, src, kind: fieldKind, at } = fields[key] || {};
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
    if (Array.isArray(v)) {
      // Object-detection field — flag the kind like file fields flag their src.
      const badge = document.createElement("span");
      badge.className = "lbp-field-src";
      badge.textContent = "object";
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
    if (Array.isArray(v)) {
      // Object-detection field: one hoverable row per detected object; hovering
      // highlights its box on the image (linked by the `key:idx` handle).
      val = document.createElement("div");
      val.className = "lbp-det-list";
      if (!v.length) {
        // The stored why is the empty reason — "No objects detected", or
        // "no image to detect on" for a non-image item. Surface it instead of a
        // hardcoded string (the separate why line is dropped below).
        val.textContent = why || "No objects detected";
        val.classList.add("lbp-det-empty");
      } else {
        v.forEach((d, idx) => {
          const detKey = `${key}:${idx}`;
          const row = document.createElement("div");
          row.className = "lbp-det-row";
          row.dataset.det = detKey;
          const sw = document.createElement("span");
          sw.className = "lbp-det-swatch";
          sw.style.background = detColor(key);
          const lab = document.createElement("span");
          lab.className = "lbp-det-label";
          lab.textContent = d.label;
          const sc = document.createElement("span");
          sc.className = "lbp-det-score";
          sc.textContent = typeof d.score === "number" ? `${Math.round(d.score * 100)}%` : "";
          row.append(sw, lab, sc);
          row.addEventListener("mouseenter", () => highlightDet(detKey, true));
          row.addEventListener("mouseleave", () => highlightDet(detKey, false));
          val.appendChild(row);
        });
      }
    } else if (vStr && /^https?:\/\//.test(vStr)) {
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
    // Object fields carry a synthesized "Detected: …" why that just echoes the
    // list — drop it; scalar fields keep the model's reasoning sentence.
    sec.appendChild(panelCell(kv, Array.isArray(v) ? null : why));
  }
  return sec;
}

// Paint the Details panel: the identity zone on top (entity name, reference
// rows, instance switcher, provisional warning, connector-bound fields), then
// the selected instance's zone (its extracted fields, its tags + reasoning).
// reasoning/fields are null while the per-instance fetch is in flight — tags
// render immediately, details fill in when it lands.
function paintPanel(img, inst, reasoning, fields, confidence) {
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
    // The rows scroll (capped at ~6.5 rows) while the count label stays put.
    const fileList = document.createElement("div");
    fileList.className = "lbp-file-list";
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
      rmBtn.addEventListener("click", busy(rmBtn, async (e) => {
        e.stopPropagation();
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
        }
      }));
      row.append(thumb, fname, rmBtn);
      fileList.appendChild(row);
    });
    filesSec.appendChild(fileList);
    meta.appendChild(filesSec);
  }
  elLightboxPanelBody.appendChild(meta);

  // Provisional identity warning — shown when the AI couldn't derive an identity.
  if (img.identityProvisional) {
    const warn = document.createElement("div");
    warn.className = "warn-box lbp-provisional-warn";
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

  // A queue-this-leg button (re-extract, retag, re-transcribe). `facets`
  // non-null puts the scope picker behind it instead of a bare click — one
  // button, one request path either way, so the two shapes can't drift apart.
  // Both arms wear busy(), so neither can be double-fired.
  function queueLegBtn(label, path, queued, { facets = null } = {}) {
    const btn = document.createElement("button");
    btn.className = "lbp-reextract";
    btn.innerHTML = `<span>${label}</span>` +
      (facets ? `<span class="dd-caret">${ICONS.chevron}</span>` : "");
    // `facet` scopes a retag to one facet — the route reads `facets` from the
    // body and leaves every other facet's tags alone, so the toast names what
    // moved. requeue mirrors the routed report onto every affected card; inst
    // IS img.instances[i], so the panel's own subject updates with them.
    const run = busy(btn, async (facet = null) => {
      if (!inst) return;
      await requeueToast(
        `/api/instances/${inst.id}/${path}`,
        queued + (facet ? ` on ${facetName(facet)}` : ""),
        `${label} failed`,
        facet ? { facets: [facet.key] } : undefined,
      );
      claim(btn, "Queued");
    });
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (facets) openFacetScopePop(btn, facets, run);
      else run();
    });
    return btn;
  }

  // The selected instance's extracted fields, with per-instance re-extract.
  const reextractBtn = queueLegBtn("Re-extract", "reextract", "Re-extraction queued");
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
  // (the tag-only counterpart to the card-level full reprocess). A tagged,
  // decided instance can also be re-rolled on ONE facet — the same scope pop
  // the admin board retag wears — so the picker appears exactly when the
  // scoped route would accept it (it 409s on anything else, and not offering
  // the choice beats offering an error). A scoped pass preserves the other
  // facets, so nothing is cleared here: the tags on screen stay until the new
  // ones land.
  const subject = inst || img;
  // The one verb reprocess deliberately withholds: forcing a fresh
  // transcription. Its own head, not the tags head — it is a transcript verb,
  // and the tags block is gated on the board having facets, which would make
  // it unreachable on a facetless audio board.
  if (inst && state.me && inst.kind === "audio") {
    const head = document.createElement("div");
    head.className = "lbp-fields-head";
    head.innerHTML = sectionHeading("Transcript");
    const rt = queueLegBtn("Re-transcribe", "retranscribe", "Re-transcription queued");
    rt.title = "Transcribe this clip again — re-bills transcription";
    head.appendChild(rt);
    elLightboxPanelBody.appendChild(head);
  }
  if (inst && state.me && state.facets.length) {
    const tagsHead = document.createElement("div");
    tagsHead.className = "lbp-fields-head";
    tagsHead.innerHTML = sectionHeading("Tags");
    tagsHead.appendChild(queueLegBtn("Retag", "retag", "Retag queued",
      { facets: scopableInstance(inst) ? state.facets : null }));
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
  const conf = confidence || {};

  if (subject.status === "held") {
    const note = document.createElement("div");
    note.className = "warn-box lbp-undecided";
    // Status-honest: held means PARKED, whatever parked it — auto-tagging off
    // at upload, or a cancelled queue. Claiming a reason here was a lie for
    // the cancel case (job-control-plan.md Stage 2 ride-along).
    note.textContent = "Not tagged — parked. Tag it by hand, or retag it to queue it again.";
    elLightboxPanelBody.appendChild(note);
  } else if (subject.undecided) {
    const note = document.createElement("div");
    note.className = "warn-box lbp-undecided";
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
    const c = conf[f.key];
    // The passes disagreed. That earns a row by itself: a facet that converged
    // on NOTHING keeps no values, and keeps no sentence either (the merge only
    // carries a justification a run actually made), so without this it would
    // vanish from the panel at exactly the moment it has the most to say.
    const split = !!(c && c.of > 1 && c.agreed < c.of);
    if (!vals.length && !text && !split) continue;
    rows++;
    const head = document.createElement("div");
    head.className = "lbp-facet-head";
    const label = document.createElement("span");
    label.className = "panel-label";
    label.textContent = f.label;
    head.appendChild(label);
    // Agreement badge: only on boards running more than one pass, and only when
    // the passes actually disagreed. An absent entry means NOT MEASURED (single
    // pass) — rendering "1 of 1" there would invent a certainty nobody checked.
    if (split) {
      // `agreed` counts passes that selected exactly this SET, not this value.
      // On a multi-value facet a value every pass chose can still sit under an
      // 0/3 badge, because each pass added a different second value — so the
      // copy says "set", and the tally beside it carries the per-value truth.
      const lost = Object.entries(c.votes || {}).filter(([v]) => !vals.includes(v));
      const tally = lost.map(([v, n]) => `${v} (${n})`).join(", ");
      const badge = document.createElement("span");
      badge.className = "lbp-agree";
      badge.textContent = `${c.agreed}/${c.of}`;
      badge.title =
        (vals.length
          ? `${c.agreed} of ${c.of} passes selected exactly this set`
          : `no value reached a majority across ${c.of} passes`) +
        (tally ? ` — ${vals.length ? "also " : ""}proposed: ${tally}` : "");
      head.appendChild(badge);
    }
    if (vals.length) {
      for (const v of vals) {
        const chip = document.createElement("span");
        chip.className = "panel-chip";
        chip.textContent = v;
        head.appendChild(chip);
      }
    } else {
      const none = document.createElement("span");
      none.className = "lbp-none";
      none.textContent = "—";
      head.appendChild(none);
    }
    elLightboxPanelBody.appendChild(panelCell(head, text));
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

  // Panel's fully built now, so layout is resolvable — bring the active file
  // into view (no-op unless the list actually overflows).
  revealActiveInstance(elLightboxPanelBody.querySelector(".lbp-file-list"));
}

async function renderPanel() {
  if (!panelOpen || !lightboxImg) return;
  const img = lightboxImg;
  const inst = selectedInst();
  if (!inst) { paintPanel(img, null, {}, {}, {}); clearDetOverlay(); return; }
  paintPanel(img, inst, null, null, {});
  clearDetOverlay(); // drop the prior instance's boxes while this one's fields load
  const token = ++reasoningReq;
  let reasoning = {};
  let fields = {};
  let confidence = {};
  try {
    const r = await fetch(`/api/instances/${inst.id}/reasoning`);
    if (r.ok) {
      const data = await r.json();
      reasoning = data.reasoning || {};
      fields = data.fields || {};
      confidence = data.confidence || {};
    }
  } catch { /* panel just shows tags without reasoning */ }
  if (token !== reasoningReq || lightboxImg !== img || selectedInst() !== inst || !panelOpen) return;
  paintPanel(img, inst, reasoning, fields, confidence);
  drawDetOverlay(fields);
}

function setPanel(open) {
  panelOpen = open;
  elLightboxPanel.hidden = !open;
  elLightbox.classList.toggle("panel-open", open);
  elLightboxInfo.classList.toggle("on", open);
  if (open) renderPanel();
  else clearDetOverlay();
  // .panel-open shifts the stage padding → the image resizes; track it.
  requestAnimationFrame(positionDetOverlay);
}

const isDocItem = (it) => it.kind && it.kind !== "image";

function preloadFull(i) {
  if (i >= 0 && i < lightboxList.length && !isDocItem(lightboxList[i])) {
    const im = new Image();
    im.src = fullUrl(lightboxList[i].name);
  }
}

// Render a file-carrying thing (an instance, or the entity's face fields as
// a fallback) into the main lightbox view, by mounting whichever detail
// renderer claims it (detail-view.js) into the stage. The previous renderer's
// unmount releases its resources first — playback, listeners, its nodes — so
// navigating away from an audio clip stops it, exactly as before the registry.
function showMedia(f) {
  clearDetOverlay(); // any prior instance's boxes; redrawn by renderPanel for images
  currentHandle?.unmount?.();
  currentHandle = mountDetail(elLightboxStage, f, lightboxImg, {
    root: elLightbox,
    onImageLayout: positionDetOverlay,
  });
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

// Open on a specific instance (a rows-mode tile click). showLightbox resets
// the selection to index 0, so the re-aim happens after.
export function openLightboxAt(img, instId) {
  openLightbox(img);
  const i = (img.instances || []).findIndex((x) => x.id === instId);
  if (i > 0) showInstance(i);
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
  currentHandle?.unmount?.();
  currentHandle = null;
  elLightboxStage.replaceChildren();
  lightboxImg = null;
  lightboxList = [];
  lightboxIndex = -1;
}

export function initLightbox() {
  elDetOverlay = document.createElement("div");
  elDetOverlay.className = "lb-det-overlay";
  elDetOverlay.hidden = true;
  elLightbox.appendChild(elDetOverlay);
  window.addEventListener("resize", positionDetOverlay);

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
    if (!lightboxImg) return;
    try {
      const r = await fetch(`/api/items/${lightboxImg.id}/favorite`, { method: "POST" });
      // Session gone (expired, or revoked by a password change elsewhere).
      if (r.status === 401) return location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
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

  // Crates module dispatches this when a crate membership changes while the lightbox is open.
  document.addEventListener('app:lightbox-crate-changed', renderLightboxCrate);
}
