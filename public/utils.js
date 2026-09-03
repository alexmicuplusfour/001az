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
// server's aiWork gate (server/field-sources.js — the client can't import it;
// keep the two in step) — the reextract route answers 409 without a stamped
// mapping, so the per-instance Re-extract button shows only here. extract and
// detect are the model-backed sources; connector/file are deterministic.
export const mappingHasAiWork = (mapping) =>
  mapping?.identity?.source === "extract" ||
  (Array.isArray(mapping?.fields) &&
    mapping.fields.some((f) => f.source === "extract" || f.source === "detect"));

// An item has a mapped identity when extraction (or a connector) gave it an
// entity key distinct from its stored filename — mirrors displayLabel priority.
export const hasIdentity = (item) => !!(item.display_name || item.identity !== item.name);

export const tag = (facet, value) => `${facet}/${value}`;

// A server-authored reason, capitalized to start a sentence. The registry
// writes them to follow a label ("Why: no Stocks provider is installed"), which
// is the right case there and the wrong one wherever the string stands on its
// own — a menu sublabel, the head of a banner. One transform, shared by the
// surfaces that stand them alone, so the wire keeps ONE string per reason
// instead of the registry keeping two cases of it.
export const sentence = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

// Plural of an English noun, for labels built from a name the client didn't
// write ("All {filter}s"). Bare +"s" reads fine until the noun ends in y or a
// sibilant — "All categorys", "All industrys" — and the two rules below are
// the whole of what these labels ever hit. Not a general inflector: an
// irregular noun (people, indices) would need its own plural declared beside
// the label, which is the day this stops being one line.
export const plural = (word) => {
  const s = String(word || "");
  if (!s) return ""; // no word, no ending — never a bare "s"
  if (/[^aeiou]y$/i.test(s)) return `${s.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(s)) return `${s}es`;
  return `${s}s`;
};

// ── Icons ───────────────────────────────────────────────────────────────────
// Every glyph in this set is the same object: a 24-unit box, unfilled, drawn in
// one currentColor stroke with round caps and joins. `glyph` is where that
// agreement lives, so an entry below is its paths and nothing else. Written out
// per icon, the attribute block had already drifted — `plus` lost its
// stroke-linejoin, and the copies of it in admin.html and profile.html had
// picked up a stray 2.2 weight.
//
// `stroke` is in the 24-unit box, so it scales with the icon: what the eye gets
// is `stroke × size / 24`, and 2 units is 1.08px at 13px but 1.42px at 17px.
//
// DO NOT try to make that absolute with `vector-effect: non-scaling-stroke`.
// It is the obvious fix — the box size is chosen to normalise a glyph's INK (the
// pencil renders at 15px and the × at 14px because their strokes sit mid-viewBox
// and read small), so having the weight ride along on that decision is genuinely
// accidental. But non-scaling-stroke holds the stroke constant in DEVICE pixels,
// and a phone at devicePixelRatio 3 then draws a 1.25 line as 0.42 CSS px. It
// looks right on a desktop and renders as a hairline on every retina screen —
// which is exactly how it shipped in a31c30a and came back from a phone.
//
// Scaling with the icon is the resolution-independent behaviour and the one to
// keep. If the weights ever want recalibrating, do it in these units, per glyph,
// against the size each one actually renders at.
//
// width/height are a floor, not a preference: every surface sizes its own icons
// in CSS, but one that forgets gets text-sized ink instead of the SVG default
// of 300×150 — which is what the boards page's New board button was doing.
export const glyph = (body, { stroke = 2 } = {}) =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  viewRows: glyph('<rect x="3" y="4" width="18" height="6" rx="1"/><rect x="3" y="14" width="18" height="6" rx="1"/>'),
  tag: glyph('<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2 2 0 0 0 2.8 0l6.6-6.6a2 2 0 0 0 0-2.8z"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/>'),
  trash: glyph('<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m-9 0v14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V6"/>'),
  redo: glyph('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>'),
  // Field-source glyphs (mapping pane) — one per FIELD_SOURCE_DEFS row, plus
  // `srcDot` for an unbound slot. Grey ink = deterministic, violet = a model
  // produces it; the COLOR is the pane's, the shapes live here with the set.
  //
  // srcPerson and srcWave have NO source row yet and no consumer — they are the
  // face- and voice-matching sources the model was designed to accept (one
  // FIELD_SOURCE_DEFS row + one CAPABILITY_DEFS entry each). Drawn now, with
  // the rest of the set, because that is the only way they end up on the same
  // grid and stroke as their neighbours. They are not dead code to sweep.
  srcFile: glyph('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
  srcGlobe: glyph('<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17"/><path d="M12 3.5a13 13 0 0 1 0 17a13 13 0 0 1 0-17z"/>'),
  srcSparkle: glyph('<path d="M12 3.5l1.85 5.15L19 10.5l-5.15 1.85L12 17.5l-1.85-5.15L5 10.5l5.15-1.85z"/>'),
  srcFrame: glyph('<path d="M4 8.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3"/><circle cx="12" cy="12" r="2.6"/>'),
  srcPerson: glyph('<circle cx="12" cy="9.5" r="3.3"/><path d="M5.5 20.5a6.5 6.5 0 0 1 13 0"/>'),
  srcWave: glyph('<path d="M4 10.5v3M8 7.5v9M12 4.5v15M16 7.5v9M20 10.5v3"/>'),
  srcDot: glyph('<circle cx="12" cy="12" r="3.4"/>'),
  // Ingestion source kinds join the set here (sourceGlyph in
  // source-chooser.js): the local folder and an S3 bucket get their own
  // marks; other remote servers (FTP, installed source plugins) ride
  // srcGlobe above.
  srcFolder: glyph('<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'),
  srcCloud: glyph('<path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>'),
  // Fills on the favourite state — the surfaces that do it say `fill:
  // currentColor` in CSS, since each one was already tinting the outline the
  // same colour it wanted inside.
  heart: glyph('<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.7 1-1a5.5 5.5 0 0 0 0-7.8z"/>'),
  crate: glyph('<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>'),
  chevron: glyph('<path d="m6 9 6 6 6-6"/>', { stroke: 2.5 }),
  // The lightbox's prev/next. Sparse like the tick and the cross, and bolder
  // still: these are the only glyphs in the set that sit alone in a 44×66
  // target over a photograph, where they have to survive whatever is behind
  // them. They replace a literal ‹ and › typed into index.html, whose weight
  // came from whichever font happened to load.
  // 2.6 units at the 28px box these render at is the ~3px asked for.
  chevronLeft: glyph('<path d="m15 18-6-6 6-6"/>', { stroke: 2.6 }),
  chevronRight: glyph('<path d="m9 18 6-6-6-6"/>', { stroke: 2.6 }),
  pencil: glyph('<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'),
  // A tick, a cross and a plus are two or three bare strokes with no drawing
  // around them to give them presence, so they carry more than the shared 2.
  // The × in particular: every one of the five places it lands had already
  // overridden 2 upward one at a time, so the glyph holds the 2.5 and only the
  // two chips on black still step up from there.
  check: glyph('<path d="M20 6 9 17l-5-5"/>', { stroke: 3 }),
  x: glyph('<path d="M18 6 6 18M6 6l12 12"/>', { stroke: 2.5 }),
  plus: glyph('<path d="M12 5v14M5 12h14"/>', { stroke: 2.5 }),
  eye: glyph('<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>'),
  eyeOff: glyph('<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>'),
  info: glyph('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>'),
  download: glyph('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  coin: glyph('<ellipse cx="14.813" cy="11.997" rx="6.813" ry="9.997"/><path d="M14.654,2h-4.581c-3.762,0-6.813,4.476-6.813,9.997s3.05,9.997,6.813,9.997h4.739"/><line x1="5.195" y1="5.281" x2="9.46" y2="5.281"/><line x1="3.707" y1="9.587" x2="7.972" y2="9.587"/><line x1="3.659" y1="13.894" x2="7.925" y2="13.894"/><line x1="5.055" y1="18.202" x2="9.321" y2="18.202"/>'),
  activity: glyph('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>'),
  bell: glyph('<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'),
  // 2x2 tiles — "all boards", the boards page (planning/boards-page-plan.md)
  grid: glyph('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>'),
  // Drag handle — the six-dot grip, the one shape that reads as "pick this up"
  // without a label. Filled circles rather than the family's strokes, because a
  // 1.4-radius ring at 14px renders as grey mush; `stroke="none"` per dot so the
  // shared stroke-width can't thicken them into blobs.
  grip: glyph('<g fill="currentColor" stroke="none"><circle cx="9" cy="5" r="1.6"/><circle cx="15" cy="5" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="19" r="1.6"/><circle cx="15" cy="19" r="1.6"/></g>'),
  // AI-derived content (the boards page's custom-mapping chip)
  sparkle: glyph('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M18.5 14.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>'),
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
  // Drawn by hand in Illustrator after two attempts here missed it, and the
  // coordinates are kept ABSOLUTE so the thing that makes it work is legible
  // rather than the sum of relative deltas: both corners sit at y 18.25 and
  // both tips at y 5.25. The pair is level, and the second tick's SHORT arm is
  // the only thing that differs — clipped to 2.7 units against the first's 5.2
  // so it tucks behind the first's long arm instead of colliding with it.
  //
  // That is the move both earlier versions half-had. Offsetting the second tick
  // downward (every icon set's answer) keeps them apart but reads as one big
  // tick trailed by a fragment; sitting them level as identical twins fits only
  // by shrinking both to a smudge. Level corners plus one clipped arm is what
  // buys 13 units of height AND a pair that reads as a pair.
  //
  // `currentColor`, not the `#000000` the export carries: this button styles at
  // `var(--text-dim)` and brightens on hover, and a hard-coded fill ignores both.
  doubleCheck: glyph('<path d="M1.61 13.66 6.77 18.25 14.3 5.25"/><path d="M11.92 16.01 14.61 18.25 22.13 5.25"/>'),

  // ── The member pages (admin.html, profile.html) ─────────────────────────────
  // Everything below was hand-pasted markup in those two pages and the
  // admin-*.js renders — the exact drift this file exists to stop. It had
  // already started: `key` carried its own 2.2, `grid` was a third copy of the
  // entry twenty lines up, and `user` was pasted in two files. The pages now
  // name a glyph and get it from here like every other surface.
  //
  // These render at 16px in the rail and the table rows, which is the small end
  // of the set — 2 units is 1.33px there. They hold at that size because they
  // are drawn wide in the box; nothing here needed a per-glyph bump except the
  // key, below.
  users: glyph('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  user: glyph('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>'),
  database: glyph('<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>'),
  hardDrive: glyph('<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>'),
  // A shell prompt, >_ — the logs tab. Was a <polyline> and a <line>; paths
  // say the same thing and keep every entry here the same kind of object.
  terminal: glyph('<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>'),
  arrowLeft: glyph('<path d="M19 12H5"/><path d="m12 19-7-7 7-7"/>'),
  // A puzzle piece: one rounded shoulder top-right, a tab out of the left edge
  // and one out of the bottom, each a semicircle on a short neck, centred on
  // the edge it leaves. Drawn in Illustrator; the export sat off-centre enough
  // that the left tab's stroke fell outside the viewBox and the rail clipped
  // it, so the coordinates here are the centred ones — ink spans x 2–22 and
  // y 2.5–21.5, and they are absolute so that stays legible.
  //
  // It replaces a chain/link glyph, which was mostly negative space at 16px and
  // read as "external link" in a rail whose last row is a link off the page.
  plugin: glyph('<path d="M22 6.5A4 4 0 0 0 18 2.5H6V7.5H4.5A2.5 2.5 0 0 0 4.5 12.5H6V17.5H11.5V19A2.5 2.5 0 0 0 16.5 19V17.5H22Z"/>'),
  gear: glyph('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  // 12px inside the "1 key" badge — the smallest anything in the set renders,
  // and the busiest glyph in it (bow, shaft and two teeth). 2.2 units is 1.1px
  // there, and it is the weight this shipped with: the bump is per-glyph and
  // earned, like the tick's 3, not the stray attribute it looked like while it
  // sat in admin-plugins.js as a hand-written <svg>.
  key: glyph('<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>', { stroke: 2.2 }),
  // The logs console's own pair: corners with an arrow between them, out for
  // full-page and in for back. Four subpaths each, so the arrowheads keep their
  // round caps instead of joining the corner brackets.
  expand: glyph('<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>'),
  collapse: glyph('<path d="M4 14h6v6"/><path d="M20 10h-6V4"/><path d="m14 10 7-7"/><path d="m10 14-7 7"/>'),
  // Transport pair for the boards table: run the held items now, cancel what is
  // queued. New drawings rather than transfers — these two were the typed ■ and
  // ▸ that the lightbox's arrows already got taken off (beda504), and a
  // character's weight is whichever font wins the race.
  stop: glyph('<rect x="5" y="5" width="14" height="14" rx="2"/>'),
  play: glyph('<path d="M6 4.5 20 12 6 19.5Z"/>'),
};

// An inline icon holder: ICONS[name] in a span the sizing/context rules
// target (.glyph; .ai flips it to the model ink). Unknown names fall back to
// the neutral dot rather than an empty box.
export const glyphEl = (name, ai) => {
  const el = document.createElement("span");
  el.className = "glyph" + (ai ? " ai" : "");
  el.innerHTML = ICONS[name] || ICONS.srcDot;
  return el;
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

// The compact token count for STATIC text ("3.9M", "575.9K", "208") — the
// admin usage cell and the job rows. Not interchangeable with formatTokens
// above: this one rolls up to M and renders small counts exactly, which is
// right for a label and wrong for the odometer.
export const fmtTok = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "K"
  : String(n);

// The in/out pair as one phrase — the app says a token bill this way
// everywhere it says one (admin usage cell, its sparkline hover, job rows).
export const tokPair = (input, output) => `${fmtTok(input)} in / ${fmtTok(output)} out`;

// A byte count — promoted from admin-backups.js when the Storage tab became
// its second caller, growing the two rungs backups never needed: TB (a disk
// can be one; an archive can't) and the truthful bottom end. The old KB floor
// rounded everything up to "1 KB", which was harmless under archives but
// renders an EMPTY store as holding something — 0 is "0 B", exactly.
export const fmtSize = (n) => {
  if (!n) return "0 B";
  if (n >= 2 ** 40) return (n / 2 ** 40).toFixed(1) + " TB";
  if (n >= 2 ** 30) return (n / 2 ** 30).toFixed(1) + " GB";
  if (n >= 2 ** 20) return (n / 2 ** 20).toFixed(1) + " MB";
  if (n >= 1024) return Math.round(n / 1024) + " KB";
  return n + " B";
};

// One stat on a KPI strip: the figure, its name under it, detail on hover.
// Wears .kpi inside a .kpi-row — grown on the Usage tab, promoted (and the
// classes renamed neutral) when Storage became the second wearer.
export function kpi(value, label, title = "") {
  return `<div class="kpi"${title ? ` title="${title}"` : ""}><div class="v">${value}</div><div class="k">${label}</div></div>`;
}

// A dollar amount — promoted from paged-table.js (which re-exports it) when
// the metering chip and the admin usage cell became its third and fourth
// callers. Sub-dollar amounts keep their precision: a board's spend is
// usually cents, and "$0.00" would round a real number into a lie.
export function fmtUsd(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
}

// Stamped spend as the chip/cell phrase. Micros in, prose out — micros stay
// the wire unit. The ≈ is CONDITIONAL and the server decides it: a cost object
// carries the unpriced remainder, so "this figure is incomplete" is a fact we
// are told, not a hedge every figure wears. Hedging a complete number is the
// mirror of the mistake this stage refuses at the other end (no ≈$0.00 out of
// ignorance) — both are the renderer asserting something it wasn't told.
export const fmtCost = (cost) =>
  `${cost.unpriced?.length ? "≈" : ""}${fmtUsd(cost.micros / 1e6)}`;

// A quantity in a unit the server described. Format KINDS come from
// server/units.js and ride the wire beside the label — the client renders
// what it is handed and names no unit itself; a kind it has no formatter for
// degrades to a plain count. Shared by every surface printing a quantity it
// didn't name (the unpriced remainder below, the usage tab's cells).
const UNIT_FORMAT = {
  tokens: fmtTok,
  count: (n) => n.toLocaleString(),
  duration: (n) => fmtDuration(n * 1000), // served in seconds; fmtDuration speaks ms
};
export const fmtQty = (n, format) => (UNIT_FORMAT[format] || UNIT_FORMAT.count)(n);

// A quantity WITH its unit named — "1,200 input tokens", "12h audio". `def` is
// a served vocabulary entry ({ unit, label, format }); every surface that
// prints a unit it didn't name says it this way, so the phrase (and what to
// do when a label is missing) is decided once.
export const fmtUnit = (n, def = {}) => `${fmtQty(n, def.format)} ${def.label ?? def.unit}`;

// A served vocabulary as a lookup by unit id — the shape every renderer wants
// from the `units` array the server ships beside its data.
export const unitDefs = (units = []) => Object.fromEntries(units.map((u) => [u.unit, u]));

// What a cost figure does NOT cover, as a phrase — the per-unit remainder,
// never summed (unpriced tokens plus unpriced searches is a quantity of
// nothing).
export const fmtUnpriced = (unpriced = []) => unpriced.map((u) => fmtUnit(u.quantity, u)).join(", ");

// A duration as one coarse unit ("38s", "12m", "2h", "5d"), every unit
// computed from the raw seconds — re-rounding minutes into hours would call
// 85 minutes "2h". Shared by the countdown chip and every "N ago" stamp.
export function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

// A past timestamp as "N ago". This had been copied, character for character,
// into five modules — each one importing fmtDuration to build it, which is
// how a shared half ends up with five private wholes. One name, so the next
// surface that needs the phrase finds it instead of writing a sixth.
export const relTime = (ts) => `${fmtDuration(Date.now() - ts)} ago`;

function appendCount(el, count) {
  if (count == null) return;
  const c = document.createElement("span");
  c.className = "count";
  c.textContent = count;
  el.appendChild(c);
}

// The toolbar button. `label` is markup: an icon button passes an ICONS glyph,
// a labelled one passes `ICONS.foo + "<span>Text</span>"` — the span is what
// makes the label one flex item, so the button's own 5px gap spaces it from
// the icon. Nothing here sizes the glyph or sets the gap: .tool-btn owns both,
// which is what lets a caller pass any icon and get the same button.
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

