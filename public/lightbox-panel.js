// The lightbox's Details panel, a component (planning/lightbox-panel-plan.md,
// Stage 2). lightbox.js draws it into #lightbox-panel-body from its effect,
// on every change to what it shows, and Preact changes only what differs, so
// the keyboard, the scroll and an open Retag menu stay where they were.
//
// Two halves. The item's: its name, its files, its connector fields and the
// shown file's info rows, drawn from the item at once. The file's: its
// fields, its tags and their reasons, drawn from one snapshot of the file's
// details (D6), which a move waits for (D11).
import { state } from './state.js';
import { signal } from './vendor/signals.mjs';
import { html, render, useRef, useLayoutEffect } from './vendor/preact.mjs';
import { Icon, Markup } from './icon.js';
import { ICONS, fmtField, relTime, scopableInstance, facetName } from './utils.js';
import { kindFor, fullUrl } from './kinds.js';
import { IN_FLIGHT, requeueToast, removeInstance } from './data.js';
import { sectionHeading } from './modal.js';
import { openFacetScopePop } from './dropdown.js';
import { fieldFormat, loadCatalogs } from './sort.js';
import { detColor } from './det-geometry.js';

// ── The file's details (D6)─────────────────────────────────────────────────
// What the file's half draws: the file's tags, status and undecided flag as
// they were when its details were asked for, and the reasons, agreement and
// fields that came back. One at a time, the shown file's. A full retag clears
// the file's tags and reasons on the server at once, and the page takes the
// file's cleared tags as they come, so a half drawn from the file as it is
// would lose its chips for as long as the retag runs.
const fileDetails = signal(null);

let watch = { file: null, runs: 0, flying: false, asked: false }; // the shown file, as seen from here
let asked = null; // the question out: { file, key }
let era = 0; // which opening of the lightbox an answer belongs to

// The snapshot if it's this file's: what the half draws, and the boxes over
// the picture. Another file's waits (D11).
export const detailsOf = (file) => (file && fileDetails.value?.file === file.id ? fileDetails.value : null);

// The lightbox's effect calls this on every run with the shown file. It
// counts the file's runs through the queue, and with the panel open (`ask`)
// asks for its details when they'd say something new: on every move to
// another file, and for the same file once it settles, if it went through a
// run or its status or tags changed. While the file is queued or running, the
// half keeps what it showed.
export function followFile(file, ask) {
  const flying = IN_FLIGHT.has(file.status);
  if (watch.file !== file.id) watch = { file: file.id, runs: 0, flying, asked: false };
  else if (flying && !watch.flying) watch.runs++;
  watch.flying = flying;
  if (!flying) endQueued(file.id);
  if (!ask) return;
  const key = flying ? `${watch.runs}|running` : `${watch.runs}|${file.status}|${file.tags.join(",")}`;
  const shown = detailsOf(file);
  if (watch.asked && shown && (flying || shown.key === key)) return;
  watch.asked = true;
  if (asked?.file === file.id && asked.key === key) return;
  fetchDetails(file, key);
}

async function fetchDetails(file, key) {
  const ask = (asked = { file: file.id, key });
  const snap = {
    file: file.id, key, tags: file.tags, status: file.status, undecided: file.undecided,
    reasoning: {}, confidence: {}, fields: {},
  };
  // The catalog the fields print by (fieldFormat): the page asks for it as it
  // loads and keeps it only once it has it, so this asks again after a
  // failure there. Not waited for: the fields reprint when it lands, and one
  // that hangs mustn't keep the tags and Retag from drawing.
  loadCatalogs();
  try {
    const r = await fetch(`/api/instances/${file.id}/reasoning`);
    if (r.ok) {
      const data = await r.json();
      snap.reasoning = data.reasoning || {};
      snap.confidence = data.confidence || {};
      snap.fields = data.fields || {};
    }
  } catch { /* drawn without them, as the panel always has (D11) */ }
  if (asked !== ask) return; // asked again since, for this file or another
  asked = null;
  fileDetails.value = snap;
}

// The lightbox closed: nothing of this opening carries into the next.
export function resetPanel(el) {
  render(null, el);
  era++;
  fileDetails.value = null;
  asked = null;
  watch = { file: null, runs: 0, flying: false, asked: false };
  legs.value = new Map();
  keyboardOn = null;
}

export function drawPanel(el, props) {
  render(html`<${Panel} ...${props} />`, el);
}

// ── The buttons' state (D7) ─────────────────────────────────────────────────
// "busy" while a button's request is out, "queued" from a success until the
// file settles. By file and button, so another file's never wears it, and
// apart from the components, which a move makes anew.
const legs = signal(new Map());

function mark(key, value) {
  const next = new Map(legs.value);
  if (value) next.set(key, value);
  else next.delete(key);
  legs.value = next;
}

// Read with peek: the effect calls this before the buttons read the table, so
// reading it here would only run the effect once more for the write below.
function endQueued(fileId) {
  const ended = [...legs.peek()].filter(([key, value]) => value === "queued" && key.startsWith(`${fileId}:`));
  if (!ended.length) return;
  const next = new Map(legs.peek());
  for (const [key] of ended) next.delete(key);
  legs.value = next;
}

const LEGS = {
  reextract: { path: "reextract", label: "Re-extract", queued: "Re-extraction queued" },
  retag: { path: "retag", label: "Retag", queued: "Retag queued" },
  retranscribe: { path: "retranscribe", label: "Re-transcribe", queued: "Re-transcription queued" },
};

// `facet` scopes a retag to one facet: the route reads `facets` from the body
// and leaves every other facet's tags alone, so the toast names what moved.
async function queueLeg(file, leg, facet = null) {
  const key = `${file.id}:${leg.path}`;
  if (legs.value.get(key) === "busy") return;
  const now = era;
  mark(key, "busy");
  const ok = await requeueToast(
    `/api/instances/${file.id}/${leg.path}`,
    leg.queued + (facet ? ` on ${facetName(facet)}` : ""),
    `${leg.label} failed`,
    facet ? { facets: [facet.key] } : undefined,
  );
  if (now === era) mark(key, ok ? "queued" : null);
}

// The busy ring, as modal.js's busy() draws it into a hand-built button.
const busyFace = (face) => html`<span class="busy-label">${face}</span><span class="busy-spin" aria-hidden="true"></span>`;

// The leg whose button had the keyboard when the panel moved off its file,
// until the next file's half is drawn.
let keyboardOn = null;

// Re-extract, Retag or Re-transcribe for one file. `facets` puts the scope
// menu behind the click (Retag on a tagged, decided file: the scoped route
// would refuse anything else, and not offering the choice beats offering an
// error).
function LegButton({ file, leg, facets = null, title }) {
  const ref = useRef(null);
  // A move draws the next file's half only once its details land (D11), so
  // this button goes for a round trip and comes back. The one the keyboard
  // was on takes it back, unless it went somewhere else meanwhile (D5).
  useLayoutEffect(() => {
    const el = ref.current;
    if (keyboardOn === leg.path) {
      keyboardOn = null;
      if (!document.activeElement || document.activeElement === document.body) el.focus({ preventScroll: true });
    }
    return () => { if (document.activeElement === el) keyboardOn = leg.path; };
  }, []);
  const worn = legs.value.get(`${file.id}:${leg.path}`);
  const busy = worn === "busy";
  const queued = worn === "queued"; // until the file settles (followFile)
  const face = html`<span>${leg.label}</span>${facets ? html`<span class="dd-caret"><${Icon} svg=${ICONS.chevron} /></span>` : null}`;
  const run = (facet) => queueLeg(file, leg, facet);
  // A menu button while it has the menu: the dropdown marks its anchor as it
  // opens (dropdown.js), and this button outlives a file that stops being
  // scopable, so it says so itself and drops the marks with the menu. A menu
  // still up then leaves them off as it closes.
  return html`<button ref=${ref} class=${busy ? "lbp-reextract is-busy" : "lbp-reextract"} title=${title}
    disabled=${busy || queued} aria-busy=${busy ? "true" : undefined}
    aria-haspopup=${facets ? "menu" : undefined} aria-expanded=${facets ? "false" : undefined}
    onClick=${(e) => { e.stopPropagation(); if (facets) openFacetScopePop(e.currentTarget, facets, run); else run(); }}
  >${queued ? "Queued" : busy ? busyFace(face) : face}</button>`;
}

// ── The item's half ─────────────────────────────────────────────────────────

// Start the instances list with the current file in view rather than at the
// top — nudged only as far as needed (mirrors the dropdown's revealActive).
// offsetParent is the fixed panel shell for both row and list, so the
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

// ── Downloads (D9) ──────────────────────────────────────────────────────────

// A file of the board's own, from an upload or a feed, which a download and
// the "file" row can name. Not a ticker tile's placeholder, which has nothing
// stored behind it and is named after the ticker (`kind: "connector"`), nor a
// chart the app draws for itself (`generated`), whose random name changes on
// every refresh.
const ownFile = (f) => !!f && f.kind !== "connector" && !f.generated;

// The name a download saves under: the file's original one, except an SVG,
// which the server stores as WebP (vectors can carry scripts, so it
// rasterizes them; server/sources/image.js) and which saves as one. Not the
// stored extension in general: a HEIC is kept as it is, under an .avif name.
function savedName(f) {
  const name = f.label || f.name;
  return /\.webp$/i.test(f.name) ? name.replace(/\.svg$/i, ".webp") : name;
}

// A same-origin link, so its download attribute names the saved file. Named
// for the file it saves, and its click stays its own: the row's click picks
// the file.
function Download({ f }) {
  const name = savedName(f);
  return html`<a class="lbp-file-btn lbp-file-download" href=${fullUrl(f.name)} download=${name}
    title=${`Download ${name}`} onClick=${(e) => e.stopPropagation()}><${Icon} svg=${ICONS.download} /></a>`;
}

function FileRow({ item, f, active, onPick }) {
  const key = `${f.id}:remove`;
  const busy = legs.value.get(key) === "busy";
  // Thumbnail when the store has one (images always; docs when a preview
  // rendered); otherwise the card's badge in miniature (kinds.js small).
  const small = kindFor(f).small(f);
  const remove = async (e) => {
    e.stopPropagation();
    if (busy) return;
    const now = era;
    mark(key, "busy");
    await removeInstance(item, f); // D8; the shown file's removal is the effect's to follow
    if (now === era) mark(key, null);
  };
  const trash = html`<${Icon} svg=${ICONS.trash} />`;
  return html`<div class=${active ? "lbp-file-row lbp-file-active" : "lbp-file-row"} onClick=${() => onPick(f.id)}>
    ${small.src
      ? html`<img class="lbp-file-thumb" src=${small.src} loading="lazy" alt="" />`
      : html`<div class="lbp-file-thumb">${small.legend}</div>`}
    <button class="lbp-file-name" title="View this file">${f.label || f.name}</button>
    ${ownFile(f) ? html`<${Download} f=${f} />` : null}
    <button class=${busy ? "lbp-file-btn lbp-file-remove is-busy" : "lbp-file-btn lbp-file-remove"} title="Remove this file"
      disabled=${busy} aria-busy=${busy ? "true" : undefined} onClick=${remove}>${busy ? busyFace(trash) : trash}</button>
  </div>`;
}

// Made anew for each item (its key), so another item's list starts at its top.
function FileList({ item, file, onPick }) {
  const list = useRef(null);
  // The selected row in view when the list is drawn and when the selection
  // moves, not on every draw.
  useLayoutEffect(() => revealActiveInstance(list.current), [file?.id]);
  const instances = item.instances;
  return html`<div class="lbp-files">
    <div class="lbp-fields-label">${`Instances (${instances.length})`}</div>
    <div class="lbp-file-list" ref=${list}>
      ${instances.map((f) => html`<${FileRow} key=${f.id} item=${item} f=${f} active=${f.id === file?.id} onPick=${onPick} />`)}
    </div>
  </div>`;
}

// ── Fields ──────────────────────────────────────────────────────────────────

const hasFields = (fields) => !!fields && typeof fields === "object" && Object.keys(fields).length > 0;

// One detected object: hovering it highlights its box on the image, linked by
// the `key:idx` handle.
function DetRow({ detKey, color, d, onDetHover }) {
  return html`<div class="lbp-det-row" data-det=${detKey}
    onMouseEnter=${() => onDetHover(detKey, true)} onMouseLeave=${() => onDetHover(detKey, false)}>
    <span class="lbp-det-swatch" style=${{ background: color }}></span>
    <span class="lbp-det-label">${d.label}</span>
    <span class="lbp-det-score">${typeof d.score === "number" ? `${Math.round(d.score * 100)}%` : ""}</span>
  </div>`;
}

// One field's light-gray cell: its key with its badges, its value, and the
// model's sentence for it.
function FieldCell({ name, field, onDetHover }) {
  const { v, why, src, kind, at } = field || {};
  // A list field (options on the mapping) stores an array of the options'
  // spellings under `kind: "list"`; it reads as a joined line, the same line
  // the tag dossier sees, never as detection boxes.
  const list = kind === "list";
  const isObjects = Array.isArray(v) && !list;
  const vStr = list ? (v?.length ? v.join(", ") : null) : v !== null && v !== undefined ? String(v) : null;
  let val;
  if (isObjects) {
    // An empty one says why: its stored reason ("no image to detect on").
    val = html`<div class="lbp-field-val">${v.length
      ? v.map((d, idx) => html`<${DetRow} key=${idx} detKey=${`${name}:${idx}`} color=${detColor(name)} d=${d} onDetHover=${onDetHover} />`)
      : why || "No objects detected"}</div>`;
  } else if (vStr && /^https?:\/\//.test(vStr)) {
    val = html`<a href=${vStr} target="_blank" rel="noopener noreferrer" class="lbp-field-val">${vStr}</a>`;
  } else {
    // As the field prints everywhere (utils.js fmtField,
    // planning/list-view-plan.md D4): by its kind, and the format its
    // descriptor declares, found through the mapping. An AI answer carries no
    // kind and prints as it is.
    val = html`<span class="lbp-field-val">${list ? vStr ?? "—" : fmtField(v, { kind, format: fieldFormat(name) })}</span>`;
  }
  // Its age from the fetch or refresh that stamped it (connector fields carry
  // `at`; live ones advance it each refresh, static ones keep the add time).
  const age = at ? (Date.now() - at < 45000 ? "just now" : relTime(at)) : null;
  return html`<div class="panel-cell">
    <div class="lbp-field-kv">
      <span class="lbp-field-key">
        <span class="lbp-field-key-main">${name}${src ? html`<span class="lbp-field-src">${src}</span>` : null}${isObjects || list
          ? html`<span class="lbp-field-src">${isObjects ? "object" : "list"}</span>` : null}</span>
        ${at ? html`<span class="lbp-field-at" title=${`Updated ${new Date(at).toLocaleString()}`} aria-label=${`Updated ${age}`}><${Icon} svg=${ICONS.redo} /><span>${age}</span></span>` : null}
      </span>
      ${val}
    </div>
    ${why && !isObjects ? html`<p class="lbp-why">${why}</p>` : null}
  </div>`;
}

// A "Fields" section, in the mapping's order. They arrive in the database's
// (Postgres keeps an object's keys shortest first); a key the mapping no
// longer names goes last.
function FieldsSection({ fields, label, action = null, onDetHover }) {
  const order = new Map((state.boardMapping?.fields || []).map((f, i) => [f.key, i]));
  const rank = (key) => order.get(key) ?? order.size;
  const keys = Object.keys(fields).sort((a, b) => rank(a) - rank(b));
  return html`<div class="lbp-fields">
    <div class="lbp-fields-head"><${Markup} markup=${sectionHeading(label)} />${action}</div>
    ${keys.map((key) => html`<${FieldCell} key=${key} name=${key} field=${fields[key]} onDetHover=${onDetHover} />`)}
  </div>`;
}

// ── The file's half ─────────────────────────────────────────────────────────

// One facet's cell: its values as chips, the reason, and when the passes
// disagreed, how far.
function FacetCell({ facet, vals, why, c, split }) {
  let title = "";
  if (split) {
    // `agreed` counts passes that selected exactly this SET, not this value.
    // On a multi-value facet a value every pass chose can still sit under an
    // 0/3 badge, because each pass added a different second value — so the
    // copy says "set", and the tally beside it carries the per-value truth.
    const lost = Object.entries(c.votes || {}).filter(([v]) => !vals.includes(v));
    const tally = lost.map(([v, n]) => `${v} (${n})`).join(", ");
    title = (vals.length
      ? `${c.agreed} of ${c.of} passes selected exactly this set`
      : `no value reached a majority across ${c.of} passes`) +
      (tally ? ` — ${vals.length ? "also " : ""}proposed: ${tally}` : "");
  }
  return html`<div class="panel-cell">
    <div class="lbp-facet-head">
      <span class="panel-label">${facet.label}</span>
      ${split ? html`<span class="lbp-agree" title=${title}>${`${c.agreed}/${c.of}`}</span>` : null}
      ${vals.length
        ? vals.map((v) => html`<span key=${v} class="panel-chip">${v}</span>`)
        : html`<span class="lbp-none">—</span>`}
    </div>
    ${why ? html`<p class="lbp-why">${why}</p>` : null}
  </div>`;
}

// The selected file's fields, then its tags and reasons, from the snapshot
// (D6): the tags and reasons of one moment, so a retag landing redraws them
// together. An item with no file at all, a moment's state mid-merge, draws
// its own, at once. The leg buttons go by the file as it is: "Queued" lasts
// until it settles (D7).
function FileHalf({ item, file, snap, onDetHover }) {
  // Drawn for the next file: the leg button the keyboard was on has taken it
  // back by now (a child's layout effect runs first), and if this file has
  // none, the keyboard stays where it is rather than wait for a later one's.
  useLayoutEffect(() => { keyboardOn = null; }, []);
  const s = file ? snap : { tags: item.tags, status: item.status, undecided: item.undecided, reasoning: {}, confidence: {}, fields: {} };
  const fileFields = {};
  const aiFields = {};
  for (const [key, field] of Object.entries(s.fields)) (field?.src === "file" ? fileFields : aiFields)[key] = field;
  const why = s.reasoning;
  const conf = s.confidence;
  const byFacet = new Map();
  for (const t of s.tags) {
    const i = t.indexOf("/");
    if (i <= 0) continue;
    const k = t.slice(0, i);
    if (!byFacet.has(k)) byFacet.set(k, []);
    byFacet.get(k).push(t.slice(i + 1));
  }
  const cells = [];
  for (const f of state.facets) {
    const vals = byFacet.get(f.key) || [];
    const c = conf[f.key];
    // The passes disagreed. That earns a row by itself: a facet that converged
    // on NOTHING keeps no values, and keeps no sentence either (the merge only
    // carries a justification a run actually made), so without this it would
    // vanish from the panel at exactly the moment it has the most to say. An
    // absent entry means NOT MEASURED (single pass): no badge.
    const split = !!(c && c.of > 1 && c.agreed < c.of);
    if (!vals.length && !why[f.key] && !split) continue;
    cells.push(html`<${FacetCell} key=${f.key} facet=${f} vals=${vals} why=${why[f.key]} c=${c} split=${split} />`);
  }
  let hint = null;
  if (!cells.length && !s.undecided && s.status !== "held") hint = "No AI tags for this item.";
  else if (s.tags.length && !Object.keys(why).length) {
    hint = state.aiReasoning
      ? "No reasoning recorded — this item was tagged before reasoning was captured. Retag it to record one."
      : "AI reasoning is turned off for this board.";
  }
  const hasFile = hasFields(fileFields);
  const hasAi = hasFields(aiFields);
  return [
    hasFile ? html`<${FieldsSection} fields=${fileFields} label="File fields" onDetHover=${onDetHover} />` : null,
    hasAi ? html`<${FieldsSection} fields=${aiFields} label="AI-extracted fields" onDetHover=${onDetHover}
      action=${file ? html`<${LegButton} file=${file} leg=${LEGS.reextract} />` : null} />` : null,
    hasFile || hasAi ? html`<hr class="lbp-divider" />` : null,
    // The one verb reprocess deliberately withholds: forcing a fresh
    // transcription. Its own head, not the tags head: it is a transcript
    // verb, and the tags block is gated on the board having facets, which
    // would make it unreachable on a facetless audio board.
    file && state.me && file.kind === "audio" ? html`<div class="lbp-fields-head">
      <${Markup} markup=${sectionHeading("Transcript")} />
      <${LegButton} file=${file} leg=${LEGS.retranscribe} title="Transcribe this clip again — re-bills transcription" />
    </div>` : null,
    // Retag: re-tag just this file, leaving its identity and fields as they
    // are. A scoped pass keeps the other facets, so nothing is cleared here.
    file && state.me && state.facets.length ? html`<div class="lbp-fields-head">
      <${Markup} markup=${sectionHeading("Tags")} />
      <${LegButton} file=${file} leg=${LEGS.retag} facets=${scopableInstance(file) ? state.facets : null} />
    </div>` : null,
    // Held means PARKED, whatever parked it: auto-tagging off at upload, or a
    // cancelled queue (job-control-plan.md Stage 2 ride-along).
    s.status === "held"
      ? html`<div class="warn-box lbp-undecided">Not tagged — parked. Tag it by hand, or retag it to queue it again.</div>`
      : s.undecided
        ? html`<div class="warn-box lbp-undecided">${why.fit || "The AI couldn't apply this board's facets to this item."}</div>`
        : null,
    why.description ? html`<p class="lbp-desc">${why.description}</p>` : null,
    cells,
    hint ? html`<p class="lbp-hint">${hint}</p>` : null,
  ];
}

// The whole panel. `file` is the selected file, or null for an item with no
// file at all; `snap` that file's details snapshot (detailsOf), which the
// file's half waits for (D11).
function Panel({ item, file, snap, onPick, onDetHover }) {
  const instances = item.instances || [];
  return [
    // The item: its name, and when it has several files, the switcher under
    // it, which is the item's own navigation, each file with its download.
    // With one file, its download sits at the end of the name (D9).
    html`<div class="lbp-meta">
      <div class="lbp-meta-name" title=${item.displayLabel}>${item.displayLabel}${instances.length === 1 && ownFile(file)
        ? html`<${Download} f=${file} />` : null}</div>
      ${instances.length >= 2 ? html`<${FileList} key=${item.id} item=${item} file=${file} onPick=${onPick} />` : null}
    </div>`,
    item.identityProvisional
      ? html`<div class="warn-box lbp-provisional-warn">Identity not derived — AI couldn't identify this entity. Re-extract or remove the item.</div>`
      : null,
    // Connector-bound fields: live data, not extraction output.
    hasFields(item.fields) ? html`<${FieldsSection} fields=${item.fields} label="Connector fields" onDetHover=${onDetHover} />` : null,
    hasFields(item.fields) ? html`<hr class="lbp-divider" />` : null,
    // The selected file's reference rows: "file" only for a file of the
    // board's own (D9).
    html`<div class="lbp-meta">
      ${[ownFile(file) && ["file", file.name], ["kind", file?.kind || item.kind || "image"], ["id", String(file?.id ?? item.id)]]
        .filter(Boolean)
        .map(([k, v]) => html`<div key=${k} class="lbp-meta-row"><span>${k}</span><span class="lbp-meta-val">${v}</span></div>`)}
    </div>`,
    !file || snap
      ? html`<${FileHalf} item=${item} file=${file} snap=${snap} onDetHover=${onDetHover} />`
      : html`<p class="lbp-hint">Loading…</p>`,
  ];
}
