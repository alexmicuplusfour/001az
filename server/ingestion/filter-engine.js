// The shared, pure half of ingestion: filters, sorting and the admission
// limit, evaluated over adapter candidates. A candidate carries a flat
// `values` bag ({ fn: primitive }) described by the adapter's filter catalog
// ([{ fn, kind, label }]); nothing here touches the db or the filesystem, so
// every adapter (folder now, connector feeds later) gets identical semantics.
//
// Date-kind candidate values are ms epochs; date filter values are
// "YYYY-MM-DD" strings (before/after) or a day count (within_days).

// Ops by filter kind — the single source of truth: served to the client in
// the descriptor payload, enforced by validateIngest, evaluated here.
export const OPS_BY_KIND = {
  text: ["contains", "equals", "starts_with"],
  number: ["gte", "lte", "eq"],
  date: ["within_days", "before", "after"],
};

const DAY_MS = 86400000;

const kindOf = (fn, catalog) => catalog.find((c) => c.fn === fn)?.kind || null;

// Parse "YYYY-MM-DD" as a local-time day boundary; NaN on anything else.
function dayStart(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!m) return NaN;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

// A null/missing candidate value fails every filter — a filter never admits
// blind. Unknown fn/op/kind also fail (validateIngest rejects them upstream;
// this is the defensive floor for stale saved configs).
export function evaluate(values, { fn, op, value }, catalog, now = Date.now()) {
  const kind = kindOf(fn, catalog);
  if (!kind || !(OPS_BY_KIND[kind] || []).includes(op)) return false;
  const v = values?.[fn];
  if (v === null || v === undefined) return false;
  if (kind === "text") {
    const s = String(v).toLowerCase();
    const q = String(value ?? "").toLowerCase();
    if (op === "contains") return s.includes(q);
    if (op === "equals") return s === q;
    if (op === "starts_with") return s.startsWith(q);
  }
  if (kind === "number") {
    const n = Number(v);
    const q = Number(value);
    if (!Number.isFinite(n) || !Number.isFinite(q)) return false;
    if (op === "gte") return n >= q;
    if (op === "lte") return n <= q;
    if (op === "eq") return n === q;
  }
  if (kind === "date") {
    const t = Number(v);
    if (!Number.isFinite(t)) return false;
    if (op === "within_days") return t >= now - Number(value) * DAY_MS;
    const day = dayStart(value);
    if (!Number.isFinite(day)) return false;
    if (op === "before") return t < day;
    if (op === "after") return t >= day + DAY_MS; // strictly after that day
  }
  return false;
}

// AND semantics: every filter must pass.
export function applyFilters(candidates, filters, catalog, now = Date.now()) {
  if (!Array.isArray(filters) || !filters.length) return candidates;
  return candidates.filter((c) => filters.every((f) => evaluate(c.values, f, catalog, now)));
}

// Stable sort, nulls last regardless of direction: text localeCompare,
// number/date numeric. No sort config → input order preserved.
export function applySort(candidates, sort, catalog) {
  if (!sort || !sort.by) return candidates;
  const kind = kindOf(sort.by, catalog) || "text";
  const dir = sort.order === "asc" ? 1 : -1;
  const cmp = (a, b) => {
    const av = a.values?.[sort.by] ?? null;
    const bv = b.values?.[sort.by] ?? null;
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (kind === "text") return dir * String(av).localeCompare(String(bv));
    return dir * (Number(av) - Number(bv));
  };
  return [...candidates].sort(cmp);
}

export function applyLimit(candidates, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return candidates;
  return candidates.slice(0, limit);
}
