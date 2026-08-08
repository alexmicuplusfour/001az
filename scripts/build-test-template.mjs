// Builds the template database the test harness clones from.
//
// Every test file used to pay for its own schema: CREATE DATABASE (~70 ms) then
// a replay of all ~32 migrations (~390 ms). Across the suite that was ~27 s of
// scaffolding before a single assertion ran. Postgres can copy a whole database
// at the file level instead — `CREATE DATABASE x TEMPLATE y` clones in ~90 ms —
// so we migrate ONCE here and let every startServer() clone the result.
//
// Runs as `pretest`, so the template is always freshly migrated: a migration
// added or edited on this branch is in it before any test starts. Nothing here
// touches the dev database — it only ever creates/drops TEMPLATE_DB.
import pg from "pg";
import { runMigrations } from "../server/migrate.js";

const ADMIN_URL = process.env.TEST_ADMIN_URL || "postgres://gallery:gallery@127.0.0.1:5433/postgres";
export const TEMPLATE_DB = process.env.TEST_TEMPLATE_DB || "gallery_test_template";

// Identifiers are interpolated (pg can't parameterize a database name), so keep
// the name to a plain slug — no quoting games, nothing injectable.
if (!/^[a-z_][a-z0-9_]*$/.test(TEMPLATE_DB)) {
  throw new Error(`TEST_TEMPLATE_DB must be a simple lowercase identifier, got "${TEMPLATE_DB}"`);
}

const admin = new pg.Pool({ connectionString: ADMIN_URL, max: 2 });
try {
  // FORCE evicts a client left over from an interrupted run; without it a stale
  // connection would make the drop hang instead of fail.
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);

  const url = ADMIN_URL.replace(/\/[^/]+$/, "/" + TEMPLATE_DB);
  const db = new pg.Pool({ connectionString: url, max: 1 });
  try {
    await runMigrations(db);
  } finally {
    // CREATE DATABASE ... TEMPLATE refuses while ANY session is connected to the
    // source, so the clones can't start until this pool is fully drained.
    await db.end();
  }
  console.log(`test template ready: ${TEMPLATE_DB}`);
} finally {
  await admin.end();
}
