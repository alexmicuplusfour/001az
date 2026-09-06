// Land-time projection of connector fields — the pure half of the stored =
// declared invariant (planning/field-projection-plan.md): an entity stores
// exactly the connector fields its board's mapping declares, under the
// mapping's keys. No db, no provider — the schedule.js of "what lands"
// (schedule.js is "when it needs work"; the two lean on each other:
// fieldDueAt's absent-key term is only safe because projection is TOTAL).
//
// The reconcile-time strip deliberately has no JS twin here: it lives as one
// SQL statement (db.js stripBoardEntityFields — where the maps are), and its
// rule is the complement of this one: keep mapped keys as stored, add
// NOTHING — absence is what makes the scheduler buy a newly-mapped key.

// The present-but-empty cell for a mapped field the provider didn't answer —
// extractFileFields' rule (media/index.js). Presence means "asked", so the
// scheduler's absent-key term can't re-buy an unanswerable field forever.
// Provenance stays truthful: the provider that was asked, when it was asked.
export const absentField = (f, src, at) => ({ v: null, kind: f.kind, src, at });

// Project a fetched connector entity's field map (keyed by catalog fn, values
// already stamped {v, kind, src, at} by runtime.fetchEntity) onto the
// mapping's connector fields, keyed by f.key — the fn→key seam that lets a
// mapping rename a field without the provider knowing (keys equal fns today;
// the file source already renames). Takes the whole fetched entity so the
// absent-arm provenance is derived here, not rebuilt by every land site.
export function projectConnectorFields(entity, mappingFields, now = Date.now()) {
  const out = {};
  for (const f of mappingFields || []) {
    if (f.source !== "connector") continue;
    const v = entity?.fields?.[f.fn];
    out[f.key] = v !== undefined ? v : absentField(f, entity?.source?.provider, now);
  }
  return out;
}
