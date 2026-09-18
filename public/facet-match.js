// facet-match.js — the facet selection's one home (planning/
// chip-exclusion-plan.md): the membership rule, the entry shapes, and the
// wire codecs. filters.js runs these in the browser; alerts.js and the
// config/condition cleaning run them in node. Dependency-free on purpose —
// the cluster-core move: rules two sides must agree on have exactly one
// home, and this file is where a selection's meaning, serialization, and
// equality are all decided.
//
// The membership rule: OR within a facet's included values, AND with "no
// excluded value held". `has` is the membership seam (the caller closes
// over entityHasValue / instanceHasValue / a tagSet lookup); `any` and
// `not` are iterables — Sets in live state, arrays in stored conditions,
// either absent. An empty/absent `any` constrains nothing: "no includes"
// is an untouched half, not an unmatchable one. What an empty facet ENTRY
// means is the caller's call — a live selection skips it, a stored
// condition refuses it — which is why that guard stays in each caller,
// visibly.

export function facetPass(has, any, not) {
  let sawAny = false, ok = false;
  for (const v of any || []) { sawAny = true; if (has(v)) { ok = true; break; } }
  if (sawAny && !ok) return false;
  for (const v of not || []) { if (has(v)) return false; }
  return true;
}

// ── the shapes ──────────────────────────────────────────────────────────────
// LIVE form: { any: Set, not: Set } — what state.selected holds per facet
// and what test fixtures build. WIRE form (configs, conditions, ?f=/?fx=):
// a plain array is the legacy include-only shape — old rows never migrate,
// they just read as "no exclusions" — and { any: [...], not: [...] } once
// an exclusion exists. halvesOf reads the wire form (junk collapses to
// empty halves for the caller's own corrupt-entry rule to judge); wireEntry
// writes it, emitting the array whenever `not` is empty so exclusion-free
// rows stay byte-identical to the old shape.

export const selEntry = (any = [], not = []) => ({ any: new Set(any), not: new Set(not) });

export function halvesOf(v) {
  if (Array.isArray(v)) return { any: v, not: [] };
  if (v && typeof v === "object")
    return { any: Array.isArray(v.any) ? v.any : [], not: Array.isArray(v.not) ? v.not : [] };
  return { any: [], not: [] };
}

export function wireEntry(any, not) {
  const a = [...any].sort(), n = [...not].sort();
  if (!a.length && !n.length) return null;
  return n.length ? { any: a, not: n } : a;
}

// Canonical equality for a wire entry, both spellings alike — an array
// config must equal its { any } form. JSONB reorders keys and clients
// reorder values; neither changes what matches.
export function canonEntry(v) {
  const { any, not } = halvesOf(v);
  return [[...any].sort(), [...not].sort()];
}

// Live-entry conveniences. Visibility asks "is this value selected in
// EITHER half" — a selected-but-gone value must keep its click-off
// whichever side it sits on; sizes gate row presence the same way.
export const selSize = (e) => e.any.size + e.not.size;
export const selHas = (e, v) => e.any.has(v) || e.not.has(v);
export const selValues = (e) => [...e.any, ...e.not];

// ── the URL codec ───────────────────────────────────────────────────────────
// Compact query-param form: "key:v1,v2;key2:v3" (parts URI-encoded so the
// separators can't collide with facet names/values). ?f= carries include
// halves — its meaning since day one, so old links decode unchanged — and
// ?fx= the exclude halves; alert firing links ride the same pair. One
// implementation for both sides: the client encodes state.selected halves,
// the server encodes condition halves, and neither can drift.

export function encodePairs(pairs) {
  const parts = [];
  for (const [key, values] of [...pairs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = [...values].sort();
    if (!sorted.length) continue;
    parts.push(encodeURIComponent(key) + ":" + sorted.map(encodeURIComponent).join(","));
  }
  return parts.join(";");
}

export function decodePairs(str) {
  const map = new Map();
  if (!str) return map;
  for (const part of str.split(";")) {
    const i = part.indexOf(":");
    if (i <= 0) continue;
    const key = decodeURIComponent(part.slice(0, i));
    const values = part.slice(i + 1).split(",").filter(Boolean).map(decodeURIComponent);
    if (values.length) map.set(key, values);
  }
  return map;
}

// The API boundary's cleaning, for every stored or received selection: filter
// configs, alert conditions, and an MCP tool's `facets` argument. It lives here
// because it is the WIRE form's own rule — strings only, caps enforced,
// both-empty entries dropped — and a third caller copying it is exactly what
// this file exists to prevent.
//
// Note what it does NOT decide: a result with no keys means "nothing was
// selected", and what that means is the caller's call. A filter config refuses
// it (an empty saved view is a mistake), an alert condition refuses it (an
// empty condition would fire on everything), and an MCP search treats it as
// UNCONSTRAINED and skips matching entirely. Same cleaning, three verdicts —
// which is why the verdict stays out here.
export function cleanSelection(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const strings = (a) => a.filter((x) => typeof x === "string").slice(0, 100);
  for (const [k, v] of Object.entries(raw)) {
    const halves = halvesOf(v);
    const wire = wireEntry(strings(halves.any), strings(halves.not));
    if (wire) out[String(k).slice(0, 100)] = wire;
  }
  return out;
}
