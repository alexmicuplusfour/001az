// Stored = declared, backfilled (planning/field-projection-plan.md).
//
// Connector entities historically stored the provider's ENTIRE field catalog —
// fetchEntity answered everything and the add path kept it all — while the
// board's mapping declared a subset. From this build, land-time projection and
// the mapping-save reconcile keep entities.fields equal to the mapping's
// connector keys; this migration converges the rows that predate the rule, so
// a field removed from a mapping months ago finally leaves the entities too.
//
// Strip only, per the plan: mapped-but-missing keys stay missing — the boot
// reconcile (db.js reconcileLiveSchedules, with schedule.js's absent-key term)
// stamps those entities due and the refresh sweep buys the data. Historical
// keys equal catalog fns, so there is no rename leg. field_snapshots keep
// their history (movement records, not current state).
//
// The key filter is defined HERE, not imported — migrations stay frozen while
// app code drifts. Idempotent: an already-converged row fails the WHERE's
// stray-key test and is untouched. Fresh installs have no rows: a no-op.

export async function up(client) {
  const { rows } = await client.query(
    "SELECT id, mapping FROM boards WHERE mapping->'input'->>'connector' IS NOT NULL"
  );
  for (const b of rows) {
    const keys = (b.mapping?.fields || [])
      .filter((f) => f && f.source === "connector" && typeof f.key === "string")
      .map((f) => f.key);
    await client.query(
      `UPDATE entities SET
         fields = COALESCE(
           (SELECT jsonb_object_agg(key, value) FROM jsonb_each(fields) WHERE key = ANY($2::text[])),
           '{}'::jsonb),
         updated_at = $3
       WHERE board_id = $1
         AND EXISTS (SELECT 1 FROM jsonb_each(fields) WHERE NOT key = ANY($2::text[]))`,
      [b.id, keys, Date.now()]
    );
  }
}
