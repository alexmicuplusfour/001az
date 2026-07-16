import pg from "pg";
import crypto from "node:crypto";
import { runMigrations } from "./migrate.js";

// BIGINT (int8) comes back from pg as a string by default. Everything we store
// in BIGINT is a ms epoch or a row id — both far below 2^53 — so parse to
// Number globally. Without this, every `expires_at < Date.now()` style
// comparison silently breaks.
pg.types.setTypeParser(20, Number);

// Session ids and invite tokens are bearer credentials: the raw value goes to
// the client (cookie / login URL) but only its SHA-256 is stored, so a DB read
// can't be replayed as a login. Raw tokens are 48 hex chars, digests 64 — the
// length gap drives migration 0003_hash_bearer_tokens.
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

export function openDb(databaseUrl) {
  return new pg.Pool({ connectionString: databaseUrl, max: 5 });
}

// Bring the schema up to date, then reconcile live-refresh schedules. The schema
// itself — baseline plus every historical data transform — is the versioned
// migration ledger in server/migrations (run once each, recorded in
// schema_migrations; see runMigrations). reconcileLiveSchedules is NOT a
// migration: it recomputes refresh_at from the current board mappings on every
// boot, so it stays here.
export async function initDb(db) {
  await runMigrations(db);
  await reconcileLiveSchedules(db);
}

// Ensure every entity on a board with live connector fields has a refresh_at.
// Covers boards configured live before this feature deployed (or before a build
// that scheduled them) — otherwise their entities sit with refresh_at NULL and
// the sweep never sees them until the mapping is re-saved. Idempotent: it just
// recomputes min(field.at + every*60000), the correct next-due, each boot.
async function reconcileLiveSchedules(db) {
  const { rows } = await db.query("SELECT id, mapping FROM boards WHERE mapping IS NOT NULL");
  for (const b of rows) {
    const live = (b.mapping?.fields || []).filter((f) => f.from === "connector" && f.live);
    const fc = b.mapping?.face;
    const faceCad = fc && fc.from === "connector" && fc.live ? { every: fc.every } : null;
    if (live.length || faceCad) await rescheduleEntityRefreshes(db, b.id, live, faceCad);
  }
}

// Run fn with a dedicated client inside BEGIN/COMMIT.
export async function withTx(db, fn) {
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
const STATUS_PRIORITY = ["facing", "pending_face", "extracting", "pending_extract", "processing", "pending", "failed", "held"];
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
//
// Three modes, one query shape:
// - no opts: the whole board (legacy full list).
// - limit/after: one keyset page, walking (created_at DESC, id DESC); the
//   cursor is the last row's (created_at, id) pair. Returns nextCursor while
//   pages remain (emitted only on exactly-full pages, so an exact-multiple
//   total costs one final empty page).
// - since: only entities changed after the given ms stamp — their own
//   updated_at or any of their instances'. Timestamps are BIGINT ms, so
//   cursors round-trip exactly (see the type-parser note at the top).
export async function listItems(db, userId = null, boardId = null, { limit = null, after = null, since = null } = {}) {
  const params = [userId, boardId];
  const where = ["($2::text IS NULL OR e.board_id = $2)"];
  let tail = "";
  if (since != null) {
    params.push(since);
    where.push(`(e.updated_at > $3 OR e.id IN (SELECT entity_id FROM items WHERE board_id = $2 AND updated_at > $3))`);
  } else {
    if (after != null) {
      params.push(after.createdAt, after.id);
      where.push(`(e.created_at, e.id) < ($${params.length - 1}::bigint, $${params.length}::bigint)`);
    }
    if (limit != null) {
      params.push(limit);
      tail = ` LIMIT $${params.length}`;
    }
  }
  const { rows: ents } = await db.query(
    `SELECT e.id, e.identity, e.display_name, e.symbol, e.fields, e.identity_provisional, e.created_at,
      e.uploaded_by AS uploader_id, u.name AS uploader_name, u.email AS uploader_email,
      COALESCE(fh.hearts, 0) AS hearts,
      (fme.user_id IS NOT NULL) AS fav
     FROM entities e
     LEFT JOIN users u ON u.id = e.uploaded_by
     LEFT JOIN (SELECT item_id, COUNT(*)::int AS hearts FROM favorites GROUP BY item_id) fh ON fh.item_id = e.id
     LEFT JOIN favorites fme ON fme.item_id = e.id AND fme.user_id = $1
     WHERE ${where.join(" AND ")}
     ORDER BY e.created_at DESC, e.id DESC${tail}`,
    params
  );

  // A page/delta covers a known set of entities — fetch just their instances
  // (an entity needs ALL of them for aggregateStatus and the face mirror).
  // The full listing keeps the board-wide query.
  const partial = limit != null || after != null || since != null;
  const { rows: insts } = await db.query(
    partial
      ? `SELECT id, entity_id, status, tags, undecided, payload FROM items
         WHERE entity_id = ANY($1::bigint[])
         ORDER BY created_at ASC, id ASC`
      : `SELECT id, entity_id, status, tags, undecided, payload FROM items
         WHERE ($1::text IS NULL OR board_id = $1)
         ORDER BY created_at ASC, id ASC`,
    [partial ? ents.map((e) => e.id) : boardId]
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

  const items = ents.map((e) => {
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
      uploadedBy: e.uploader_id ? { id: e.uploader_id, name: e.uploader_name || null, email: e.uploader_email } : null,
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

  let nextCursor = null;
  if (limit != null && ents.length === limit) {
    const last = ents[ents.length - 1];
    nextCursor = `${last.created_at}_${last.id}`;
  }
  return { items, nextCursor };
}

// All entity ids on a board, in one cheap scan — delta polls ship this so the
// client can tell "unchanged" apart from "merged/deleted" without the full list.
export async function listEntityIds(db, boardId) {
  const { rows } = await db.query("SELECT id FROM entities WHERE board_id = $1", [boardId]);
  return rows.map((r) => r.id);
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

// Bulk form of updateItemPayload: shallow-merge a per-item patch into many items
// in a single round-trip. `patches` is [{ id, patch }]. The file-field backfill
// uses this so a mapping change touching every item is one write, not one per row.
export async function updateItemPayloads(db, patches) {
  if (!patches.length) return;
  await db.query(
    `UPDATE items AS i SET payload = i.payload || u.patch
     FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, patch jsonb)
     WHERE i.id = u.id`,
    [JSON.stringify(patches)]
  );
}

// Every item's { id, payload } (startup sweeps like the thumb-dims backfill).
export async function listItemPayloads(db) {
  const { rows } = await db.query("SELECT id, payload FROM items ORDER BY id");
  return rows;
}

// One board's item payloads — used to backfill file-metadata fields when a
// board's file-field set changes (server/media projection over stored entries).
// created_at rides along so a legacy entry can source its `added` date from it.
export async function boardItemPayloads(db, boardId) {
  const { rows } = await db.query("SELECT id, payload, created_at FROM items WHERE board_id=$1 ORDER BY id", [boardId]);
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
    "UPDATE items SET status='tagged', tags=$1, tag_reasoning=$2, undecided=FALSE, embedding=NULL, embedding_model=NULL, embed_error=NULL, updated_at=$3 WHERE id=$4",
    [JSON.stringify(tags), JSON.stringify(reasoning), Date.now(), id]
  );
  await addTagSnapshot(db, id, "user", tags, reasoning, false);
}

// Order-insensitive tag comparison for the snapshot dedupe below.
const sameTagSet = (a, b) => {
  const x = [...(a || [])].sort(), y = [...(b || [])].sort();
  return x.length === y.length && x.every((t, i) => t === y[i]);
};

// Append one row of judgment history (see tag_snapshots in 0001_baseline.sql).
// History records CHANGES — the mirror of field_snapshots' moved-only
// discipline: a tagging that lands the same tags and verdict as the item's
// latest snapshot appends nothing. Reasoning is excluded from the comparison
// (the model re-words it every call — presentation, not judgment), and so is
// source (a user's no-op save is still a no-op). Without this, a periodic
// retag re-records every stable item's unchanged judgment each pass, and a
// retag_on_refresh live board writes ~1.4k identical rows per item per day.
async function addTagSnapshot(db, itemId, source, tags, reasoning, undecided) {
  const { rows: [last] } = await db.query(
    "SELECT tags, undecided FROM tag_snapshots WHERE item_id=$1 ORDER BY tagged_at DESC, id DESC LIMIT 1",
    [itemId]
  );
  if (last && last.undecided === undecided && sameTagSet(last.tags, tags)) return;
  await db.query(
    "INSERT INTO tag_snapshots (item_id, source, tags, reasoning, undecided, tagged_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [itemId, source, JSON.stringify(tags || []), JSON.stringify(reasoning || {}), undecided, Date.now()]
  );
}

export async function getItemReasoning(db, id) {
  const { rows } = await db.query("SELECT board_id, tag_reasoning, payload FROM items WHERE id=$1", [id]);
  return rows[0] || null;
}

// The mapping to stamp for AI extraction: the given mapping when it has AI
// work in it (derived identity or AI fields), else null. Mirrors ingest's
// hasMapping gate.
function aiMappingJson(mapping) {
  const hasAi =
    mapping?.identity?.from === "ai" ||
    (Array.isArray(mapping?.fields) && mapping.fields.some((f) => f.from === "ai"));
  return hasAi ? JSON.stringify(mapping) : null;
}

async function boardAiMappingJson(db, boardId) {
  const { rows } = await db.query("SELECT mapping FROM boards WHERE id=$1", [boardId]);
  return rows.length ? aiMappingJson(rows[0].mapping) : null;
}

// Reset an item to the extract leg. User-initiated, so the CURRENT board
// mapping is what applies — it's re-stamped onto the instance (the stamp an
// instance was built with only governs automatic replay, e.g. error retries).
// A board with no AI mapping falls back to replaying the instance's stamp;
// with neither there is nothing to extract.
export async function reextractItem(db, id) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM items i JOIN boards b ON b.id = i.board_id WHERE i.id=$1", [id]);
  if (!rows.length) return false;
  const current = aiMappingJson(rows[0].mapping);
  // `- 'park'`: an explicit re-extract runs the full pipeline through tagging,
  // even on an auto-tag-off board — park only gates the automatic ingest flow.
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN $3::jsonb IS NULL THEN payload - 'park'
                        ELSE jsonb_set(payload - 'park', '{mapping}', $3::jsonb) END,
         status='pending_extract', attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE id=$2 AND ($3::jsonb IS NOT NULL OR payload ? 'mapping')`,
    [Date.now(), id, current]
  );
  return result.rowCount > 0;
}

// Reset one instance to the tag leg — re-tag it from its existing material and
// fields, without re-deriving identity/fields. The per-instance counterpart to
// the card-level full reprocess (reprocessEntity); the lightbox exposes it next
// to Re-extract since a single instance is what's in focus there.
export async function retagItem(db, id) {
  const result = await db.query(
    "UPDATE items SET status='pending', tags='[]'::jsonb, tag_reasoning='{}'::jsonb, undecided=FALSE, attempts=0, error=NULL, retry_at=NULL, updated_at=$1 WHERE id=$2",
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
    // Hearts are entity-level; item_id references entities (see 0001_baseline.sql).
    const item = await db.query("SELECT 1 FROM entities WHERE id=$1", [itemId]);
    if (!item.rows.length) return null;
    await db.query("INSERT INTO favorites (user_id, item_id, created_at) VALUES ($1, $2, $3)", [
      userId,
      itemId,
      Date.now(),
    ]);
  }
  // The heart count is part of the entity's list payload — stamp it so other
  // viewers' delta polls pick the change up.
  await touchEntity(db, itemId);
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
  // crateIds ride in the entity's list payload — stamp for delta polls.
  await touchEntity(db, itemId);
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
      (SELECT COUNT(*) FROM boards b WHERE b.ai_key_id = k.id OR b.extract_key_id = k.id) AS boards_using
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
  await db.query("UPDATE boards SET extract_model=NULL WHERE extract_key_id=$1", [id]);
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
  "extract_key_id, extract_model, " +
  "auto_tag, auto_tag_periodic, auto_tag_every_min, auto_tag_skip_weekends, auto_tag_next_run_at, mapping, gather_every_min, retag_on_refresh, " +
  "ingest, ingest_next_run_at, ingest_state, created_at";

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

export async function updateBoard(db, id, { name, facets, context, aiReasoning, aiResearch, aiKeyId, aiModel, extractKeyId, extractModel, autoTag, autoTagPeriodic, autoTagEveryMin, autoTagSkipWeekends, autoTagNextRunAt, mapping, retagOnRefresh, ingest, ingestNextRunAt } = {}) {
  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(String(name).trim()); sets.push(`name=$${vals.length}`); }
  if (facets !== undefined) { vals.push(JSON.stringify(facets)); sets.push(`facets=$${vals.length}`); }
  if (context !== undefined) { vals.push(String(context)); sets.push(`context=$${vals.length}`); }
  if (aiReasoning !== undefined) { vals.push(!!aiReasoning); sets.push(`ai_reasoning=$${vals.length}`); }
  if (aiResearch !== undefined) { vals.push(!!aiResearch); sets.push(`ai_research=$${vals.length}`); }
  if (aiKeyId !== undefined) { vals.push(aiKeyId); sets.push(`ai_key_id=$${vals.length}`); }
  if (aiModel !== undefined) { vals.push(aiModel); sets.push(`ai_model=$${vals.length}`); }
  if (extractKeyId !== undefined) { vals.push(extractKeyId); sets.push(`extract_key_id=$${vals.length}`); }
  if (extractModel !== undefined) { vals.push(extractModel); sets.push(`extract_model=$${vals.length}`); }
  if (autoTag !== undefined) { vals.push(!!autoTag); sets.push(`auto_tag=$${vals.length}`); }
  if (autoTagPeriodic !== undefined) { vals.push(!!autoTagPeriodic); sets.push(`auto_tag_periodic=$${vals.length}`); }
  if (autoTagEveryMin !== undefined) { vals.push(autoTagEveryMin); sets.push(`auto_tag_every_min=$${vals.length}`); }
  if (autoTagSkipWeekends !== undefined) { vals.push(!!autoTagSkipWeekends); sets.push(`auto_tag_skip_weekends=$${vals.length}`); }
  if (autoTagNextRunAt !== undefined) { vals.push(autoTagNextRunAt); sets.push(`auto_tag_next_run_at=$${vals.length}`); }
  if (mapping !== undefined) { vals.push(mapping === null ? null : JSON.stringify(mapping)); sets.push(`mapping=$${vals.length}`); }
  if (retagOnRefresh !== undefined) { vals.push(!!retagOnRefresh); sets.push(`retag_on_refresh=$${vals.length}`); }
  if (ingest !== undefined) { vals.push(ingest === null ? null : JSON.stringify(ingest)); sets.push(`ingest=$${vals.length}`); }
  if (ingestNextRunAt !== undefined) { vals.push(ingestNextRunAt); sets.push(`ingest_next_run_at=$${vals.length}`); }
  // ingest_state is deliberately absent: the sweep owns it (setIngestState).
  if (!sets.length) return false;
  vals.push(id);
  const result = await db.query(`UPDATE boards SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  return result.rowCount > 0;
}

// Returns the deleted board's item payloads (the caller hands their files to
// sources.cleanup), or null if the board doesn't exist. Rows cascade via FKs.
export async function deleteBoard(db, id) {
  return withTx(db, async (client) => {
    // Lock first: the tx alone doesn't stop a concurrent ingest/reparent from
    // slipping an item between the payload read and the cascade (orphaning its
    // file). FK references take FOR KEY SHARE on this row, so they block here
    // and fail cleanly once the delete commits.
    const locked = await client.query("SELECT 1 FROM boards WHERE id=$1 FOR UPDATE", [id]);
    if (!locked.rows.length) return null;
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

// Queue a board's settled items for a fresh tagging pass (held ones included —
// retag is an explicit "tag now"). Returns the count. Only terminal states are
// touched: items still in the pipeline (pending_extract/extracting/
// pending_face/facing/processing) already end in the tag leg when their legs
// finish, so flipping them here would only skip their definition legs and tag
// them with no fields, identity or face. Touched items resume the RIGHT leg,
// with the same routing as releaseHeld: an unfaced connector vehicle re-enters
// the face leg (another shot at the chart), anything already extracted goes
// straight to tagging, anything not yet extracted — a failed extraction, or a
// tagged item that never got its definition — re-enters the extract leg. Held
// items with no stamp adopt the current board mapping (the board may have
// gained one since they were uploaded); other unstamped items stay tag-only,
// so retag never turns into a surprise extraction sweep over a whole board.
export async function retagBoard(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN status='held' AND NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = CASE
           WHEN payload->'mapping'->'face'->>'from' = 'connector'
                AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0 THEN 'pending_face'
           WHEN payload ? 'extracted_at' THEN 'pending'
           WHEN (payload ? 'mapping') OR (status='held' AND $3::jsonb IS NOT NULL) THEN 'pending_extract'
           ELSE 'pending' END,
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status IN ('tagged','failed','held')`,
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// --- periodic auto-tagging ---

// Release a board's held items. Connector entities awaiting a chart face enter
// the face leg (pending_face); already-extracted items (the extract leg runs
// even with auto-tag off and parks them back in held) go straight to the tag
// leg; items with AI extraction still to do enter the extract leg. Held items
// with no stamp adopt the current board mapping — the board may have gained
// one since they were uploaded.
export async function releaseHeld(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = CASE
           WHEN payload->'mapping'->'face'->>'from' = 'connector'
                AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0 THEN 'pending_face'
           WHEN payload ? 'extracted_at' THEN 'pending'
           WHEN (payload ? 'mapping') OR $3::jsonb IS NOT NULL THEN 'pending_extract'
           ELSE 'pending' END,
         updated_at = $1
     WHERE board_id = $2 AND status = 'held'`,
    [Date.now(), boardId, current]
  );
  return result.rowCount;
}

// Queue everything untagged in a board: held uploads, AI-undecided items,
// and failed ones (fresh attempts). Fired when auto-tagging turns on — the
// point of the board is tags, so nothing untagged is left behind. In-flight
// ('processing') and human-tagged items are untouched. Everything routes
// through the face/extract legs exactly like releaseHeld/retagBoard:
// already-extracted items go straight to tagging, ones whose definition never
// ran — including an extraction that FAILED — resume the extract leg, and
// unstamped held items adopt the board mapping.
export async function queueUntagged(db, boardId) {
  const current = await boardAiMappingJson(db, boardId);
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN status='held' AND NOT (payload ? 'mapping') AND NOT (payload ? 'extracted_at') AND $3::jsonb IS NOT NULL
                        THEN jsonb_set(payload, '{mapping}', $3::jsonb) ELSE payload END,
         status = CASE
           WHEN payload->'mapping'->'face'->>'from' = 'connector'
                AND jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0 THEN 'pending_face'
           WHEN payload ? 'extracted_at' THEN 'pending'
           WHEN (payload ? 'mapping') OR (status='held' AND $3::jsonb IS NOT NULL) THEN 'pending_extract'
           ELSE 'pending' END,
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE board_id=$2 AND status IN ('held','tagged','failed') AND tags='[]'::jsonb`,
    [Date.now(), boardId, current]
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

// --- automatic ingestion ---

// Boards whose ingestion run time has arrived. Full rows: the sweep needs the
// mapping (adapter resolution) and the ingest config/state (budget, trigger).
export async function dueIngestBoards(db, now) {
  const { rows } = await db.query(
    `SELECT ${BOARD_COLS} FROM boards
     WHERE ingest IS NOT NULL AND COALESCE((ingest->>'enabled')::boolean, false)
       AND ingest_next_run_at IS NOT NULL AND ingest_next_run_at <= $1`,
    [now]
  );
  return rows;
}

export async function setIngestNextRun(db, boardId, ts) {
  await db.query("UPDATE boards SET ingest_next_run_at=$1 WHERE id=$2", [ts, boardId]);
}

// Sweep-owned run status (last_run_at, last_added, last_error, drain_left) —
// kept out of updateBoard so a user saving config never clobbers it.
export async function setIngestState(db, boardId, state) {
  await db.query("UPDATE boards SET ingest_state=$1 WHERE id=$2", [state === null ? null : JSON.stringify(state), boardId]);
}

// The one sweep-state field a config save IS allowed to touch: drain_left is
// the unfinished budget of the run the OLD config started — carrying it into
// a new config hands the next run a stale limit. Run history stays.
export async function clearIngestDrain(db, boardId) {
  await db.query("UPDATE boards SET ingest_state = ingest_state - 'drain_left' WHERE id=$1", [boardId]);
}

// The dedup ledger: every source_key ever admitted to this board. Rows outlive
// their entities on purpose — deleting an item is a user judgment the feed
// must not overturn on the next scan.
export async function ingestedKeys(db, boardId) {
  const { rows } = await db.query("SELECT source_key FROM ingest_log WHERE board_id=$1", [boardId]);
  return new Set(rows.map((r) => r.source_key));
}

// Ledger membership for a handful of specific keys (a preview page) — a PK
// probe instead of materializing a board's whole ledger.
export async function ingestedAmong(db, boardId, keys) {
  if (!keys.length) return new Set();
  const { rows } = await db.query(
    "SELECT source_key FROM ingest_log WHERE board_id=$1 AND source_key = ANY($2)",
    [boardId, keys]
  );
  return new Set(rows.map((r) => r.source_key));
}

// Accepts the pool or a tx client (the folder adapter ledgers inside the
// admit transaction).
export async function recordIngest(dbc, boardId, sourceKey, at) {
  await dbc.query(
    "INSERT INTO ingest_log (board_id, source_key, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
    [boardId, sourceKey, at]
  );
}

// --- source connections (reusable credentials for remote ingestion sources) ---
// One row per saved connection (ftp/s3 host+login), referenced by boards from
// JSONB (ingest.source.connectionId). Secrets live in `config` — the routes
// mask them on read and the runtime reads them raw. Mirrors the ai_keys shape.

export async function listSourceConnections(db, type = null) {
  const { rows } = await db.query(
    `SELECT c.id, c.type, c.label, c.config, c.created_at, c.updated_at,
       (SELECT COUNT(*) FROM boards b WHERE (b.ingest #>> '{source,connectionId}') = c.id::text) AS boards_using
     FROM source_connections c
     ${type ? "WHERE c.type = $1" : ""}
     ORDER BY c.created_at ASC`,
    type ? [type] : []
  );
  return rows;
}

export async function getSourceConnection(db, id) {
  if (!Number.isFinite(Number(id))) return null;
  const { rows } = await db.query("SELECT id, type, label, config FROM source_connections WHERE id=$1", [Number(id)]);
  return rows[0] || null;
}

export async function createSourceConnection(db, type, label, config) {
  const now = Date.now();
  const { rows } = await db.query(
    "INSERT INTO source_connections (type, label, config, created_at, updated_at) VALUES ($1, $2, $3::jsonb, $4, $4) RETURNING id",
    [type, label, JSON.stringify(config || {}), now]
  );
  return rows[0].id;
}

// Partial: an undefined field is left alone. `config` is a full replacement of
// the merged object — the route merges blank-secret-keeps before calling.
export async function updateSourceConnection(db, id, { label, config } = {}) {
  const sets = [];
  const vals = [];
  let i = 1;
  if (label !== undefined) { sets.push(`label=$${i++}`); vals.push(label); }
  if (config !== undefined) { sets.push(`config=$${i++}::jsonb`); vals.push(JSON.stringify(config)); }
  if (!sets.length) return false;
  sets.push(`updated_at=$${i++}`); vals.push(Date.now());
  vals.push(Number(id));
  const r = await db.query(`UPDATE source_connections SET ${sets.join(", ")} WHERE id=$${i}`, vals);
  return r.rowCount > 0;
}

export async function deleteSourceConnection(db, id) {
  const r = await db.query("DELETE FROM source_connections WHERE id=$1", [Number(id)]);
  return r.rowCount > 0;
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

// --- plugins ---
// One row per plugin id; an ABSENT (or NULL-installed) row falls to the tier
// default (server/plugins.js coalesces), so nothing is ever seeded. `config`
// holds only schema-declared overrides — secrets live in their existing stores.

export async function listPluginRows(db) {
  const { rows } = await db.query("SELECT * FROM plugins");
  return rows;
}

export async function getPluginRow(db, id) {
  const { rows } = await db.query("SELECT * FROM plugins WHERE id=$1", [id]);
  return rows[0] || null;
}

// Partial upsert: an undefined field leaves the stored value alone, so an
// install write never clobbers config and vice versa. A config-only write
// leaves `installed` NULL (falls to the tier default) rather than forcing it.
export async function setPluginState(db, id, { installed, config } = {}) {
  await db.query(
    `INSERT INTO plugins (id, installed, config, updated_at)
     VALUES ($1, $2, COALESCE($3::jsonb, '{}'::jsonb), $4)
     ON CONFLICT (id) DO UPDATE SET
       installed  = COALESCE($2, plugins.installed),
       config     = COALESCE($3::jsonb, plugins.config),
       updated_at = $4`,
    [id, installed ?? null, config !== undefined ? JSON.stringify(config) : null, Date.now()]
  );
}

// Drop a plugin's config/health row entirely. Used when UNINSTALLING an external
// plugin (built-ins keep their row and just flip `installed`). Safe if absent.
export async function deletePluginRow(db, id) {
  await db.query("DELETE FROM plugins WHERE id = $1", [id]);
}

// Health ledger (the self-healing seed): failures always write (streaks bump
// fail_count, last_error stays structured); success writes ONLY when healing
// (fail_count > 0 or never-ok) so steady-state sweeps don't chatter the table.
export async function recordPluginHealth(db, id, error = null) {
  const now = Date.now();
  if (error) {
    const payload = JSON.stringify({
      message: String(error.message || error).slice(0, 500),
      status: error.status ?? null,
      at: now,
    });
    await db.query(
      `INSERT INTO plugins (id, last_fail_at, fail_count, last_error, updated_at)
       VALUES ($1, $2, 1, $3::jsonb, $2)
       ON CONFLICT (id) DO UPDATE SET
         last_fail_at = $2, fail_count = plugins.fail_count + 1, last_error = $3::jsonb, updated_at = $2`,
      [id, now, payload]
    );
  } else {
    await db.query(
      `INSERT INTO plugins (id, last_ok_at, updated_at) VALUES ($1, $2, $2)
       ON CONFLICT (id) DO UPDATE SET last_ok_at = $2, fail_count = 0, last_error = NULL, updated_at = $2
       WHERE plugins.fail_count > 0 OR plugins.last_ok_at IS NULL`,
      [id, now]
    );
  }
}

// Run `fn` and ledger its outcome on plugin `id` (heal on success, structured
// error on throw). The ledger write never masks the call's own result — a
// failed health write is swallowed, the original value/throw passes through.
// The one health-tracking pattern; every live provider/tagger/embed call and
// admin reachability test funnels through here.
export async function withPluginHealth(db, id, fn) {
  try {
    const out = await fn();
    await recordPluginHealth(db, id).catch(() => {});
    return out;
  } catch (err) {
    await recordPluginHealth(db, id, err).catch(() => {});
    throw err;
  }
}

// --- external plugins (the dynamic-loading install record) ---
// Distinct from the `plugins` table (config/health for ALL plugins): this holds
// only WHERE an external plugin came from and where its code lives, so boot can
// reload it. See server/migrations/0020_external_plugins.sql.

export async function listExternalPlugins(db) {
  const { rows } = await db.query("SELECT * FROM external_plugins");
  return rows;
}

export async function getExternalPlugin(db, id) {
  const { rows } = await db.query("SELECT * FROM external_plugins WHERE id = $1", [id]);
  return rows[0] || null;
}

// Record an install (or re-install). `manifest` is stored verbatim; a successful
// (re)load clears any prior load_error. Called only after the code is on disk.
export async function upsertExternalPlugin(db, { id, kind, sourceUrl, resolvedRef, dir, manifest }) {
  await db.query(
    `INSERT INTO external_plugins (id, kind, source_url, resolved_ref, dir, manifest, installed_at, load_error)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, NULL)
     ON CONFLICT (id) DO UPDATE SET
       kind = $2, source_url = $3, resolved_ref = $4, dir = $5, manifest = $6::jsonb,
       installed_at = $7, load_error = NULL`,
    [id, kind, sourceUrl, resolvedRef ?? null, dir, JSON.stringify(manifest), Date.now()]
  );
}

// Mark a load failure without dropping the install record — the code stays on
// disk (the dir is unchanged), so a later Retry can reload it. `error` is
// coerced to the same structured shape the health ledger uses.
export async function setExternalLoadError(db, id, error) {
  const payload = error
    ? JSON.stringify({ message: String(error.message || error).slice(0, 500), at: Date.now() })
    : null;
  await db.query("UPDATE external_plugins SET load_error = $2::jsonb WHERE id = $1", [id, payload]);
}

// Remove the install record. The caller also rm's the dir + drops the `plugins`
// row (config/health) — this is only the provenance half.
export async function deleteExternalPlugin(db, id) {
  await db.query("DELETE FROM external_plugins WHERE id = $1", [id]);
}

// --- AI tagging queue helpers ---

// Atomically take the oldest ready item — whatever stage it's in — and mark it
// with that stage's in-flight status. ONE queue, one policy: oldest work first
// (created_at, id), so an item flows extract → face → tag to completion before
// newer items start (it re-enters the queue with its original created_at and
// stays at the front). There are no per-stage legs to starve: a bulk upload's
// extractions and other boards' tagging interleave by age. The returned row's
// status ('extracting' | 'facing' | 'processing') tells the worker which step
// to run.
//
// SKIP LOCKED keeps concurrent claimers (or a second worker) from grabbing the
// same row. When no default key is configured, boards without their own key
// are skipped for the AI stages — their items stay queued until a key appears
// (never failed for a missing key) — while faces still claim (rendering a
// chart is a data+render step, no model call). Rows whose retry_at is still in
// the future (a spaced transient retry) are skipped; every requeue path that
// wants an immediate run clears retry_at.
export async function claimNextWork(db, hasDefaultKey = true) {
  const { rows } = await db.query(
    `UPDATE items SET
       status = CASE items.status
         WHEN 'pending_extract' THEN 'extracting'
         WHEN 'pending_face'    THEN 'facing'
         ELSE 'processing' END,
       updated_at = $1
     WHERE id = (
       SELECT i.id FROM items i JOIN boards b ON b.id = i.board_id
       WHERE i.status IN ('pending_extract', 'pending_face', 'pending')
         AND (i.status = 'pending_face' OR b.ai_key_id IS NOT NULL OR $2)
         AND (i.retry_at IS NULL OR i.retry_at <= $1)
       ORDER BY i.created_at ASC, i.id ASC LIMIT 1
       FOR UPDATE OF i SKIP LOCKED
     )
     RETURNING *`,
    [Date.now(), hasDefaultKey]
  );
  return rows[0] || null;
}

export async function setEntityFaceAt(db, id, at) {
  await db.query("UPDATE entities SET face_at=$1, updated_at=$2 WHERE id=$3", [at, Date.now(), id]);
}

// Write extracted fields into payload and advance. Extraction is part of the
// item's definition (identity, fields), so it runs regardless of auto-tagging;
// auto_tag gates only the TAG leg. Items born on an auto-tag-off board carry
// `park`: definition done, they return to held instead of flowing into
// tagging. Explicit runs (reprocess/re-extract/release) carry no park and go
// all the way — the toggle gates the automatic flow, not the user's hand.
// The board is re-checked so a mid-flight auto-tag flip beats a stale park.
// extracted_at records that the extract leg ran, so a later release routes
// the item to the tag leg rather than paying for a second extraction.
// Value-fenced like markTagged: lands only while the row is still
// 'extracting'; a mid-flight re-route/delete discards (returns false).
export async function markExtracted(db, id, fields) {
  const { rowCount } = await db.query(
    `UPDATE items
     SET payload = (payload - 'park') || jsonb_build_object('fields', $1::jsonb, 'extracted_at', $2::bigint),
         status = CASE WHEN payload ? 'park'
                            AND NOT (SELECT b.auto_tag FROM boards b WHERE b.id = items.board_id)
                       THEN 'held' ELSE 'pending' END,
         attempts = 0,
         error = NULL,
         retry_at = NULL,
         updated_at = $2
     WHERE id = $3 AND status = 'extracting'`,
    [JSON.stringify(fields || {}), Date.now(), id]
  );
  return rowCount > 0;
}

// The face leg's counterpart: the chart (or tile fallback) is rendered — the
// visual half of the item's definition — so advance with the same park rule.
// extracted_at is stamped here too: for a connector vehicle the face IS its
// definition leg, and the stamp is what routes a later release straight to
// the tag leg.
// Value-fenced like its siblings: lands only while the row is still 'facing'.
export async function advanceFaced(db, id) {
  const { rowCount } = await db.query(
    `UPDATE items
     SET payload = (payload - 'park') || jsonb_build_object('extracted_at', $1::bigint),
         status = CASE WHEN payload ? 'park'
                            AND NOT (SELECT b.auto_tag FROM boards b WHERE b.id = items.board_id)
                       THEN 'held' ELSE 'pending' END,
         attempts = 0,
         error = NULL,
         retry_at = NULL,
         updated_at = $1
     WHERE id = $2 AND status = 'facing'`,
    [Date.now(), id]
  );
  return rowCount > 0;
}

// --- entities ---

// Create an entity row. identity must be unique per board — a 23505 here
// means the entity already exists (connector adds answer 409; the extract
// leg re-parents instead). Returns the new id.
export async function createEntity(db, boardId, { identity, displayName = null, symbol = null, fields = {}, provisional = false, uploadedBy = null } = {}) {
  const { rows } = await db.query(
    `INSERT INTO entities (board_id, identity, display_name, symbol, fields, identity_provisional, uploaded_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING id`,
    [boardId, identity, displayName, symbol, JSON.stringify(fields || {}), provisional, uploadedBy, Date.now()]
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

// The set of entity identities already on a board — for marking connector rows
// as already added in the browse modal.
export async function boardEntityIdentities(db, boardId) {
  const { rows } = await db.query("SELECT identity FROM entities WHERE board_id=$1", [boardId]);
  return new Set(rows.map((r) => r.identity));
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

// Bump an entity's change stamp without touching anything else. For writes
// that alter what the list shows for an entity but live in OTHER rows —
// losing an instance, gaining/losing a heart or crate membership — so delta
// polls (?since=) see the entity as changed.
export async function touchEntity(db, id) {
  await db.query("UPDATE entities SET updated_at=$1 WHERE id=$2", [Date.now(), id]);
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

// Move an instance under another entity and drop the old entity if it emptied
// out — one transaction, so a crash between the statements can't leave a ghost
// empty entity behind, and the emptiness check observes the re-parent it
// follows. The latest derivation wins the target's display name. Returns true
// when the old entity was deleted (merge emptied it) — false means it kept
// instances (split).
export async function reparentInstance(db, itemId, target, displayName, oldEntityId) {
  return withTx(db, async (client) => {
    await reparentItem(client, itemId, target.id);
    if (displayName !== target.display_name) await setEntityIdentity(client, target.id, target.identity, displayName);
    const deleted = await deleteEntityIfEmpty(client, oldEntityId);
    // Split: the old entity survives minus an instance — stamp it so delta
    // polls pick up its new aggregate status/tags/face.
    if (!deleted) await touchEntity(client, oldEntityId);
    return deleted;
  });
}

// Delete an entity and (via FK cascade) all its instances. Returns the
// instances' file entries so the caller can clean the stores. The row is
// locked BEFORE the payload read: a concurrent merge-in takes FOR KEY SHARE on
// this row to reference it, so it either committed first (its files make the
// cleanup list) or blocks on the lock, fails its FK check once the delete
// commits, and heals via the extract retry. Without the lock the cascade can
// eat a freshly re-parented instance whose files were never read — row lost,
// files orphaned on disk.
export async function deleteEntity(db, id) {
  return withTx(db, async (client) => {
    const locked = await client.query("SELECT 1 FROM entities WHERE id=$1 FOR UPDATE", [id]);
    if (!locked.rows.length) return null;
    const { rows: insts } = await client.query("SELECT payload FROM items WHERE entity_id=$1", [id]);
    const { rows } = await client.query("DELETE FROM entities WHERE id=$1 RETURNING board_id", [id]);
    if (!rows.length) return null;
    return { board_id: rows[0].board_id, files: insts.flatMap((r) => r.payload?.files || []) };
  });
}

// Delete one instance row. Returns { payload, entity_id, board_id } for file
// cleanup and last-instance checks, or null when it doesn't exist. The parent
// entity's stamp bumps in the same statement — its aggregate status/tags/face
// just changed — so delta polls see it (a no-op when the delete empties the
// entity: the row goes away right after and the ids list covers that).
export async function deleteInstance(db, id) {
  const { rows } = await db.query(
    `WITH del AS (DELETE FROM items WHERE id=$1 RETURNING payload, entity_id, board_id),
          touch AS (UPDATE entities SET updated_at=$2 WHERE id = (SELECT entity_id FROM del))
     SELECT payload, entity_id, board_id FROM del`,
    [id, Date.now()]
  );
  return rows[0] || null;
}

// --- connector liveness (slice 5c) ---

// Entities due for a live-field or face refresh: refresh_at set and reached.
// Each rides with its connector instance — matched by `payload ? 'source'` (the
// tag vehicle's marker; NOT file-count, since a generated face gives it a file)
// — and its board. Soonest-due first, bounded per sweep.
export async function dueLiveEntities(db, now, limit = 20) {
  const { rows } = await db.query(
    `SELECT e.id AS e_id, e.identity, e.symbol, e.fields, e.refresh_at, e.face_at,
            i.id AS i_id, i.payload AS i_payload,
            b.id AS b_id, b.mapping AS b_mapping, b.retag_on_refresh, b.auto_tag
     FROM entities e
     JOIN items i ON i.entity_id = e.id AND i.payload ? 'source'
     JOIN boards b ON b.id = e.board_id
     WHERE e.refresh_at IS NOT NULL AND e.refresh_at <= $1
     ORDER BY e.refresh_at ASC
     LIMIT $2`,
    [now, limit]
  );
  return rows.map((r) => ({
    entity: { id: r.e_id, identity: r.identity, symbol: r.symbol, fields: r.fields, refresh_at: r.refresh_at, face_at: r.face_at },
    inst: { id: r.i_id, payload: r.i_payload },
    board: { id: r.b_id, mapping: r.b_mapping, retag_on_refresh: r.retag_on_refresh, auto_tag: r.auto_tag },
  }));
}

// Write refreshed connector fields + the next due time, atomically.
export async function updateEntityFields(db, id, fields, refreshAt) {
  await db.query(
    "UPDATE entities SET fields=$1, refresh_at=$2, updated_at=$3 WHERE id=$4",
    [JSON.stringify(fields), refreshAt, Date.now(), id]
  );
}

export async function setEntityRefreshAt(db, id, at) {
  await db.query("UPDATE entities SET refresh_at=$1 WHERE id=$2", [at, id]);
}

// One movement-history row (only the fields whose value actually changed).
export async function addFieldSnapshot(db, entityId, fields, source, at) {
  await db.query(
    "INSERT INTO field_snapshots (entity_id, fields, source, refreshed_at) VALUES ($1,$2,$3,$4)",
    [entityId, JSON.stringify(fields || {}), source || null, at]
  );
}

// Drop movement history older than the cutoff (the worker's retention prune).
// Returns the number of rows removed.
export async function pruneFieldSnapshots(db, cutoff) {
  const { rowCount } = await db.query("DELETE FROM field_snapshots WHERE refreshed_at < $1", [cutoff]);
  return rowCount;
}

// The judgment-history counterpart. Post-dedupe every row is a real judgment
// change (the then-vs-now data), so this backstop defaults to disabled — see
// TAG_SNAPSHOT_RETENTION_DAYS in the worker.
export async function pruneTagSnapshots(db, cutoff) {
  const { rowCount } = await db.query("DELETE FROM tag_snapshots WHERE tagged_at < $1", [cutoff]);
  return rowCount;
}

// Send one instance back to the tag queue (the opt-in retag-on-new-data path).
// Only settled items: the refresh cascade must not yank a row out of the
// definition legs or a user's mid-flight run. Returns whether it requeued.
export async function requeueItemForTag(db, id) {
  const { rowCount } = await db.query(
    "UPDATE items SET status='pending', attempts=0, error=NULL, retry_at=NULL, updated_at=$1 WHERE id=$2 AND status IN ('tagged','failed')",
    [Date.now(), id]
  );
  return rowCount > 0;
}

// Recompute refresh_at for every entity on a board after its mapping changes
// (a field or the face turned live/idle, or a cadence moved). `live` = the
// mapping's live connector fields [{ key, every }]; `faceCad` = { every } when
// the face is live, else null. Empty/null both clear that term.
export async function rescheduleEntityRefreshes(db, boardId, live, faceCad = null, now = Date.now()) {
  // Nothing live and no live face → every entity's next refresh is null. Clear the
  // whole board in one statement instead of a write per entity. This is the common
  // case on a file board, where no field can be live — so the mapping save that
  // used to fan out N no-op writes now does a single targeted one.
  if (!live.length && !faceCad) {
    await db.query("UPDATE entities SET refresh_at=NULL WHERE board_id=$1 AND refresh_at IS NOT NULL", [boardId]);
    return;
  }
  const { rows } = await db.query("SELECT id, fields, face_at FROM entities WHERE board_id=$1", [boardId]);
  const sched = [];
  for (const e of rows) {
    let next = null;
    for (const f of live) {
      const due = (e.fields?.[f.key]?.at ?? now) + f.every * 60000;
      if (next === null || due < next) next = due;
    }
    if (faceCad) {
      // A never-rendered face (face_at null) is due now, so enabling/adjusting a
      // live face schedules every entity for its first render on the next sweep.
      const due = e.face_at != null ? e.face_at + faceCad.every * 60000 : now;
      if (next === null || due < next) next = due;
    }
    sched.push({ id: e.id, nx: next });
  }
  if (!sched.length) return;
  // One bulk write instead of a round-trip per entity.
  await db.query(
    `UPDATE entities AS e SET refresh_at = u.nx
     FROM jsonb_to_recordset($1::jsonb) AS u(id bigint, nx bigint)
     WHERE e.id = u.id`,
    [JSON.stringify(sched)]
  );
}

// Re-run the full pipeline for every instance of an entity (the card-level
// "reprocess"). User-initiated, so the CURRENT board mapping is re-stamped and
// applied — a mapping edited after upload (or added to a board that had none)
// actually takes effect here; connector vehicles restart at the face leg (the
// chart is part of the definition, and this is the only manual path that can
// re-render a non-live face — e.g. after a period change), other instances at
// the extract leg when there is AI work (current or stamped), else at tagging.
// Tags are cleared up front so the card shows a clean reprocessing state
// either way. The face check reads the mapping that will apply ($3 when
// re-stamped, else the stamp — $3 is null for connector-only mappings, which
// carry no AI work); a vehicle is zero-files (unrendered) or generated-file
// (rendered chart), never a user upload.
export async function reprocessEntity(db, entityId) {
  const { rows } = await db.query(
    "SELECT b.mapping FROM entities e JOIN boards b ON b.id = e.board_id WHERE e.id=$1", [entityId]);
  if (!rows.length) return false;
  const current = aiMappingJson(rows[0].mapping);
  // `- 'park'`: an explicit reprocess runs the full pipeline through tagging,
  // even on an auto-tag-off board — park only gates the automatic ingest flow.
  const result = await db.query(
    `UPDATE items
     SET payload = CASE WHEN $3::jsonb IS NULL THEN payload - 'park'
                        ELSE jsonb_set(payload - 'park', '{mapping}', $3::jsonb) END,
         status = CASE
           WHEN COALESCE($3::jsonb, payload->'mapping')->'face'->>'from' = 'connector'
                AND (jsonb_array_length(COALESCE(payload->'files','[]'::jsonb)) = 0
                     OR payload->'files'->0->>'generated' = 'true') THEN 'pending_face'
           WHEN $3::jsonb IS NOT NULL OR payload ? 'mapping' THEN 'pending_extract'
           ELSE 'pending' END,
         tags='[]'::jsonb, tag_reasoning='{}'::jsonb, undecided=FALSE,
         attempts=0, error=NULL, retry_at=NULL, updated_at=$1
     WHERE entity_id=$2`,
    [Date.now(), entityId, current]
  );
  return result.rowCount > 0;
}

// Value-fenced (`AND status='processing'`): the stamp lands only while the row
// is still this claim's in-flight status. A per-card route (reprocess,
// re-extract, retag, tag edit) that re-routed the row mid-call wins — the
// stale result is discarded (returns false) and the snapshot is skipped, so
// history never records a judgment that was never current. A row deleted
// mid-call discards the same way instead of FK-erroring on the snapshot.
// Sound single-process because a stale stamp always executes before any
// re-claim (single-flight tick); across processes a value fence is NOT
// ownership — see the worker-queue audit, hole #7.
export async function markTagged(db, id, tags, undecided = false, reasoning = {}) {
  // Clearing the vector marks the item for the embedding sweep — the text it
  // was embedded from just changed.
  const { rowCount } = await db.query(
    "UPDATE items SET status='tagged', tags=$1, undecided=$2, tag_reasoning=$3, error=NULL, retry_at=NULL, embedding=NULL, embedding_model=NULL, embed_error=NULL, updated_at=$4 WHERE id=$5 AND status='processing'",
    [JSON.stringify(tags), undecided, JSON.stringify(reasoning || {}), Date.now(), id]
  );
  if (rowCount) await addTagSnapshot(db, id, "ai", tags, reasoning, undecided);
  return rowCount > 0;
}

// --- semantic search embeddings ---

export async function setItemEmbedding(db, id, vector, model) {
  await db.query("UPDATE items SET embedding=$1, embedding_model=$2, embed_error=NULL WHERE id=$3", [
    Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
    model,
    id,
  ]);
}

// Mark an item the embedder rejected on its own (a poison input): the sweep
// skips it so one bad item can't wedge the whole backfill. Cleared wherever
// the embed text changes (markTagged, setItemTags) and on a later success.
export async function setItemEmbedError(db, id, message) {
  await db.query("UPDATE items SET embed_error=$1 WHERE id=$2", [String(message).slice(0, 500), id]);
}

// Tagged items whose vector is missing or from another model — the embedding
// sweep's work queue. Newest first so fresh uploads become searchable before
// a long backfill finishes. Items whose text the embedder rejected
// (embed_error) are skipped until fresh tags give them new text.
export async function itemsNeedingEmbedding(db, model, limit) {
  const { rows } = await db.query(
    `SELECT id, tags, tag_reasoning, payload FROM items
     WHERE status='tagged' AND embed_error IS NULL
       AND (embedding IS NULL OR embedding_model IS DISTINCT FROM $1)
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

// Backfill progress for the admin panel: how many tagged items exist, how
// many already carry a current-model vector, and how many were skipped after
// the embedder rejected their text (so a stuck count has a visible why).
export async function embeddingStats(db, model) {
  const { rows } = await db.query(
    `SELECT COUNT(*) FILTER (WHERE status='tagged') AS tagged,
            COUNT(*) FILTER (WHERE status='tagged' AND embedding IS NOT NULL AND embedding_model=$1) AS embedded,
            COUNT(*) FILTER (WHERE status='tagged' AND embed_error IS NOT NULL) AS failed
     FROM items`,
    [model]
  );
  return { tagged: Number(rows[0].tagged), embedded: Number(rows[0].embedded), failed: Number(rows[0].failed) };
}

// Route a failed work attempt by what the error says. Three classes:
//  - permanent (HTTP 4xx except 408/429 — bad request, bad key, too large):
//    fail on the FIRST attempt; repeating the same rejected call just repeats
//    the rejection. Providers stamp err.status (compatError / the Anthropic
//    SDK); no status means we can't prove it's permanent, so we retry.
//  - transient (429/408/5xx, network errors, model whims — anything else):
//    requeue with a spaced retry_at (1m, 5m, then 15m — honoring a longer
//    Retry-After when the provider sent one) so the attempts outlast a
//    rate-limit window or an outage instead of burning within seconds, and
//    with TRANSIENT_EXTRA headroom over maxAttempts.
//  - configuration gaps (err.noCount, e.g. "no API key configured"): requeue
//    without consuming an attempt at all — the claim gate promises a missing
//    key never fails an item, and this closes its race.
// requeueStatus controls which queue the item returns to ('pending' for the
// tag leg, 'pending_extract' / 'pending_face' for the definition legs).
// Returns true if the item was failed.
const RETRY_BACKOFF_MS = [60000, 300000, 900000];
const TRANSIENT_EXTRA = 2;
// Maps a leg's requeue target back to the in-flight status that leg claims
// into — the value fence for failOrRequeue below.
const IN_FLIGHT_FOR = { pending: "processing", pending_extract: "extracting", pending_face: "facing" };

export async function failOrRequeue(db, id, error, maxAttempts, requeueStatus = "pending") {
  const httpStatus = Number(error?.status);
  const permanent =
    Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500 &&
    httpStatus !== 408 && httpStatus !== 429;
  const noCount = error?.noCount === true;
  const { rows } = await db.query("SELECT attempts FROM items WHERE id=$1", [id]);
  const attempts = (rows.length ? rows[0].attempts : 0) + (noCount ? 0 : 1);
  const failed = !noCount && (permanent || attempts >= maxAttempts + TRANSIENT_EXTRA);
  const backoff = noCount
    ? RETRY_BACKOFF_MS[0]
    : RETRY_BACKOFF_MS[Math.min(Math.max(attempts - 1, 0), RETRY_BACKOFF_MS.length - 1)];
  const ra = Number(error?.retryAfter);
  const wait = Math.max(backoff, Number.isFinite(ra) ? Math.min(ra * 1000, 3600000) : 0);
  // Value-fenced: a stale failure must not stamp error/retry_at over a row the
  // user re-routed mid-flight (their reprocess/re-extract already reset it and
  // chose its leg). The fence also closes the attempts read-then-write race —
  // every writer that resets attempts also moves the row out of this status.
  const { rowCount } = await db.query(
    "UPDATE items SET status=$1, attempts=$2, error=$3, retry_at=$4, updated_at=$5 WHERE id=$6 AND status=$7",
    [
      failed ? "failed" : requeueStatus,
      attempts,
      String(error?.message ?? error).slice(0, 500),
      failed ? null : Date.now() + wait,
      Date.now(),
      id,
      IN_FLIGHT_FOR[requeueStatus] || "processing",
    ]
  );
  return rowCount > 0 && failed;
}

// Recover items stranded mid-flight ('processing'/'extracting'/'facing') by a
// crash or a shutdown that outlived the 5s drain. Each recovery counts as an
// attempt — an interruption is evidence — and requeues to its own leg with
// the same spaced retry_at as transient failures, so a crash-looping poison
// item stops re-leading the FIFO on every boot and, at the transient ceiling,
// actually fails. Nothing else can fail it: claims don't check attempts, and
// failOrRequeue only ever sees CAUGHT errors — a crash reaches neither. The
// ceiling's headroom means an innocent item must straddle maxAttempts+2
// separate interruptions (deploys included) before it could be wrongly
// failed. Returns the number of rows touched.
export async function recoverStuck(db, olderThanMs, maxAttempts = 3) {
  const now = Date.now();
  const [b0, b1, b2] = RETRY_BACKOFF_MS;
  const { rowCount } = await db.query(
    `UPDATE items SET
       attempts = attempts + 1,
       status = CASE
         WHEN attempts + 1 >= $2 THEN 'failed'
         WHEN status = 'extracting' THEN 'pending_extract'
         WHEN status = 'facing' THEN 'pending_face'
         ELSE 'pending' END,
       error = CASE WHEN attempts + 1 >= $2
                    THEN 'interrupted mid-flight repeatedly (crash or shutdown)' ELSE error END,
       retry_at = CASE WHEN attempts + 1 >= $2 THEN NULL
                       ELSE $3::bigint + (CASE LEAST(attempts, 2) WHEN 0 THEN ${b0} WHEN 1 THEN ${b1} ELSE ${b2} END) END,
       updated_at = $3
     WHERE status IN ('processing','extracting','facing') AND updated_at < $1`,
    [now - olderThanMs, maxAttempts + TRANSIENT_EXTRA, now]
  );
  return rowCount;
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

// Total (input + output) tokens consumed by AI tagging for a single board.
export async function getBoardTokenTotal(db, boardId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM ai_board_usage WHERE board_id=$1`,
    [boardId]
  );
  return Number(rows[0]?.total ?? 0);
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

