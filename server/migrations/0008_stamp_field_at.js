// Connector field values that predate per-field liveness lack the `at` timestamp
// the refresh scheduler reads. Stamp it from the entity's updated_at so existing
// coins have a baseline. Idempotent via the `? 'at'` guard; fresh installs (empty
// entities) no-op.
export async function up(client) {
  await client.query(
    `UPDATE entities
     SET fields = (
       SELECT jsonb_object_agg(k, CASE WHEN v ? 'at' THEN v ELSE v || jsonb_build_object('at', updated_at) END)
       FROM jsonb_each(fields) AS f(k, v))
     WHERE fields <> '{}'::jsonb
       AND EXISTS (SELECT 1 FROM jsonb_each(fields) AS e(k, v) WHERE NOT (e.v ? 'at'))`
  );
}
