// One-time ETL: copy the legacy SQLite database into Postgres.
//
// Usage:
//   DATABASE_URL=postgres://... node scripts/sqlite-to-pg.js <path/to/data.db>
//
// - Runs the migration ledger against the target first (initDb → runMigrations,
//   which on an empty target applies the baseline schema), then refuses to run
//   if the target already has users or images (no accidental double-import).
// - Preserves row ids verbatim (favorites/crate_images/sessions reference
//   them), then setval()s each identity sequence.
// - Converts 0/1 ints to booleans and TEXT JSON to JSONB.
// - Copies sessions so everyone stays logged in through the cutover.
// - Skips legacy crates with board_id='' (invisible in the app since the
//   per-board crates migration) along with their crate_images.
// - Copy the source db only while the old service is STOPPED so the -wal
//   contents are included.
//
// better-sqlite3 is a devDependency; run this from a dev checkout, not the
// production image. For the droplet cutover, scp data.db down and point
// DATABASE_URL at the droplet's Postgres through an SSH tunnel.
import Database from "better-sqlite3";
import { openDb, initDb } from "../server/db.js";

const sqlitePath = process.argv[2];
const DATABASE_URL = process.env.DATABASE_URL;
if (!sqlitePath || !DATABASE_URL) {
  console.error("usage: DATABASE_URL=postgres://... node scripts/sqlite-to-pg.js <data.db>");
  process.exit(1);
}

const src = new Database(sqlitePath, { readonly: true, fileMustExist: true });
const pool = openDb(DATABASE_URL);
await initDb(pool);

const { c: existing } = (
  await pool.query("SELECT (SELECT COUNT(*) FROM users) + (SELECT COUNT(*) FROM items) AS c")
).rows[0];
if (existing > 0) {
  console.error(`target already has data (${existing} users+items) — refusing to import`);
  process.exit(1);
}

const orphans = src.prepare("SELECT COUNT(*) AS c FROM images WHERE board_id=''").get().c;
if (orphans > 0) {
  console.error(`source has ${orphans} image(s) with board_id='' — run the old server once to migrate them first`);
  process.exit(1);
}

const bool = (v) => !!v;
const counts = {};

const client = await pool.connect();
try {
  await client.query("BEGIN");

  const copy = async (label, rows, insert) => {
    for (const r of rows) await insert(r);
    counts[label] = rows.length;
  };

  await copy("users", src.prepare("SELECT * FROM users").all(), (r) =>
    client.query(
      `INSERT INTO users (id, email, name, is_admin, created_at, last_login_at)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6)`,
      [r.id, r.email, r.name, bool(r.is_admin), r.created_at, r.last_login_at]
    )
  );

  await copy("boards", src.prepare("SELECT * FROM boards").all(), (r) =>
    client.query(
      "INSERT INTO boards (id, name, facets, glosses, context, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [r.id, r.name, r.facets, r.glosses || "{}", r.context || "", r.created_at]
    )
  );

  await copy("board_members", src.prepare("SELECT * FROM board_members").all(), (r) =>
    client.query("INSERT INTO board_members (board_id, user_id, created_at) VALUES ($1, $2, $3)", [
      r.board_id,
      r.user_id,
      r.created_at,
    ])
  );

  // The source's image columns become the generic item payload
  // ({identity, files, fields} — see schema.sql).
  const toPayload = (r) => {
    const f = { name: r.filename };
    if (r.original_name) f.original_name = r.original_name;
    if (r.thumb_w) f.w = r.thumb_w;
    if (r.thumb_h) f.h = r.thumb_h;
    return JSON.stringify({ identity: r.filename, files: [f], fields: {} });
  };
  await copy("items", src.prepare("SELECT * FROM images").all(), (r) =>
    client.query(
      `INSERT INTO items (id, status, tags, error, attempts, board_id, undecided, payload, created_at, updated_at)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [r.id, r.status, r.tags, r.error, r.attempts, r.board_id, bool(r.undecided), toPayload(r), r.created_at, r.updated_at]
    )
  );

  // Hoist the entity layer: one entity per item, same id, so the favorites /
  // crate_items copies below (which reference entities) land on the right
  // rows. Source rows are image-era — raw identity, single file.
  await client.query(
    `INSERT INTO entities (id, board_id, identity, created_at, updated_at)
     OVERRIDING SYSTEM VALUE
     SELECT id, board_id, payload->>'identity', created_at, updated_at FROM items`
  );
  await client.query("UPDATE items SET entity_id = id");

  await copy("invites", src.prepare("SELECT * FROM invites").all(), (r) =>
    client.query(
      "INSERT INTO invites (token, user_id, expires_at, used_at, permanent, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [r.token, r.user_id, r.expires_at, r.used_at, bool(r.permanent), r.created_at]
    )
  );

  await copy("sessions", src.prepare("SELECT * FROM sessions").all(), (r) =>
    client.query("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)", [
      r.id,
      r.user_id,
      r.created_at,
      r.expires_at,
    ])
  );

  await copy("favorites", src.prepare("SELECT * FROM favorites").all(), (r) =>
    client.query("INSERT INTO favorites (user_id, item_id, created_at) VALUES ($1, $2, $3)", [
      r.user_id,
      r.image_id,
      r.created_at,
    ])
  );

  const legacyCrates = src.prepare("SELECT COUNT(*) AS c FROM crates WHERE board_id=''").get().c;
  if (legacyCrates) console.log(`skipping ${legacyCrates} legacy crate(s) with board_id='' (+ their crate_images)`);
  await copy("crates", src.prepare("SELECT * FROM crates WHERE board_id != ''").all(), (r) =>
    client.query(
      "INSERT INTO crates (id, user_id, board_id, name, created_at) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4, $5)",
      [r.id, r.user_id, r.board_id, r.name, r.created_at]
    )
  );

  await copy(
    "crate_items",
    src
      .prepare(
        "SELECT ci.* FROM crate_images ci JOIN crates c ON c.id = ci.crate_id WHERE c.board_id != ''"
      )
      .all(),
    (r) =>
      client.query("INSERT INTO crate_items (crate_id, item_id, created_at) VALUES ($1, $2, $3)", [
        r.crate_id,
        r.image_id,
        r.created_at,
      ])
  );

  await copy("ai_usage", src.prepare("SELECT * FROM ai_usage").all(), (r) =>
    client.query("INSERT INTO ai_usage (day, count) VALUES ($1, $2)", [r.day, r.count])
  );

  await copy("settings", src.prepare("SELECT * FROM settings").all(), (r) =>
    client.query("INSERT INTO settings (key, value) VALUES ($1, $2)", [r.key, r.value])
  );

  // Identity sequences must resume past the copied ids.
  for (const table of ["users", "items", "entities", "crates"]) {
    await client.query(
      `SELECT setval(pg_get_serial_sequence('${table}','id'), GREATEST((SELECT COALESCE(MAX(id),0) FROM ${table}), 1))`
    );
  }

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  throw err;
} finally {
  client.release();
}

// Verify: target counts must match what we copied.
console.log("imported:");
for (const [table, n] of Object.entries(counts)) {
  const { c } = (await pool.query(`SELECT COUNT(*) AS c FROM ${table}`)).rows[0];
  const ok = c === n ? "ok" : `MISMATCH (target has ${c})`;
  console.log(`  ${table.padEnd(14)} ${String(n).padStart(6)}  ${ok}`);
}

src.close();
await pool.end();
