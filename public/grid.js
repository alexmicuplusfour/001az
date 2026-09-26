import { state } from './state.js';
import { itemsChanged, itemsVersion } from './state-signals.js';
import { ICONS, hasIdentity, instanceTagCounts, mappingHasAiWork, scopableInstance, facetName } from './utils.js';
import { html, render, Component, useState, useRef, useLayoutEffect } from './vendor/preact.mjs';
import { batch } from './vendor/signals.mjs';
import { Icon } from './icon.js';
import { openDropdown, ddRow, ddAction, openFacetScopePop } from './dropdown.js';
import { toast } from './toast.js';
import { taggedFiltered, needsTags } from './filters.js';
import { dropPendingUploadId, requeueToast, ACTIVE, QUEUED } from './data.js';
import { openCratePop } from './crates.js';
import { openTagEditor } from './tag-editor.js';
import { toggleBulkSelect } from './bulk.js';
import { kindFor } from './kinds.js';
import { openDetail } from './detail-open.js';
import { effectiveView } from './view.js';
import { runSimilar, runSimilarMeaning } from './search.js';
import { MIN_TAGS } from './patterns.js';

const elGrid = document.getElementById("grid");
const elGridSentinel = document.getElementById("grid-sentinel");

const GAP = 14;       // matches --gap CSS var
const COL_MIN = 320;  // minimum column width
const RENDER_BATCH = 60;

let layoutTimer = null;
let limit = RENDER_BATCH; // how many of the filtered items are drawn
let last = { progress: [], items: [] }; // what renderGrid last drew, for the appends

// The cards are components (planning/ui-updates-plan.md, Stage 4): drawn
// into #grid from render() as before, keyed by item id, and each one redraws
// only when a prop it draws has changed. A poll tick that brought nothing
// costs nothing per card, whatever the scroll depth; a heart on one card
// redraws that card. What a card used to keep in the DOM (its hover chrome,
// a menu pinned on it, its picture loaded or broken) is its state.

// Spinners run only while their card is near the viewport (.onstage) — a
// scrolled queue view mounts hundreds of cards, and hundreds of infinite
// animations grind the tab even when each is cheap. An in-flight card watches
// itself while it's mounted; the observer tells the component, which owns
// the class.
const onstageOf = new WeakMap(); // element -> (onstage) => void
const stageObserver = new IntersectionObserver((entries) => {
  for (const e of entries) onstageOf.get(e.target)?.(e.isIntersecting);
}, { rootMargin: "300px 0px" });
function watchStage(el, set) { onstageOf.set(el, set); stageObserver.observe(el); }
function unwatchStage(el) { onstageOf.delete(el); stageObserver.unobserve(el); }
function useOnstage(ref, active) {
  const [onstage, setOnstage] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!active || !el) return undefined;
    watchStage(el, setOnstage);
    return () => unwatchStage(el);
  }, [active]);
  return onstage;
}

// The grid's box and the columns it holds, read one way for the masonry and
// the lane's budget (they used to differ by the grid's padding, so the lane
// could wrap a row early near a column boundary).
function gridBox() {
  const cs = getComputedStyle(elGrid);
  const pl = parseFloat(cs.paddingLeft) || 0; // jsdom answers "" for these
  const pr = parseFloat(cs.paddingRight) || 0;
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const inner = elGrid.clientWidth - pl - pr;
  return { pl, pt, pb, inner, cols: Math.max(1, Math.floor((inner + GAP) / (COL_MIN + GAP))) };
}

export function layoutGrid() {
  // Rows mode is normal document flow — masonry's absolute positions would
  // corrupt it (resize handlers and rAF callers land here unconditionally).
  if (effectiveView() === "rows") return;
  const cards = [...elGrid.querySelectorAll(".card")];
  if (!cards.length) { elGrid.style.height = ""; return; }
  const { pl, pt, pb, inner, cols } = gridBox();
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
  let h = pt + Math.max(...heights) - GAP + pb;
  // The scrollbar takes width, this layout reads that width, and the height
  // stamped here decides whether the scrollbar exists. A board whose stack
  // lands within a whisker of the fold has no consistent answer: at full
  // width it overflows, minus the scrollbar it fits, so each relayout
  // toggled the scrollbar and the next one measured the other width —
  // forever, 20s apart. The escape is that the disagreement is only ever a
  // few px tall: a stack that would scroll ONLY into its own bottom padding
  // is clamped to exactly fit instead. Near-the-fold boards keep full width
  // and no scrollbar, with the difference absorbed by padding (at least
  // 20px of it always survives); boards clearly past the fold are past the
  // clamp's reach and scroll exactly as before. Floor, because a stamped
  // height a fraction over the room still rounds up into a scrollbar.
  const room = Math.floor(window.innerHeight - (elGrid.getBoundingClientRect().top + window.scrollY));
  if (h > room && h - room < pb - 20) h = room;
  elGrid.style.height = h + "px";
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
    toast("Item deleted");
  } catch {
    toast.error("Delete failed");
  }
}

// Which caret entries apply to THIS card. Absence is the honest state — an
// entry that can't run isn't shown, and a card with no entries gets no caret
// at all (CardActions asks the same question). Applicability rides fields the
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
    out.push({ label: "Re-extract fields", icon: ICONS.srcExtract, url: u("reextract"), ok: "Re-extraction queued", fail: "Re-extract failed" });
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

// An action button on a card's chrome: the glyph, the class the stylesheet
// knows, and a click that never reaches the card (which would open the
// detail view). Exported for the rows view's tiles.
export const Act = ({ icon, cls, title, onClick }) => html`<button class=${"act " + cls} title=${title}
  onClick=${(e) => { e.stopPropagation(); onClick(e); }}><${Icon} svg=${ICONS[icon]} /></button>`;

function CardActions({ item }) {
  // Reprocess is a split control: main click = the whole shebang, the caret
  // opens the granular verbs (the reprocess formalization plan's Stage 4).
  // No caret when the menu would be empty (no facets, no AI mapping, no
  // connector, no audio) — the same honesty the entries themselves get.
  // `.dd-caret` on the button, the spelling the toolbar's split arrow uses.
  return html`<div class="card-actions">
    <div class="split-btn">
      <${Act} icon="redo" cls="reprocess" title="Reprocess — redo everything for this item"
        onClick=${() => requeueToast(`/api/items/${item.id}/reprocess`, "Reprocessing…", "Reprocess failed")} />
      ${verbsFor(item).length > 0 && html`<${Act} icon="chevron" cls="split-arrow dd-caret" title="More processing actions"
        onClick=${(e) => openVerbsPop(e.currentTarget, item)} />`}
    </div>
    <${Act} icon="trash" cls="delete" title="Delete" onClick=${() => doDelete(item.id)} />
    <${Act} icon="crate" cls="crate" title="Add to crate" onClick=${(e) => openCratePop(e.currentTarget, item)} />
  </div>`;
}

// The heart: on and its count from the card's props; who hearted it fetched
// on hover, once per count.
function HeartControl({ item, hearts, on }) {
  const [names, setNames] = useState(null); // { hearts, text } — the answer, for the count it was asked at
  const asked = useRef(-1);
  const text = names && names.hearts === hearts ? names.text : "";
  const enter = async () => {
    if (!hearts) { setNames({ hearts, text: "no hearts yet" }); return; }
    if (asked.current === hearts) return;
    asked.current = hearts;
    try {
      const { names: who } = await fetch(`/api/items/${item.id}/hearts`).then((r) => r.json());
      setNames({ hearts, text: who && who.length ? who.join(", ") : "no hearts yet" });
    } catch { asked.current = -1; }
  };
  const click = async (e) => {
    e.stopPropagation();
    try {
      const r = await fetch(`/api/items/${item.id}/favorite`, { method: "POST" });
      // Session gone (expired, or revoked by a password change elsewhere).
      if (r.status === 401) return location.replace("/login.html?next=" + encodeURIComponent(location.pathname + location.search));
      const { favorited, count: n } = await r.json();
      item.favoritedByMe = favorited;
      item.hearts = n;
      itemsChanged(); // the card redraws from its new props
    } catch {
      toast.error("Couldn't update favorite");
    }
  };
  return html`<div class=${"heart" + (on ? " on" : "") + (hearts > 0 ? " has" : "")} title="Favorite" onMouseEnter=${enter} onClick=${click}>
    <span class="hi"><${Icon} svg=${ICONS.heart} /></span><span class="hc">${hearts || ""}</span><div class="heart-pop">${text}</div>
  </div>`;
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
      if (canSimilar) act("Find similar by tags", ICONS.search, () => runSimilar(item));
      if (canMeaning) act("Find similar by meaning", ICONS.embed, () => runSimilarMeaning(item));
    } : undefined,
    onClose: pin.release,
  });
  pin.hold(ctx);
}

const TagChip = ({ item, count }) => html`<div class="tag-chip" onClick=${(e) => e.stopPropagation()} onPointerEnter=${(e) => openTagPop(e.currentTarget, item)}>
  <span class="ti"><${Icon} svg=${ICONS.tag} /></span><span class="tc">${count}</span>
</div>`;

// Two rows' worth of progress cards — under this, a drop behaves exactly as
// before; past it, the lane truncates and the tail card carries the count.
function laneBudget() {
  return Math.max(4, gridBox().cols * 2);
}

// The lane's share of a draw's stamp (below): which items are in it and,
// while there are any, its budget, which reads the grid's width. Exported for
// rows.js, which draws the same lane.
export function laneStamp(progress) {
  return progress.length ? `${progress.map((p) => p.tempId ?? p.id).join(",")}/${laneBudget()}` : "";
}

// The lane's tail: "+N processing…" standing in for everything past the
// budget.
function LaneMore({ count }) {
  const showQueue = () => {
    // "Show me the queue" — active facet pills would exclude the tagless
    // queue items, so clear them rather than landing on an empty grid.
    batch(() => {
      state.selected = new Map();
      state.showUntagged = false;
      state.showProcessing = true;
      state.showUnprocessed = true;
    });
  };
  return html`<div class="card lane-more" title="Show the whole queue" onClick=${showQueue}>
    <div class="lane-more-count">+${count}</div><div class="lane-more-label">processing…</div>
  </div>`;
}

// An upload placeholder or an item still in flight, in the lane. Its face
// follows its kind; it has no data-id, so the settled-card counts (tests,
// the select-all shortcut) don't see it.
function ProgressCard({ p, me }) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const ref = useRef(null);
  const onstage = useOnstage(ref, !broken);
  if (broken) return null;
  const kind = kindFor(p);
  const cls = "card loading" + (kind.instant || loaded ? " loaded" : "") + (onstage ? " onstage" : "");
  return html`<div ref=${ref} class=${cls}>
    <${kind.ProgressFace} name=${p.name} objURL=${p.objURL} w=${p.w} h=${p.h} symbol=${p.symbol} identity=${p.identity}
      label=${p.displayLabel} count=${p.instances?.length || 0} loaded=${loaded}
      onLoaded=${() => setLoaded(true)} onBroken=${() => setBroken(true)} onLayout=${scheduleLayout} />
    <div class="spinner" />
    ${p.id && me && html`<div class="card-actions"><${Act} icon="trash" cls="delete" title="Delete" onClick=${() => doDelete(p.id)} /></div>`}
  </div>`;
}

// The progress lane, budgeted — shared by both gallery modes (rows.js draws
// the same lane above its entity rows).
export function Lane({ progress, me }) {
  const budget = laneBudget();
  const out = progress.slice(0, budget).map((p) => html`<${ProgressCard} key=${p.tempId != null ? `u${p.tempId}` : `p${p.id}`} p=${p} me=${me} />`);
  if (progress.length > budget) out.push(html`<${LaneMore} key="lane-more" count=${progress.length - budget} />`);
  return out;
}

// Pin a card's (or a tile's) hover chrome while a menu opened from it is up.
// The chrome is component state, so the pin is set on the component: each
// mounted card and tile registers its setter under its own element, and a
// menu's opener finds that element from the button it was given. By element,
// not by id: one file can sit under two entities (in classify mode a file
// belongs to every entity that claimed it, data.js), so two tiles can share
// an id. `release` takes the dropdown's close REASON: "keep-card" means the
// menu handed off to another over the same anchor (crates' re-open, the
// caret's facet-scope chain), so the chrome must survive or the second menu
// is placed against an element that just vanished. Stage 5 turns the
// registry into a signal the card reads.
const pins = new WeakMap(); // a card's or tile's element -> its setPinned
export function registerPin(el, set) {
  if (el) pins.set(el, set);
}
export function pinWhileOpen(anchor, { sel = ".card" } = {}) {
  const el = anchor.closest(sel);
  const set = el ? pins.get(el) : undefined;
  return {
    el,
    hold: (ctx) => { if (ctx) set?.(true); },
    release: (reason) => { if (reason !== "keep-card") set?.(false); },
  };
}

// Props compared one by one: the card redraws when one of them changed.
export function sameProps(a, b) {
  if (a === b) return true;
  for (const k in a) if (a[k] !== b[k]) return false;
  for (const k in b) if (!(k in a)) return false;
  return true;
}

// What a card draws, read off the item once per repaint. The card renders
// from these alone (the item rides along for its handlers), so a field that
// isn't here can't be drawn stale, and the card's redraw check is a compare
// of these values. Exported for the rows view, whose rows carry the same
// card.
export function cardProps(item) {
  return {
    item,
    id: item.id,
    status: item.status,
    loading: ACTIVE.has(item.status) || QUEUED.has(item.status),
    // Anything in the grid without tags needs human attention — AI-undecided,
    // held (waiting for auto-tagging), failed, or hand-cleared — but only on
    // a board with a taxonomy; a board with no facets can't be tagged at all,
    // so the dotted "needs tags" treatment there would be a permanent false
    // alarm (needsTags).
    undecided: needsTags(item),
    hearts: item.hearts || 0,
    favoritedByMe: !!item.favoritedByMe,
    name: item.name,
    w: item.w,
    h: item.h,
    kind: item.kind,
    generated: !!item.generated,
    label: item.displayLabel,
    titled: hasIdentity(item),
    symbol: item.symbol,
    identity: item.identity,
    count: item.instances?.length || 0,
    tags: item.tags, // replaced by every writer, never edited (D5)
    selected: state.bulkSelected.has(item.id),
  };
}

// A card: the frame and the chrome around a face (kinds.js owns the face).
// It draws from its props alone and redraws only when one changed. Its own
// state: the pointer over it (the chrome draws while it is, as it always
// did), a menu pinned on it, its picture loaded or broken, and whether it's
// near the viewport (the spinner runs only then). In bulk mode the chrome is
// hidden by the stylesheet (body.bulk-mode), not by a prop: a prop would
// redraw every card on the first and the last selection. Exported for the
// rows view.
export class Card extends Component {
  constructor(props) {
    super(props);
    this.state = { pic: props.name, hover: false, pinned: false, loaded: false, broken: false, onstage: false };
    this.setPinned = (on) => {
      if (on) { this.setState({ pinned: true }); return; }
      // Released with the pointer still over the card (the menu closed under
      // it): the chrome stays, as :hover says, not as the last pointerleave
      // said — that one fired when the pointer went onto the menu.
      let hover = false;
      try { hover = !!this.base?.matches?.(":hover"); } catch { /* jsdom: no pointer */ }
      this.setState({ pinned: false, hover });
    };
    this.onLoaded = () => { if (!this.state.loaded) this.setState({ loaded: true }); };
    this.onBroken = () => this.setState({ broken: true });
    this.onEnter = () => this.setState({ hover: true });
    this.onLeave = () => this.setState({ hover: false });
    this.onClick = () => {
      if (state.bulkSelected.size) toggleBulkSelect(this.props.item);
      else openDetail(this.props.item);
    };
    this.onSelect = (e) => { e.stopPropagation(); toggleBulkSelect(this.props.item); };
  }

  // Loaded and broken belong to a picture: a new one (the item's face moved
  // to another file, or a chart was drawn again under a new name) starts
  // over, as a rebuilt card did before Stage 4. Kept, a new picture drew on
  // a blank face with no shimmer while it loaded (Chromium drops a lazy
  // image's old picture when its src changes), and a card whose picture had
  // failed stayed hidden through every new one.
  static getDerivedStateFromProps(p, s) {
    return p.name === s.pic ? null : { pic: p.name, loaded: false, broken: false };
  }

  shouldComponentUpdate(nextProps, nextState) {
    return !sameProps(nextProps, this.props) || !sameProps(nextState, this.state);
  }

  componentDidMount() {
    registerPin(this.base, this.setPinned);
    this.watch();
  }

  componentDidUpdate(prev, prevState) {
    registerPin(this.base, this.setPinned); // a card back from a broken picture is a new element
    this.watch();
    // A picture that failed took the card with it, and one that replaced it
    // brought the card back: the masonry has a hole, or a card to place.
    if (this.state.broken !== prevState.broken) scheduleLayout();
  }

  componentWillUnmount() {
    this.unwatch();
  }

  // Watched while in flight and drawn; the observer holds strong refs, so
  // whatever stops needing it is unwatched.
  watch() {
    const el = this.state.broken ? null : this.base;
    const want = !!(this.props.loading && el && el.nodeType === 1);
    if (want && this.watched !== el) {
      this.unwatch();
      watchStage(el, (v) => this.setState({ onstage: v }));
      this.watched = el;
    } else if (!want) {
      this.unwatch();
    }
  }

  unwatch() {
    if (this.watched) { unwatchStage(this.watched); this.watched = null; }
  }

  render(p, s) {
    if (s.broken) return null;
    const kind = kindFor(p);
    const loaded = !!kind.instant || s.loaded;
    const chrome = s.hover || s.pinned;
    const cls = "card" + (loaded ? " loaded" : "") + (p.loading ? " loading" : "") + (p.undecided ? " undecided" : "")
      + (p.selected ? " selected" : "") + (s.onstage ? " onstage" : "") + (s.pinned ? " pop-open" : "");
    // Lets layoutGrid compute the height (cardW / ratio) instead of measuring.
    // Only valid while the body is a pinned-ratio image and no card state adds
    // layout height (selected/undecided use outline + inner padding, which
    // don't). Bodies with content-dependent height (doc faces and
    // identity-titled images carry a title strip) leave this unset — they
    // take the measured lane.
    const ratio = p.w && p.h && p.kind === "image" && !p.titled ? p.w / p.h : undefined;
    // The select button and the heart sit inside the face's media region,
    // above the title strip if there is one.
    const overlay = html`${p.me && html`<button class="sel-cb" title="Select" aria-pressed=${String(p.selected)} onClick=${this.onSelect}><${Icon} svg=${ICONS.check} /></button>`}
      ${p.me && (chrome || p.hearts > 0 || p.favoritedByMe) && html`<${HeartControl} item=${p.item} hearts=${p.hearts} on=${p.favoritedByMe} />`}`;
    return html`<div class=${cls} data-id=${p.id} data-ratio=${ratio} onClick=${this.onClick} onPointerEnter=${this.onEnter} onPointerLeave=${this.onLeave}>
      <${kind.Face} ...${p} loaded=${loaded} overlay=${overlay} onLoaded=${this.onLoaded} onBroken=${this.onBroken} onLayout=${scheduleLayout} />
      ${p.loading && html`<div class="spinner" />`}
      ${chrome && p.me && html`<${CardActions} item=${p.item} />`}
      ${chrome && html`<${TagChip} item=${p.item} count=${p.tags.length} />`}
    </div>`;
  }
}

// The two empty states are different sentences: a board with nothing in it is
// not a filter result, and "No items match these filters" on a fresh board
// blames filters that were never touched. state.items is the UNFILTERED set,
// so it is the discriminant — the filtered list going empty while items exist
// is the filters' doing. Exported so rows.js says the same thing.
export const EmptyNote = () => html`<div class="empty">${state.items.length
  ? "No items match these filters."
  : "Nothing here yet — use + to add the first items."}</div>`;

function Grid({ progress, items, limit, me }) {
  if (!items.length && !progress.length) return html`<${EmptyNote} />`;
  return [
    html`<${Lane} key="lane" progress=${progress} me=${me} />`,
    ...items.slice(0, limit).map((item) => html`<${Card} key=${`c${item.id}`} ...${cardProps(item)} me=${me} />`),
  ];
}

// What the tree is drawn from, as a stamp: a draw is skipped when none of it
// moved since the last one, so a repaint that changed nothing (the common
// poll tick) doesn't walk the cards at all, whatever the scroll depth.
// Everything a card draws comes from its item (itemsVersion counts every
// write to one, Stage 3), the selection, the viewer, the board's facets (the
// needs-tags outline), the lane and the limit. Stage 5 makes this the grid's
// own subscription.
let drawn = null;
function stamp() {
  return [last.items, limit, laneStamp(last.progress), state.me, state.bulkSelected, state.facets, itemsVersion.value];
}

function draw(force = false) {
  const s = stamp();
  if (!force && drawn && s.every((v, i) => v === drawn[i])) return;
  drawn = s;
  render(html`<${Grid} progress=${last.progress} items=${last.items} limit=${limit} me=${!!state.me} />`, elGrid);
}

// The key #grid was last drawn under, from app.js render(): the filters and
// the view. Both views draw into #grid, so both go by this one key. A key
// other than the last one (the filters changed, or the view flipped) starts
// the view over at its first batch and always draws, since #grid may be
// holding the other view's tree: each view skips a draw when nothing it
// reads has moved, and a flip moves nothing it reads. Exported for rows.js.
let shownKey = "";
export function freshKey(key) {
  if (key === shownKey) return false;
  shownKey = key;
  return true;
}

// key is passed in from app.js render() so grid.js doesn't need to import
// filterKey.
export function renderGrid(key, progressItems, items) {
  const fresh = freshKey(key);
  if (fresh) limit = RENDER_BATCH;
  last = { progress: progressItems, items };
  draw(fresh);
}

export function scrollToCard(item) {
  if (!item) return;
  let card = elGrid.querySelector(`[data-id="${item.id}"]`);
  // The backfill below draws masonry cards — grid-mode machinery. In rows
  // mode an off-screen row (past the render limit) is just not scrolled to.
  if (!card && effectiveView() !== "rows") {
    const items = taggedFiltered();
    const targetIdx = items.indexOf(item);
    if (targetIdx < 0) return;
    limit = Math.max(limit, targetIdx + 1);
    last.items = items;
    draw();
    layoutGrid();
    pokeSentinel();
    card = elGrid.querySelector(`[data-id="${item.id}"]`);
  }
  if (card) card.scrollIntoView({ behavior: "instant", block: "center" });
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
  if (limit >= items.length) return;
  limit = Math.min(limit + RENDER_BATCH, items.length);
  last.items = items;
  draw();
  layoutGrid();
  pokeSentinel();
}

const sentinelObserver = new IntersectionObserver(
  (entries) => { if (entries.some((e) => e.isIntersecting)) appendMoreCards(); },
  { rootMargin: "1200px 0px" }
);
sentinelObserver.observe(elGridSentinel);

export function initGrid() {
  // The width layoutGrid reads is the html element's content box, and that
  // box changes twice as often as the window does: on real resizes, and when
  // the page scrollbar comes or goes — which fires no resize event. Observe
  // the box itself, so a scrollbar toggle relays out now, not at the next
  // 20s signals tick (that lag is what made the old flap visible as a slow
  // dance). With the fit clamp above, every board reaches a state where the
  // stamped height and the scrollbar agree, so this observer goes quiet
  // after at most one extra pass.
  new ResizeObserver(scheduleLayout).observe(document.documentElement);
}

export function visibleGridItems() {
  const byId = new Map(state.items.map((i) => [i.id, i]));
  return [...document.querySelectorAll("#grid .card[data-id]")]
    .map((c) => byId.get(Number(c.dataset.id)))
    .filter(Boolean);
}
