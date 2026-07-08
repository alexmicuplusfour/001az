import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// BIGINT (int8) comes back from pg as a string by default. Everything we store
// in BIGINT is a ms epoch or a row id — both far below 2^53 — so parse to
// Number globally. Without this, every `expires_at < Date.now()` style
// comparison silently breaks.
pg.types.setTypeParser(20, Number);

// Session ids and invite tokens are bearer credentials: the raw value goes to
// the client (cookie / login URL) but only its SHA-256 is stored, so a DB read
// can't be replayed as a login. Raw tokens are 48 hex chars, digests 64 — the
// length gap drives the one-time migration in initDb.
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

export function openDb(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

// Apply schema.sql (idempotent CREATE IF NOT EXISTS statements).
export async function initDb(db) {
  await migrateImagesToItems(db); // must run before schema.sql (see below)
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(sql);
  // One-time: hash any raw session ids / invite tokens left at rest (48 hex
  // chars → 64-char SHA-256). Non-breaking — an existing cookie or login link
  // still hashes to the stored digest. Idempotent via the length guard, so
  // fresh installs and already-migrated DBs skip it. Postgres has sha256()
  // built in (>= PG 11); text::bytea gives the same bytes Node hashes.
  await db.query("UPDATE sessions SET id = encode(sha256(id::bytea), 'hex') WHERE length(id) <> 64");
  await db.query("UPDATE invites SET token = encode(sha256(token::bytea), 'hex') WHERE length(token) <> 64");
  await db.query("ALTER TABLE crates ADD COLUMN IF NOT EXISTS public BOOLEAN NOT NULL DEFAULT FALSE");
  // One-time: image-era payloads ({filename, original_name, w, h}) become the
  // generic item shape ({identity, files, fields}). Identity = the filename,
  // which was globally unique, so the per-board unique index (schema.sql)
  // can't collide. Idempotent via the WHERE guard; a single UPDATE is atomic.
  await db.query(`UPDATE items SET payload = jsonb_build_object(
      'identity', payload->>'filename',
      'files', jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
        'name', payload->>'filename', 'original_name', payload->>'original_name',
        'w', payload->'w', 'h', payload->'h'))),
      'fields', '{}'::jsonb)
    WHERE payload ? 'filename' AND NOT payload ? 'identity'`);
  await db.query("DROP INDEX IF EXISTS idx_items_filename"); // superseded by the entity identity index
  await migrateItemsToEntities(db);
  // One-time migration: fold the legacy single-key setting into the ai_keys
  // registry and point the default at it.
  const legacy = await getSetting(db, "api_key");
  if (legacy) {
    const { rows } = await db.query(
      "INSERT INTO ai_keys (name, provider, api_key, created_at) VALUES ('Anthropic', 'anthropic', $1, $2) RETURNING id",
      [legacy, Date.now()]
    );
    await setSetting(db, "default_key_id", String(rows[0].id));
    await setSetting(db, "api_key", null);
  }
  await migrateCoingeckoToCrypto(db);
}

// One-time (slice 5b): the `crypto` domain connector replaces the flat
// `coingecko` connector, with the provider now selected in settings.
//  1. Board mappings rename their input connector coingecko -> crypto.
//  2. Connector entities re-key identity from the CoinGecko id ("bitcoin") to
//     the lowercase symbol ("btc") — portable across providers so a coin added
//     under two backends dedupes — and stamp the provider handle onto the tag-
//     vehicle instance for a future liveness re-fetch (captured before the
//     identity is overwritten).
// All guarded/idempotent; file boards never match. On a fresh install the
// tables are empty and every statement is a no-op.
async function migrateCoingeckoToCrypto(db) {
  await db.query(
    `UPDATE boards SET mapping = jsonb_set(mapping, '{input,connector}', '"crypto"')
     WHERE mapping->'input'->>'connector' = 'coingecko'`
  );
  await db.query(
    `UPDATE items i
     SET payload = i.payload
       || jsonb_build_object('source', jsonb_build_object('provider', 'coingecko', 'id', e.identity))
     FROM entities e
     WHERE i.entity_id = e.id
       AND i.payload->'mapping'->'input'->>'connector' IN ('coingecko', 'crypto')
       AND NOT i.payload ? 'source'
       AND COALESCE(e.symbol, '') <> ''`
  );
  await db.query(
    `UPDATE entities e
     SET identity = lower(e.symbol)
     WHERE COALESCE(e.symbol, '') <> ''
       AND e.identity <> lower(e.symbol)
       AND EXISTS (
         SELECT 1 FROM items i WHERE i.entity_id = e.id
           AND i.payload->'mapping'->'input'->>'connector' IN ('coingecko', 'crypto'))`
  );
}

// One-time rename for live DBs that predate the modular-boards refactor:
// images -> items with the image-specific columns folded into payload JSONB,
// and the referencing tables renamed to match. Runs before schema.sql so the
// idempotent CREATEs there don't spawn an empty items table next to a full
// images one. Fresh installs never enter (no images table); already-migrated
// DBs never enter (items exists). Transactional DDL makes it all-or-nothing.
async function migrateImagesToItems(db) {
  const { rows } = await db.query(
    "SELECT (to_regclass('images') IS NOT NULL AND to_regclass('items') IS NULL) AS go"
  );
  if (!rows[0].go) return;
  await withTx(db, async (c) => {
    await c.query("ALTER TABLE images RENAME TO items");
    await c.query("ALTER TABLE items ADD COLUMN payload JSONB NOT NULL DEFAULT '{}'");
    await c.query(`UPDATE items SET payload = jsonb_strip_nulls(jsonb_build_object(
      'filename', filename, 'original_name', original_name, 'w', thumb_w, 'h', thumb_h))`);
    await c.query(
      "ALTER TABLE items DROP COLUMN filename, DROP COLUMN original_name, DROP COLUMN thumb_w, DROP COLUMN thumb_h"
    );
    await c.query("ALTER TABLE favorites RENAME COLUMN image_id TO item_id");
    await c.query("ALTER TABLE crate_images RENAME COLUMN image_id TO item_id");
    await c.query("ALTER TABLE crate_images RENAME TO crate_items");
    // tag_snapshots may not exist yet on DBs older than the snapshots deploy
    await c.query("ALTER TABLE IF EXISTS tag_snapshots RENAME COLUMN image_id TO item_id");
    const idx = [
      ["idx_images_status", "idx_items_status"],
      ["idx_images_created", "idx_items_created"],
      ["idx_images_board", "idx_items_board"],
      ["idx_fav_image", "idx_fav_item"],
      ["idx_crate_images_image", "idx_crate_items_item"],
      ["idx_snapshots_image", "idx_snapshots_item"],
    ];
    for (const [from, to] of idx) await c.query(`ALTER INDEX IF EXISTS ${from} RENAME TO ${to}`);
    console.log("db: migrated images -> items (image columns folded into payload)");
  });
}

// One-time: hoist the entity layer out of items. Every item row becomes an
// instance (one file, own fields/tags/queue state) under a new entities row
// carrying identity/display_name/symbol/connector fields. Entity ids are
// seeded from the item ids so favorites/crate_items re-point with their
// values unchanged (and client-visible card ids stay stable). Multi-file
// items (derived-identity merges) split into one instance per file; the
// extra files were never individually extracted or tagged, so they queue
// fresh. Idempotent: driven by items with entity_id IS NULL, and the split /
// FK-re-point steps carry their own natural guards. Transactional.
async function migrateItemsToEntities(db) {
  await withTx(db, async (c) => {
    const { rowCount: migrated } = await c.query(
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
      await c.query(
        "SELECT setval(pg_get_serial_sequence('entities','id'), GREATEST((SELECT COALESCE(MAX(id),1) FROM entities), 1))"
      );
      // Connector vehicles (no files): their bound fields moved to the entity.
      await c.query(
        `UPDATE items SET payload = jsonb_set(payload, '{fields}', '{}'::jsonb)
         WHERE entity_id IS NULL AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0`
      );
      // Entity-level keys leave the instance payload (they live on entities now).
      await c.query(
        `UPDATE items SET payload = payload - 'display_name' - 'identity_provisional' - 'symbol',
           entity_id = id
         WHERE entity_id IS NULL`
      );
      console.log(`db: migrated ${migrated} item(s) into the entity/instance model`);
    }

    // Split multi-file items: the row keeps files[0]; every extra file becomes
    // a fresh instance under the same entity, queued for its own extraction
    // and tagging (its data was never derived individually — see plan).
    const { rows: multi } = await c.query(
      "SELECT id, board_id, entity_id, status, payload, created_at FROM items WHERE jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) > 1"
    );
    for (const row of multi) {
      const files = row.payload.files;
      const mapping = row.payload.mapping;
      for (let i = 1; i < files.length; i++) {
        const f = files[i];
        const payload = { identity: f.name, files: [f], fields: {}, ...(mapping ? { mapping } : {}) };
        const status = row.status === "held" ? "held" : mapping ? "pending_extract" : "pending";
        await c.query(
          `INSERT INTO items (board_id, entity_id, status, payload, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [row.board_id, row.entity_id, status, JSON.stringify(payload), row.created_at, Date.now()]
        );
      }
      await c.query(
        "UPDATE items SET payload = jsonb_set(payload, '{files}', $1::jsonb), updated_at=$2 WHERE id=$3",
        [JSON.stringify([files[0]]), Date.now(), row.id]
      );
    }
    if (multi.length) console.log(`db: split ${multi.length} multi-file item(s) into per-file instances`);

    // Re-point favorites / crate_items FKs from items to entities (values are
    // unchanged — entity ids were seeded from item ids above). Constraint
    // names vary across DB generations, so find them by what they reference.
    const { rows: fks } = await c.query(
      `SELECT con.conname, rel.relname AS tbl
       FROM pg_constraint con
       JOIN pg_class rel ON rel.oid = con.conrelid
       JOIN pg_class ref ON ref.oid = con.confrelid
       WHERE con.contype = 'f' AND rel.relname IN ('favorites','crate_items') AND ref.relname = 'items'`
    );
    for (const fk of fks) {
      await c.query(`ALTER TABLE ${fk.tbl} DROP CONSTRAINT ${fk.conname}`);
      await c.query(
        `ALTER TABLE ${fk.tbl} ADD CONSTRAINT ${fk.tbl}_entity_fkey FOREIGN KEY (item_id) REFERENCES entities(id) ON DELETE CASCADE`
      );
    }

    // Identity uniqueness now lives on entities.
    await c.query("DROP INDEX IF EXISTS idx_items_board_identity");
  });
}

// Run fn with a dedicated client inside BEGIN/COMMIT.
async function withTx(db, fn) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function countItems(db) {
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM items");
  return rows[0].c;
}

// Aggregate an entity's display status from its instances: any in-flight
// state wins (the card shows a spinner), then failed, then held; an entity
// whose instances are all done reads tagged. Single-instance entities (every
// raw board) pass their status through verbatim.
const STATUS_PRIORITY = ["extracting", "pending_extract", "processing", "pending", "failed", "held"];
export function aggregateStatus(instances) {
  if (!instances.length) return "tagged";
  if (instances.length === 1) return instances[0].status;
  for (const s of STATUS_PRIORITY) if (instances.some((i) => i.status === s)) return s;
  return "tagged";
}

// One instance's slice of the list payload.
function instanceEntry(r) {
  const file = r.payload.files?.[0];
  return {
    id: r.id,
    name: file?.name || r.payload.identity,
    label: file?.original_name || null,
    w: file?.w || null,
    h: file?.h || null,
    kind: file?.kind || (file ? "image" : "connector"),
    status: r.status,
    tags: r.tags,
    undecided: !!r.undecided,
  };
}

// The board listing: entities, each carrying its instances. Face fields
// (name/w/h/kind/label) mirror the first instance so the card path needs no
// special cases; tags at the entity level are the union across instances
// (what filtering and facet counts consume), per-instance tags ride inside.
export async function listItems(db, userId = null, boardId = null) {
  const { rows: ents } = await db.query(
    `SELECT e.id, e.identity, e.display_name, e.symbol, e.fields, e.identity_provisional, e.created_at,
      (SELECT COUNT(*) FROM favorites f WHERE f.item_id = e.id) AS hearts,
      EXISTS(
        SELECT 1 FROM favorites f WHERE f.item_id = e.id AND f.user_id = $1
      ) AS fav
     FROM entities e
     WHERE ($2::text IS NULL OR e.board_id = $2)
     ORDER BY e.created_at DESC, e.id DESC`,
    [userId, boardId]
  );

  const { rows: insts } = await db.query(
    `SELECT id, entity_id, status, tags, undecided, payload FROM items
     WHERE ($1::text IS NULL OR board_id = $1)
     ORDER BY created_at ASC, id ASC`,
    [boardId]
  );
  const byEntity = new Map();
  for (const r of insts) {
    if (!byEntity.has(r.entity_id)) byEntity.set(r.entity_id, []);
    byEntity.get(r.entity_id).push(instanceEntry(r));
  }

  const crateMap = new Map();
  if (userId) {
    const memberships = await db.query(
      `SELECT ci.item_id, ci.crate_id FROM crate_items ci
       JOIN crates c ON c.id = ci.crate_id
       WHERE c.board_id = $2 AND (c.user_id = $1 OR c.public = TRUE)`,
      [userId, boardId]
    );
    for (const m of memberships.rows) {
      if (!crateMap.has(m.item_id)) crateMap.set(m.item_id, []);
      crateMap.get(m.item_id).push(m.crate_id);
    }
  }

  return ents.map((e) => {
    const instances = byEntity.get(e.id) || [];
    const face = instances[0] || null;
    const tags = [];
    const seen = new Set();
    for (const i of instances) for (const t of i.tags) if (!seen.has(t)) { seen.add(t); tags.push(t); }
    return {
      id: e.id,
      // name = stored filename of the face file, used to construct gallery/
      // thumbnail URLs; identity is the entity key — they diverge on derived
      // boards.
      name: face?.name || e.identity,
      identity: e.identity,
      // AI's original-casing output ("Maya Chen") for display; absent on raw items.
      display_name: e.display_name || null,
      identity_provisional: !!e.identity_provisional,
      status: aggregateStatus(instances),
      tags,
      undecided: instances.length > 0 && instances.every((i) => i.undecided),
      hearts: e.hearts,
      favoritedByMe: !!e.fav,
      crateIds: crateMap.get(e.id) || [],
      w: face?.w || null,
      h: face?.h || null,
      // connector entities have no files; instanceEntry marks the file-less
      // vehicle "connector" so the client renders the symbol tile face.
      kind: face?.kind || (e.symbol != null ? "connector" : "image"),
      symbol: e.symbol || null,
      label: face?.label || null,
      // Connector-bound entity fields (AI-extracted fields are per instance).
      fields: e.fields || {},
      instances,
    };
  });
}

// status: 'pending' (tag now) or 'held' (wait — for the board's scheduled
// run, or for auto-tagging to be switched back on). Every instance belongs
// to an entity (createEntity first, then insert the instance under it).
export async function insertItem(db, boardId, payload, status = "pending", entityId = null) {
  const { rows } = await db.query(
    `INSERT INTO items (payload, status, board_id, entity_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`,
    [JSON.stringify(payload || {}), status, boardId, entityId, Date.now()]
  );
  return rows[0].id;
}

// Shallow-merge a patch into an item's payload.
export async function updateItemPayload(db, id, patch) {
  await db.query("UPDATE items SET payload = payload || $1::jsonb WHERE id=$2", [JSON.stringify(patch || {}), id]);
}

// Every item's { id, payload } (startup sweeps like the thumb-dims backfill).
export async function listItemPayloads(db) {
  const { rows } = await db.query("SELECT id, payload FROM items ORDER BY id");
  return rows;
}

export async function getItemBoard(db, id) {
  const { rows } = await db.query("SELECT board_id FROM items WHERE id=$1", [id]);
  return rows[0] || null;
}

// Group "facet/value" tag strings into { facetKey: Set(values) }.
function tagsByFacet(tags) {
  const map = new Map();
  for (const t of tags) {
    const i = t.indexOf("/");
    if (i <= 0) continue;
    const key = t.slice(0, i);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(t.slice(i + 1));
  }
  return map;
}

// A human made the call, so any AI "undecided" flag is resolved. AI reasoning
// is dropped for facets whose values changed — it justified a different choice.
export async function setItemTags(db, id, tags) {
  const { rows } = await db.query("SELECT tags, tag_reasoning FROM items WHERE id=$1", [id]);
  const reasoning = { ...(rows[0]?.tag_reasoning || {}) };
  const before = tagsByFacet(rows[0]?.tags || []);
  const after = tagsByFacet(tags);
  for (const key of Object.keys(reasoning)) {
    if (key === "fit") continue;
    const b = before.get(key) || new Set();
    const a = after.get(key) || new Set();
    if (b.size !== a.size || [...b].some((v) => !a.has(v))) delete reasoning[key];
  }
  await db.query(
    "UPDATE items SET status='tagged', tags=$1, tag_reasoning=$2, undecided=FALSE, embedding=NULL, embedding_model=NULL, updated_at=$3 WHERE id=$4",
    [JSON.stringify(tags), JSON.stringify(reasoning), Date.now(), id]
  );
  await addTagSnapshot(db, id, "user", tags, reasoning, false);
}

// Append one row of judgment history (see tag_snapshots in schema.sql).
async function addTagSnapshot(db, itemId, source, tags, reasoning, undecided) {
  await db.query(
    "INSERT INTO tag_snapshots (item_id, source, tags, reasoning, undecided, tagged_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [itemId, source, JSON.stringify(tags || []), JSON.stringify(reasoning || {}), undecided, Date.now()]
  );
}

export async function getItemReasoning(db, id) {
  const { rows } = await db.query("SELECT board_id, tag_reasoning, payload FROM items WHERE id=$1", [id]);
  return rows[0] || null;
}

// Reset an item to the extract leg so its fields are re-derived from its
// stamped mapping. Only succeeds when the item actually has a mapping stamped.
export async function reextractItem(db, id) {
  const result = await db.query(
    "UPDATE items SET status='pending_extract', attempts=0, error=NULL, updated_at=$1 WHERE id=$2 AND payload ? 'mapping'",
    [Date.now(), id]
  );
  return result.rowCount > 0;
}

// --- users / invites / sessions / favorites ---

export async function seedAdmin(db, email) {
  if (!email) return;
  email = email.trim().toLowerCase();
  await db.query(
    `INSERT INTO users (email, name, is_admin, created_at) VALUES ($1, $2, TRUE, $3)
     ON CONFLICT(email) DO UPDATE SET is_admin = TRUE`,
    [email, email.split("@")[0], Date.now()]
  );
}

export async function createUser(db, email, name) {
  email = String(email).trim().toLowerCase();
  const existing = await getUserByEmail(db, email);
  if (existing) return existing;
  const { rows } = await db.query(
    "INSERT INTO users (email, name, is_admin, created_at) VALUES ($1, $2, FALSE, $3) RETURNING *",
    [email, name || null, Date.now()]
  );
  return rows[0];
}

export async function getUserByEmail(db, email) {
  const { rows } = await db.query("SELECT * FROM users WHERE email=$1", [
    String(email).trim().toLowerCase(),
  ]);
  return rows[0] || null;
}

export async function userExists(db, id) {
  const { rows } = await db.query("SELECT 1 FROM users WHERE id=$1", [id]);
  return rows.length > 0;
}

export async function listUsers(db) {
  // No invite token here: it's a bearer credential and only its hash is stored
  // now anyway. The admin mints a fresh link on demand (POST /users/:id/link).
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.is_admin, u.last_login_at,
      (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS hearts_given
     FROM users u ORDER BY u.is_admin DESC, u.created_at ASC`
  );
  return rows;
}

export async function deleteUser(db, id) {
  // FKs cascade sessions/invites/favorites/crates.
  await db.query("DELETE FROM users WHERE id=$1 AND NOT is_admin", [id]);
}

export async function consumeInvite(db, token) {
  const hash = hashToken(token);
  const { rows } = await db.query("SELECT * FROM invites WHERE token=$1", [hash]);
  const row = rows[0];
  if (!row || row.expires_at < Date.now()) return null;
  if (!row.permanent) {
    if (row.used_at) return null;
    await db.query("UPDATE invites SET used_at=$1 WHERE token=$2", [Date.now(), hash]);
  }
  return row.user_id;
}

export async function mintPermanentInvite(db, userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await withTx(db, async (client) => {
    await client.query("DELETE FROM invites WHERE user_id=$1 AND permanent", [userId]);
    await client.query(
      `INSERT INTO invites (token, user_id, expires_at, used_at, created_at, permanent)
       VALUES ($1, $2, $3, NULL, $4, TRUE)`,
      [hashToken(token), userId, now + 100 * 365 * 24 * 3600 * 1000, now]
    );
  });
  return token; // raw token — returned once, only its hash is stored
}

export async function createSession(db, userId, ttlMs = 90 * 24 * 3600 * 1000) {
  const id = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await db.query(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    [hashToken(id), userId, now, now + ttlMs]
  );
  return id; // raw id for the cookie; the DB holds only its hash
}

export async function getSessionUser(db, sid) {
  if (!sid) return null;
  const { rows } = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > $2`,
    [hashToken(sid), Date.now()]
  );
  return rows[0] || null;
}

export async function deleteSession(db, sid) {
  if (sid) await db.query("DELETE FROM sessions WHERE id=$1", [hashToken(sid)]);
}

// Sliding expiry: renew the session to now+ttl, but only write if it hasn't
// been renewed in the last `minIdleMs` (≈ once/day). Returns true if renewed.
export async function touchSession(db, sid, ttlMs = 90 * 24 * 3600 * 1000, minIdleMs = 24 * 3600 * 1000) {
  if (!sid) return false;
  const now = Date.now();
  const result = await db.query("UPDATE sessions SET expires_at=$1 WHERE id=$2 AND expires_at < $3", [
    now + ttlMs,
    hashToken(sid),
    now + ttlMs - minIdleMs,
  ]);
  return result.rowCount > 0;
}

export async function touchLogin(db, userId) {
  await db.query("UPDATE users SET last_login_at=$1 WHERE id=$2", [Date.now(), userId]);
}

export async function toggleFavorite(db, userId, itemId) {
  const exists = (
    await db.query("SELECT 1 FROM favorites WHERE user_id=$1 AND item_id=$2", [userId, itemId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM favorites WHERE user_id=$1 AND item_id=$2", [userId, itemId]);
  } else {
    // Hearts are entity-level; item_id references entities (see schema.sql).
    const item = await db.query("SELECT 1 FROM entities WHERE id=$1", [itemId]);
    if (!item.rows.length) return null;
    await db.query("INSERT INTO favorites (user_id, item_id, created_at) VALUES ($1, $2, $3)", [
      userId,
      itemId,
      Date.now(),
    ]);
  }
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM favorites WHERE item_id=$1", [itemId]);
  return { favorited: !exists, count: rows[0].c };
}

export async function heartNames(db, itemId) {
  const { rows } = await db.query(
    `SELECT u.name, u.email FROM favorites f JOIN users u ON u.id = f.user_id
     WHERE f.item_id = $1 ORDER BY f.created_at ASC`,
    [itemId]
  );
  return rows.map((r) => r.name || r.email);
}

// --- crates ---

export async function listCrates(db, userId, boardId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, c.public, c.user_id = $1 AS owned,
      COALESCE(u.name, u.email) AS owner_name,
      (SELECT COUNT(*) FROM crate_items ci WHERE ci.crate_id = c.id) AS item_count
     FROM crates c
     JOIN users u ON u.id = c.user_id
     WHERE c.board_id = $2 AND (c.user_id = $1 OR c.public = TRUE)
     ORDER BY (c.user_id = $1) DESC, c.created_at ASC`,
    [userId, boardId]
  );
  return rows;
}

export async function createCrate(db, userId, boardId, name) {
  name = String(name).trim().slice(0, 64);
  if (!name || !boardId) return null;
  try {
    const { rows } = await db.query(
      "INSERT INTO crates (user_id, board_id, name, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
      [userId, boardId, name, Date.now()]
    );
    return { id: rows[0].id, name, public: false, owned: true, item_count: 0 };
  } catch (err) {
    if (err.code !== "23505") throw err; // anything but unique_violation is real
    const { rows } = await db.query(
      "SELECT id, name, public FROM crates WHERE user_id=$1 AND board_id=$2 AND name=$3",
      [userId, boardId, name]
    );
    if (!rows.length) return null;
    const count = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [rows[0].id]);
    return { id: rows[0].id, name: rows[0].name, public: !!rows[0].public, owned: true, item_count: count.rows[0].c };
  }
}

export async function setCratePublic(db, userId, crateId, isPublic) {
  const { rows } = await db.query(
    `UPDATE crates SET public = $3 WHERE id = $1 AND user_id = $2
     RETURNING id, name, public`,
    [crateId, userId, !!isPublic]
  );
  if (!rows.length) return null;
  const count = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  return {
    id: rows[0].id,
    name: rows[0].name,
    public: rows[0].public,
    owned: true,
    item_count: count.rows[0].c,
  };
}

export async function deleteCrate(db, userId, crateId) {
  // crate_images cascades.
  const result = await db.query("DELETE FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  return result.rowCount > 0;
}

export async function toggleCrateItem(db, userId, crateId, itemId) {
  const crate = await db.query("SELECT id, board_id FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  if (!crate.rows.length) return null;
  const exists = (
    await db.query("SELECT 1 FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId]);
  } else {
    // A crate only holds entities from its own board.
    const item = await db.query("SELECT 1 FROM entities WHERE id=$1 AND board_id=$2", [itemId, crate.rows[0].board_id]);
    if (!item.rows.length) return null;
    await db.query("INSERT INTO crate_items (crate_id, item_id, created_at) VALUES ($1, $2, $3)", [
      crateId,
      itemId,
      Date.now(),
    ]);
  }
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [crateId]);
  return { added: !exists, count: rows[0].c };
}

// --- filter configs (named facet-selection snapshots, per user per board) ---

export async function listFilterConfigs(db, userId, boardId) {
  const { rows } = await db.query(
    "SELECT id, name, config FROM filter_configs WHERE user_id=$1 AND board_id=$2 ORDER BY created_at ASC",
    [userId, boardId]
  );
  return rows;
}

// Saving under an existing name overwrites its config — "save" means
// "this name now points at the current filters".
export async function saveFilterConfig(db, userId, boardId, name, config) {
  name = String(name).trim().slice(0, 64);
  if (!name || !boardId) return null;
  const { rows } = await db.query(
    `INSERT INTO filter_configs (user_id, board_id, name, config, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, board_id, name) DO UPDATE SET config = EXCLUDED.config
     RETURNING id, name, config`,
    [userId, boardId, name, JSON.stringify(config || {}), Date.now()]
  );
  return rows[0];
}

export async function deleteFilterConfig(db, userId, id) {
  const result = await db.query("DELETE FROM filter_configs WHERE id=$1 AND user_id=$2", [id, userId]);
  return result.rowCount > 0;
}

// --- AI keys (multi-provider registry for the tagger) ---

export async function listAiKeys(db) {
  const { rows } = await db.query(
    `SELECT k.id, k.name, k.provider, k.api_key, k.created_at,
      (SELECT COUNT(*) FROM boards b WHERE b.ai_key_id = k.id) AS boards_using
     FROM ai_keys k ORDER BY k.created_at ASC`
  );
  return rows;
}

export async function getAiKey(db, id) {
  const { rows } = await db.query("SELECT id, name, provider, api_key FROM ai_keys WHERE id=$1", [id]);
  return rows[0] || null;
}

export async function createAiKey(db, name, provider, apiKey) {
  const { rows } = await db.query(
    "INSERT INTO ai_keys (name, provider, api_key, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
    [name, provider, apiKey, Date.now()]
  );
  return rows[0].id;
}

// Boards referencing the key fall back to the default via ON DELETE SET NULL;
// their model override goes with it, and if the key *was* the default, clear
// the settings pointer too.
export async function deleteAiKey(db, id) {
  await db.query("UPDATE boards SET ai_model=NULL WHERE ai_key_id=$1", [id]);
  const result = await db.query("DELETE FROM ai_keys WHERE id=$1", [id]);
  if (result.rowCount > 0 && Number(await getSetting(db, "default_key_id")) === id) {
    await setSetting(db, "default_key_id", null);
  }
  if (result.rowCount > 0 && Number(await getSetting(db, "embed_key_id")) === id) {
    await setSetting(db, "embed_key_id", null);
    await setSetting(db, "embed_enabled", null);
  }
  return result.rowCount > 0;
}

// --- boards ---

// boards.type still exists in the schema (unread legacy; drop in a later
// schema pass) but is deliberately not selected anywhere.
const BOARD_COLS =
  "id, name, facets, context, ai_reasoning, ai_research, ai_key_id, ai_model, " +
  "auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at, mapping, gather_every_min, created_at";

export async function createBoard(db, name, facets = [], context = "", aiReasoning = true, aiKeyId = null, aiModel = null, autoTag = {}, aiResearch = false) {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO boards (id, name, facets, context, ai_reasoning, ai_research, ai_key_id, ai_model,
       auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id, name, JSON.stringify(facets), context, !!aiReasoning, !!aiResearch, aiKeyId, aiModel,
      autoTag.enabled !== false, !!autoTag.periodic, autoTag.everyMin || 1440,
      !!autoTag.skipWeekends, autoTag.nextRunAt ?? null, Date.now(),
    ]
  );
  return id;
}

export async function listBoards(db) {
  const { rows } = await db.query(`SELECT ${BOARD_COLS} FROM boards ORDER BY created_at ASC`);
  return rows;
}

export async function getBoard(db, id) {
  const { rows } = await db.query(`SELECT ${BOARD_COLS} FROM boards WHERE id=$1`, [id]);
  return rows[0] || null;
}

export async function updateBoard(db, id, { name, facets, context, aiReasoning, aiResearch, aiKeyId, aiModel, autoTag, autoTagPeriodic, autoTagEveryMin, autoTagSkipWeekends, autoTagNextRunAt, mapping } = {}) {
  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(String(name).trim()); sets.push(`name=$${vals.length}`); }
  if (facets !== undefined) { vals.push(JSON.stringify(facets)); sets.push(`facets=$${vals.length}`); }
  if (context !== undefined) { vals.push(String(context)); sets.push(`context=$${vals.length}`); }
  if (aiReasoning !== undefined) { vals.push(!!aiReasoning); sets.push(`ai_reasoning=$${vals.length}`); }
  if (aiResearch !== undefined) { vals.push(!!aiResearch); sets.push(`ai_research=$${vals.length}`); }
  if (aiKeyId !== undefined) { vals.push(aiKeyId); sets.push(`ai_key_id=$${vals.length}`); }
  if (aiModel !== undefined) { vals.push(aiModel); sets.push(`ai_model=$${vals.length}`); }
  if (autoTag !== undefined) { vals.push(!!autoTag); sets.push(`auto_tag=$${vals.length}`); }
  if (autoTagPeriodic !== undefined) { vals.push(!!autoTagPeriodic); sets.push(`auto_tag_periodic=$${vals.length}`); }
  if (autoTagEveryMin !== undefined) { vals.push(autoTagEveryMin); sets.push(`auto_tag_every_min=$${vals.length}`); }
  if (autoTagSkipWeekends !== undefined) { vals.push(!!autoTagSkipWeekends); sets.push(`auto_tag_skip_weekends=$${vals.length}`); }
  if (autoTagNextRunAt !== undefined) { vals.push(autoTagNextRunAt); sets.push(`auto_tag_next_run_at=$${vals.length}`); }
  if (mapping !== undefined) { vals.push(mapping === null ? null : JSON.stringify(mapping)); sets.push(`mapping=$${vals.length}`); }
  if (!sets.length) return false;
  vals.push(id);
  const result = await db.query(`UPDATE boards SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  return result.rowCount > 0;
}

// Returns the deleted board's item payloads (the caller hands their files to
// sources.cleanup), or null if the board doesn't exist. Rows cascade via FKs.
export async function deleteBoard(db, id) {
  return withTx(db, async (client) => {
    const items = await client.query("SELECT payload FROM items WHERE board_id=$1", [id]);
    const result = await client.query("DELETE FROM boards WHERE id=$1", [id]);
    if (result.rowCount === 0) return null;
    return items.rows.map((r) => r.payload);
  });
}

export async function boardExists(db, id) {
  const { rows } = await db.query("SELECT 1 FROM boards WHERE id=$1", [id]);
  return rows.length > 0;
}

// Per-board item totals + pending/held counts in one pass: { boardId: { c, p, h } }.
export async function boardItemStats(db) {
  const { rows } = await db.query(
    `SELECT board_id, COUNT(*) AS c,
       COUNT(*) FILTER (WHERE status='pending') AS p,
       COUNT(*) FILTER (WHERE status='held') AS h
     FROM items GROUP BY board_id`
  );
  return Object.fromEntries(rows.map((r) => [r.board_id, { c: r.c, p: r.p, h: r.h }]));
}

// Queue every non-pending item in a board for retagging (held ones included —
// retag is an explicit "tag now"). Returns the count.
export async function retagBoard(db, boardId) {
  const result = await db.query(
    "UPDATE items SET status='pending', attempts=0, error=NULL, updated_at=$1 WHERE board_id=$2 AND status != 'pending'",
    [Date.now(), boardId]
  );
  return result.rowCount;
}

// --- periodic auto-tagging ---

// Release a board's held items. Items with a stamped mapping enter the
// extract leg first (pending_extract); plain items go straight to pending.
export async function releaseHeld(db, boardId) {
  const result = await db.query(
    `UPDATE items
     SET status = CASE WHEN payload ? 'mapping' THEN 'pending_extract' ELSE 'pending' END,
         updated_at = $1
     WHERE board_id = $2 AND status = 'held'`,
    [Date.now(), boardId]
  );
  return result.rowCount;
}

// Queue everything untagged in a board: held uploads, AI-undecided items,
// and failed ones (fresh attempts). Fired when auto-tagging turns on — the
// point of the board is tags, so nothing untagged is left behind. In-flight
// ('processing') and human-tagged items are untouched.
export async function queueUntagged(db, boardId) {
  const result = await db.query(
    `UPDATE items SET status='pending', attempts=0, error=NULL, updated_at=$1
     WHERE board_id=$2 AND status IN ('held','tagged','failed') AND tags='[]'::jsonb`,
    [Date.now(), boardId]
  );
  return result.rowCount;
}

// Periodic boards whose scheduled run time has arrived.
export async function dueBoards(db, now) {
  const { rows } = await db.query(
    `SELECT id, name, auto_tag_every_min, auto_tag_skip_weekends FROM boards
     WHERE auto_tag AND auto_tag_periodic AND auto_tag_next_run_at IS NOT NULL AND auto_tag_next_run_at <= $1`,
    [now]
  );
  return rows;
}

export async function setBoardNextRun(db, boardId, ts) {
  await db.query("UPDATE boards SET auto_tag_next_run_at=$1 WHERE id=$2", [ts, boardId]);
}

// --- board membership ---

export async function getBoardMemberIds(db, boardId) {
  const { rows } = await db.query("SELECT user_id FROM board_members WHERE board_id=$1", [boardId]);
  return rows.map((r) => r.user_id);
}

// User ids that are board-admins (role='admin') on this board — a subset of the
// members. Global admins aren't listed here; they manage every board implicitly.
export async function getBoardAdminIds(db, boardId) {
  const { rows } = await db.query(
    "SELECT user_id FROM board_members WHERE board_id=$1 AND role='admin'",
    [boardId]
  );
  return rows.map((r) => r.user_id);
}

// Replace a board's membership. adminIds get role='admin' (only if also members);
// everyone else is a plain 'member'. adminIds defaults to none.
export async function setBoardMembers(db, boardId, userIds, adminIds = []) {
  const admins = new Set(adminIds.map(Number));
  await withTx(db, async (client) => {
    await client.query("DELETE FROM board_members WHERE board_id=$1", [boardId]);
    for (const uid of userIds) {
      await client.query(
        "INSERT INTO board_members (board_id, user_id, role, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
        [boardId, uid, admins.has(Number(uid)) ? "admin" : "member", Date.now()]
      );
    }
  });
}

export async function canAccessBoard(db, boardId, user) {
  if (!user) return false;
  if (user.is_admin) return true;
  const { rows } = await db.query("SELECT 1 FROM board_members WHERE board_id=$1 AND user_id=$2", [
    boardId,
    user.id,
  ]);
  return rows.length > 0;
}

// May this user edit the board's content? Global admins always; otherwise a
// board-admin (board_members.role='admin'). Read side of the board-manager routes.
export async function canManageBoard(db, boardId, user) {
  if (!user) return false;
  if (user.is_admin) return true;
  const { rows } = await db.query(
    "SELECT 1 FROM board_members WHERE board_id=$1 AND user_id=$2 AND role='admin'",
    [boardId, user.id]
  );
  return rows.length > 0;
}

// --- settings ---

export async function getSetting(db, key) {
  const { rows } = await db.query("SELECT value FROM settings WHERE key=$1", [key]);
  return rows.length ? rows[0].value : null;
}

export async function setSetting(db, key, value) {
  if (value === null || value === undefined || value === "") {
    await db.query("DELETE FROM settings WHERE key=$1", [key]);
  } else {
    await db.query(
      "INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      [key, String(value)]
    );
  }
}

// --- AI tagging queue helpers ---

// Atomically take the oldest pending item and mark it processing. SKIP LOCKED
// keeps concurrent claimers (or a second worker) from grabbing the same row.
// When no default key is configured, boards without their own key are skipped —
// their items stay pending until a key appears (never failed for a missing key).
export async function claimNextPending(db, hasDefaultKey = true) {
  const { rows } = await db.query(
    `UPDATE items SET status='processing', updated_at=$1
     WHERE id = (
       SELECT i.id FROM items i JOIN boards b ON b.id = i.board_id
       WHERE i.status='pending' AND (b.ai_key_id IS NOT NULL OR $2)
       ORDER BY i.created_at ASC, i.id ASC LIMIT 1
       FOR UPDATE OF i SKIP LOCKED
     )
     RETURNING *`,
    [Date.now(), hasDefaultKey]
  );
  return rows[0] || null;
}

// Atomically take the oldest pending_extract item and mark it extracting.
// Mirrors claimNextPending; the worker poll loop calls this first.
export async function claimNextPendingExtract(db, hasDefaultKey = true) {
  const { rows } = await db.query(
    `UPDATE items SET status='extracting', updated_at=$1
     WHERE id = (
       SELECT i.id FROM items i JOIN boards b ON b.id = i.board_id
       WHERE i.status='pending_extract' AND (b.ai_key_id IS NOT NULL OR $2)
       ORDER BY i.created_at ASC, i.id ASC LIMIT 1
       FOR UPDATE OF i SKIP LOCKED
     )
     RETURNING *`,
    [Date.now(), hasDefaultKey]
  );
  return rows[0] || null;
}

// Write extracted fields into payload and advance to the tag leg.
export async function markExtracted(db, id, fields) {
  await db.query(
    `UPDATE items
     SET payload = payload || jsonb_build_object('fields', $1::jsonb),
         status = 'pending',
         attempts = 0,
         error = NULL,
         updated_at = $2
     WHERE id = $3`,
    [JSON.stringify(fields || {}), Date.now(), id]
  );
}

// --- entities ---

// Create an entity row. identity must be unique per board — a 23505 here
// means the entity already exists (connector adds answer 409; the extract
// leg re-parents instead). Returns the new id.
export async function createEntity(db, boardId, { identity, displayName = null, symbol = null, fields = {}, provisional = false } = {}) {
  const { rows } = await db.query(
    `INSERT INTO entities (board_id, identity, display_name, symbol, fields, identity_provisional, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $7) RETURNING id`,
    [boardId, identity, displayName, symbol, JSON.stringify(fields || {}), provisional, Date.now()]
  );
  return rows[0].id;
}

export async function getEntity(db, id) {
  const { rows } = await db.query("SELECT * FROM entities WHERE id=$1", [id]);
  return rows[0] || null;
}

export async function getEntityBoard(db, id) {
  const { rows } = await db.query("SELECT board_id FROM entities WHERE id=$1", [id]);
  return rows[0] || null;
}

// Find an entity by its (normalised) identity string.
export async function getEntityByIdentity(db, boardId, identity) {
  const { rows } = await db.query(
    "SELECT * FROM entities WHERE board_id=$1 AND identity=$2",
    [boardId, identity]
  );
  return rows[0] || null;
}

// Set a derived identity on an entity, clearing the provisional flag.
// displayName preserves the AI's original casing for display; identity is the
// normalised lowercase key. Throws 23505 on collision — caller re-parents the
// instance into the existing entity instead.
export async function setEntityIdentity(db, id, identity, displayName = null) {
  await db.query(
    `UPDATE entities
     SET identity=$1, display_name=COALESCE($2, display_name), identity_provisional=FALSE, updated_at=$3
     WHERE id=$4`,
    [identity, displayName, Date.now(), id]
  );
}

// Flag an entity whose identity the AI couldn't derive (still keyed by its
// provisional filename). Purely informational — nothing blocks on it.
export async function markEntityProvisional(db, id) {
  await db.query("UPDATE entities SET identity_provisional=TRUE, updated_at=$1 WHERE id=$2", [Date.now(), id]);
}

// Move an instance under another entity (the merge/split mechanism — the
// instance keeps its file, fields and tags).
export async function reparentItem(db, itemId, entityId) {
  await db.query("UPDATE items SET entity_id=$1, updated_at=$2 WHERE id=$3", [entityId, Date.now(), itemId]);
}

export async function entityInstanceCount(db, entityId) {
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM items WHERE entity_id=$1", [entityId]);
  return Number(rows[0].c);
}

// Drop an entity that lost its last instance (post merge/split re-parent).
// Returns true when it was actually deleted.
export async function deleteEntityIfEmpty(db, entityId) {
  const result = await db.query(
    "DELETE FROM entities WHERE id=$1 AND NOT EXISTS (SELECT 1 FROM items WHERE entity_id=$1)",
    [entityId]
  );
  return result.rowCount > 0;
}

// Delete an entity and (via FK cascade) all its instances. Returns the
// instances' file entries so the caller can clean the stores.
export async function deleteEntity(db, id) {
  const { rows: insts } = await db.query("SELECT payload FROM items WHERE entity_id=$1", [id]);
  const { rows } = await db.query("DELETE FROM entities WHERE id=$1 RETURNING board_id", [id]);
  if (!rows.length) return null;
  return { board_id: rows[0].board_id, files: insts.flatMap((r) => r.payload?.files || []) };
}

// Delete one instance row. Returns { payload, entity_id, board_id } for file
// cleanup and last-instance checks, or null when it doesn't exist.
export async function deleteInstance(db, id) {
  const { rows } = await db.query("DELETE FROM items WHERE id=$1 RETURNING payload, entity_id, board_id", [id]);
  return rows[0] || null;
}

// Re-queue every instance of an entity for tagging (the card-level
// "reprocess" — instances are where tags live).
export async function reprocessEntity(db, entityId) {
  const result = await db.query(
    "UPDATE items SET status='pending', tags='[]'::jsonb, tag_reasoning='{}'::jsonb, undecided=FALSE, attempts=0, error=NULL, updated_at=$1 WHERE entity_id=$2",
    [Date.now(), entityId]
  );
  return result.rowCount > 0;
}

export async function markTagged(db, id, tags, undecided = false, reasoning = {}) {
  // Clearing the vector marks the item for the embedding sweep — the text it
  // was embedded from just changed.
  await db.query(
    "UPDATE items SET status='tagged', tags=$1, undecided=$2, tag_reasoning=$3, error=NULL, embedding=NULL, embedding_model=NULL, updated_at=$4 WHERE id=$5",
    [JSON.stringify(tags), undecided, JSON.stringify(reasoning || {}), Date.now(), id]
  );
  await addTagSnapshot(db, id, "ai", tags, reasoning, undecided);
}

// --- semantic search embeddings ---

export async function setItemEmbedding(db, id, vector, model) {
  await db.query("UPDATE items SET embedding=$1, embedding_model=$2 WHERE id=$3", [
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    model,
    id,
  ]);
}

// Tagged items whose vector is missing or from another model — the embedding
// sweep's work queue. Newest first so fresh uploads become searchable before
// a long backfill finishes.
export async function itemsNeedingEmbedding(db, model, limit) {
  const { rows } = await db.query(
    `SELECT id, tags, tag_reasoning, payload FROM items
     WHERE status='tagged' AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
     ORDER BY updated_at DESC, id DESC LIMIT $2`,
    [model, limit]
  );
  return rows;
}

// Current-model vectors for one board (the search corpus). Stale vectors are
// excluded rather than compared wrongly; they reappear once re-embedded.
// entity_id rides along so search results can speak in card (entity) ids.
export async function boardEmbeddings(db, boardId, model) {
  const { rows } = await db.query(
    "SELECT id, entity_id, embedding FROM items WHERE board_id=$1 AND embedding IS NOT NULL AND embedding_model=$2",
    [boardId, model]
  );
  return rows;
}

// Backfill progress for the admin panel: how many tagged items exist and how
// many already carry a current-model vector.
export async function embeddingStats(db, model) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='tagged') AS tagged,
            COUNT(*) FILTER (WHERE status='tagged' AND embedding IS NOT NULL AND embedding_model=$1) AS embedded
     FROM items`,
    [model]
  );
  return { tagged: Number(rows[0].tagged), embedded: Number(rows[0].embedded) };
}

// Increment attempts; mark failed once attempts reach maxAttempts, else
// requeue. requeueStatus controls which queue the item returns to
// ('pending' for the tag leg, 'pending_extract' for the extract leg).
// Returns true if the item was failed.
export async function failOrRequeue(db, id, error, maxAttempts, requeueStatus = "pending") {
  const { rows } = await db.query("SELECT attempts FROM items WHERE id=$1", [id]);
  const attempts = (rows.length ? rows[0].attempts : 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : requeueStatus;
  await db.query("UPDATE items SET status=$1, attempts=$2, error=$3, updated_at=$4 WHERE id=$5", [
    status,
    attempts,
    String(error).slice(0, 500),
    Date.now(),
    id,
  ]);
  return status === "failed";
}

// Recover items stuck mid-flight after a crash. 'processing' → 'pending';
// 'extracting' → 'pending_extract'. Returns total recovered count.
export async function recoverStuck(db, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const [r1, r2] = await Promise.all([
    db.query("UPDATE items SET status='pending' WHERE status='processing' AND updated_at < $1", [cutoff]),
    db.query("UPDATE items SET status='pending_extract' WHERE status='extracting' AND updated_at < $1", [cutoff]),
  ]);
  return r1.rowCount + r2.rowCount;
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// One successful tagging call: bump the board's daily row with the token
// usage the provider reported ({ input, output, cacheRead, searches }).
export async function bumpUsage(db, boardId, usage = {}) {
  await db.query(
    `INSERT INTO ai_board_usage (day, board_id, count, input_tokens, output_tokens, cache_read_tokens, search_count)
     VALUES ($1, $2, 1, $3, $4, $5, $6)
     ON CONFLICT (day, board_id) DO UPDATE SET
       count = ai_board_usage.count + 1,
       input_tokens = ai_board_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = ai_board_usage.output_tokens + EXCLUDED.output_tokens,
       cache_read_tokens = ai_board_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
       search_count = ai_board_usage.search_count + EXCLUDED.search_count`,
    [today(), boardId, Number(usage.input) || 0, Number(usage.output) || 0, Number(usage.cacheRead) || 0, Number(usage.searches) || 0]
  );
}

// Per-board tagger usage, all-time + today, plus the last 14 days broken out
// for the admin sparkline:
// { boardId: { calls, input, output, cacheRead, searches, today: { calls, input, output },
//              days: [{ day, calls, input, output, searches }] } }  (days ascending, gaps omitted)
export async function boardAiUsage(db) {
  const { rows } = await db.query(
    `SELECT board_id,
       SUM(count) AS calls, SUM(input_tokens) AS input,
       SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
       SUM(search_count) AS searches,
       COALESCE(SUM(count)         FILTER (WHERE day=$1), 0) AS t_calls,
       COALESCE(SUM(input_tokens)  FILTER (WHERE day=$1), 0) AS t_input,
       COALESCE(SUM(output_tokens) FILTER (WHERE day=$1), 0) AS t_output
     FROM ai_board_usage GROUP BY board_id`,
    [today()]
  );
  const out = Object.fromEntries(
    rows.map((r) => [
      r.board_id,
      {
        calls: Number(r.calls),
        input: Number(r.input),
        output: Number(r.output),
        cacheRead: Number(r.cache_read),
        searches: Number(r.searches),
        today: { calls: Number(r.t_calls), input: Number(r.t_input), output: Number(r.t_output) },
        days: [],
      },
    ])
  );
  const cutoff = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
  const { rows: dayRows } = await db.query(
    `SELECT board_id, day, count, input_tokens, output_tokens, search_count
     FROM ai_board_usage WHERE day >= $1 ORDER BY day`,
    [cutoff]
  );
  for (const r of dayRows) {
    out[r.board_id]?.days.push({
      day: r.day,
      calls: Number(r.count),
      input: Number(r.input_tokens),
      output: Number(r.output_tokens),
      searches: Number(r.search_count),
    });
  }
  return out;
}

// Delete a row; returns { payload, board_id } (the caller hands the payload's
// files to sources.cleanup) or null if missing.
// Pull a board's items out of the tagging queue. Items that still carry
// their previous tags go back to 'tagged'; never-tagged ones also become
// 'tagged' but flagged undecided — the same untagged-for-human-review state
// as when the AI can't place an item. An in-flight 'processing' item is
// left to finish.
export async function cancelBoardQueue(db, boardId) {
  return withTx(db, async (client) => {
    const now = Date.now();
    const restored = (
      await client.query(
        `UPDATE items SET status='tagged', attempts=0, error=NULL, updated_at=$1
         WHERE board_id=$2 AND status='pending' AND tags != '[]'::jsonb`,
        [now, boardId]
      )
    ).rowCount;
    const cleared = (
      await client.query(
        `UPDATE items SET status='tagged', undecided=TRUE, attempts=0, error=NULL, updated_at=$1
         WHERE board_id=$2 AND status='pending'`,
        [now, boardId]
      )
    ).rowCount;
    return { restored, cleared };
  });
}

