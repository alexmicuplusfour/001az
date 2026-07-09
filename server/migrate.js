// Versioned migration ledger. Replaces the old pile of boot-time one-timers in
// db.js: each file in ./migrations runs exactly once, in filename order, and is
// recorded in schema_migrations so it never runs again.
//
// A migration file is either:
//   - `NNNN_name.sql` — raw SQL, run verbatim, or
//   - `NNNN_name.js`  — an ES module exporting `async up(client)`.
// Each runs inside its own transaction on a single advisory-locked connection,
// so two booting containers can't apply the same migration twice.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

// Arbitrary app-wide constant so concurrent boots serialize on the same lock.
const LOCK_KEY = 4915623;

// Everything up to and including this id is the pre-ledger history — its effects
// are already present in any database created before the ledger existed (the app
// ran the equivalent one-timers on every boot). On first adoption those are
// recorded as applied without running; anything after it is a genuine post-ledger
// change and always runs. Bump this ONLY when squashing new history into the
// baseline, never for ordinary new migrations.
const ADOPT_THROUGH = "0008_stamp_field_at";

const migrationId = (file) => file.replace(/\.(sql|js)$/, "");

export async function runMigrations(db) {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql") || f.endsWith(".js"))
    .sort();

  const client = await db.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at BIGINT NOT NULL)"
    );
    const { rows } = await client.query("SELECT id FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.id));

    // First run against a database that predates the ledger: its schema and every
    // historical migration's effect are already in place, so baseline them in
    // rather than re-running. A fresh database has no `boards` table and skips
    // this, so every migration (baseline included) runs for real below.
    if (applied.size === 0) {
      const { rows: [{ exists }] } = await client.query(
        "SELECT to_regclass('public.boards') IS NOT NULL AS exists"
      );
      if (exists) {
        for (const file of files) {
          const id = migrationId(file);
          if (id > ADOPT_THROUGH) continue; // zero-padded ids compare lexically
          await client.query(
            "INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            [id, Date.now()]
          );
          applied.add(id);
        }
        console.log(`db: adopted migration ledger on existing database (baselined through ${ADOPT_THROUGH})`);
      }
    }

    for (const file of files) {
      const id = migrationId(file);
      if (applied.has(id)) continue;
      await client.query("BEGIN");
      try {
        if (file.endsWith(".sql")) {
          await client.query(fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
        } else {
          const mod = await import(pathToFileURL(path.join(MIGRATIONS_DIR, file)).href);
          await mod.up(client);
        }
        await client.query("INSERT INTO schema_migrations (id, applied_at) VALUES ($1, $2)", [id, Date.now()]);
        await client.query("COMMIT");
        console.log(`db: applied migration ${id}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`migration ${id} failed: ${err.message}`, { cause: err });
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    client.release();
  }
}
