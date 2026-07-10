// One-time backfill: set uploaded_by on all existing entities (NULL = pre-tracking)
// to the first admin user found. Run once after deploying 0009_entity_uploaded_by.sql.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/backfill-uploaded-by.js
//
// Safe to run multiple times — only touches rows where uploaded_by IS NULL.
import pg from "pg";

pg.types.setTypeParser(20, Number);

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });

const { rows: [admin] } = await db.query(
  "SELECT id, email FROM users WHERE is_admin = TRUE ORDER BY id ASC LIMIT 1"
);
if (!admin) {
  console.error("No admin user found — aborting.");
  process.exit(1);
}
console.log(`Backfilling to: ${admin.email} (id=${admin.id})`);

const { rowCount } = await db.query(
  "UPDATE entities SET uploaded_by = $1 WHERE uploaded_by IS NULL",
  [admin.id]
);
console.log(`Updated ${rowCount} entities.`);

await db.end();
