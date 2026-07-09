// Hoist the entity layer out of items. Every item row becomes an instance (one
// file, own fields/tags/queue state) under a new entities row carrying identity/
// display_name/symbol/connector fields. Entity ids are seeded from the item ids
// so favorites/crate_items re-point with their values unchanged (and client-
// visible card ids stay stable). Multi-file items (derived-identity merges) split
// into one instance per file; the extra files were never individually extracted
// or tagged, so they queue fresh. Idempotent: driven by items with entity_id IS
// NULL, and the split / FK-re-point steps carry their own natural guards. The
// ledger wraps this whole `up` in a transaction.
export async function up(client) {
  const { rowCount: migrated } = await client.query(
    `INSERT INTO entities (id, board_id, identity, display_name, symbol, fields, identity_provisional, created_at, updated_at)
     OVERRIDING SYSTEM VALUE
     SELECT id, board_id,
       COALESCE(payload->>'identity', payload->'files'->0->>'name', id::text),
       payload->>'display_name',
       payload->>'symbol',
       CASE WHEN jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0
            THEN COALESCE(payload->'fields','{}'::jsonb) ELSE '{}'::jsonb END,
       COALESCE((payload->>'identity_provisional')::boolean, FALSE),
       created_at, updated_at
     FROM items WHERE entity_id IS NULL`
  );
  if (migrated) {
    await client.query(
      "SELECT setval(pg_get_serial_sequence('entities','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM entities), 1))"
    );
    // Connector vehicles (no files): their bound fields moved to the entity.
    await client.query(
      `UPDATE items SET payload = jsonb_set(payload, '{fields}', '{}'::jsonb)
       WHERE entity_id IS NULL AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0`
    );
    // Entity-level keys leave the instance payload (they live on entities now).
    await client.query(
      `UPDATE items SET payload = payload - 'display_name' - 'identity_provisional' - 'symbol',
         entity_id = id
       WHERE entity_id IS NULL`
    );
    console.log(`db: migrated ${migrated} item(s) into the entity/instance model`);
  }

  // Split multi-file items: the row keeps files[0]; every extra file becomes a
  // fresh instance under the same entity, queued for its own extraction and
  // tagging (its data was never derived individually — see plan).
  const { rows: multi } = await client.query(
    "SELECT id, board_id, entity_id, status, payload, created_at FROM items WHERE jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) > 1"
  );
  for (const row of multi) {
    const files = row.payload.files;
    const mapping = row.payload.mapping;
    for (let i = 1; i < files.length; i++) {
      const f = files[i];
      const payload = { identity: f.name, files: [f], fields: {}, ...(mapping ? { mapping } : {}) };
      const status = row.status === "held" ? "held" : mapping ? "pending_extract" : "pending";
      await client.query(
        `INSERT INTO items (board_id, entity_id, status, payload, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.board_id, row.entity_id, status, JSON.stringify(payload), row.created_at, Date.now()]
      );
    }
    await client.query(
      "UPDATE items SET payload = jsonb_set(payload, '{files}', $1::jsonb), updated_at=$2 WHERE id=$3",
      [JSON.stringify([files[0]]), Date.now(), row.id]
    );
  }
  if (multi.length) console.log(`db: split ${multi.length} multi-file item(s) into per-file instances`);

  // Re-point favorites / crate_items FKs from items to entities (values are
  // unchanged — entity ids were seeded from item ids above). Constraint names
  // vary across DB generations, so find them by what they reference.
  const { rows: fks } = await client.query(
    `SELECT con.conname, rel.relname AS tbl
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_class ref ON ref.oid = con.confrelid
     WHERE con.contype = 'f' AND rel.relname IN ('favorites','crate_items') AND ref.relname = 'items'`
  );
  for (const fk of fks) {
    await client.query(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT ${fk.conname}`);
    await client.query(
      `ALTER TABLE ${fk.tbl} ADD CONSTRAINT ${fk.tbl}_entity_fkey FOREIGN KEY (item_id) REFERENCES entities(id) ON DELETE CASCADE`
    );
  }

  // Identity uniqueness now lives on entities.
  await client.query("DROP INDEX IF EXISTS idx_items_board_identity");
}
