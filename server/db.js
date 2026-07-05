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

export function openDb(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

// Apply schema.sql (idempotent CREATE IF NOT EXISTS statements).
export async function initDb(db) {
  await migrateImagesToItems(db); // must run before schema.sql (see below)
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(sql);
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

export async function countImages(db) {
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM items");
  return rows[0].c;
}

export async function listImages(db, userId = null, boardId = null) {
  const { rows } = await db.query(
    `SELECT i.id, i.payload, i.status, i.tags, i.undecided,
      (SELECT COUNT(*) FROM favorites f WHERE f.item_id = i.id) AS hearts,
      EXISTS(
        SELECT 1 FROM favorites f WHERE f.item_id = i.id AND f.user_id = $1
      ) AS fav
     FROM items i
     WHERE ($2::text IS NULL OR i.board_id = $2)
     ORDER BY i.created_at DESC, i.id DESC`,
    [userId, boardId]
  );

  const crateMap = new Map();
  if (userId) {
    const memberships = await db.query(
      `SELECT ci.item_id, ci.crate_id FROM crate_items ci
       JOIN crates c ON c.id = ci.crate_id WHERE c.user_id = $1 AND c.board_id = $2`,
      [userId, boardId]
    );
    for (const m of memberships.rows) {
      if (!crateMap.has(m.item_id)) crateMap.set(m.item_id, []);
      crateMap.get(m.item_id).push(m.crate_id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.payload.filename,
    status: r.status,
    tags: r.tags,
    undecided: !!r.undecided,
    hearts: r.hearts,
    favoritedByMe: !!r.fav,
    crateIds: crateMap.get(r.id) || [],
    w: r.payload.w || null,
    h: r.payload.h || null,
  }));
}

// status: 'pending' (tag now) or 'held' (wait — for the board's scheduled
// run, or for auto-tagging to be switched back on).
export async function insertItem(db, boardId, payload, status = "pending") {
  const { rows } = await db.query(
    `INSERT INTO items (payload, status, board_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`,
    [JSON.stringify(payload || {}), status, boardId, Date.now()]
  );
  return rows[0].id;
}

// Shallow-merge a patch into an item's payload.
export async function updateItemPayload(db, id, patch) {
  await db.query("UPDATE items SET payload = payload || $1::jsonb WHERE id=$2", [JSON.stringify(patch || {}), id]);
}

// All items living on boards of the given type: { id, payload }.
export async function listItemsByType(db, type) {
  const { rows } = await db.query(
    "SELECT i.id, i.payload FROM items i JOIN boards b ON b.id = i.board_id WHERE b.type=$1 ORDER BY i.id",
    [type]
  );
  return rows;
}

export async function getImageBoard(db, id) {
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
export async function setImageTags(db, id, tags) {
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
    "UPDATE items SET status='tagged', tags=$1, tag_reasoning=$2, undecided=FALSE, updated_at=$3 WHERE id=$4",
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

export async function getImageReasoning(db, id) {
  const { rows } = await db.query("SELECT board_id, tag_reasoning FROM items WHERE id=$1", [id]);
  return rows[0] || null;
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
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.name, u.is_admin, u.last_login_at,
      (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS hearts_given,
      (SELECT token FROM invites WHERE user_id = u.id AND permanent ORDER BY created_at DESC LIMIT 1) AS link_token
     FROM users u ORDER BY u.is_admin DESC, u.created_at ASC`
  );
  return rows;
}

export async function deleteUser(db, id) {
  // FKs cascade sessions/invites/favorites/crates.
  await db.query("DELETE FROM users WHERE id=$1 AND NOT is_admin", [id]);
}

export async function consumeInvite(db, token) {
  const { rows } = await db.query("SELECT * FROM invites WHERE token=$1", [token]);
  const row = rows[0];
  if (!row || row.expires_at < Date.now()) return null;
  if (!row.permanent) {
    if (row.used_at) return null;
    await db.query("UPDATE invites SET used_at=$1 WHERE token=$2", [Date.now(), token]);
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
      [token, userId, now + 100 * 365 * 24 * 3600 * 1000, now]
    );
  });
  return token;
}

export async function createSession(db, userId, ttlMs = 90 * 24 * 3600 * 1000) {
  const id = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  await db.query(
    "INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    [id, userId, now, now + ttlMs]
  );
  return id;
}

export async function getSessionUser(db, sid) {
  if (!sid) return null;
  const { rows } = await db.query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > $2`,
    [sid, Date.now()]
  );
  return rows[0] || null;
}

export async function deleteSession(db, sid) {
  if (sid) await db.query("DELETE FROM sessions WHERE id=$1", [sid]);
}

// Sliding expiry: renew the session to now+ttl, but only write if it hasn't
// been renewed in the last `minIdleMs` (≈ once/day). Returns true if renewed.
export async function touchSession(db, sid, ttlMs = 90 * 24 * 3600 * 1000, minIdleMs = 24 * 3600 * 1000) {
  if (!sid) return false;
  const now = Date.now();
  const result = await db.query("UPDATE sessions SET expires_at=$1 WHERE id=$2 AND expires_at < $3", [
    now + ttlMs,
    sid,
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
    const item = await db.query("SELECT 1 FROM items WHERE id=$1", [itemId]);
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
    `SELECT c.id, c.name,
      (SELECT COUNT(*) FROM crate_items ci WHERE ci.crate_id = c.id) AS image_count
     FROM crates c WHERE c.user_id = $1 AND c.board_id = $2 ORDER BY c.created_at ASC`,
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
    return { id: rows[0].id, name, image_count: 0 };
  } catch (err) {
    if (err.code !== "23505") throw err; // anything but unique_violation is real
    const { rows } = await db.query(
      "SELECT id, name FROM crates WHERE user_id=$1 AND board_id=$2 AND name=$3",
      [userId, boardId, name]
    );
    if (!rows.length) return null;
    const count = await db.query("SELECT COUNT(*) AS c FROM crate_items WHERE crate_id=$1", [rows[0].id]);
    return { id: rows[0].id, name: rows[0].name, image_count: count.rows[0].c };
  }
}

export async function deleteCrate(db, userId, crateId) {
  // crate_images cascades.
  const result = await db.query("DELETE FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  return result.rowCount > 0;
}

export async function toggleCrateImage(db, userId, crateId, itemId) {
  const crate = await db.query("SELECT id, board_id FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  if (!crate.rows.length) return null;
  const exists = (
    await db.query("SELECT 1 FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM crate_items WHERE crate_id=$1 AND item_id=$2", [crateId, itemId]);
  } else {
    // A crate only holds items from its own board.
    const item = await db.query("SELECT 1 FROM items WHERE id=$1 AND board_id=$2", [itemId, crate.rows[0].board_id]);
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
  return result.rowCount > 0;
}

// --- boards ---

const BOARD_COLS =
  "id, name, type, facets, context, ai_reasoning, ai_key_id, ai_model, " +
  "auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at, created_at";

export async function createBoard(db, name, facets = [], context = "", aiReasoning = true, aiKeyId = null, aiModel = null, autoTag = {}, type = "image") {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO boards (id, name, type, facets, context, ai_reasoning, ai_key_id, ai_model,
       auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id, name, type, JSON.stringify(facets), context, !!aiReasoning, aiKeyId, aiModel,
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

export async function updateBoard(db, id, { name, facets, context, aiReasoning, aiKeyId, aiModel, autoTag, autoTagPeriodic, autoTagEveryMin, autoTagSkipWeekends, autoTagNextRunAt } = {}) {
  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(String(name).trim()); sets.push(`name=$${vals.length}`); }
  if (facets !== undefined) { vals.push(JSON.stringify(facets)); sets.push(`facets=$${vals.length}`); }
  if (context !== undefined) { vals.push(String(context)); sets.push(`context=$${vals.length}`); }
  if (aiReasoning !== undefined) { vals.push(!!aiReasoning); sets.push(`ai_reasoning=$${vals.length}`); }
  if (aiKeyId !== undefined) { vals.push(aiKeyId); sets.push(`ai_key_id=$${vals.length}`); }
  if (aiModel !== undefined) { vals.push(aiModel); sets.push(`ai_model=$${vals.length}`); }
  if (autoTag !== undefined) { vals.push(!!autoTag); sets.push(`auto_tag=$${vals.length}`); }
  if (autoTagPeriodic !== undefined) { vals.push(!!autoTagPeriodic); sets.push(`auto_tag_periodic=$${vals.length}`); }
  if (autoTagEveryMin !== undefined) { vals.push(autoTagEveryMin); sets.push(`auto_tag_every_min=$${vals.length}`); }
  if (autoTagSkipWeekends !== undefined) { vals.push(!!autoTagSkipWeekends); sets.push(`auto_tag_skip_weekends=$${vals.length}`); }
  if (autoTagNextRunAt !== undefined) { vals.push(autoTagNextRunAt); sets.push(`auto_tag_next_run_at=$${vals.length}`); }
  if (!sets.length) return false;
  vals.push(id);
  const result = await db.query(`UPDATE boards SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  return result.rowCount > 0;
}

// Returns the deleted board's item payloads (the board type's onDelete cleans
// up whatever they reference), or null if the board doesn't exist. Rows
// cascade via FKs.
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

// Per-board image totals + pending/held counts in one pass: { boardId: { c, p, h } }.
export async function boardImageStats(db) {
  const { rows } = await db.query(
    `SELECT board_id, COUNT(*) AS c,
       COUNT(*) FILTER (WHERE status='pending') AS p,
       COUNT(*) FILTER (WHERE status='held') AS h
     FROM items GROUP BY board_id`
  );
  return Object.fromEntries(rows.map((r) => [r.board_id, { c: r.c, p: r.p, h: r.h }]));
}

// Queue every non-pending image in a board for retagging (held ones included —
// retag is an explicit "tag now"). Returns the count.
export async function retagBoard(db, boardId) {
  const result = await db.query(
    "UPDATE items SET status='pending', attempts=0, error=NULL, updated_at=$1 WHERE board_id=$2 AND status != 'pending'",
    [Date.now(), boardId]
  );
  return result.rowCount;
}

// --- periodic auto-tagging ---

// Release a board's held images into the tagging queue. Returns the count.
export async function releaseHeld(db, boardId) {
  const result = await db.query(
    "UPDATE items SET status='pending', updated_at=$1 WHERE board_id=$2 AND status='held'",
    [Date.now(), boardId]
  );
  return result.rowCount;
}

// Queue everything untagged in a board: held uploads, AI-undecided images,
// and failed ones (fresh attempts). Fired when auto-tagging turns on — the
// point of the board is tags, so nothing untagged is left behind. In-flight
// ('processing') and human-tagged images are untouched.
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

export async function setBoardMembers(db, boardId, userIds) {
  await withTx(db, async (client) => {
    await client.query("DELETE FROM board_members WHERE board_id=$1", [boardId]);
    for (const uid of userIds) {
      await client.query(
        "INSERT INTO board_members (board_id, user_id, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        [boardId, uid, Date.now()]
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

export async function markTagged(db, id, tags, undecided = false, reasoning = {}) {
  await db.query(
    "UPDATE items SET status='tagged', tags=$1, undecided=$2, tag_reasoning=$3, error=NULL, updated_at=$4 WHERE id=$5",
    [JSON.stringify(tags), undecided, JSON.stringify(reasoning || {}), Date.now(), id]
  );
  await addTagSnapshot(db, id, "ai", tags, reasoning, undecided);
}

// Increment attempts; mark failed once attempts reach maxAttempts, else requeue. Returns true if failed.
export async function failOrRequeue(db, id, error, maxAttempts) {
  const { rows } = await db.query("SELECT attempts FROM items WHERE id=$1", [id]);
  const attempts = (rows.length ? rows[0].attempts : 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  await db.query("UPDATE items SET status=$1, attempts=$2, error=$3, updated_at=$4 WHERE id=$5", [
    status,
    attempts,
    String(error).slice(0, 500),
    Date.now(),
    id,
  ]);
  return status === "failed";
}

// Recover rows stuck in 'processing' (e.g. after a crash) back to pending.
export async function recoverStuck(db, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  const result = await db.query(
    "UPDATE items SET status='pending' WHERE status='processing' AND updated_at < $1",
    [cutoff]
  );
  return result.rowCount;
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

// One successful tagging call: bump the board's daily row with the token
// usage the provider reported ({ input, output, cacheRead }).
export async function bumpUsage(db, boardId, usage = {}) {
  await db.query(
    `INSERT INTO ai_board_usage (day, board_id, count, input_tokens, output_tokens, cache_read_tokens)
     VALUES ($1, $2, 1, $3, $4, $5)
     ON CONFLICT (day, board_id) DO UPDATE SET
       count = ai_board_usage.count + 1,
       input_tokens = ai_board_usage.input_tokens + EXCLUDED.input_tokens,
       output_tokens = ai_board_usage.output_tokens + EXCLUDED.output_tokens,
       cache_read_tokens = ai_board_usage.cache_read_tokens + EXCLUDED.cache_read_tokens`,
    [today(), boardId, Number(usage.input) || 0, Number(usage.output) || 0, Number(usage.cacheRead) || 0]
  );
}

// Per-board tagger usage, all-time + today, plus the last 14 days broken out
// for the admin sparkline:
// { boardId: { calls, input, output, cacheRead, today: { calls, input, output },
//              days: [{ day, calls, input, output }] } }  (days ascending, gaps omitted)
export async function boardAiUsage(db) {
  const { rows } = await db.query(
    `SELECT board_id,
       SUM(count) AS calls, SUM(input_tokens) AS input,
       SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read,
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
        today: { calls: Number(r.t_calls), input: Number(r.t_input), output: Number(r.t_output) },
        days: [],
      },
    ])
  );
  const cutoff = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
  const { rows: dayRows } = await db.query(
    `SELECT board_id, day, count, input_tokens, output_tokens
     FROM ai_board_usage WHERE day >= $1 ORDER BY day`,
    [cutoff]
  );
  for (const r of dayRows) {
    out[r.board_id]?.days.push({
      day: r.day,
      calls: Number(r.count),
      input: Number(r.input_tokens),
      output: Number(r.output_tokens),
    });
  }
  return out;
}

// Delete a row; returns { payload, board_id } (the board type's onDelete
// cleans up whatever the payload references) or null if missing.
export async function deleteItem(db, id) {
  const { rows } = await db.query("DELETE FROM items WHERE id=$1 RETURNING payload, board_id", [id]);
  return rows[0] || null;
}

// Pull a board's images out of the tagging queue. Images that still carry
// their previous tags go back to 'tagged'; never-tagged ones also become
// 'tagged' but flagged undecided — the same untagged-for-human-review state
// as when the AI can't place an image. An in-flight 'processing' image is
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

// Reset an item back to the tagging queue. Returns true if it existed.
export async function reprocessImage(db, id) {
  const result = await db.query(
    "UPDATE items SET status='pending', tags='[]'::jsonb, tag_reasoning='{}'::jsonb, undecided=FALSE, attempts=0, error=NULL, updated_at=$1 WHERE id=$2",
    [Date.now(), id]
  );
  return result.rowCount > 0;
}
