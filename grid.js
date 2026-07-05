import { state } from './state.js';
import { ICONS, actionBtn } from './utils.js';
import { openDropdown } from './dropdown.js';
import { toast } from './toast.js';
import { taggedFiltered } from './filters.js';
import { ensurePolling, dropPendingUploadId } from './data.js';
import { openCratePop } from './crates.js';
import { openTagEditor } from './tag-editor.js';
import { toggleBulkSelect } from './bulk.js';

const elGrid = document.getElementById("grid");
const elGridSentinel = document.getElementById("grid-sentinel");

const GAP = 14;       // matches --gap CSS var
const COL_MIN = 320;  // minimum column width
const RENDER_BATCH = 60;

let layoutTimer = null;
let renderLimit = RENDER_BATCH;
let renderedIds = new Set();
let lastFilterKey = "";

export function layoutGrid() {
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
  const heights = new Array(cols).fill(0);
  for (const card of cards) {
    card.style.width = cardW + "px";
    const col = heights.indexOf(Math.min(...heights));
    card.style.left = (pl + col * (cardW + GAP)) + "px";
    card.style.top  = (pt + heights[col]) + "px";
    heights[col] += card.offsetHeight + GAP;
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
  } catch {
    toast.error("Delete failed");
  }
}

async function doReprocess(id) {
  try {
    const r = await fetch(`/api/items/${id}/reprocess`, { method: "POST" });
    if (!r.ok) throw new Error();
    const img = state.items.find((i) => i.id === id);
    if (img) {
      img.status = "pending";
      if (!img.tags.length) img.tagSet = new Set();
    }
    document.dispatchEvent(new Event('app:render'));
    ensurePolling();
    toast("Reprocessing…", { duration: "short" });
  } catch {
    toast.error("Reprocess failed");
  }
}

function cardActions(img) {
  const actions = document.createElement("div");
  actions.className = "card-actions";
  actions.appendChild(actionBtn("redo", "reprocess", "Reprocess (re-tag with AI)", () => doReprocess(img.id)));
  actions.appendChild(actionBtn("trash", "delete", "Delete", () => doDelete(img.id)));
  const cb = document.createElement("button");
  cb.className = "act crate";
  cb.title = "Add to crate";
  cb.innerHTML = ICONS.crate;
  cb.addEventListener("click", (e) => { e.stopPropagation(); openCratePop(cb, img); });
  actions.appendChild(cb);
  return actions;
}

function heartControl(img) {
  const wrap = document.createElement("div");
  wrap.className = "heart" + (img.favoritedByMe ? " on" : "") + (img.hearts > 0 ? " has" : "");
  wrap.title = "Favorite";
  const icon = document.createElement("span");
  icon.className = "hi";
  icon.innerHTML = ICONS.heart;
  const count = document.createElement("span");
  count.className = "hc";
  count.textContent = img.hearts || "";
  wrap.append(icon, count);

  const pop = document.createElement("div");
  pop.className = "heart-pop";
  wrap.appendChild(pop);

  let loaded = false;
  wrap.addEventListener("mouseenter", async () => {
    if (loaded || !img.hearts) { if (!img.hearts) pop.textContent = "no hearts yet"; return; }
    loaded = true;
    try {
      const { names } = await fetch(`/api/items/${img.id}/hearts`).then((r) => r.json());
      pop.textContent = names && names.length ? names.join(", ") : "no hearts yet";
    } catch { loaded = false; }
  });

  wrap.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const r = await fetch(`/api/items/${img.id}/favorite`, { method: "POST" });
      if (r.status === 401) return toast.info("Sign in to favorite");
const { favorited, count: n } = await r.json();
      img.favoritedByMe = favorited;
      img.hearts = n;
      if (state.showFavorites && !favorited) { document.dispatchEvent(new Event('app:render')); return; }
      wrap.classList.toggle("on", favorited);
      wrap.classList.toggle("has", n > 0);
      count.textContent = n || "";
      loaded = false;
      pop.textContent = "";
    } catch {
      toast.error("Couldn't update favorite");
    }
  });
  return wrap;
}

function openTagPop(chip, img) {
  const card = chip.closest(".card");
  const ctx = openDropdown(chip, {
    className: "tag-pop",
    hover: true,
    align: "start",
    minWidth: 150,
    maxWidth: 250,
    maxItems: 0, // tags wrap freely; only the viewport caps the height
    build: (body) => {
      if (img.tags.length) {
        for (const t of img.tags) {
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
        openTagEditor(img);
      });
      foot.appendChild(editBtn);
    } : undefined,
    onClose: () => {
      if (!card) return;
      card.classList.remove("pop-open");
      if (!card.matches(":hover")) teardownCardHover(card);
    },
  });
  if (ctx && card) card.classList.add("pop-open");
}

function tagChip(img) {
  const chip = document.createElement("div");
  chip.className = "tag-chip";
  chip.addEventListener("click", (e) => e.stopPropagation());
  const icon = document.createElement("span");
  icon.className = "ti";
  icon.innerHTML = ICONS.tag;
  const count = document.createElement("span");
  count.className = "tc";
  count.textContent = img.tags.length;
  chip.append(icon, count);
  chip.addEventListener("pointerenter", () => openTagPop(chip, img));
  return chip;
}

function progressCard(p) {
  const card = document.createElement("div");
  card.className = "card loading";
  const body = state.adapter.renderProgressBody?.(p, card, scheduleLayout);
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
  return card;
}

export function teardownCardHover(card) {
  card.querySelector(".card-actions")?.remove();
  card.querySelector(".tag-chip")?.remove();
  const heart = card.querySelector(".heart");
  if (heart && !heart.classList.contains("on") && !heart.classList.contains("has")) heart.remove();
}

export function scrollToCard(img) {
  if (!img) return;
  let card = elGrid.querySelector(`[data-id="${img.id}"]`);
  if (!card) {
    const items = taggedFiltered();
    const targetIdx = items.indexOf(img);
    if (targetIdx < 0) return;
    for (let i = 0; i <= targetIdx; i++) {
      if (renderedIds.has(items[i].id)) continue;
      elGrid.appendChild(cardFor(items[i]));
      renderedIds.add(items[i].id);
    }
    renderLimit = Math.max(renderLimit, targetIdx + 1);
    layoutGrid();
    pokeSentinel();
    card = elGrid.querySelector(`[data-id="${img.id}"]`);
  }
  if (card) card.scrollIntoView({ behavior: "instant", block: "center" });
}

function cardFor(img) {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.id = img.id;
  // Held items (waiting for auto-tagging) get the same dashed "needs tags"
  // treatment as AI-undecided ones.
  if (img.undecided || img.status === "held") card.classList.add("undecided");
  // The board type owns the card body (the media); grid owns the frame + chrome.
  card.appendChild(state.adapter.renderCardBody(img, card, scheduleLayout));
  if (img.status === "pending" || img.status === "processing") {
    card.classList.add("loading");
    const sp = document.createElement("div");
    sp.className = "spinner";
    card.appendChild(sp);
  }
  card.addEventListener("click", () => {
    if (state.bulkSelected.size) { toggleBulkSelect(img, card); return; }
    state.adapter.openDetail(img);
  });

  if (state.me) {
    const cb = document.createElement("button");
    cb.className = "sel-cb";
    cb.title = "Select";
    cb.innerHTML = ICONS.check;
    cb.setAttribute("aria-pressed", String(state.bulkSelected.has(img.id)));
    cb.addEventListener("click", (e) => { e.stopPropagation(); toggleBulkSelect(img, card); });
    card.appendChild(cb);
    if (state.bulkSelected.has(img.id)) card.classList.add("selected");
  }

  if (state.me && (img.hearts > 0 || img.favoritedByMe)) card.appendChild(heartControl(img));

  card.addEventListener("pointerenter", () => {
    if (state.bulkSelected.size) return;
    if (state.me && !card.querySelector(".card-actions")) card.appendChild(cardActions(img));
    if (!card.querySelector(".tag-chip")) card.appendChild(tagChip(img));
    if (state.me && !card.querySelector(".heart")) card.appendChild(heartControl(img));
  });
  card.addEventListener("pointerleave", () => {
    if (card.classList.contains("pop-open")) return;
    teardownCardHover(card);
  });
  return card;
}

// key is passed in from app.js render() so grid.js doesn't need to import filterKey.
export function renderGrid(key, progressItems, items) {
  if (key !== lastFilterKey) {
    lastFilterKey = key;
    renderLimit = RENDER_BATCH;
  }
  elGrid.replaceChildren();
  renderedIds = new Set();
  for (const p of progressItems) elGrid.appendChild(progressCard(p));
  if (!items.length && !progressItems.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = "No items match these filters.";
    elGrid.appendChild(e);
    return;
  }
  for (const img of items.slice(0, renderLimit)) {
    elGrid.appendChild(cardFor(img));
    renderedIds.add(img.id);
  }
}

export function pokeSentinel() {
  sentinelObserver.unobserve(elGridSentinel);
  sentinelObserver.observe(elGridSentinel);
}

function appendMoreCards() {
  const items = taggedFiltered();
  let appended = 0;
  for (const img of items) {
    if (appended >= RENDER_BATCH) break;
    if (renderedIds.has(img.id)) continue;
    elGrid.appendChild(cardFor(img));
    renderedIds.add(img.id);
    appended++;
  }
  if (!appended) return;
  renderLimit = renderedIds.size;
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
