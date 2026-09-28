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
// One sort at a time; state.sort === null is the server default (newest
// first). Missing values sort last in either direction, in their incoming
// (newest-first) order — same semantics as ingestion's applySort.
//
// The same catalog is List's columns (planning/list-view-plan.md, D3): each
// entry carries how its value prints (`format`, from the descriptor), and
// columnCatalog() below is every column the board can show.
import { state } from './state.js';
import { signal } from './vendor/signals.mjs';

// Universal entries — attributes every entity carries regardless of source.
const UNIVERSAL = [
  { by: "name", label: "Name", kind: "text" },
  { by: "created", label: "Date added", kind: "date" },
  { by: "updated", label: "Date updated", kind: "date" },
  { by: "hearts", label: "Hearts", kind: "number" },
];
// Files per card — meaningful only on card-key boards (per-file and connector
// entities always have exactly one instance).
const INSTANCES_ENTRY = { by: "instances", label: "Files", kind: "number" };

// The board's card mode: "extract" (a card key names an extract field) |
// "connector" (an input — the connector's entries are the cards) | null (one
// card per file — neither slot carries config).
const cardMode = () => {
  const m = state.boardMapping;
  return m?.card?.by ? "extract" : m?.input?.connector ? "connector" : null;
};

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
export const loadCatalogs = () => (cardMode() === "connector" ? connectorList() : mediaFields());

// The bound connector fields a sort or a column can use: url fields aren't
// orderable. In the mapping's order.
const boundFields = () =>
  (state.boardMapping?.fields || []).filter((f) => f.source === "connector" && f.kind !== "url");
const boardConnector = (mods) => mods?.find((c) => c.name === state.boardMapping?.input?.connector) || null;

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
// stays correct as the background drain lands.
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
  return cardMode() === "extract" ? [...UNIVERSAL, INSTANCES_ENTRY] : [...UNIVERSAL];
}

// The sectioned menu: [{ label, count?, entries: [{ by, label, kind, format }] }].
// Async only for the catalog fetches (cached after the first call). A raw
// board's file sections are for the kinds among its items so far; an entry in
// `keep` shows regardless (List's Columns menu keeps a shown column, whose
// items may not have loaded yet).
export async function sortCatalog({ keep = new Set() } = {}) {
  const from = cardMode();
  const sections = [{ label: "Board", entries: boardEntries() }];

  if (from === "connector") {
    const bound = boundFields();
    if (bound.length) {
      const mod = boardConnector(await connectorList());
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
// by the file kinds loaded so far (D6): a board loads its newest 200 items
// first. The same array until one of those changes, so a row's props compare.
let columnsMemo = null;
export function columnCatalog() {
  const v = catalogsLanded.value; // a draw that reads this redraws on a landing
  const mapping = state.boardMapping;
  if (columnsMemo?.v === v && columnsMemo.mapping === mapping) return columnsMemo.entries;
  const from = cardMode();
  const entries = boardEntries()
    .filter((e) => e.by !== "name" && e.by !== "hearts")
    .map((e) => ({ ...e, byDefault: e.by === "created" || e.by === "instances" }));
  if (from === "connector") {
    const mod = boardConnector(landed.get("/api/connectors"));
    if (mod) entries.push(...boundFields().map((f) => fieldEntry(f, mod)));
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
  if (f?.source === "connector") return boardConnector(landed.get("/api/connectors"))?.fields?.find((c) => c.fn === f.fn)?.format;
  if (f?.source === "file") return landed.get("/api/file-fields")?.find((d) => d.fn === f.fn)?.format;
  return undefined;
}

// The value an entity presents for a sort key; null/undefined = sorts last.
export function sortValue(item, by) {
  if (by === "name") return item.displayLabel || "";
  if (by === "created") return item.created_at;
  if (by === "updated") return item.updated_at;
  if (by === "hearts") return item.hearts || 0;
  if (by === "instances") return item.instances.length;
  if (by.startsWith("media:")) return item.media?.[by.slice(6)] ?? null;
  if (by.startsWith("field:")) return item.fields?.[by.slice(6)]?.v ?? null;
  return null;
}

export const defaultDir = (kind) => (kind === "text" ? "asc" : "desc");

// The one sort rule, for both controls that set a sort (the toolbar's menu and
// List's column headers): picking the sort in effect again flips it, and a new
// pick takes its kind's natural direction.
export function nextSort(entry, current = state.sort) {
  const again = current?.by === entry.by;
  return { by: entry.by, dir: again ? (current.dir === "asc" ? "desc" : "asc") : defaultDir(entry.kind), label: entry.label };
}

export function setSort(sort) {
  state.sort = sort;
  saveSort();
}

// The sort in effect, as List's headers show it (planning/list-view-plan.md,
// Stage 2). No sort chosen is the server's order, which is Date added, newest
// first (db.js orders by created_at DESC); a header that didn't say so would
// take a first click that changes nothing. While a search is on, its relevance
// order is in effect, and no column is sorted.
const NEWEST = { ...UNIVERSAL.find((u) => u.by === "created"), dir: "desc" };
export function shownSort() {
  if (state.searchResults) return null;
  return state.sort || NEWEST;
}

// In-place stable sort of the filtered list. Nulls last regardless of
// direction; ties and the null tail keep their incoming newest-first order.
// No catalog lookup at compare time: numbers compare numerically, everything
// else as strings (media dates are ISO "YYYY-MM-DD" — lexicographic is
// chronological).
export function applyBoardSort(list) {
  const s = state.sort;
  if (!s || !s.by) return list;
  const dir = s.dir === "asc" ? 1 : -1;
  list.sort((a, b) => {
    const av = sortValue(a, s.by);
    const bv = sortValue(b, s.by);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") return dir * (av - bv);
    return dir * String(av).localeCompare(String(bv));
  });
  return list;
}

// --- persistence: per viewer, per board (the lastBoard pattern) ---

const storeKey = () => `boardSort:${state.boardId}`;

export function saveSort() {
  try {
    if (state.sort) localStorage.setItem(storeKey(), JSON.stringify(state.sort));
    else localStorage.removeItem(storeKey());
  } catch { /* private mode / quota — sort just won't stick */ }
}

// A stored `by` must still make sense for the board's current card mode —
// a mapping edit can strand one (e.g. a connector rebind dropping a field).
// Media fns aren't checked against the catalog (that fetch is lazy); a stale
// fn yields all-null values, which is just the default order.
function validSort(s) {
  if (!s || typeof s.by !== "string" || !["asc", "desc"].includes(s.dir)) return false;
  const from = cardMode();
  if (UNIVERSAL.some((u) => u.by === s.by)) return true;
  if (s.by === "instances") return from === "extract";
  if (s.by.startsWith("media:")) return from === null;
  if (s.by.startsWith("field:")) {
    const key = s.by.slice(6);
    return (
      from === "connector" &&
      (state.boardMapping?.fields || []).some((f) => f.source === "connector" && f.key === key)
    );
  }
  return false;
}

// Restore the viewer's sort for this board; with nothing stored, a connector
// board seeds from its manifest's browse defaultSort (a crypto board opens by
// market cap, not upload order) — async, renders when it lands.
export function restoreSort() {
  let stored = null;
  try {
    stored = JSON.parse(localStorage.getItem(storeKey()) || "null");
  } catch { /* corrupted entry — fall through to default */ }
  if (stored && validSort(stored)) {
    state.sort = stored;
    return;
  }
  state.sort = null;
  if (cardMode() !== "connector") return;
  connectorList().then((mods) => {
    if (state.sort) return; // the user beat the fetch
    const mod = boardConnector(mods);
    const key = mod?.browse?.defaultSort;
    const bound = key ? boundFields().find((f) => f.key === key) : null;
    if (!bound) return;
    const label = (mod.fields || []).find((c) => c.fn === bound.fn)?.label || key;
    state.sort = { by: `field:${key}`, dir: defaultDir(bound.kind), label };
  });
}
