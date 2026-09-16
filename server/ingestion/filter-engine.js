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

// The one classification of a scan — the can't-disagree promise that used to
// live in a shared `membership()` helper, now that the preview and the sweep
// need the same SPLIT and not just the same set (stages 3-5).
// `known` is the ledger as Map(key -> { reason, size, modified }).
//
// Everything below falls out of ONE classification of each matching
// candidate, because every earlier attempt to compute these separately drifted
// apart: the preview tallied "held back" one way while the run row counted
// "ignored" another, and the two disagreed on exactly the case that motivated
// the stage.
//
//   settled   the key is known AND still holds the bytes we recorded. Only a
//             settled key can speak for its ledger row.
//   slots     a settled key consumes a `total` slot iff its reason is
//             `admitted` (legacy rows included — they can't prove absence).
//             `deleted` and `skipped` backfill: the board keeps itself at N
//             ELIGIBLE members, and a corrupt file is no more an eligible
//             member than a rejected one.
//   admission every settled key stays out of `fresh`, whatever its reason —
//             backfilling a slot never resurrects its occupant.
//
// CHANGED is what makes a disposable watch folder work. A path there is not a
// name, it is a slot, and slots get reused: drop a file, ingest it, clear the
// folder, drop a different file under the same name. Judged by path alone that
// second file is skipped forever — no error, no badge, no run row. So a key
// whose recorded facts no longer match the listing is NOT settled: it is a new
// file wearing an old name, it takes a slot from nobody, and the admit path
// reads its bytes and decides by content. The predicate belongs to the adapter
// (files.js `changed`; a connector passes none and can never change), so
// nothing here learns file-specific vocabulary.
//
// Returns { matched, member, fresh, tally }: `matched` is everything the
// filters admit (unsorted — the caller sorts if it needs to), `member` the
// slot-aware membership or null when there is no cap, `fresh` what a run
// admits, `tally` the reason split the preview shows and the run row's
// `ignored` reads off.
// Is this candidate's ledger row still speaking for it? Returns the row when
// it is, null when the key is unknown or the slot has drifted (see CHANGED
// below). Exported because the scoped forget (stage 6) has to delete exactly
// the rows the tally counted — computing "settled" a second way there is how
// the shown number and the acted-on number come apart, which is the failure
// this whole arc keeps circling.
export function settledRow(candidate, known, changed = null) {
  const row = known.get(candidate.key);
  if (row === undefined) return null;
  return changed && changed(candidate, row) ? null : row;
}

export function runWindow(candidates, cfg, catalog, known, { changed = null, now = Date.now() } = {}) {
  const settled = (c) => !!settledRow(c, known, changed);
  const matched = applyFilters(candidates, cfg.filters, catalog, now);

  const tally = { on_board: 0, held: 0, unprocessable: 0 };
  for (const c of matched) {
    const row = settledRow(c, known, changed);
    if (!row) continue; // a reused slot answers for nothing
    if (row.reason === "admitted") tally.on_board++;
    else if (row.reason === "deleted") tally.held++;
    else if (row.reason === "skipped") tally.unprocessable++;
  }

  // The cap is the only reason to look at settled rows at all, so without one
  // the sort runs over the fresh remainder alone — a mature continuous board
  // orders its ~0 new rows per tick, never the whole window.
  const total = Number(cfg.total) || 0;
  const member = total
    ? applyLimit(applySort(matched.filter((c) => !settled(c) || known.get(c.key).reason === "admitted"),
        cfg.sort, catalog), total)
    : null;
  const fresh = member
    ? member.filter((c) => !settled(c))
    : applySort(matched.filter((c) => !settled(c)), cfg.sort, catalog);
  return { matched, member, fresh, tally };
}
