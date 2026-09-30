// sort.js — attribute sorting for the board view. The menu's entries are
// assembled from the board's attribute catalogs, decided by what one card IS
// on the board — the mapping's card mode (planning/board-sorting-plan.md
// wrote this up as the "identity source"; card-key-plan.md renamed it):
//
// - null (one card per file, or no mapping): universal + media-catalog fields
//   for the file kinds present on the board (entity:instance is 1:1, so a
//   file's metadata IS the entity's — no aggregation question).
// - connector (one card per connector entry): universal + the mapping's bound
//   connector fields — exactly the keys whose values exist in entities.fields,
//   so the menu can never offer a sort without data behind it.
// - extract (one card per extracted value — `mapping.card.by`): universal
//   only, by decision — name, dates, hearts, file count. Media attributes are
//   per-instance there and would need an aggregation policy we've declined
//   to invent.
//
// One sort at a time; state.sort === null is Date added, newest first. The
// order itself (empty values last, numbers before text, ties newest first
// then by id) is sort-core.js's, the one rule the server shares
// (planning/sorted-loading-plan.md). Ingestion's applySort is a different
// rule for a different job (which feed entries a run takes in) and is not
// this one.
//
// The same catalog is List's columns (planning/list-view-plan.md, D3): each
// entry carries how its value prints (`format`, from the descriptor), and
// columnCatalog() below is every column the board can show.
import { state } from './state.js';
import { signal } from './vendor/signals.mjs';
import { resortLoading } from './data.js';
import {
  UNIVERSAL, INSTANCES_ENTRY, NEWEST, cardMode, boundFields, boardConnector, settleSort, adoptSort, defaultDir, compareItems,
} from './sort-core.js';

// Static per-session catalogs, fetched once: the board loads the one its
// fields come from (loadCatalogs), and the sort menu asks for either. A failed
// or empty response isn't cached — a boot-time network blip shouldn't degrade
// the menu for the whole session.
//
// What has landed is kept for the readers that can't wait for a fetch (List's
// draw, the lightbox's first paint), with a signal the page redraws on when a
// catalog lands: app.js draws in an effect over what it reads.
const catalogCache = new Map();
const landed = new Map();
const catalogsLanded = signal(0);
const fetchJson = (url) =>
  fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
function catalog(url) {
  if (!catalogCache.has(url)) {
    catalogCache.set(url, fetchJson(url).then((r) => {
      const list = Array.isArray(r) ? r : [];
      if (!list.length) catalogCache.delete(url);
      else {
        landed.set(url, list);
        catalogsLanded.value++;
      }
      return list;
    }));
  }
  return catalogCache.get(url);
}
const mediaFields = () => catalog("/api/file-fields");
const connectorList = () => catalog("/api/connectors");

// The catalog a board's fields come from: the domain's manifest on a connector
// board, the file fields on any other (a card-key board's file fields print by
// it in the lightbox).
export const loadCatalogs = () => (cardMode(state.boardMapping) === "connector" ? connectorList() : mediaFields());

// Entries from the two catalogs, one way for the sort menu and List alike. A
// connector field is named and formatted by its domain's manifest (by fn), and
// starts shown in List when the domain previews it (its browse columns marked
// `preview`: the domain's headline numbers, D5). A file field by its media
// descriptor.
function fieldEntry(f, mod) {
  const c = mod?.fields?.find((x) => x.fn === f.fn);
  return {
    by: `field:${f.key}`, label: c?.label || f.key, kind: f.kind || "number", format: c?.format,
    byDefault: !!mod?.browse?.columns?.some((col) => col.key === f.fn && col.preview),
  };
}
const mediaEntry = (d) => ({ by: `media:${d.fn}`, label: d.label, kind: d.kind, format: d.format });
// `added` duplicates the universal Date added (entity created_at IS the upload
// moment on raw boards); url-kind fields aren't orderable.
const orderableMedia = (d) => d.fn !== "added" && d.kind !== "url";

const kindMatches = (appliesTo, kind) =>
  appliesTo === "*" || appliesTo === kind || (Array.isArray(appliesTo) && appliesTo.includes(kind));

// File kinds present on the board — from the instances already in hand, so it
// stays correct as the background load lands.
function kindsPresent() {
  const kinds = new Set();
  for (const item of state.items)
    for (const inst of item.instances) if (inst.kind !== "connector") kinds.add(inst.kind);
  return kinds;
}

// The Board section's entries, which need no catalog fetch: the universal
// ones, plus Files on card-key boards. List's fixed columns sort by these
// (planning/list-view-plan.md, Stage 2).
export function boardEntries() {
  return cardMode(state.boardMapping) === "extract" ? [...UNIVERSAL, INSTANCES_ENTRY] : [...UNIVERSAL];
}

// The sectioned menu: [{ label, count?, entries: [{ by, label, kind, format }] }].
// Async only for the catalog fetches (cached after the first call). A raw
// board's file sections are for the kinds among its items so far; an entry in
// `keep` shows regardless (List's Columns menu keeps a shown column, whose
// items may not have loaded yet).
export async function sortCatalog({ keep = new Set() } = {}) {
  const from = cardMode(state.boardMapping);
  const sections = [{ label: "Board", entries: boardEntries() }];

  if (from === "connector") {
    const bound = boundFields(state.boardMapping);
    if (bound.length) {
      const mod = boardConnector(state.boardMapping, await connectorList());
      sections.push({ label: mod?.label || "Connector", entries: bound.map((f) => fieldEntry(f, mod)) });
    }
    return sections;
  }

  if (from === "extract") return sections;

  // Raw board: media sections for the kinds present.
  const kinds = kindsPresent();
  const mixed = kinds.size > 1;
  const bySection = new Map();
  for (const d of await mediaFields()) {
    if (!orderableMedia(d)) continue;
    const present = d.appliesTo === "*" ? kinds.size > 0 : [...kinds].some((k) => kindMatches(d.appliesTo, k));
    if (!present && !keep.has(`media:${d.fn}`)) continue;
    if (!bySection.has(d.group)) bySection.set(d.group, { appliesTo: d.appliesTo, entries: [] });
    bySection.get(d.group).entries.push(mediaEntry(d));
  }
  for (const [label, { appliesTo, entries }] of bySection) {
    // On a mixed board, a kind-scoped section header carries how many entities
    // it covers — a partial sort should read as intentional, not broken.
    const count =
      mixed && appliesTo !== "*"
        ? state.items.filter((item) => kindMatches(appliesTo, item.kind)).length
        : null;
    sections.push({ label, count, entries });
  }
  return sections;
}

// Every column List can show on this board, in catalog order: the Board
// section's (the name and the hearts are the table's own), then a connector
// board's bound fields or a raw board's file fields, each marked `byDefault`
// when the board starts with it (D5: Date added, Files on a card-key board,
// the fields a domain previews). Read from the catalogs that have landed: a
// catalog still on its way shows nothing of its section yet, and the page
// redraws when it lands. Decided by the card mode and the catalog alone, never
// by the file kinds loaded so far (D6): a board loads its first 200 items
// first. The same array until one of those changes, so a row's props compare.
let columnsMemo = null;
export function columnCatalog() {
  const v = catalogsLanded.value; // a draw that reads this redraws on a landing
  const mapping = state.boardMapping;
  if (columnsMemo?.v === v && columnsMemo.mapping === mapping) return columnsMemo.entries;
  const from = cardMode(state.boardMapping);
  const entries = boardEntries()
    .filter((e) => e.by !== "name" && e.by !== "hearts")
    .map((e) => ({ ...e, byDefault: e.by === "created" || e.by === "instances" }));
  if (from === "connector") {
    const mod = boardConnector(state.boardMapping, landed.get("/api/connectors"));
    if (mod) entries.push(...boundFields(state.boardMapping).map((f) => fieldEntry(f, mod)));
  } else if (from === null) {
    entries.push(...(landed.get("/api/file-fields") || []).filter(orderableMedia).map(mediaEntry));
  }
  columnsMemo = { v, mapping, entries };
  return entries;
}

// How a board field's value prints, for the lightbox (D4): the format its
// descriptor declares, looked up through the mapping by the field's key. A
// connector field's from the domain's manifest, a file field's from the media
// catalog; an AI field has none. Undefined until the catalog has landed.
export function fieldFormat(key) {
  void catalogsLanded.value;
  const f = state.boardMapping?.fields?.find((x) => x.key === key);
  if (f?.source === "connector") return boardConnector(state.boardMapping, landed.get("/api/connectors"))?.fields?.find((c) => c.fn === f.fn)?.format;
  if (f?.source === "file") return landed.get("/api/file-fields")?.find((d) => d.fn === f.fn)?.format;
  return undefined;
}

// The one sort rule, for both controls that set a sort (the toolbar's menu and
// List's column headers): picking the sort in effect again flips it, and a new
// pick takes its kind's natural direction.
export function nextSort(entry, current = state.sort) {
  const again = current?.by === entry.by;
  return { by: entry.by, dir: again ? (current.dir === "asc" ? "desc" : "asc") : defaultDir(entry.kind), label: entry.label };
}

// The one door the sort changes through (planning/sorted-loading-plan.md,
// D10): at once with the whole board here. While it's still loading, the
// keys hold only the old sort's values, so the new sort waits for its own
// first page and keys (data.js resortLoading), with the old order on screen
// until then. The same order again (Newest first and Date added ↓ are one)
// takes effect at once too: the queue is already in it. Resolves true once
// the sort is in effect.
function useSort(sort) {
  const next = sort || NEWEST, was = state.sort || NEWEST;
  if (!state.unloaded.length || (next.by === was.by && next.dir === was.dir)) {
    state.sort = sort;
    return Promise.resolve(true);
  }
  return resortLoading(sort);
}

// The viewer's pick, from the menu or List's headers: in effect, then saved.
export async function setSort(sort) {
  const ok = await useSort(sort);
  if (ok) saveSort();
  return ok;
}

// The sort in effect, as List's headers show it (planning/list-view-plan.md,
// Stage 2). No sort chosen is Date added, newest first (sort-core.js NEWEST):
// applyBoardSort sorts by it. A header that didn't say so would take a first
// click that changes nothing. While a search is on, its relevance order is in
// effect, and no column is sorted.
export function shownSort() {
  if (state.searchResults) return null;
  return state.sort || NEWEST;
}

// In-place sort of the filtered list by the sort in effect, never by the
// order the items arrived in (planning/sorted-loading-plan.md, Stage 1): a
// card the poll brings back that the background load hasn't reached lands at
// the front of state.items, and belongs wherever its date puts it. No catalog
// lookup at compare time (sort-core.js): media dates are ISO "YYYY-MM-DD", so
// comparing them as text is chronological.
export function applyBoardSort(list) {
  return list.sort(compareItems(state.sort || NEWEST));
}

// --- persistence: per viewer, per board (the lastBoard pattern) ---

const storeKey = () => `boardSort:${state.boardId}`;

export function saveSort() {
  try {
    if (state.sort) localStorage.setItem(storeKey(), JSON.stringify(state.sort));
    else localStorage.removeItem(storeKey());
  } catch { /* private mode / quota — sort just won't stick */ }
}

// The viewer's saved pick for this board, as saved. Boot sends it with its
// first request, and the server settles it against the board (D6).
export function storedSort() {
  try {
    return JSON.parse(localStorage.getItem(storeKey()) || "null");
  } catch {
    return null; // private mode, or a corrupted entry
  }
}

// After a mapping save (toolbar.js): the sort may no longer fit the board (a
// connector rebind can drop its field), so it's settled again the way the
// server settles it at load: the saved pick if it still fits, else the
// connector's default (a crypto board opens by market cap), else newest
// first. Through the door, so a new sort during the load gets its own keys.
export async function restoreSort() {
  const was = state.sort;
  const pick = storedSort();
  const mods = cardMode(state.boardMapping) === "connector" ? await connectorList() : [];
  if (state.sort !== was) return; // the viewer picked while the manifests came in
  const next = adoptSort(pick, settleSort(pick, state.boardMapping, mods));
  if (next?.by !== was?.by || next?.dir !== was?.dir) await useSort(next);
}
