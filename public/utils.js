import { state } from './state.js';

export function isAdmin() {
  return !!(state.me && state.me.is_admin);
}

// One instance = one file with its own tags/status/fields under an entity.
export function toInstance(i) {
  const list = Array.isArray(i.tags) ? i.tags : [];
  return {
    id: i.id,
    name: i.name,          // stored filename — used for URL construction
    label: i.label || null,
    w: i.w || 0,
    h: i.h || 0,
    kind: i.kind || "image",
    status: i.status,
    tags: list,
    tagSet: new Set(list),
    // Detected-object field keys (the server's distilled summary; absent =
    // none) — the `~objects` system facet's per-instance membership, what
    // rows-mode dimming consults.
    objectSet: new Set(i.objects || []),
    undecided: !!i.undecided,
  };
}

export function toItem(d) {
  const list = Array.isArray(d.tags) ? d.tags : [];
  // Display label priority: original-casing AI name > derived identity >
  // original filename > stored filename.
  const identity = d.identity || d.name;
  const displayLabel = d.display_name || (identity !== d.name ? identity : (d.label || d.name));
  return {
    id: d.id,             // entity id — what cards, hearts and crates key on
    name: d.name,         // face file's stored name — used for URL construction
    identity,             // entity's semantic key (derived name or stored filename)
    display_name: d.display_name || null,  // AI's original-casing output
    symbol: d.symbol || null,             // connector entities: short ticker e.g. "BTC"
    displayLabel,         // what to show as the primary human-readable title
    identityProvisional: !!d.identity_provisional,
    status: d.status,     // aggregate across instances (server-computed)
    tags: list,           // union across instances — what filtering consumes
    tagSet: new Set(list),
    // Union of the instances' detected-object keys (server-computed, absent =
    // none) — the `~objects` system facet's entity-level membership.
    objectSet: new Set(d.objects || []),
    undecided: !!d.undecided,
    hearts: d.hearts || 0,
    favoritedByMe: !!d.favoritedByMe,
    crateIds: new Set(Array.isArray(d.crateIds) ? d.crateIds : []),
    uploadedBy: d.uploadedBy || null,
    // String-id membership for the `~uploaders` system facet (selection values
    // are strings — saved configs and the ?f= encoding assume it).
    uploaderIdSet: new Set(d.uploadedBy ? [String(d.uploadedBy.id)] : []),
    w: d.w || 0,
    h: d.h || 0,
    kind: d.kind || "image",
    label: d.label || null,
    fields: d.fields || {},  // connector-bound entity fields (per-instance fields come from the reasoning fetch)
    created_at: d.created_at ?? null,
    updated_at: d.updated_at ?? null,
    media: d.media || null,  // face file's metadata projection ({ fn: value }) — sort keys
    instances: Array.isArray(d.instances) ? d.instances.map(toInstance) : [],
  };
}

// Recompute an entity's union tags after a per-instance tag change.
export function refreshEntityTags(item) {
  const tags = [];
  const seen = new Set();
  for (const inst of item.instances) {
    for (const t of inst.tags) if (!seen.has(t)) { seen.add(t); tags.push(t); }
  }
  item.tags = tags;
  item.tagSet = new Set(tags);
  item.undecided = item.instances.length > 0 && item.instances.every((i) => i.undecided);
}

// How many instances carry each tag. The grid tag pop annotates the entity's
// union with these when there's more than one instance, so a "pick one" facet
// holding three values reads as a distribution across photos, not a
// contradiction (see planning/instance-rows-plan.md).
export function instanceTagCounts(item) {
  const counts = new Map();
  for (const inst of item.instances) {
    for (const t of inst.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return counts;
}

// Does the board's mapping give the extract leg AI work to do? Mirrors the
// worker's aiWork gate (extractOne) — the reextract route answers 409 without
// a stamped mapping, so the per-instance Re-extract button shows only here.
export const mappingHasAiWork = (mapping) =>
  mapping?.identity?.from === "ai" ||
  (Array.isArray(mapping?.fields) && mapping.fields.some((f) => f.from === "ai"));

// An item has a mapped identity when extraction (or a connector) gave it an
// entity key distinct from its stored filename — mirrors displayLabel priority.
export const hasIdentity = (item) => !!(item.display_name || item.identity !== item.name);

export const tag = (facet, value) => `${facet}/${value}`;

export const ICONS = {
  viewRows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/></svg>',
  tag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2 2 0 0 0 2.8 0l6.6-6.6a2 2 0 0 0 0-2.8z"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="var(--hf, none)" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.7 1-1a5.5 5.5 0 0 0 0-7.8z"/></svg>',
  crate: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
  eyeOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="14.813" cy="11.997" rx="6.813" ry="9.997"/><path d="M14.654,2h-4.581c-3.762,0-6.813,4.476-6.813,9.997s3.05,9.997,6.813,9.997h4.739"/><line x1="5.195" y1="5.281" x2="9.46" y2="5.281"/><line x1="3.707" y1="9.587" x2="7.972" y2="9.587"/><line x1="3.659" y1="13.894" x2="7.925" y2="13.894"/><line x1="5.055" y1="18.202" x2="9.321" y2="18.202"/></svg>',
  activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
  // 2x2 tiles — "all boards", the boards page (planning/boards-page-plan.md)
  grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  // AI-derived content (the boards page's custom-mapping chip)
  sparkle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/></svg>',
  // Tagging consistency — two ticks, the second offset up-right. It draws the
  // name of the switch that produces the data it reads: "Double-check tags".
  // Its own glyph rather than `sparkle`, which is the boards page's AI-fields
  // chip and would mean two things one click apart; `activity` is the jobs
  // ledger, and `viewRows` is two bars — which is why a bar chart was ruled out
  // for something sitting in the same header.
  //
  // It replaces a dial whose ink spanned y 7.5–17.4 of the 24 box: at the 15px
  // every icon button here renders at, that is half the ink of the pencil
  // beside it, and it read as a smudge in an empty square. Sizing is per-glyph
  // in this set, so reaching the edges of the viewBox is the glyph's own job.
  //
  // The two ticks are IDENTICAL and share a baseline — same corner y, same tip
  // y, same arm lengths — rather than the offset pair every icon set draws. The
  // offset is not decoration: two 45° ticks large enough to fill this box
  // overlap, and the only way to keep both legible is to slide the second one
  // down and clip its short arm, which is what made the first attempt read as
  // one big tick trailed by a small crooked one. Sitting them level costs
  // height (9.5 units where the offset pair got 15) and buys it back in ink,
  // since this is four strokes across the full width rather than two. The arms
  // are steeper than the 45° of `check` for the same reason — that is the price
  // of two ticks abreast in 20 units with a gap you can still see at 15px.
  doubleCheck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13 4.5 16.5 10 7"/><path d="M14 13 16.5 16.5 22 7"/></svg>',
};

// Corner presence dot for any button — sits centered on the top-right
// corner, half in and half out. Reusable: the class pair does the placement,
// this just wires it on.
export function attachBtnDot(btn) {
  btn.classList.add("has-dot");
  const dot = document.createElement("span");
  dot.className = "btn-dot";
  btn.appendChild(dot);
  return dot;
}

export function actionBtn(icon, cls, title, onClick) {
  const b = document.createElement("button");
  b.className = "act " + cls;
  b.title = title;
  b.innerHTML = ICONS[icon];
  b.addEventListener("click", (e) => { e.stopPropagation(); onClick(); });
  return b;
}

// Always render in whole thousands ("525k", "1,247k") — never rolling up to
// "M". A single tagging pass moves the count by a few thousand tokens, so the
// last digit has to live at the 1k level for the live odometer to visibly tick.
export function formatTokens(n) {
  return `${Math.round(n / 1000).toLocaleString()}k`;
}

// A duration as one coarse unit ("38s", "12m", "2h", "5d"), every unit
// computed from the raw seconds — re-rounding minutes into hours would call
// 85 minutes "2h". Shared by the countdown chip and both "N ago" stamps.
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function appendCount(el, count) {
  if (count == null) return;
  const c = document.createElement("span");
  c.className = "count";
  c.textContent = count;
  el.appendChild(c);
}

export function toolBtn(label, cls, onClick, count) {
  const b = document.createElement("button");
  b.className = "tool-btn" + (cls ? " " + cls : "");
  b.innerHTML = label;
  appendCount(b, count);
  if (onClick) b.addEventListener("click", onClick);
  return b;
}

export function pill(label, count, active, muted, onClick) {
  const b = document.createElement("button");
  b.className = "pill" + (active ? " active" : "") + (muted ? " muted" : "");
  b.textContent = label;
  appendCount(b, count);
  b.addEventListener("click", onClick);
  return b;
}

