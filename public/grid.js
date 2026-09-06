import { state } from './state.js';
import { ICONS, actionBtn, hasIdentity, instanceTagCounts, mappingHasAiWork, scopableInstance, facetName } from './utils.js';
import { openDropdown, ddRow, ddAction, openFacetScopePop } from './dropdown.js';
import { toast } from './toast.js';
import { taggedFiltered, needsTags } from './filters.js';
import { dropPendingUploadId, requeueToast, ACTIVE, QUEUED } from './data.js';
import { openCratePop } from './crates.js';
import { openTagEditor } from './tag-editor.js';
import { toggleBulkSelect } from './bulk.js';
import { kindFor } from './kinds.js';
import { effectiveView } from './view.js';
import { runSimilar, runSimilarMeaning } from './search.js';
import { MIN_TAGS } from './patterns.js';

const elGrid = document.getElementById("grid");
const elGridSentinel = document.getElementById("grid-sentinel");

const GAP = 14;       // matches --gap CSS var
const COL_MIN = 320;  // minimum column width
const RENDER_BATCH = 60;

let layoutTimer = null;
let renderLimit = RENDER_BATCH;
let lastFilterKey = "";

// Rendered card elements, reused across renders so a heart click or poll
// tick doesn't recreate the whole grid. A card is reused only while its
// signature matches; a change (tagging finished, hearts moved) recreates
// just that card.
let cardCache = new Map();     // item id -> { el, sig }
let progressCache = new Map(); // upload tempId / item id -> el

// Spinners run only while their card is near the viewport (.onstage) — a
// scrolled queue view mounts hundreds of cards, and hundreds of infinite
// animations grind the tab even when each is cheap. Cards are observed at
// creation; every path that drops a card must unobserve it, or the
// observer's strong refs leak recreated cards across status churn.
const stageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) e.target.classList.toggle("onstage", e.isIntersecting);
}, { rootMargin: "300px 0px" });

// Everything cardFor bakes into the DOM that can change after creation.
// Bulk selection isn't included: bulk.js updates card elements in place.
// name + instance count: a merge/split can swap the face file or change the
// stack badge without touching anything else. Exported for rows.js, whose
// row signature embeds it (a row re-renders when its card would).
export function cardSig(item) {
  return `${item.status}|${item.undecided}|${item.hearts}|${item.favoritedByMe}|${item.w}|${item.name}|${item.instances?.length || 0}|${item.displayLabel}|${item.tags.join(",")}`;
}

// Drop a card element rows.js (or any cache owner) is done with — the stage
// observer holds strong refs, so every dropped card must be unobserved.
export function releaseCard(el) {
  if (el) stageObserver.unobserve(el);
}

// The grid counterpart of rows.js dropAllRows, called on each rows-mode
// render (a no-op once empty): release the cached cards from the stage
// observer — nothing else prunes this cache while the grid isn't rendering —
// and reset the render key, so a later flip back re-enters at a fresh first
// batch instead of synchronously rebuilding a scrolled-deep limit's worth of
// cards under a scroll position that just reset to the top.
export function dropAllCards() {
  for (const { el } of cardCache.values()) stageObserver.unobserve(el);
  cardCache = new Map();
  lastFilterKey = "";
}

function cardEl(item) {
  const sig = cardSig(item);
  const hit = cardCache.get(item.id);
  // isConnected: a card that removed itself (broken image) must not be
  // resurrected from the cache — recreate so the error path runs again.
  if (hit && hit.sig === sig && hit.el.isConnected) return hit.el;
  if (hit) stageObserver.unobserve(hit.el);
  const el = cardFor(item);
  cardCache.set(item.id, { el, sig });
  return el;
}

export function layoutGrid() {
  // Rows mode is normal document flow — masonry's absolute positions would
  // corrupt it (resize handlers and rAF callers land here unconditionally).
  if (effectiveView() === "rows") return;
  const cards = [...elGrid.querySelectorAll(".card")];
  if (!cards.length) { elGrid.style.height = ""; return; }
  const cs = getComputedStyle(elGrid);
  const pl = parseFloat(cs.paddingLeft);
  const pr = parseFloat(cs.paddingRight);
  const pt = parseFloat(cs.paddingTop);
  const pb = parseFloat(cs.paddingBottom);
  const inner = elGrid.clientWidth - pl - pr;
  const cols = Math.max(1, Math.floor((inner + GAP) / (COL_MIN + GAP)));
  const cardW = (inner - GAP * (cols - 1)) / cols;

  // Interleaving width writes with height reads forces a full page reflow
  // per card, so writes and reads are split into separate passes.
  for (const card of cards) card.style.width = cardW + "px";

  // Cards without a stamped ratio (progress placeholders, items missing
  // w/h, future bodies with content-dependent height) get measured here,
  // all together: one reflow for the batch instead of one per card.
  const measured = new Map();
  for (const card of cards) {
    if (!card.dataset.ratio) measured.set(card, card.offsetHeight);
  }

  const heights = new Array(cols).fill(0);
  for (const card of cards) {
    const h = card.dataset.ratio ? cardW / Number(card.dataset.ratio) : measured.get(card);
    const col = heights.indexOf(Math.min(...heights));
    card.style.left = (pl + col * (cardW + GAP)) + "px";
    card.style.top  = (pt + heights[col]) + "px";
    heights[col] += h + GAP;
  }
  elGrid.style.height = (pt + Math.max(...heights) - GAP + pb) + "px";
}

export function scheduleLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(layoutGrid, 30);
}

async function doDelete(id) {
  if (!confirm("Delete this item?")) return;
  try {
    const r = await fetch(`/api/items/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error();
    state.items = state.items.filter((i) => i.id !== id);
    dropPendingUploadId(id);
    document.dispatchEvent(new Event('app:render'));
    toast("Item deleted");
  } catch {
    toast.error("Delete failed");
  }
}

// The split button's caret: the granular slices of reprocess, each an entry
// only when it applies to THIS card — absence is the honest state, no
// disabled ghosts. Applicability rides fields the client already holds
// (instance kind/status/undecided, state.facets, state.boardMapping) through
// the same mirrors rows-mode already gates with; the plan's close look is
// explicit that a server-shipped can[] waits until these mirrors multiply.
// Which caret entries apply to THIS card. Absence is the honest state — an
// entry that can't run isn't shown, and a card with no entries gets no caret
// at all (cardActions asks the same question). Applicability rides fields the
// client already holds (instance kind/status/undecided, state.facets,
// state.boardMapping) through the same mirrors rows-mode gates with; the
// plan's close look is explicit that a server-shipped can[] waits until those
// mirrors multiply. A wrong guess fails soft — requeueToast shows the route's
// own 409 sentence.
function verbsFor(item) {
  const insts = item.instances || [];
  const u = (verb) => `/api/items/${item.id}/${verb}`;
  const out = [];
  if (state.facets.length) {
    out.push({ label: "Retag", icon: ICONS.tag, url: u("retag"), ok: "Retag queued", fail: "Retag failed" });
    if (insts.some(scopableInstance)) {
      out.push({ label: "Retag one facet…", icon: ICONS.tag, url: u("retag"), ok: "Retag queued", fail: "Retag failed", scoped: true });
    }
  }
  if (mappingHasAiWork(state.boardMapping)) {
    out.push({ label: "Re-extract fields", icon: ICONS.srcSparkle, url: u("reextract"), ok: "Re-extraction queued", fail: "Re-extract failed" });
  }
  if (state.boardMapping?.input?.connector) {
    out.push({ label: "Refresh data + chart", icon: ICONS.srcGlobe, url: u("refresh"), ok: "Refresh queued", fail: "Refresh failed" });
  }
  if (insts.some((i) => i.kind === "audio")) {
    out.push({ label: "Re-transcribe (re-bills)", icon: ICONS.srcWave, url: u("retranscribe"), ok: "Re-transcription queued", fail: "Re-transcribe failed" });
  }
  return out;
}

// The split button's caret: the granular slices of reprocess.
function openVerbsPop(anchor, item) {
  const pin = pinWhileOpen(anchor);
  const ctx = openDropdown(anchor, {
    align: "end",
    minWidth: 210,
    onClose: pin.release,
    build: (body, { close }) => {
      for (const v of verbsFor(item)) {
        const icon = document.createElement("span");
        icon.className = "dd-icon";
        icon.innerHTML = v.icon;
        body.appendChild(ddRow({ label: v.label, leading: icon, onClick: (e) => {
          e.stopPropagation();
          // A scoped row hands the card off to the facet pop over the SAME
          // anchor — "keep-card" is the app's existing word for that (crates'
          // re-open uses it), so pin.release leaves the chrome standing.
          close(v.scoped ? "keep-card" : "manual");
          if (!v.scoped) return requeueToast(v.url, v.ok, v.fail);
          openFacetScopePop(anchor, state.facets, (f) =>
            requeueToast(v.url, f ? `${v.ok} on ${facetName(f)}` : v.ok, v.fail,
              f ? { facets: [f.key] } : undefined),
            { onClose: pin.release });
        } }));
      }
    },
  });
  pin.hold(ctx);
}

function cardActions(item) {
  const actions = document.createElement("div");
  actions.className = "card-actions";
  // Reprocess is a split control: main click = the whole shebang, the caret
  // opens the granular verbs (the reprocess formalization plan's Stage 4).
  const split = document.createElement("div");
  split.className = "split-btn";
  split.appendChild(actionBtn("redo", "reprocess", "Reprocess — redo everything for this item",
    () => requeueToast(`/api/items/${item.id}/reprocess`, "Reprocessing…", "Reprocess failed")));
  // No caret when the menu would be empty (no facets, no AI mapping, no
  // connector, no audio) — the same honesty the entries themselves get.
  // `.dd-caret` on the button, the spelling the toolbar's split arrow uses.
  if (verbsFor(item).length) {
    const caret = actionBtn("chevron", "split-arrow dd-caret", "More processing actions",
      () => openVerbsPop(caret, item));
    split.appendChild(caret);
  }
  actions.appendChild(split);
  actions.appendChild(actionBtn("trash", "delete", "Delete", () => doDelete(item.id)));
  const cb = document.createElement("button");
  cb.className = "act crate";
  cb.title = "Add to crate";
  cb.innerHTML = ICONS.crate;
  cb.addEventListener("click", (e) => { e.stopPropagation(); openCratePop(cb, item); });
  actions.appendChild(cb);
  return actions;
}

function heartControl(item) {
  const wrap = document.createElement("div");
  wrap.className = "heart" + (item.favoritedByMe ? " on" : "") + (item.hearts > 0 ? " has" : "");
  wrap.title = "Favorite";
  const icon = document.createElement("span");
  icon.className = "hi";
  icon.innerHTML = ICONS.heart;
  const count = document.createElement("span");
  count.className = "hc";
  count.textContent = item.hearts || "";
  wrap.append(icon, count);

  const pop = document.createElement("div");
  pop.className = "heart-pop";
  wrap.appendChild(pop);

  let loaded = false;
  wrap.addEventListener("mouseenter", async () => {
    if (loaded || !item.hearts) { if (!item.hearts) pop.textContent = "no hearts yet"; return; }
    loaded = true;
    try {
      const { names } = await fetch(`/api/items/${item.id}/hearts`).then((r) => r.json());
      pop.textContent = names && names.length ? names.join(", ") : "no hearts yet";
    } catch { loaded = false; }
  });

  wrap.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const r = await fetch(`/api/items/${item.id}/favorite`, { method: "POST" });
      // Session gone (expired, or revoked by a password change elsewhere).
      if (r.status === 401) return location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
const { favorited, count: n } = await r.json();
      item.favoritedByMe = favorited;
      item.hearts = n;
      wrap.classList.toggle("on", favorited);
      wrap.classList.toggle("has", n > 0);
      count.textContent = n || "";
      loaded = false;
      pop.textContent = "";
      document.dispatchEvent(new Event('app:render'));
    } catch {
      toast.error("Couldn't update favorite");
    }
  });
  return wrap;
}

function openTagPop(chip, item) {
  const pin = pinWhileOpen(chip);
  // The footer's actions gate one by one — they want different things.
  // Editing needs a logged-in user and a taxonomy; Find similar (the 1b
  // search, computed from exactly the chips this pop shows) needs neither,
  // just enough identity to match on; the meaning flavor needs only the
  // board's embeddings (no tag floor — a barely-tagged item with a rich
  // description is exactly where it shines).
  const canEdit = state.me && state.facets.length;
  const canSimilar = item.tags.length >= MIN_TAGS;
  const canMeaning = state.searchAvailable;
  const ctx = openDropdown(chip, {
    className: "tag-pop",
    hover: true,
    align: "start",
    minWidth: 150,
    maxWidth: 250,
    maxItems: 0, // tags wrap freely; only the viewport caps the height
    build: (body) => {
      if (item.tags.length) {
        // The union across a multi-instance entity is a distribution — each
        // tag carries how many instances hold it. Single-instance entities
        // (every raw board) render without counts, exactly as before.
        const counts = item.instances.length > 1 ? instanceTagCounts(item) : null;
        for (const t of item.tags) {
          const s = document.createElement("span");
          s.className = "tp";
          s.textContent = t;
          const n = counts?.get(t);
          if (n) {
            const c = document.createElement("span");
            c.className = "tp-n";
            c.textContent = n;
            s.appendChild(c);
          }
          body.appendChild(s);
        }
      } else {
        const s = document.createElement("span");
        s.className = "tp empty";
        s.textContent = "no tags";
        body.appendChild(s);
      }
    },
    footer: (canEdit || canSimilar || canMeaning) ? (foot, { close }) => {
      // One wrapper for every row: close the pop, then run the verb.
      const act = (label, icon, fn) => foot.appendChild(ddAction({
        label, icon,
        onClick: (e) => { e.stopPropagation(); close(); fn(); },
      }));
      if (canEdit) act("Edit tags", ICONS.pencil, () => openTagEditor(item));
      if (canSimilar) act("Find similar", ICONS.search, () => runSimilar(item));
      if (canMeaning) act("Find similar by meaning", ICONS.sparkle, () => runSimilarMeaning(item));
    } : undefined,
    onClose: pin.release,
  });
  pin.hold(ctx);
}

function tagChip(item) {
  const chip = document.createElement("div");
  chip.className = "tag-chip";
  chip.addEventListener("click", (e) => e.stopPropagation());
  const icon = document.createElement("span");
  icon.className = "ti";
  icon.innerHTML = ICONS.tag;
  const count = document.createElement("span");
  count.className = "tc";
  count.textContent = item.tags.length;
  chip.append(icon, count);
  chip.addEventListener("pointerenter", () => openTagPop(chip, item));
  return chip;
}

// Two rows' worth of progress cards — under this, a drop behaves exactly as
// before; past it, the lane truncates and the tail card carries the count.
function laneBudget() {
  const cols = Math.max(1, Math.floor((elGrid.clientWidth + GAP) / (COL_MIN + GAP)));
  return Math.max(4, cols * 2);
}

// The lane's tail: "+N processing…" standing in for everything past the
// budget. One cached element whose count updates in place, so poll ticks
// where nothing else changed keep the DOM-untouched fast path.
let laneMoreCard = null;
function laneMore(count) {
  if (!laneMoreCard) {
    laneMoreCard = document.createElement("div");
    laneMoreCard.className = "card lane-more";
    laneMoreCard.title = "Show the whole queue";
    const n = document.createElement("div");
    n.className = "lane-more-count";
    const label = document.createElement("div");
    label.className = "lane-more-label";
    label.textContent = "processing…";
    laneMoreCard.append(n, label);
    laneMoreCard.addEventListener("click", () => {
      // "Show me the queue" — active facet pills would exclude the tagless
      // queue items, so clear them rather than landing on an empty grid.
      state.selected = new Map();
      state.showUntagged = false;
      state.showProcessing = true;
      state.showUnprocessed = true;
      document.dispatchEvent(new Event('app:render'));
    });
  }
  laneMoreCard.querySelector(".lane-more-count").textContent = `+${count}`;
  return laneMoreCard;
}

function progressCard(p) {
  const card = document.createElement("div");
  card.className = "card loading";
  const body = kindFor(p).progressFace?.(p, card, scheduleLayout);
  if (body) card.appendChild(body);
  const sp = document.createElement("div");
  sp.className = "spinner";
  card.appendChild(sp);
  if (p.id && state.me) {
    const acts = document.createElement("div");
    acts.className = "card-actions";
    acts.appendChild(actionBtn("trash", "delete", "Delete", () => doDelete(p.id)));
    card.appendChild(acts);
  }
  stageObserver.observe(card);
  return card;
}

// Pin an element's hover chrome while a pop owns it. Four surfaces need the
// same three moves — add .pop-open on open, drop it on close, and tear the
// chrome down only if the pointer has since left — and they differ solely in
// which element and which teardown. `release` takes the dropdown's close
// REASON: "keep-card" means the pop handed off to another pop over the same
// anchor (crates' re-open, the caret's facet-scope chain), so the chrome must
// survive or the second pop is placed against an element that just vanished.
export function pinWhileOpen(anchor, { sel = ".card", teardown = teardownCardHover } = {}) {
  const el = anchor.closest(sel);
  return {
    el,
    hold: (ctx) => { if (ctx && el) el.classList.add("pop-open"); },
    release: (reason) => {
      if (!el || reason === "keep-card") return;
      el.classList.remove("pop-open");
      if (!el.matches(":hover")) teardown(el);
    },
  };
}

export function teardownCardHover(card) {
  card.querySelector(".card-actions")?.remove();
  card.querySelector(".tag-chip")?.remove();
  const heart = card.querySelector(".heart");
  if (heart && !heart.classList.contains("on") && !heart.classList.contains("has")) heart.remove();
}

export function scrollToCard(item) {
  if (!item) return;
  let card = elGrid.querySelector(`[data-id="${item.id}"]`);
  // The backfill below builds masonry cards — grid-mode machinery. In rows
  // mode an off-screen row (past the render limit) is just not scrolled to.
  if (!card && effectiveView() !== "rows") {
    const items = taggedFiltered();
    const targetIdx = items.indexOf(item);
    if (targetIdx < 0) return;
    for (let i = 0; i <= targetIdx; i++) {
      if (cardCache.has(items[i].id)) continue;
      elGrid.appendChild(cardEl(items[i]));
    }
    renderLimit = Math.max(renderLimit, targetIdx + 1);
    layoutGrid();
    pokeSentinel();
    card = elGrid.querySelector(`[data-id="${item.id}"]`);
  }
  if (card) card.scrollIntoView({ behavior: "instant", block: "center" });
}

function faceOverlay(card) {
  return card.querySelector(".face-media") || card;
}

// Exported for rows.js: a row is this exact card (all entity affordances —
// hearts, crate, tag chip, reprocess, delete, bulk select — ride along) plus
// an instance strip beside it. rows.js keeps its own element cache; cards
// created here are masonry-positioned only by layoutGrid, which rows mode
// never runs, so the same builder serves both layouts.
export function cardFor(item) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = item.id;
  // Lets layoutGrid compute the height (cardW / ratio) instead of measuring.
  // Only valid while the body is a pinned-ratio image and no card state adds
  // layout height (selected/undecided use outline + inner padding, which
  // don't). Bodies with content-dependent height (doc faces and identity-titled
  // images carry a title strip) must leave this unset — they take the measured lane.
  if (item.w && item.h && item.kind === "image" && !hasIdentity(item)) card.dataset.ratio = item.w / item.h;
  // Anything in the grid without tags needs human attention — AI-undecided,
  // held (waiting for auto-tagging), failed, or hand-cleared — but only on a
  // board with a taxonomy; a board with no facets can't be tagged at all, so
  // the dotted "needs tags" treatment there would be a permanent false alarm.
  if (needsTags(item)) card.classList.add("undecided");
  // The file kind owns the face (the media); grid owns the frame + chrome.
  // (The instance-count chip rides inside the face's title strip — kinds.js.)
  card.appendChild(kindFor(item).face(item, card, scheduleLayout));
  if (ACTIVE.has(item.status) || QUEUED.has(item.status)) {
    card.classList.add("loading");
    const sp = document.createElement("div");
    sp.className = "spinner";
    card.appendChild(sp);
  }
  card.addEventListener("click", () => {
    if (state.bulkSelected.size) { toggleBulkSelect(item, card); return; }
    kindFor(item).openDetail(item);
  });

  if (state.me) {
    const cb = document.createElement("button");
    cb.className = "sel-cb";
    cb.title = "Select";
    cb.innerHTML = ICONS.check;
    cb.setAttribute("aria-pressed", String(state.bulkSelected.has(item.id)));
    cb.addEventListener("click", (e) => { e.stopPropagation(); toggleBulkSelect(item, card); });
    faceOverlay(card).appendChild(cb);
    if (state.bulkSelected.has(item.id)) card.classList.add("selected");
  }

  if (state.me && (item.hearts > 0 || item.favoritedByMe)) faceOverlay(card).appendChild(heartControl(item));

  card.addEventListener("pointerenter", () => {
    if (state.bulkSelected.size) return;
    if (state.me && !card.querySelector(".card-actions")) card.appendChild(cardActions(item));
    if (!card.querySelector(".tag-chip")) card.appendChild(tagChip(item));
    if (state.me && !card.querySelector(".heart")) faceOverlay(card).appendChild(heartControl(item));
  });
  card.addEventListener("pointerleave", () => {
    if (card.classList.contains("pop-open")) return;
    teardownCardHover(card);
  });
  stageObserver.observe(card);
  return card;
}

// The progress lane's cards, budgeted and cached — shared verbatim by both
// gallery modes (rows.js prepends the same lane above its entity rows), so
// the cache has one owner and upload placeholders survive a mode flip.
export function progressLane(progressItems) {
  const children = [];
  const nextProgress = new Map();
  const budget = laneBudget();
  for (const p of progressItems.slice(0, budget)) {
    const k = p.tempId != null ? `u${p.tempId}` : p.id;
    const el = progressCache.get(k) || progressCard(p);
    nextProgress.set(k, el);
    children.push(el);
  }
  for (const [k, el] of progressCache) {
    if (!nextProgress.has(k)) stageObserver.unobserve(el);
  }
  progressCache = nextProgress;
  if (progressItems.length > budget) children.push(laneMore(progressItems.length - budget));
  return children;
}

// key is passed in from app.js render() so grid.js doesn't need to import filterKey.
export function renderGrid(key, progressItems, items) {
  if (key !== lastFilterKey) {
    lastFilterKey = key;
    renderLimit = RENDER_BATCH;
  }
  const children = progressLane(progressItems);

  if (!items.length && !progressItems.length) {
    for (const { el } of cardCache.values()) stageObserver.unobserve(el);
    cardCache = new Map();
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No items match these filters.";
    elGrid.replaceChildren(e);
    return;
  }

  for (const item of items.slice(0, renderLimit)) children.push(cardEl(item));

  // Prune cards that fell out of view or were deleted.
  const keep = new Set(items.slice(0, renderLimit).map((i) => i.id));
  for (const [id, { el }] of cardCache) {
    if (!keep.has(id)) {
      stageObserver.unobserve(el);
      cardCache.delete(id);
    }
  }

  // Nothing changed (the common poll tick) — leave the DOM alone.
  const same =
    children.length === elGrid.children.length &&
    children.every((el, i) => el === elGrid.children[i]);
  if (!same) elGrid.replaceChildren(...children);
}

export function pokeSentinel() {
  sentinelObserver.unobserve(elGridSentinel);
  sentinelObserver.observe(elGridSentinel);
}

function appendMoreCards() {
  // Both modes' sentinel observers watch the same element; each appender
  // no-ops outside its own mode (rows.js has the rows counterpart).
  if (effectiveView() === "rows") return;
  const items = taggedFiltered();
  let appended = 0;
  for (const item of items) {
    if (appended >= RENDER_BATCH) break;
    if (cardCache.has(item.id)) continue;
    elGrid.appendChild(cardEl(item));
    appended++;
  }
  if (!appended) return;
  renderLimit = cardCache.size;
  layoutGrid();
  pokeSentinel();
}

const sentinelObserver = new IntersectionObserver(
  (entries) => { if (entries.some((e) => e.isIntersecting)) appendMoreCards(); },
  { rootMargin: "1200px 0px" }
);
sentinelObserver.observe(elGridSentinel);

export function initGrid() {
  window.addEventListener("resize", scheduleLayout);
}

export function visibleGridItems() {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  return [...document.querySelectorAll("#grid .card[data-id]")]
    .map((c) => byId.get(Number(c.dataset.id)))
    .filter(Boolean);
}
