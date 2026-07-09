// Image-era payloads ({filename, original_name, w, h}) become the generic item
// shape ({identity, files, fields}). Identity = the filename, which was globally
// unique, so the per-board unique index can't collide. Idempotent via the WHERE
// guard; a single UPDATE is atomic. Then drop the filename index it superseded.
export async function up(client) {
  await client.query(`UPDATE items SET payload = jsonb_build_object(
      'identity', payload->>'filename',
      'files', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'name', payload->>'filename', 'original_name', payload->>'original_name',
        'w', payload->'w', 'h', payload->'h'))),
      'fields', '{}'::jsonb)
    WHERE payload ? 'filename' AND NOT payload ? 'identity'`);
  await client.query("DROP INDEX IF EXISTS idx_items_filename"); // superseded by the entity identity index
}
