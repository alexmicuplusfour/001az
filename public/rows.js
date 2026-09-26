// rows.js — the instance-rows gallery mode (planning/instance-rows-plan.md).
// Entities stack vertically; each row is the untouched entity card (grid.js's
// Card, so every entity affordance rides along) plus a horizontally
// scrolling strip of its instance tiles, the whole group in a bordered
// container. Single-instance entities render without a strip — the card
// already IS that instance, and a one-tile strip would repeat the same
// photo. Everything on a tile is instance-scoped (the lightbox's per-instance
// verbs, relocated): its own tag pop + editor, Retag, Re-extract on mapped
// boards, and remove; hearts/crates stay on the card — they reference
// entities(id) in the schema.
//
// Rows and tiles are components (planning/ui-updates-plan.md, Stage 4), drawn
// from render() as before and keyed by entity and file id. A row redraws only
// when something it draws changed: its card's props, its file list, which
// tiles match the filter, which files are in work, which file is the face.
// Rows persist across repaints, so a strip keeps its own scroll; the
// bookkeeping that carried a scroll position from a rebuilt row to its
// replacement is gone with the rebuilds.
import { state } from './state.js';
import { itemsChanged, itemsVersion } from './state-signals.js';
import { html, render, Component, useState, useRef, useLayoutEffect } from './vendor/preact.mjs';
import { Icon } from './icon.js';
import { cardProps, Card, Lane, EmptyNote, Act, pinWhileOpen, registerPin, sameProps, freshKey, laneStamp } from './grid.js';
import { thumbUrl } from './kinds.js';
import { openDetailAt } from './detail-open.js';
import { selectFace } from './face-select.js';
import { taggedFiltered, instanceMatches } from './filters.js';
import { effectiveView } from './view.js';
import { ACTIVE, QUEUED, requeueToast } from './data.js';
import { ICONS, refreshEntityTags, mappingHasAiWork, applyFace } from './utils.js';
import { openDropdown, ddAction } from './dropdown.js';
import { openTagEditor } from './tag-editor.js';
import { toggleBulkSelect } from './bulk.js';
import { toast } from './toast.js';

const elGrid = document.getElementById("grid");
const elGridSentinel = document.getElementById("grid-sentinel");

// Rows carry more DOM than cards; smaller batches, same sentinel flow.
const RENDER_BATCH = 30;
let limit = RENDER_BATCH;
let epoch = ""; // the key of the last fresh draw (grid.js freshKey): the rows' filters
let last = { progress: [], items: [] };

// ── per-instance verbs (the lightbox's, relocated to the tile) ──────────────

// data.js takes the server's instance list wholesale on every delta row, so
// a handler made at draw time can hold an object the entity no longer
// contains. Everything below re-resolves by id at fire time — mutating a
// captured orphan is a write the union recompute and the next draw never
// read (a tag edit would look lost, an optimistic status would never paint).
// The captured object is the fallback (instance deleted in another tab): the
// request still fires and the server's 404/409 surfaces as the toast.
const liveInst = (item, inst) => item.instances.find((x) => x.id === inst.id) || inst;

// The lightbox disables its buttons mid-flight; a tile's buttons come and go
// with the hover, so the latch lives here instead. Without it a double click
// double-DELETEs — the second 404s and toasts a failure after a removal that
// succeeded.
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

function doRetag(item, inst) {
  return once(`retag:${inst.id}`, () =>
    requeueToast(`/api/instances/${liveInst(item, inst).id}/retag`, "Retag queued", "Retag failed"));
}

function doReextract(item, inst) {
  // A 409 here (an instance older than the board's mapping) reaches the user
  // as the server's own sentence — requeueToast prefers it over the fallback.
  return once(`reextract:${inst.id}`, () =>
    requeueToast(`/api/instances/${liveInst(item, inst).id}/reextract`, "Re-extraction queued", "Re-extract failed"));
}

function doRemoveInstance(item, inst) {
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
      item.instances = item.instances.filter((x) => x.id !== inst.id);
      refreshEntityTags(item);
      applyFace(item, selectFace(item.instances, state.boardMapping?.face));
      itemsChanged();
      toast("File removed");
    } catch {
      toast.error("Couldn't remove file");
    }
  });
}

// The tile's tag pop: this instance's own tags (no union — that's the card's
// story), with Edit/Retag in the footer. Click-open, unlike the card's
// hover pop — tiles are small and their overlay buttons sit millimetres away.
// The pin keeps the hover chrome while the pop is up (the card's pattern).
function openInstTagPop(chip, item, inst) {
  inst = liveInst(item, inst); // freshest tags for the list about to render
  const pin = pinWhileOpen(chip, { sel: ".inst-tile" });
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
            openTagEditor(item, liveInst(item, inst));
          },
        }),
        ddAction({
          label: "Retag",
          icon: ICONS.tag,
          onClick: (e) => {
            e.stopPropagation();
            close();
            doRetag(item, inst);
          },
        }),
      );
    } : undefined,
    onClose: pin.release,
  });
  pin.hold(ctx);
}

// A tile: one file of the entity. Its chrome (the tag chip, the buttons)
// draws while the pointer is over it or a menu is pinned on it, exactly like
// the card's — a 60-instance strip would otherwise carry 60 chips and 120
// buttons nobody is pointing at — and the stylesheet hides it in bulk mode.
// The face chip stays (informational, one per strip at most).
function Tile({ item, inst, dim, loading, isFace, me, aiWork }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);
  useLayoutEffect(() => { registerPin(ref.current, setPinned); }, []);
  const chrome = hover || pinned;
  // Dim, don't hide: the entity filter is per-facet-any-instance, so a row
  // can match while no single tile does — hiding would leave it empty. An
  // all-dim strip is the honest rendering ("matches only in aggregate").
  const cls = "inst-tile" + (loading ? " loading" : "") + (dim ? " dim" : "") + (pinned ? " pop-open" : "");
  const onClick = () => {
    // Bulk mode selects entities — a tile stands for its whole row there,
    // exactly like a card click (the tile chrome is CSS-hidden in bulk mode).
    if (state.bulkSelected.size) { toggleBulkSelect(item); return; }
    openDetailAt(item, inst.id);
  };
  // A rendered preview exists exactly when dimensions do (the previewUrl
  // convention in kinds.js) — images always, docs/audio when one rendered.
  // aspect-ratio makes the tile's width resolve BEFORE the lazy image loads:
  // no strip reflow as thumbs land, and the first-match scroll (one frame
  // after the draw) measures real offsets, not collapsed ones.
  const face = inst.w && inst.h
    ? html`<img loading="lazy" style=${`aspect-ratio: ${inst.w} / ${inst.h}`} src=${thumbUrl(inst.name)} alt=${inst.label || inst.name} />`
    : html`<div class="inst-badge">${((inst.label || inst.name || "").match(/\.(\w+)$/)?.[1] || inst.kind || "file").toUpperCase()}</div>`;
  return html`<div ref=${ref} class=${cls} data-inst-id=${inst.id} title=${inst.label || inst.name} onClick=${onClick}
      onPointerEnter=${() => setHover(true)} onPointerLeave=${() => setHover(false)}>
    ${face}
    ${isFace && html`<span class="inst-face-chip" title="This file is the entity's card face">face</span>`}
    ${chrome && html`<div class="inst-tag-chip" title="Tags for this file" onClick=${(e) => { e.stopPropagation(); openInstTagPop(e.currentTarget, item, inst); }}>
      <${Icon} svg=${ICONS.tag} /><span class="tc">${inst.tags.length}</span>
    </div>`}
    ${chrome && me && html`<div class="inst-actions">
      ${aiWork && html`<${Act} icon="redo" cls="reextract" title="Re-extract (re-derive identity + fields for this file)" onClick=${() => doReextract(item, inst)} />`}
      <${Act} icon="trash" cls="delete" title="Remove this file from the entity" onClick=${() => doRemoveInstance(item, inst)} />
    </div>`}
  </div>`;
}

// A row: the entity's card plus its strip. `card` is the card's props
// (grid.js cardProps), compared value by value. `matches` and `busy` are one
// character per file: whether it matches the filters, and whether it's in
// work. A file's status is written in place (data.js applyRoutedEntities,
// on every re-queue's answer), so the file list can be the same array with a
// new status in it: the row compares these strings, not the files. A facet
// toggle that moves the dim pattern, or a file sent back to work, redraws
// the row, and nothing else does.
class Row extends Component {
  shouldComponentUpdate(next) {
    for (const k in next) {
      if (k === "card" ? !sameProps(next.card, this.props.card) : next[k] !== this.props[k]) return true;
    }
    return false;
  }

  componentDidMount() { this.aim(); }

  // Aimed where a rebuilt strip was before rows persisted: a strip that just
  // appeared (a second file arrived), or a filter change that moved this
  // strip's dim pattern. Data churn, and a filter change that leaves this
  // row's files as they were (a sort, the favorites, another facet), keep
  // the hand where it is.
  componentDidUpdate(prev) {
    const appeared = prev.instances.length < 2 && this.props.instances.length > 1;
    if (appeared || (prev.epoch !== this.props.epoch && prev.matches !== this.props.matches)) this.aim();
  }

  // A mixed strip (some tiles match the filters, some dimmed) scrolls its
  // first match into view — the reason the row surfaced shouldn't be off-
  // screen right; any other strip goes back to its start. One frame later,
  // because the offsets need layout.
  aim() {
    const strip = this.base?.querySelector?.(".inst-strip");
    if (!strip) return;
    requestAnimationFrame(() => {
      const first = strip.querySelector(".inst-tile.dim") ? strip.querySelector(".inst-tile:not(.dim)") : null;
      strip.scrollLeft = first ? Math.max(0, first.offsetLeft - strip.offsetLeft - 8) : 0;
    });
  }

  render(p) {
    const strip = p.instances.length > 1 && html`<div class="inst-strip">
      ${p.instances.map((inst, i) => html`<${Tile} key=${inst.id} item=${p.card.item} inst=${inst} dim=${p.matches[i] === "0"}
        loading=${p.busy[i] === "1"} isFace=${inst.id === p.faceId} me=${p.me} aiWork=${p.aiWork} />`)}
    </div>`;
    return html`<div class="entity-row" data-eid=${p.card.id}>
      <${Card} ...${p.card} me=${p.me} />
      ${strip}
    </div>`;
  }
}

function Rows({ progress, items, limit, epoch, me, aiWork, faceCfg }) {
  if (!items.length && !progress.length) return html`<${EmptyNote} />`;
  return [
    html`<${Lane} key="lane" progress=${progress} me=${me} />`,
    ...items.slice(0, limit).map((item) => html`<${Row} key=${`r${item.id}`} card=${cardProps(item)} instances=${item.instances}
      matches=${item.instances.map((i) => (instanceMatches(i) ? "1" : "0")).join("")}
      busy=${item.instances.map((i) => (ACTIVE.has(i.status) || QUEUED.has(i.status) ? "1" : "0")).join("")}
      faceId=${selectFace(item.instances, faceCfg)?.id ?? null}
      epoch=${epoch} me=${me} aiWork=${aiWork} />`),
  ];
}

// The draw's inputs as a stamp, the grid's way (grid.js draw): a repaint that
// moved none of them is skipped. Rows also read the selection (which tiles
// match) and the board's mapping (the face, the re-extract button).
let drawn = null;
function stamp() {
  return [last.items, limit, laneStamp(last.progress), state.me, state.bulkSelected, state.facets,
    state.selected, state.boardMapping, itemsVersion.value];
}

function draw(force = false) {
  const s = stamp();
  if (!force && drawn && s.every((v, i) => v === drawn[i])) return;
  drawn = s;
  render(html`<${Rows} progress=${last.progress} items=${last.items} limit=${limit} epoch=${epoch} me=${!!state.me}
    aiWork=${mappingHasAiWork(state.boardMapping)} faceCfg=${state.boardMapping?.face} />`, elGrid);
}

// The rows counterpart of renderGrid — same contract, and the same key.
export function renderRows(key, progressItems, items) {
  const fresh = freshKey(key);
  if (fresh) {
    epoch = key;
    limit = RENDER_BATCH;
  }
  last = { progress: progressItems, items };
  elGrid.style.height = ""; // masonry's inline height from a prior grid draw
  draw(fresh);
}

function appendMoreRows() {
  const items = taggedFiltered();
  if (limit >= items.length) return;
  limit = Math.min(limit + RENDER_BATCH, items.length);
  last.items = items;
  draw();
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
