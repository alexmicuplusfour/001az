// sort-core.js — the board's one sort order (planning/sorted-loading-plan.md,
// D4). Pure: no state, no fetch, no storage, so the server can import it the
// way it imports facet-match.js and cluster-core.js, and both ends order a
// board the same way. With it, what both ends need to agree on which sort a
// board opens on (D6): the built-in entries, the card mode, the Name rule,
// whether a saved sort fits, and the connector's default. And a card's key,
// its place in a sort, which the page loads the board by (D3).
//
// The rule:
// - Empty values (null, undefined) go last, in either direction.
// - Numbers come before text, in either direction. Numbers compare by value,
//   text by the collator (the viewer's language). One field can hold both:
//   connector values arrive as the provider sent them, plugins included.
// - Ties go by date added, newest first, then by id, never by the order the
//   items happened to arrive in. The server's own order ends the same way
//   (created_at DESC, id DESC).
// - A card with no date added yet counts as newest: a card added from
//   connector browse has none until the next poll brings it, and it is the
//   newest card.

// The built-in sort entries: attributes every entity carries, whatever its
// source.
export const UNIVERSAL = [
  { by: "name", label: "Name", kind: "text" },
  { by: "created", label: "Date added", kind: "date" },
  { by: "updated", label: "Date updated", kind: "date" },
  { by: "hearts", label: "Hearts", kind: "number" },
];
// Files per card — meaningful only on card-key boards (per-file and connector
// entities always have exactly one instance).
export const INSTANCES_ENTRY = { by: "instances", label: "Files", kind: "number" };

// The board's card mode: "extract" (a card key names an extract field) |
// "connector" (an input — the connector's entries are the cards) | null (one
// card per file — neither slot carries config).
export const cardMode = (mapping) =>
  mapping?.card?.by ? "extract" : mapping?.input?.connector ? "connector" : null;

// A new sort's direction: text A to Z, everything else biggest first.
export const defaultDir = (kind) => (kind === "text" ? "asc" : "desc");

// No sort chosen: Date added, newest first.
export const NEWEST = { ...UNIVERSAL.find((u) => u.by === "created"), dir: "desc" };

// A card's name: the AI's original casing, else a derived identity, else the
// file's original name, else its stored name. `d` is a listing row
// (display_name, identity, name, label): toItem names every card with it, and
// the server sorts by Name with it.
export function labelOf(d) {
  const identity = d.identity || d.name;
  return d.display_name || (identity !== d.name ? identity : (d.label || d.name));
}

// The bound connector fields a sort or a column can use (url fields aren't
// orderable), in the mapping's order; and the board's connector among the
// manifests.
export const boundFields = (mapping) =>
  (mapping?.fields || []).filter((f) => f.source === "connector" && f.kind !== "url");
export const boardConnector = (mapping, connectors) =>
  connectors?.find((c) => c.name === mapping?.input?.connector) || null;

// A saved sort must still make sense for the board's card mode — a mapping
// edit can strand one (e.g. a connector rebind dropping a field). Media fns
// aren't checked against the catalog; a stale fn yields all-empty values,
// which is just newest first.
function validSort(s, mapping) {
  if (!s || typeof s.by !== "string" || !["asc", "desc"].includes(s.dir)) return false;
  const from = cardMode(mapping);
  if (UNIVERSAL.some((u) => u.by === s.by)) return true;
  if (s.by === "instances") return from === "extract";
  if (s.by.startsWith("media:")) return from === null;
  if (s.by.startsWith("field:")) {
    const key = s.by.slice(6);
    return from === "connector" && (mapping?.fields || []).some((f) => f.source === "connector" && f.key === key);
  }
  return false;
}

// A connector board's own opening sort: its manifest's browse.defaultSort (a
// crypto board opens by market cap), when the mapping binds that field. The
// manifest names the field (fn); the board sorts by its mapping key for it.
export function connectorDefault(mapping, connectors) {
  if (cardMode(mapping) !== "connector") return null;
  const mod = boardConnector(mapping, connectors);
  const fn = mod?.browse?.defaultSort;
  const bound = fn ? boundFields(mapping).find((f) => f.fn === fn) : null;
  if (!bound) return null;
  const label = (mod.fields || []).find((c) => c.fn === fn)?.label || bound.key;
  return { by: `field:${bound.key}`, dir: defaultDir(bound.kind), label };
}

// The sort a board opens on (planning/sorted-loading-plan.md, D6): the
// viewer's saved pick if it still fits, else the connector's default, else
// null — newest first. A pick comes back as { by, dir }: its label is the
// viewer's own, already in hand; the default carries its manifest label.
export function settleSort(pick, mapping, connectors) {
  if (validSort(pick, mapping)) return { by: pick.by, dir: pick.dir };
  return connectorDefault(mapping, connectors);
}

// The sort the page takes up from a settled one (D6). `asked` is what the
// page asked for: a pick, which carries its label, or null, newest first.
// `applied` is what was settled: the pick, as { by, dir }, when it still fits;
// else the connector's default, which carries its manifest label; else null.
export function adoptSort(asked, applied) {
  if (!applied) return null;
  const ask = asked || NEWEST;
  return applied.by === ask.by && applied.dir === ask.dir ? asked : applied;
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

const added = (item) => item.created_at ?? Infinity;

// The tiebreak every order ends on: date added, newest first, then id.
export function newestFirst(a, b) {
  const x = added(a), y = added(b);
  if (x !== y) return x < y ? 1 : -1;
  return b.id - a.id;
}

// One collator for the page: the viewer's language, as localeCompare used.
// The page sends its language, so the server sorts text the same way.
const viewerCollator = new Intl.Collator();
export const viewerLocale = viewerCollator.resolvedOptions().locale;

// Two sort values: empty last, numbers before text, then by value within a
// type. `dir` (1 up, -1 down) flips only that last comparison.
function compareValues(av, bv, dir, collator) {
  const aEmpty = av == null, bEmpty = bv == null;
  if (aEmpty || bEmpty) return aEmpty === bEmpty ? 0 : aEmpty ? 1 : -1;
  const aNum = typeof av === "number", bNum = typeof bv === "number";
  if (aNum !== bNum) return aNum ? -1 : 1;
  if (aNum) return av === bv ? 0 : av < bv ? -dir : dir;
  return dir * collator.compare(String(av), String(bv));
}

// The value a sort reads off a card. Date added reads a missing date as
// newest, so a dateless card sorts with the newest either way.
const valueOf = (sort) => (sort.by === "created" ? added : (item) => sortValue(item, sort.by));

// A card's key for a sort: its id, its date added and its sort value. The
// server lists one for every card on the board (the `keys` of GET
// /api/items/sorted, as [id, created_at, value]); the page orders the cards
// it hasn't loaded by them, and draws a loaded card only when its key comes
// before the first of those (D3).
export const keyOf = (item, sort) => ({ id: item.id, created_at: item.created_at, v: valueOf(sort)(item) });

function compareBy(sort, value, collator) {
  const dir = sort.dir === "asc" ? 1 : -1;
  return (a, b) => compareValues(value(a), value(b), dir, collator) || newestFirst(a, b);
}

// The compare function for a sort ({ by, dir }): over cards, and over keys.
// The two agree: a card compares as its key does.
export const compareItems = (sort, collator = viewerCollator) => compareBy(sort, valueOf(sort), collator);
export const compareKeys = (sort, collator = viewerCollator) => compareBy(sort, (k) => k.v, collator);
