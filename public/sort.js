// sort.js — attribute sorting for the board view. The menu's entries are
// assembled from the board's attribute catalogs, decided by the mapping's
// identity source (see planning/board-sorting-plan.md):
//
// - null (no identity source, or no mapping): universal + media-catalog fields
//   for the file kinds present on the board (entity:instance is 1:1, so a
//   file's metadata IS the entity's — no aggregation question).
// - connector: universal + the mapping's bound connector fields — exactly the
//   keys whose values exist in entities.fields, so the menu can never offer a
//   sort without data behind it.
// - extract (derived identity): universal only, by decision — name, dates,
//   hearts, file count. Media attributes are per-instance there and would need
//   an aggregation policy we've declined to invent.
//
// One sort at a time; state.sort === null is the server default (newest
// first). Missing values sort last in either direction, in their incoming
// (newest-first) order — same semantics as ingestion's applySort.
import { state } from './state.js';

// Universal entries — attributes every entity carries regardless of source.
const UNIVERSAL = [
  { by: "name", label: "Name", kind: "text" },
  { by: "created", label: "Date added", kind: "date" },
  { by: "updated", label: "Date updated", kind: "date" },
  { by: "hearts", label: "Hearts", kind: "number" },
];
// Files per identity — meaningful only on derived boards (raw and connector
// entities always have exactly one instance).
const INSTANCES_ENTRY = { by: "instances", label: "Files", kind: "number" };

// The identity slot's source: "extract" | "connector" | null (null = the
// filename default — the slot carries no config).
const identityFrom = () => state.boardMapping?.identity?.source || null;

// Static per-session catalogs, fetched lazily on first menu open. A failed or
// empty response isn't cached — a boot-time network blip shouldn't degrade the
// menu for the whole session.
const catalogCache = new Map();
const fetchJson = (url) =>
  fetch(url, { cache: "no-store" }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
function catalog(url) {
  if (!catalogCache.has(url)) {
    catalogCache.set(url, fetchJson(url).then((r) => {
      if (!Array.isArray(r) || !r.length) catalogCache.delete(url);
      return Array.isArray(r) ? r : [];
    }));
  }
  return catalogCache.get(url);
}
const mediaFields = () => catalog("/api/file-fields");
const connectorList = () => catalog("/api/connectors");

const kindMatches = (appliesTo, kind) =>
  appliesTo === "*" || appliesTo === kind || (Array.isArray(appliesTo) && appliesTo.includes(kind));

// File kinds present on the board — from the instances already in hand, so it
// stays correct as the background drain lands.
function kindsPresent() {
  const kinds = new Set();
  for (const img of state.items)
    for (const inst of img.instances) if (inst.kind !== "connector") kinds.add(inst.kind);
  return kinds;
}

// The sectioned menu: [{ label, entries: [{ by, label, kind, count? }] }].
// Async only for the catalog fetches (cached after the first call).
export async function sortCatalog() {
  const from = identityFrom();
  const universal = from === "extract" ? [...UNIVERSAL, INSTANCES_ENTRY] : [...UNIVERSAL];
  const sections = [{ label: "Board", entries: universal }];

  if (from === "connector") {
    const bound = (state.boardMapping?.fields || []).filter(
      (f) => f.source === "connector" && f.kind !== "url"
    );
    if (bound.length) {
      const mod = (await connectorList()).find(
        (c) => c.name === state.boardMapping?.input?.connector
      );
      const catalog = mod?.fields || [];
      sections.push({
        label: mod?.label || "Connector",
        entries: bound.map((f) => ({
          by: `field:${f.key}`,
          label: catalog.find((c) => c.fn === f.fn)?.label || f.key,
          kind: f.kind || "number",
        })),
      });
    }
    return sections;
  }

  if (from === "extract") return sections;

  // Raw board: media sections for the kinds present. `added` duplicates the
  // universal Date added (entity created_at IS the upload moment on raw
  // boards); url-kind fields aren't orderable.
  const kinds = kindsPresent();
  if (!kinds.size) return sections;
  const mixed = kinds.size > 1;
  const bySection = new Map();
  for (const d of await mediaFields()) {
    if (d.fn === "added" || d.kind === "url") continue;
    if (d.appliesTo !== "*" && ![...kinds].some((k) => kindMatches(d.appliesTo, k))) continue;
    if (!bySection.has(d.group)) bySection.set(d.group, { appliesTo: d.appliesTo, entries: [] });
    bySection.get(d.group).entries.push({ by: `media:${d.fn}`, label: d.label, kind: d.kind });
  }
  for (const [label, { appliesTo, entries }] of bySection) {
    // On a mixed board, a kind-scoped section header carries how many entities
    // it covers — a partial sort should read as intentional, not broken.
    const count =
      mixed && appliesTo !== "*"
        ? state.items.filter((img) => kindMatches(appliesTo, img.kind)).length
        : null;
    sections.push({ label, count, entries });
  }
  return sections;
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

// A stored `by` must still make sense for the board's current identity mode —
// a mapping edit can strand one (e.g. a connector rebind dropping a field).
// Media fns aren't checked against the catalog (that fetch is lazy); a stale
// fn yields all-null values, which is just the default order.
function validSort(s) {
  if (!s || typeof s.by !== "string" || !["asc", "desc"].includes(s.dir)) return false;
  const from = identityFrom();
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
  if (identityFrom() !== "connector") return;
  connectorList().then((mods) => {
    if (state.sort) return; // the user beat the fetch
    const mod = mods.find((c) => c.name === state.boardMapping?.input?.connector);
    const key = mod?.browse?.defaultSort;
    const bound = key
      ? (state.boardMapping?.fields || []).find(
          (f) => f.source === "connector" && f.key === key && f.kind !== "url"
        )
      : null;
    if (!bound) return;
    const label = (mod.fields || []).find((c) => c.fn === bound.fn)?.label || key;
    state.sort = { by: `field:${key}`, dir: defaultDir(bound.kind), label };
    document.dispatchEvent(new Event("app:render"));
  });
}
