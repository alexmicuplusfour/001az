// rows.js — the instance-rows gallery mode (planning/instance-rows-plan.md).
// Entities stack vertically; each row is the untouched entity card (built by
// grid.js's cardFor, so every entity affordance rides along) plus a
// horizontally scrolling strip of its instance tiles, the whole group in a
// bordered container. Single-instance entities render without a strip — the
// card already IS that instance, and a one-tile strip would repeat the same
// photo. Everything on a tile is instance-scoped (the lightbox's per-instance
// verbs, relocated): its own tag pop + editor, Retag, Re-extract on mapped
// boards, and remove; hearts/crates stay on the card — they reference
// entities(id) in the schema.
import { state } from './state.js';
import { cardFor, cardSig, releaseCard, progressLane, pinWhileOpen } from './grid.js';
import { thumbUrl } from './kinds.js';
import { openLightboxAt } from './lightbox.js';
import { selectFace } from './face-select.js';
import { taggedFiltered, instanceMatches } from './filters.js';
import { effectiveView } from './view.js';
import { ACTIVE, QUEUED, requeueToast } from './data.js';
import { ICONS, actionBtn, refreshEntityTags, mappingHasAiWork } from './utils.js';
import { openDropdown, ddAction } from './dropdown.js';
import { openTagEditor } from './tag-editor.js';
import { toggleBulkSelect } from './bulk.js';
import { toast } from './toast.js';

const elGrid = document.getElementById("grid");
const elGridSentinel = document.getElementById("grid-sentinel");

// Rows carry more DOM than cards; smaller batches, same sentinel flow.
const RENDER_BATCH = 30;
let renderLimit = RENDER_BATCH;
let lastKey = "";
let rowCache = new Map(); // entity id -> { el, sig }

// A row re-renders when anything its card OR its strip shows changes: the
// card signature, each instance's identity/status/tags, its filter-match
// state (a facet toggle that moves the dim pattern repaints the row), and
// which instance is the face. Per-instance tags ride in (not just the union)
// so a tile tag edit that doesn't move the union still repaints its row.
function rowSig(img) {
  const face = selectFace(img.instances, state.boardMapping?.face);
  const insts = img.instances
    .map((i) => `${i.id}:${i.status}:${i.undecided ? 1 : 0}:${instanceMatches(i) ? 1 : 0}:${i.tags.join("+")}`)
    .join("|");
  return `${cardSig(img)}~${insts}~${face?.id ?? ""}`;
}

// ── per-instance verbs (the lightbox's, relocated to the tile) ──────────────

// Cached rows outlive reconcile: data.js takes the server's instance list
// wholesale on every delta row, so a sig-equal row keeps its DOM while its
// closures hold objects the entity no longer contains. Everything below
// re-resolves by id at fire time — mutating a captured orphan is a write the
// union recompute and the next render never read (a tag edit would look
// lost, an optimistic status would never paint). The captured object is the
// fallback (instance deleted in another tab): the request still fires and
// the server's 404/409 surfaces as the toast.
const liveInst = (img, inst) => img.instances.find((x) => x.id === inst.id) || inst;

// The lightbox disables its buttons mid-flight; tile buttons are recreated on
// every row rebuild, so the latch lives here instead. Without it a double
// click double-DELETEs — the second 404s and toasts a failure after a
// removal that succeeded.
const inflight = new Set();
async function once(key, fn) {
  if (inflight.has(key)) return;
  inflight.add(key);
  try {
    await fn();
  } finally {
    inflight.delete(key);
  }
}

function doRetag(img, inst) {
  return once(`retag:${inst.id}`, () =>
    requeueToast(`/api/instances/${liveInst(img, inst).id}/retag`, "Retag queued", "Retag failed"));
}

function doReextract(img, inst) {
  // A 409 here (an instance older than the board's mapping) reaches the user
  // as the server's own sentence — requeueToast prefers it over the fallback.
  return once(`reextract:${inst.id}`, () =>
    requeueToast(`/api/instances/${liveInst(img, inst).id}/reextract`, "Re-extraction queued", "Re-extract failed"));
}

function doRemoveInstance(img, inst) {
  return once(`remove:${inst.id}`, async () => {
    try {
      const r = await fetch(`/api/instances/${inst.id}`, { method: "DELETE" });
      if (!r.ok) {
        // Strips only exist at 2+ instances, so a 409 here is the concurrent-
        // delete race (two tabs removing the last two) — surface the server's
        // "delete the item instead" answer rather than a generic failure.
        const { error } = await r.json().catch(() => ({}));
        toast.error(error || "Couldn't remove file");
        return;
      }
      // The lightbox removal's follow-up, verbatim: drop the instance,
      // re-derive the union, re-pick the face per the board's config.
      img.instances = img.instances.filter((x) => x.id !== inst.id);
      refreshEntityTags(img);
      const face = selectFace(img.instances, state.boardMapping?.face);
      if (face) { img.name = face.name; img.w = face.w; img.h = face.h; img.kind = face.kind; img.label = face.label; }
      document.dispatchEvent(new Event('app:render'));
      toast("File removed");
    } catch {
      toast.error("Couldn't remove file");
    }
  });
}

// The tile's tag pop: this instance's own tags (no union — that's the card's
// story), with Edit/Retag in the footer. Click-open, unlike the card's
// hover pop — tiles are small and their overlay buttons sit millimetres away.
// pop-open pins the hover chrome while the pop is up (the card's pattern).
function openInstTagPop(chip, img, inst) {
  inst = liveInst(img, inst); // freshest tags for the list about to render
  const pin = pinWhileOpen(chip, { sel: ".inst-tile", teardown: teardownTileHover });
  const ctx = openDropdown(chip, {
    className: "tag-pop",
    align: "start",
    minWidth: 150,
    maxWidth: 250,
    maxItems: 0,
    build: (body) => {
      if (inst.tags.length) {
        for (const t of inst.tags) {
          const s = document.createElement("span");
          s.className = "tp";
          s.textContent = t;
          body.appendChild(s);
        }
      } else {
        const s = document.createElement("span");
        s.className = "tp empty";
        s.textContent = "no tags";
        body.appendChild(s);
      }
    },
    footer: (state.me && state.facets.length) ? (foot, { close }) => {
      foot.append(
        ddAction({
          label: "Edit tags",
          icon: ICONS.pencil,
          onClick: (e) => {
            e.stopPropagation();
            close();
            // Re-resolve at click, not pop-open — the pop can sit open across a
            // poll tick, and the editor's save mutates what it's handed.
            openTagEditor(img, liveInst(img, inst));
          },
        }),
        ddAction({
          label: "Retag",
          icon: ICONS.tag,
          onClick: (e) => {
            e.stopPropagation();
            close();
            doRetag(img, inst);
          },
        }),
      );
    } : undefined,
    onClose: pin.release,
  });
  pin.hold(ctx);
}

// Tile chrome is mounted on hover, exactly like the card's — a 60-instance
// strip would otherwise carry 60 chips and 120 buttons nobody is pointing
// at. The face chip stays static (informational, one per strip at most).
function teardownTileHover(tile) {
  tile.querySelector(".inst-tag-chip")?.remove();
  tile.querySelector(".inst-actions")?.remove();
}

function mountTileChrome(tile, img, inst) {
  inst = liveInst(img, inst); // the chip count reads tags at mount time
  const tagChip = document.createElement("div");
  tagChip.className = "inst-tag-chip";
  tagChip.title = "Tags for this file";
  tagChip.innerHTML = ICONS.tag + `<span class="tc">${inst.tags.length}</span>`;
  tagChip.addEventListener("click", (e) => {
    e.stopPropagation();
    openInstTagPop(tagChip, img, inst);
  });
  tile.appendChild(tagChip);

  if (state.me) {
    const acts = document.createElement("div");
    acts.className = "inst-actions";
    if (mappingHasAiWork(state.boardMapping)) {
      acts.appendChild(actionBtn("redo", "reextract", "Re-extract (re-derive identity + fields for this file)", () => doReextract(img, inst)));
    }
    acts.appendChild(actionBtn("trash", "delete", "Remove this file from the entity", () => doRemoveInstance(img, inst)));
    tile.appendChild(acts);
  }
}

function tileFor(img, inst, faceId) {
  const tile = document.createElement("div");
  tile.className = "inst-tile";
  tile.dataset.instId = inst.id;
  tile.title = inst.label || inst.name;
  if (inst.w && inst.h) {
    // A rendered preview exists exactly when dimensions do (the previewUrl
    // convention in kinds.js) — images always, docs/audio when one rendered.
    // aspect-ratio makes the tile's width resolve BEFORE the lazy image
    // loads: no strip reflow as thumbs land, and scrollFlaggedStrips (one
    // frame after insert) measures real offsets, not collapsed ones.
    const im = document.createElement("img");
    im.loading = "lazy";
    im.style.aspectRatio = `${inst.w} / ${inst.h}`;
    im.src = thumbUrl(inst.name);
    im.alt = inst.label || inst.name;
    tile.appendChild(im);
  } else {
    const badge = document.createElement("div");
    badge.className = "inst-badge";
    badge.textContent = ((inst.label || inst.name || "").match(/\.(\w+)$/)?.[1] || inst.kind || "file").toUpperCase();
    tile.appendChild(badge);
  }
  if (inst.id === faceId) {
    const chip = document.createElement("span");
    chip.className = "inst-face-chip";
    chip.textContent = "face";
    chip.title = "This file is the entity's card face";
    tile.appendChild(chip);
  }
  if (ACTIVE.has(inst.status) || QUEUED.has(inst.status)) tile.classList.add("loading");
  // Dim, don't hide: the entity filter is per-facet-any-instance, so a row
  // can match while no single tile does — hiding would leave it empty. An
  // all-dim strip is the honest rendering ("matches only in aggregate").
  if (!instanceMatches(inst)) tile.classList.add("dim");
  tile.addEventListener("click", () => {
    // Bulk mode selects entities — a tile stands for its whole row there,
    // exactly like a card click (the tile chrome is CSS-hidden in bulk mode).
    if (state.bulkSelected.size) {
      const card = tile.closest(".entity-row")?.querySelector(".card");
      if (card) toggleBulkSelect(img, card);
      return;
    }
    openLightboxAt(img, inst.id);
  });

  tile.addEventListener("pointerenter", () => {
    if (state.bulkSelected.size) return;
    if (!tile.querySelector(".inst-tag-chip")) mountTileChrome(tile, img, inst);
  });
  tile.addEventListener("pointerleave", () => {
    if (tile.classList.contains("pop-open")) return;
    teardownTileHover(tile);
  });
  return tile;
}

function rowFor(img) {
  const row = document.createElement("div");
  row.className = "entity-row";
  row.dataset.eid = img.id;
  row.appendChild(cardFor(img));
  if (img.instances.length > 1) {
    const strip = document.createElement("div");
    strip.className = "inst-strip";
    const faceId = selectFace(img.instances, state.boardMapping?.face)?.id ?? null;
    for (const inst of img.instances) strip.appendChild(tileFor(img, inst, faceId));
    // A mixed strip (some tiles match the filter, some dimmed) gets flagged
    // to scroll its first match into view once it's in the DOM — the reason
    // the row surfaced shouldn't be off-screen right. Fresh and filter-
    // changed builds only: rowEl strips the flag from same-key rebuilds
    // (data churn) and hands them their predecessor's scroll position; a
    // reused row simply keeps its own.
    if (strip.querySelector(".inst-tile.dim") && strip.querySelector(".inst-tile:not(.dim)")) {
      row.dataset.scrollMatch = "1";
    }
    row.appendChild(strip);
  }
  return row;
}

// Scroll targets need layout (offsets, clamp range), so flagged strips
// scroll one frame after insertion; flags clear immediately so later renders
// never re-yank the strip. Two flags, at most one per row: scroll-keep
// restores a rebuilt strip's inherited position, scroll-match aims a fresh
// strip at its first filter match.
function scrollFlaggedStrips() {
  requestAnimationFrame(() => {
    for (const row of elGrid.querySelectorAll(".entity-row[data-scroll-keep]")) {
      const strip = row.querySelector(".inst-strip");
      if (strip) strip.scrollLeft = Number(row.dataset.scrollKeep);
      delete row.dataset.scrollKeep;
    }
    for (const row of elGrid.querySelectorAll(".entity-row[data-scroll-match]")) {
      delete row.dataset.scrollMatch;
      const strip = row.querySelector(".inst-strip");
      const first = strip?.querySelector(".inst-tile:not(.dim)");
      if (first) strip.scrollLeft = Math.max(0, first.offsetLeft - strip.offsetLeft - 8);
    }
  });
}

function rowEl(img, keyChanged = false) {
  const sig = rowSig(img);
  const hit = rowCache.get(img.id);
  if (hit && hit.sig === sig && hit.el.isConnected) return hit.el;
  if (hit) releaseCard(hit.el.querySelector(".card"));
  const el = rowFor(img);
  // A same-key rebuild is data churn (status poll, tag save, a heart on the
  // card), not a new presentation: the strip inherits its predecessor's
  // scroll position instead of snapping to 0, and never re-yanks to the
  // first match — the user's hand is mid-strip. Across a key change the
  // filters moved, so scrollMatch re-aims at the new evidence; a strip that
  // just appeared (1→2 instances, a merge) has no position to keep and
  // behaves like a fresh build. The restore rides scroll-keep because a
  // detached strip clamps scrollLeft writes to 0; reading the old row's
  // pending scroll-keep first covers chained same-frame rebuilds, whose
  // strip hasn't been restored yet and still reads 0.
  if (hit && !keyChanged) {
    const oldStrip = hit.el.querySelector(".inst-strip");
    if (oldStrip && el.querySelector(".inst-strip")) {
      delete el.dataset.scrollMatch;
      const prev = Number(hit.el.dataset.scrollKeep || 0) || oldStrip.scrollLeft;
      if (prev) el.dataset.scrollKeep = prev;
    }
  }
  rowCache.set(img.id, { el, sig });
  return el;
}

// Release every cached row's card from the stage observer. Called on each
// grid-mode render (a no-op once empty) so a mode flip doesn't strand
// observed cards in a cache nothing will prune. The key reset makes the
// return trip start from a fresh first batch — without it, rows→grid→rows
// under the same filters re-enters with the old scrolled-deep limit and an
// empty cache, one giant synchronous rebuild at top-of-page.
export function dropAllRows() {
  for (const { el } of rowCache.values()) releaseCard(el.querySelector(".card"));
  rowCache = new Map();
  lastKey = "";
}

// The rows counterpart of renderGrid — same contract, same caching shape.
export function renderRows(key, progressItems, items) {
  const keyChanged = key !== lastKey;
  if (keyChanged) {
    lastKey = key;
    renderLimit = RENDER_BATCH;
  }
  elGrid.style.height = ""; // masonry's inline height from a prior grid render
  const children = progressLane(progressItems);
  // The same cleanup at card level: lane elements are shared with grid mode
  // (progressCache and laneMoreCard survive a flip so spinners don't reset),
  // and layoutGrid stamps inline masonry width/left/top on every .card it
  // sees. In rows-mode normal flow those read as relative offsets and
  // displace the lane; strip them — the return trip re-stamps via layoutGrid.
  for (const el of children) { el.style.left = el.style.top = el.style.width = ""; }

  if (!items.length && !progressItems.length) {
    dropAllRows();
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No items match these filters.";
    elGrid.replaceChildren(e);
    return;
  }

  for (const img of items.slice(0, renderLimit)) children.push(rowEl(img, keyChanged));

  const keep = new Set(items.slice(0, renderLimit).map((i) => i.id));
  for (const [id, { el }] of rowCache) {
    if (!keep.has(id)) {
      releaseCard(el.querySelector(".card"));
      rowCache.delete(id);
    }
  }

  // Nothing changed (the common poll tick) — leave the DOM alone.
  const same =
    children.length === elGrid.children.length &&
    children.every((el, i) => el === elGrid.children[i]);
  if (!same) elGrid.replaceChildren(...children);
  scrollFlaggedStrips();
}

function appendMoreRows() {
  const items = taggedFiltered();
  let appended = 0;
  for (const img of items) {
    if (appended >= RENDER_BATCH) break;
    if (rowCache.has(img.id)) continue;
    elGrid.appendChild(rowEl(img));
    appended++;
  }
  if (!appended) return;
  renderLimit = rowCache.size;
  scrollFlaggedStrips();
  pokeRowsSentinel();
}

// Own observer on the shared sentinel element; the callback no-ops outside
// rows mode (grid.js's appendMoreCards mirrors the guard).
const sentinelObserver = new IntersectionObserver(
  (entries) => { if (effectiveView() === "rows" && entries.some((e) => e.isIntersecting)) appendMoreRows(); },
  { rootMargin: "1200px 0px" }
);
sentinelObserver.observe(elGridSentinel);

export function pokeRowsSentinel() {
  sentinelObserver.unobserve(elGridSentinel);
  sentinelObserver.observe(elGridSentinel);
}
