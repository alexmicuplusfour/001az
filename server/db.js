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
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await db.query(sql);
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
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM images");
  return rows[0].c;
}

export async function listImages(db, userId = null, boardId = null) {
  const { rows } = await db.query(
    `SELECT i.id, i.filename, i.status, i.tags, i.thumb_w, i.thumb_h, i.undecided,
      (SELECT COUNT(*) FROM favorites f WHERE f.image_id = i.id) AS hearts,
      EXISTS(
        SELECT 1 FROM favorites f WHERE f.image_id = i.id AND f.user_id = $1
      ) AS fav
     FROM images i
     WHERE ($2::text IS NULL OR i.board_id = $2)
     ORDER BY i.created_at DESC, i.id DESC`,
    [userId, boardId]
  );

  const crateMap = new Map();
  if (userId) {
    const memberships = await db.query(
      `SELECT ci.image_id, ci.crate_id FROM crate_images ci
       JOIN crates c ON c.id = ci.crate_id WHERE c.user_id = $1 AND c.board_id = $2`,
      [userId, boardId]
    );
    for (const m of memberships.rows) {
      if (!crateMap.has(m.image_id)) crateMap.set(m.image_id, []);
      crateMap.get(m.image_id).push(m.crate_id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.filename,
    status: r.status,
    tags: r.tags,
    undecided: !!r.undecided,
    hearts: r.hearts,
    favoritedByMe: !!r.fav,
    crateIds: crateMap.get(r.id) || [],
    w: r.thumb_w || null,
    h: r.thumb_h || null,
  }));
}

export async function insertImage(db, filename, originalName, boardId) {
  const now = Date.now();
  const { rows } = await db.query(
    `INSERT INTO images (filename, original_name, status, board_id, created_at, updated_at)
     VALUES ($1, $2, 'pending', $3, $4, $4) RETURNING id`,
    [filename, originalName, boardId, now]
  );
  return rows[0].id;
}

export async function setThumbDimensions(db, id, w, h) {
  await db.query("UPDATE images SET thumb_w=$1, thumb_h=$2 WHERE id=$3", [w, h, id]);
}

export async function listImagesMissingThumbDims(db) {
  const { rows } = await db.query("SELECT id, filename FROM images WHERE thumb_w IS NULL");
  return rows;
}

export async function getImageBoard(db, id) {
  const { rows } = await db.query("SELECT board_id FROM images WHERE id=$1", [id]);
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
  const { rows } = await db.query("SELECT tags, tag_reasoning FROM images WHERE id=$1", [id]);
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
    "UPDATE images SET status='tagged', tags=$1, tag_reasoning=$2, undecided=FALSE, updated_at=$3 WHERE id=$4",
    [JSON.stringify(tags), JSON.stringify(reasoning), Date.now(), id]
  );
}

export async function getImageReasoning(db, id) {
  const { rows } = await db.query("SELECT board_id, tag_reasoning FROM images WHERE id=$1", [id]);
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

export async function toggleFavorite(db, userId, imageId) {
  const exists = (
    await db.query("SELECT 1 FROM favorites WHERE user_id=$1 AND image_id=$2", [userId, imageId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM favorites WHERE user_id=$1 AND image_id=$2", [userId, imageId]);
  } else {
    const img = await db.query("SELECT 1 FROM images WHERE id=$1", [imageId]);
    if (!img.rows.length) return null;
    await db.query("INSERT INTO favorites (user_id, image_id, created_at) VALUES ($1, $2, $3)", [
      userId,
      imageId,
      Date.now(),
    ]);
  }
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM favorites WHERE image_id=$1", [imageId]);
  return { favorited: !exists, count: rows[0].c };
}

export async function heartNames(db, imageId) {
  const { rows } = await db.query(
    `SELECT u.name, u.email FROM favorites f JOIN users u ON u.id = f.user_id
     WHERE f.image_id = $1 ORDER BY f.created_at ASC`,
    [imageId]
  );
  return rows.map((r) => r.name || r.email);
}

// --- crates ---

export async function listCrates(db, userId, boardId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name,
      (SELECT COUNT(*) FROM crate_images ci WHERE ci.crate_id = c.id) AS image_count
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
    const count = await db.query("SELECT COUNT(*) AS c FROM crate_images WHERE crate_id=$1", [rows[0].id]);
    return { id: rows[0].id, name: rows[0].name, image_count: count.rows[0].c };
  }
}

export async function deleteCrate(db, userId, crateId) {
  // crate_images cascades.
  const result = await db.query("DELETE FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  return result.rowCount > 0;
}

export async function toggleCrateImage(db, userId, crateId, imageId) {
  const crate = await db.query("SELECT id FROM crates WHERE id=$1 AND user_id=$2", [crateId, userId]);
  if (!crate.rows.length) return null;
  const exists = (
    await db.query("SELECT 1 FROM crate_images WHERE crate_id=$1 AND image_id=$2", [crateId, imageId])
  ).rows.length > 0;
  if (exists) {
    await db.query("DELETE FROM crate_images WHERE crate_id=$1 AND image_id=$2", [crateId, imageId]);
  } else {
    const img = await db.query("SELECT 1 FROM images WHERE id=$1", [imageId]);
    if (!img.rows.length) return null;
    await db.query("INSERT INTO crate_images (crate_id, image_id, created_at) VALUES ($1, $2, $3)", [
      crateId,
      imageId,
      Date.now(),
    ]);
  }
  const { rows } = await db.query("SELECT COUNT(*) AS c FROM crate_images WHERE crate_id=$1", [crateId]);
  return { added: !exists, count: rows[0].c };
}

// --- boards ---

export async function createBoard(db, name, facets = [], context = "", aiReasoning = true) {
  const id = crypto.randomUUID();
  await db.query(
    "INSERT INTO boards (id, name, facets, context, ai_reasoning, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [id, name, JSON.stringify(facets), context, !!aiReasoning, Date.now()]
  );
  return id;
}

export async function listBoards(db) {
  const { rows } = await db.query(
    "SELECT id, name, facets, context, ai_reasoning, created_at FROM boards ORDER BY created_at ASC"
  );
  return rows;
}

export async function getBoard(db, id) {
  const { rows } = await db.query(
    "SELECT id, name, facets, context, ai_reasoning, created_at FROM boards WHERE id=$1",
    [id]
  );
  return rows[0] || null;
}

export async function updateBoard(db, id, { name, facets, context, aiReasoning } = {}) {
  const sets = [];
  const vals = [];
  if (name !== undefined) { vals.push(String(name).trim()); sets.push(`name=$${vals.length}`); }
  if (facets !== undefined) { vals.push(JSON.stringify(facets)); sets.push(`facets=$${vals.length}`); }
  if (context !== undefined) { vals.push(String(context)); sets.push(`context=$${vals.length}`); }
  if (aiReasoning !== undefined) { vals.push(!!aiReasoning); sets.push(`ai_reasoning=$${vals.length}`); }
  if (!sets.length) return false;
  vals.push(id);
  const result = await db.query(`UPDATE boards SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
  return result.rowCount > 0;
}

// Returns the deleted board's image filenames (caller removes the files),
// or null if the board doesn't exist. Rows cascade via FKs.
export async function deleteBoard(db, id) {
  return withTx(db, async (client) => {
    const imgs = await client.query("SELECT filename FROM images WHERE board_id=$1", [id]);
    const result = await client.query("DELETE FROM boards WHERE id=$1", [id]);
    if (result.rowCount === 0) return null;
    return imgs.rows.map((r) => r.filename);
  });
}

export async function boardExists(db, id) {
  const { rows } = await db.query("SELECT 1 FROM boards WHERE id=$1", [id]);
  return rows.length > 0;
}

// Per-board image totals + pending counts in one pass: { boardId: { c, p } }.
export async function boardImageStats(db) {
  const { rows } = await db.query(
    `SELECT board_id, COUNT(*) AS c, COUNT(*) FILTER (WHERE status='pending') AS p
     FROM images GROUP BY board_id`
  );
  return Object.fromEntries(rows.map((r) => [r.board_id, { c: r.c, p: r.p }]));
}

// Queue every non-pending image in a board for retagging. Returns the count.
export async function retagBoard(db, boardId) {
  const result = await db.query(
    "UPDATE images SET status='pending', attempts=0, error=NULL, updated_at=$1 WHERE board_id=$2 AND status != 'pending'",
    [Date.now(), boardId]
  );
  return result.rowCount;
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

// Atomically take the oldest pending image and mark it processing. SKIP LOCKED
// keeps concurrent claimers (or a second worker) from grabbing the same row.
export async function claimNextPending(db) {
  const { rows } = await db.query(
    `UPDATE images SET status='processing', updated_at=$1
     WHERE id = (
       SELECT id FROM images WHERE status='pending'
       ORDER BY created_at ASC, id ASC LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [Date.now()]
  );
  return rows[0] || null;
}

export async function markTagged(db, id, tags, undecided = false, reasoning = {}) {
  await db.query(
    "UPDATE images SET status='tagged', tags=$1, undecided=$2, tag_reasoning=$3, error=NULL, updated_at=$4 WHERE id=$5",
    [JSON.stringify(tags), undecided, JSON.stringify(reasoning || {}), Date.now(), id]
  );
}

// Increment attempts; mark failed once attempts reach maxAttempts, else requeue. Returns true if failed.
export async function failOrRequeue(db, id, error, maxAttempts) {
  const { rows } = await db.query("SELECT attempts FROM images WHERE id=$1", [id]);
  const attempts = (rows.length ? rows[0].attempts : 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  await db.query("UPDATE images SET status=$1, attempts=$2, error=$3, updated_at=$4 WHERE id=$5", [
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
    "UPDATE images SET status='pending' WHERE status='processing' AND updated_at < $1",
    [cutoff]
  );
  return result.rowCount;
}

export async function countPending(db) {
  const { rows } = await db.query("SELECT COUNT(*) AS n FROM images WHERE status='pending'");
  return rows[0].n;
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export async function usageToday(db) {
  const { rows } = await db.query("SELECT count FROM ai_usage WHERE day=$1", [today()]);
  return rows.length ? rows[0].count : 0;
}

export async function bumpUsage(db) {
  await db.query(
    "INSERT INTO ai_usage (day, count) VALUES ($1, 1) ON CONFLICT(day) DO UPDATE SET count = ai_usage.count + 1",
    [today()]
  );
}

// Delete a row; returns its filename (caller removes the files) or null if missing.
export async function deleteImage(db, id) {
  const { rows } = await db.query("DELETE FROM images WHERE id=$1 RETURNING filename", [id]);
  return rows.length ? rows[0].filename : null;
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
        `UPDATE images SET status='tagged', attempts=0, error=NULL, updated_at=$1
         WHERE board_id=$2 AND status='pending' AND tags != '[]'::jsonb`,
        [now, boardId]
      )
    ).rowCount;
    const cleared = (
      await client.query(
        `UPDATE images SET status='tagged', undecided=TRUE, attempts=0, error=NULL, updated_at=$1
         WHERE board_id=$2 AND status='pending'`,
        [now, boardId]
      )
    ).rowCount;
    return { restored, cleared };
  });
}

// Reset an image back to the tagging queue. Returns true if it existed.
export async function reprocessImage(db, id) {
  const result = await db.query(
    "UPDATE images SET status='pending', tags='[]'::jsonb, tag_reasoning='{}'::jsonb, undecided=FALSE, attempts=0, error=NULL, updated_at=$1 WHERE id=$2",
    [Date.now(), id]
  );
  return result.rowCount > 0;
}
