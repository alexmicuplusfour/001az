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
import { cardFor, cardSig, releaseCard, progressLane } from './grid.js';
import { thumbUrl } from './kinds.js';
import { openLightboxAt } from './lightbox.js';
import { selectFace } from './face-select.js';
import { taggedFiltered, instanceMatches } from './filters.js';
import { effectiveView } from './view.js';
import { ACTIVE, QUEUED, ensurePolling } from './data.js';
import { ICONS, actionBtn, refreshEntityTags, mappingHasAiWork } from './utils.js';
import { openDropdown } from './dropdown.js';
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
  return once(`retag:${inst.id}`, async () => {
    try {
      const r = await fetch(`/api/instances/${inst.id}/retag`, { method: "POST" });
      if (!r.ok) throw new Error();
      inst.status = "pending";
      img.status = "pending"; // aggregate approximation; the poll corrects it
      document.dispatchEvent(new Event('app:render'));
      ensurePolling();
      toast("Retag queued");
    } catch {
      toast.error("Retag failed");
    }
  });
}

function doReextract(img, inst) {
  return once(`reextract:${inst.id}`, async () => {
    try {
      const r = await fetch(`/api/instances/${inst.id}/reextract`, { method: "POST" });
      if (!r.ok) {
        // 409 = no stamped mapping (an instance older than the board's mapping).
        const { error } = await r.json().catch(() => ({}));
        toast.error(error || "Re-extract failed");
        return;
      }
      inst.status = "pending_extract";
      img.status = "pending_extract";
      document.dispatchEvent(new Event('app:render'));
      ensurePolling();
      toast("Re-extraction queued");
    } catch {
      toast.error("Re-extract failed");
    }
  });
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
  const tile = chip.closest(".inst-tile");
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
      const editBtn = document.createElement("button");
      editBtn.className = "tp-edit";
      editBtn.innerHTML = ICONS.pencil + "<span>Edit tags</span>";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        openTagEditor(img, inst);
      });
      const retagBtn = document.createElement("button");
      retagBtn.className = "tp-edit";
      retagBtn.innerHTML = ICONS.tag + "<span>Retag</span>";
      retagBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        close();
        doRetag(img, inst);
      });
      foot.append(editBtn, retagBtn);
    } : undefined,
    onClose: () => {
      if (!tile) return;
      tile.classList.remove("pop-open");
      if (!tile.matches(":hover")) teardownTileHover(tile);
    },
  });
  if (ctx && tile) tile.classList.add("pop-open");
}

// Tile chrome is mounted on hover, exactly like the card's — a 60-instance
// strip would otherwise carry 60 chips and 120 buttons nobody is pointing
// at. The face chip stays static (informational, one per strip at most).
function teardownTileHover(tile) {
  tile.querySelector(".inst-tag-chip")?.remove();
  tile.querySelector(".inst-actions")?.remove();
}

function mountTileChrome(tile, img, inst) {
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
    // the row surfaced shouldn't be off-screen right. Fresh builds only; a
    // reused row keeps the scroll position the user left it at.
    if (strip.querySelector(".inst-tile.dim") && strip.querySelector(".inst-tile:not(.dim)")) {
      row.dataset.scrollMatch = "1";
    }
    row.appendChild(strip);
  }
  return row;
}

// Offsets need layout, so flagged strips scroll one frame after insertion;
// the flag clears immediately so later renders never re-yank the strip.
function scrollFlaggedStrips() {
  requestAnimationFrame(() => {
    for (const row of elGrid.querySelectorAll(".entity-row[data-scroll-match]")) {
      delete row.dataset.scrollMatch;
      const strip = row.querySelector(".inst-strip");
      const first = strip?.querySelector(".inst-tile:not(.dim)");
      if (first) strip.scrollLeft = Math.max(0, first.offsetLeft - strip.offsetLeft - 8);
    }
  });
}

function rowEl(img) {
  const sig = rowSig(img);
  const hit = rowCache.get(img.id);
  if (hit && hit.sig === sig && hit.el.isConnected) return hit.el;
  if (hit) releaseCard(hit.el.querySelector(".card"));
  const el = rowFor(img);
  rowCache.set(img.id, { el, sig });
  return el;
}

// Release every cached row's card from the stage observer. Called on each
// grid-mode render (a no-op once empty) so a mode flip doesn't strand
// observed cards in a cache nothing will prune.
export function dropAllRows() {
  for (const { el } of rowCache.values()) releaseCard(el.querySelector(".card"));
  rowCache = new Map();
}

// The rows counterpart of renderGrid — same contract, same caching shape.
export function renderRows(key, progressItems, items) {
  if (key !== lastKey) {
    lastKey = key;
    renderLimit = RENDER_BATCH;
  }
  elGrid.style.height = ""; // masonry's inline height from a prior grid render
  const children = progressLane(progressItems);

  if (!items.length && !progressItems.length) {
    dropAllRows();
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No items match these filters.";
    elGrid.replaceChildren(e);
    return;
  }

  for (const img of items.slice(0, renderLimit)) children.push(rowEl(img));

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
