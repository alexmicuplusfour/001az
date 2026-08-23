// When does an entity next need work? The four pure rules behind every
// refresh_at in the system — no db, no provider, no imports.
//
// They live apart from runtime.js for one reason: db.js needs them too
// (reconcileLiveSchedules at boot, rescheduleEntityRefreshes on a mapping save)
// and runtime.js imports db.js. That used to be settled by hand-inlining the
// rules at the db.js call site — two copies of "what counts as live", drifting
// the first time one changed. This module is the single copy; runtime.js
// re-exports it, so its importers (add.js, server.js, worker.js) are unchanged.

// A mapping's live connector fields. The stored shape carries the cadence as
// `refresh: { every }`; this is the ONE place it's decoded — consumers get
// `every` flattened onto the field, so none of them learn the wire shape.
export const liveFields = (mapping) =>
  (mapping?.fields || [])
    .filter((f) => f.source === "connector" && f.refresh)
    .map((f) => ({ ...f, every: f.refresh.every }));

// Soonest time any live field comes due: min(field.at + every*60000), or null
// when nothing is live. `fields` is the entity's stored field map; a field with
// no `at` yet is treated as due now.
export function nextRefreshAt(fields, live, now = Date.now()) {
  let next = null;
  for (const f of live) {
    const due = (fields?.[f.key]?.at ?? now) + f.every * 60000;
    if (next === null || due < next) next = due;
  }
  return next;
}

// How a mapping's face is scheduled, the face-side mirror of liveFields:
//   { every }       — a connector face marked live: re-render on that cadence.
//   { first: true } — a connector face that isn't live: render ONCE, then never.
//   null            — no connector face (a file face / the tile): nothing to render.
// The `first` term is load-bearing, not a formality: the face leg only runs when
// an entity is ADDED, so an entity that predates its board's face (a mapping
// edit, the chart-face migration) has no other path to a first render. Without
// it, turning the face on with cadence Off leaves every existing card tile-faced.
export const faceSchedule = (mapping) => {
  const f = mapping?.face;
  if (!f || f.source !== "connector") return null;
  return f.refresh ? { every: f.refresh.every } : { first: true };
};

// How long to wait before re-attempting a face that has never rendered, when the
// face isn't live (a live one retries on its own cadence). Slow on purpose: the
// usual reason is a provider that can't render this face at all (CoinMarketCap
// has no history()), where every retry is a guaranteed no-op.
const FIRST_FACE_RETRY_MIN = 60;

// An entity's next refresh time across BOTH its live fields and its face.
// `faceAt` is entities.face_at (null until the face is first rendered). This
// runs right after a render attempt, so a still-null faceAt here means the
// render was unavailable (e.g. the active provider has no history) — retry
// rather than dropping the term, else a face-only board with no live fields
// would get refresh_at null and fall off the sweep, tile-faced, until the next
// boot/mapping-save. The retry is a cheap no-op while the provider can't render.
// (First-render URGENCY is separate: rescheduleEntityRefreshes/boot reconcile
// treat a null faceAt as due-now, so enabling a face still backfills at once.)
export function entityRefreshAt(fields, faceAt, mapping, now = Date.now()) {
  let next = nextRefreshAt(fields, liveFields(mapping), now);
  const sched = faceSchedule(mapping);
  if (sched) {
    // Rendered → one cadence out, or never for a one-shot face (its work is
    // done). Unrendered → retry, on the cadence or the fixed floor.
    const due = faceAt != null
      ? (sched.every ? faceAt + sched.every * 60000 : null)
      : now + (sched.every ?? FIRST_FACE_RETRY_MIN) * 60000;
    if (due !== null && (next === null || due < next)) next = due;
  }
  return next;
}

// The next refresh for an entity that has just been ADDED: its live fields only
// (a fresh entity's face is rendered by the face leg, not scheduled). null when
// nothing is live — the common case for a chart-faced board with static fields.
export const firstRefreshAt = (fields, mapping) => {
  const live = liveFields(mapping);
  return live.length ? nextRefreshAt(fields, live) : null;
};
