// One-time rename for live DBs that predate the modular-boards refactor:
// images -> items with the image-specific columns folded into payload JSONB,
// and the referencing tables renamed to match. Guarded on a to_regclass check
// so a fresh database (baseline already created `items`) is a no-op. Postgres
// DDL is transactional — the ledger runs this inside one BEGIN/COMMIT.
export async function up(client) {
  const { rows } = await client.query(
    "SELECT (to_regclass('images') IS NOT NULL AND to_regclass('items') IS NULL) AS go"
  );
  if (!rows[0].go) return;

  await client.query("ALTER TABLE images RENAME TO items");
  await client.query("ALTER TABLE items ADD COLUMN payload JSONB NOT NULL DEFAULT '{}'");
  await client.query(`UPDATE items SET payload = jsonb_strip_nulls(jsonb_build_object(
    'filename', filename, 'original_name', original_name, 'w', thumb_w, 'h', thumb_h))`);
  await client.query(
    "ALTER TABLE items DROP COLUMN filename, DROP COLUMN original_name, DROP COLUMN thumb_w, DROP COLUMN thumb_h"
  );
  await client.query("ALTER TABLE favorites RENAME COLUMN image_id TO item_id");
  await client.query("ALTER TABLE crate_images RENAME COLUMN image_id TO item_id");
  await client.query("ALTER TABLE crate_images RENAME TO crate_items");
  // tag_snapshots may not exist yet on DBs older than the snapshots deploy
  await client.query("ALTER TABLE IF EXISTS tag_snapshots RENAME COLUMN image_id TO item_id");
  const idx = [
    ["idx_images_status", "idx_items_status"],
    ["idx_images_created", "idx_items_created"],
    ["idx_images_board", "idx_items_board"],
    ["idx_fav_image", "idx_fav_item"],
    ["idx_crate_images_image", "idx_crate_items_item"],
    ["idx_snapshots_image", "idx_snapshots_item"],
  ];
  for (const [from, to] of idx) await client.query(`ALTER INDEX IF EXISTS ${from} RENAME TO ${to}`);
  console.log("db: migrated images -> items (image columns folded into payload)");
}
