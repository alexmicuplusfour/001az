import Database from "better-sqlite3";
import fs from "node:fs";
import crypto from "node:crypto";

// status: pending -> processing -> tagged | failed
const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  facets     TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS board_members (
  board_id   TEXT NOT NULL,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bm_user ON board_members(user_id);

CREATE TABLE IF NOT EXISTS images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  filename      TEXT UNIQUE NOT NULL,
  original_name TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  tags          TEXT NOT NULL DEFAULT '[]',
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  board_id      TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    INTEGER NOT NULL,
  image_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_image ON favorites(image_id);

CREATE TABLE IF NOT EXISTS crates (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crates_user ON crates(user_id);

CREATE TABLE IF NOT EXISTS crate_images (
  crate_id   INTEGER NOT NULL,
  image_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (crate_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_crate_images_image ON crate_images(image_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export function openDb(dbPath) {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  try { db.exec("ALTER TABLE invites ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE images ADD COLUMN board_id TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("CREATE INDEX IF NOT EXISTS idx_images_board ON images(board_id)"); } catch {}
  try { db.exec("ALTER TABLE boards ADD COLUMN context TEXT NOT NULL DEFAULT ''"); } catch {}
  try { db.exec("ALTER TABLE boards ADD COLUMN glosses TEXT NOT NULL DEFAULT '{}'"); } catch {}
  try { db.exec("ALTER TABLE images ADD COLUMN thumb_w INTEGER"); } catch {}
  try { db.exec("ALTER TABLE images ADD COLUMN thumb_h INTEGER"); } catch {}
  return db;
}

// One-time seed of the existing collection from tags.json (filename -> [tags]).
// No-op once the table has rows.
export function seedIfEmpty(db, tagsJsonPath) {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM images").get();
  if (c > 0) return 0;

  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(tagsJsonPath, "utf8"));
  } catch {
    return 0;
  }

  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO images (filename, original_name, status, tags, created_at, updated_at)
     VALUES (@filename, @original_name, @status, @tags, @created_at, @updated_at)`
  );
  const tx = db.transaction((entries) => {
    for (const [name, tags] of entries) {
      const t = Array.isArray(tags) ? tags : [];
      insert.run({
        filename: name,
        original_name: name,
        status: t.length ? "tagged" : "pending",
        tags: JSON.stringify(t),
        created_at: now,
        updated_at: now,
      });
    }
  });
  tx(Object.entries(data));
  return Object.keys(data).length;
}

export function listImages(db, userId = null, boardId = null) {
  const boardClause = boardId != null ? "WHERE i.board_id = @bid" : "";
  const rows = db
    .prepare(
      `SELECT i.id, i.filename, i.status, i.tags, i.thumb_w, i.thumb_h,
        (SELECT COUNT(*) FROM favorites f WHERE f.image_id = i.id) AS hearts,
        CASE WHEN @uid IS NOT NULL AND EXISTS(
          SELECT 1 FROM favorites f WHERE f.image_id = i.id AND f.user_id = @uid
        ) THEN 1 ELSE 0 END AS fav
       FROM images i
       ${boardClause}
       ORDER BY i.created_at DESC, i.id DESC`
    )
    .all({ uid: userId, bid: boardId });

  const crateMap = new Map();
  if (userId) {
    const memberships = db
      .prepare(
        `SELECT ci.image_id, ci.crate_id FROM crate_images ci
         JOIN crates c ON c.id = ci.crate_id WHERE c.user_id = ? AND c.board_id = ?`
      )
      .all(userId, boardId || "");
    for (const m of memberships) {
      if (!crateMap.has(m.image_id)) crateMap.set(m.image_id, []);
      crateMap.get(m.image_id).push(m.crate_id);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    name: r.filename,
    status: r.status,
    tags: JSON.parse(r.tags),
    hearts: r.hearts,
    favoritedByMe: !!r.fav,
    crateIds: crateMap.get(r.id) || [],
    w: r.thumb_w || null,
    h: r.thumb_h || null,
  }));
}

export function setThumbDimensions(db, id, w, h) {
  db.prepare("UPDATE images SET thumb_w=?, thumb_h=? WHERE id=?").run(w, h, id);
}

// --- users / invites / sessions / favorites ---

export function seedAdmin(db, email) {
  if (!email) return;
  email = email.trim().toLowerCase();
  db.prepare(
    `INSERT INTO users (email, name, is_admin, created_at) VALUES (?, ?, 1, ?)
     ON CONFLICT(email) DO UPDATE SET is_admin = 1`
  ).run(email, email.split("@")[0], Date.now());
}

export function createUser(db, email, name) {
  email = String(email).trim().toLowerCase();
  const existing = db.prepare("SELECT * FROM users WHERE email=?").get(email);
  if (existing) return existing;
  const info = db
    .prepare("INSERT INTO users (email, name, is_admin, created_at) VALUES (?, ?, 0, ?)")
    .run(email, name || null, Date.now());
  return db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
}

export function getUserByEmail(db, email) {
  return db.prepare("SELECT * FROM users WHERE email=?").get(String(email).trim().toLowerCase());
}

export function listUsers(db) {
  return db
    .prepare(
      `SELECT u.id, u.email, u.name, u.is_admin, u.last_login_at,
        (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS hearts_given,
        (SELECT token FROM invites WHERE user_id = u.id AND permanent = 1 ORDER BY created_at DESC LIMIT 1) AS link_token
       FROM users u ORDER BY u.is_admin DESC, u.created_at ASC`
    )
    .all();
}

export function deleteUser(db, id) {
  db.transaction(() => {
    db.prepare("DELETE FROM favorites WHERE user_id=?").run(id);
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    db.prepare("DELETE FROM invites WHERE user_id=?").run(id);
    db.prepare("DELETE FROM users WHERE id=? AND is_admin=0").run(id);
  })();
}

export function mintInvite(db, userId, ttlMs = 14 * 24 * 3600 * 1000) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  db.prepare(
    "INSERT INTO invites (token, user_id, expires_at, used_at, created_at) VALUES (?, ?, ?, NULL, ?)"
  ).run(token, userId, now + ttlMs, now);
  return token;
}

export function consumeInvite(db, token) {
  const row = db.prepare("SELECT * FROM invites WHERE token=?").get(token);
  if (!row || row.expires_at < Date.now()) return null;
  if (!row.permanent) {
    if (row.used_at) return null;
    db.prepare("UPDATE invites SET used_at=? WHERE token=?").run(Date.now(), token);
  }
  return row.user_id;
}

export function mintPermanentInvite(db, userId) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  db.transaction(() => {
    db.prepare("DELETE FROM invites WHERE user_id=? AND permanent=1").run(userId);
    db.prepare(
      "INSERT INTO invites (token, user_id, expires_at, used_at, created_at, permanent) VALUES (?, ?, ?, NULL, ?, 1)"
    ).run(token, userId, now + 100 * 365 * 24 * 3600 * 1000, now);
  })();
  return token;
}

export function createSession(db, userId, ttlMs = 90 * 24 * 3600 * 1000) {
  const id = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    id,
    userId,
    now,
    now + ttlMs
  );
  return id;
}

export function getSessionUser(db, sid) {
  if (!sid) return null;
  return (
    db
      .prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ?`
      )
      .get(sid, Date.now()) || null
  );
}

export function deleteSession(db, sid) {
  if (sid) db.prepare("DELETE FROM sessions WHERE id=?").run(sid);
}

// Sliding expiry: renew the session to now+ttl, but only write if it hasn't
// been renewed in the last `minIdleMs` (≈ once/day). Returns true if renewed.
export function touchSession(db, sid, ttlMs = 90 * 24 * 3600 * 1000, minIdleMs = 24 * 3600 * 1000) {
  if (!sid) return false;
  const now = Date.now();
  const info = db
    .prepare("UPDATE sessions SET expires_at=? WHERE id=? AND expires_at < ?")
    .run(now + ttlMs, sid, now + ttlMs - minIdleMs);
  return info.changes > 0;
}

export function touchLogin(db, userId) {
  db.prepare("UPDATE users SET last_login_at=? WHERE id=?").run(Date.now(), userId);
}

export function toggleFavorite(db, userId, imageId) {
  const exists = db.prepare("SELECT 1 FROM favorites WHERE user_id=? AND image_id=?").get(userId, imageId);
  if (exists) {
    db.prepare("DELETE FROM favorites WHERE user_id=? AND image_id=?").run(userId, imageId);
  } else {
    if (!db.prepare("SELECT 1 FROM images WHERE id=?").get(imageId)) return null;
    db.prepare("INSERT INTO favorites (user_id, image_id, created_at) VALUES (?, ?, ?)").run(
      userId,
      imageId,
      Date.now()
    );
  }
  const count = db.prepare("SELECT COUNT(*) AS c FROM favorites WHERE image_id=?").get(imageId).c;
  return { favorited: !exists, count };
}

export function heartNames(db, imageId) {
  return db
    .prepare(
      `SELECT u.name, u.email FROM favorites f JOIN users u ON u.id = f.user_id
       WHERE f.image_id = ? ORDER BY f.created_at ASC`
    )
    .all(imageId)
    .map((r) => r.name || r.email);
}

// --- crates ---

export function listCrates(db, userId, boardId) {
  return db
    .prepare(
      `SELECT c.id, c.name,
        (SELECT COUNT(*) FROM crate_images ci WHERE ci.crate_id = c.id) AS image_count
       FROM crates c WHERE c.user_id = ? AND c.board_id = ? ORDER BY c.created_at ASC`
    )
    .all(userId, boardId || "");
}

export function createCrate(db, userId, boardId, name) {
  name = String(name).trim().slice(0, 64);
  const bid = boardId || "";
  if (!name) return null;
  try {
    const info = db
      .prepare("INSERT INTO crates (user_id, board_id, name, created_at) VALUES (?, ?, ?, ?)")
      .run(userId, bid, name, Date.now());
    return { id: Number(info.lastInsertRowid), name, image_count: 0 };
  } catch {
    const row = db.prepare("SELECT id, name FROM crates WHERE user_id=? AND board_id=? AND name=?").get(userId, bid, name);
    if (!row) return null;
    const { c } = db.prepare("SELECT COUNT(*) AS c FROM crate_images WHERE crate_id=?").get(row.id);
    return { id: row.id, name: row.name, image_count: c };
  }
}

export function deleteCrate(db, userId, crateId) {
  const crate = db.prepare("SELECT id FROM crates WHERE id=? AND user_id=?").get(crateId, userId);
  if (!crate) return false;
  db.transaction(() => {
    db.prepare("DELETE FROM crate_images WHERE crate_id=?").run(crateId);
    db.prepare("DELETE FROM crates WHERE id=?").run(crateId);
  })();
  return true;
}

export function toggleCrateImage(db, userId, crateId, imageId) {
  const crate = db.prepare("SELECT id FROM crates WHERE id=? AND user_id=?").get(crateId, userId);
  if (!crate) return null;
  const exists = db.prepare("SELECT 1 FROM crate_images WHERE crate_id=? AND image_id=?").get(crateId, imageId);
  if (exists) {
    db.prepare("DELETE FROM crate_images WHERE crate_id=? AND image_id=?").run(crateId, imageId);
  } else {
    if (!db.prepare("SELECT 1 FROM images WHERE id=?").get(imageId)) return null;
    db
      .prepare("INSERT INTO crate_images (crate_id, image_id, created_at) VALUES (?, ?, ?)")
      .run(crateId, imageId, Date.now());
  }
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM crate_images WHERE crate_id=?").get(crateId);
  return { added: !exists, count: c };
}

// --- boards ---

export function createBoard(db, name, facets = [], context = "") {
  const id = crypto.randomUUID();
  db.prepare("INSERT INTO boards (id, name, facets, context, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, name, JSON.stringify(facets), context, Date.now());
  return id;
}

function parseBoard(r) {
  return { id: r.id, name: r.name, facets: JSON.parse(r.facets), context: r.context || "", created_at: r.created_at };
}

export function listBoards(db) {
  return db.prepare("SELECT id, name, facets, context, created_at FROM boards ORDER BY created_at ASC").all()
    .map(parseBoard);
}

export function getBoard(db, id) {
  const r = db.prepare("SELECT id, name, facets, context, created_at FROM boards WHERE id=?").get(id);
  return r ? parseBoard(r) : null;
}

export function updateBoard(db, id, { name, facets, context } = {}) {
  const sets = [];
  const vals = [];
  if (name !== undefined) { sets.push("name=?"); vals.push(String(name).trim()); }
  if (facets !== undefined) { sets.push("facets=?"); vals.push(JSON.stringify(facets)); }
  if (context !== undefined) { sets.push("context=?"); vals.push(String(context)); }
  if (!sets.length) return false;
  vals.push(id);
  return db.prepare(`UPDATE boards SET ${sets.join(",")} WHERE id=?`).run(...vals).changes > 0;
}

export function deleteBoard(db, id) {
  return db.transaction(() => {
    if (!db.prepare("SELECT 1 FROM boards WHERE id=?").get(id)) return null;
    const imgs = db.prepare("SELECT id, filename FROM images WHERE board_id=?").all(id);
    if (imgs.length) {
      const qs = imgs.map(() => "?").join(",");
      const ids = imgs.map((r) => r.id);
      db.prepare(`DELETE FROM favorites WHERE image_id IN (${qs})`).run(...ids);
      db.prepare(`DELETE FROM crate_images WHERE image_id IN (${qs})`).run(...ids);
      db.prepare("DELETE FROM images WHERE board_id=?").run(id);
    }
    db.prepare("DELETE FROM boards WHERE id=?").run(id);
    return imgs.map((r) => r.filename);
  })();
}

export function countBoardImages(db, id) {
  return db.prepare("SELECT COUNT(*) AS c FROM images WHERE board_id=?").get(id).c;
}

// --- board membership ---

export function getBoardMemberIds(db, boardId) {
  return db.prepare("SELECT user_id FROM board_members WHERE board_id=?").all(boardId).map((r) => r.user_id);
}

export function setBoardMembers(db, boardId, userIds) {
  db.transaction(() => {
    db.prepare("DELETE FROM board_members WHERE board_id=?").run(boardId);
    const ins = db.prepare("INSERT INTO board_members (board_id, user_id, created_at) VALUES (?, ?, ?)");
    for (const uid of userIds) ins.run(boardId, uid, Date.now());
  })();
}

export function canAccessBoard(db, boardId, user) {
  if (!user) return false;
  if (user.is_admin) return true;
  return !!db.prepare("SELECT 1 FROM board_members WHERE board_id=? AND user_id=?").get(boardId, user.id);
}

// One-time migration: when board_members is empty, seed all non-admin users into all boards.
export function migrateInitialBoardMembers(db) {
  const { c } = db.prepare("SELECT COUNT(*) AS c FROM board_members").get();
  if (c > 0) return;
  const users = db.prepare("SELECT id FROM users WHERE is_admin=0").all();
  const boards = db.prepare("SELECT id FROM boards").all();
  if (!users.length || !boards.length) return;
  const ins = db.prepare("INSERT OR IGNORE INTO board_members (board_id, user_id, created_at) VALUES (?, ?, ?)");
  db.transaction(() => {
    for (const b of boards) for (const u of users) ins.run(b.id, u.id, Date.now());
  })();
}

// Migration: add board_id to crates and update unique constraint.
export function migrateCratesPerBoard(db) {
  const cols = db.prepare("PRAGMA table_info(crates)").all();
  if (cols.find((c) => c.name === "board_id")) return;
  db.transaction(() => {
    db.prepare(`CREATE TABLE crates_new (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id    INTEGER NOT NULL,
      board_id   TEXT NOT NULL DEFAULT '',
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(user_id, board_id, name)
    )`).run();
    db.prepare(`INSERT INTO crates_new (id, user_id, board_id, name, created_at)
      SELECT id, user_id, '', name, created_at FROM crates`).run();
    db.prepare("DROP TABLE crates").run();
    db.prepare("ALTER TABLE crates_new RENAME TO crates").run();
    db.prepare("CREATE INDEX IF NOT EXISTS idx_crates_user ON crates(user_id)").run();
  })();
}

// On first deploy: assign any images with board_id='' to an existing or new board.
export function migrateOrphanImages(db, facetsJsonPath) {
  const { c: orphanCount } = db.prepare("SELECT COUNT(*) AS c FROM images WHERE board_id=''").get();
  if (!orphanCount) return;
  const first = db.prepare("SELECT id FROM boards ORDER BY created_at ASC LIMIT 1").get();
  let boardId;
  if (first) {
    boardId = first.id;
  } else {
    let facets = [];
    try { facets = JSON.parse(fs.readFileSync(facetsJsonPath, "utf8")).facets || []; } catch {}
    boardId = createBoard(db, "Gallery", facets);
  }
  db.prepare("UPDATE images SET board_id=? WHERE board_id=''").run(boardId);
  console.log(`migrated ${orphanCount} orphan image(s) to board ${boardId}`);
}

// --- settings ---

export function getSetting(db, key) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : null;
}

export function setSetting(db, key, value) {
  if (value === null || value === undefined || value === "") {
    db.prepare("DELETE FROM settings WHERE key=?").run(key);
  } else {
    db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
    ).run(key, String(value));
  }
}

// --- AI tagging queue helpers ---

// Atomically take the oldest pending image and mark it processing.
export function claimNextPending(db) {
  const tx = db.transaction(() => {
    const row = db
      .prepare("SELECT * FROM images WHERE status='pending' ORDER BY created_at ASC, id ASC LIMIT 1")
      .get();
    if (!row) return null;
    db.prepare("UPDATE images SET status='processing', updated_at=? WHERE id=?").run(Date.now(), row.id);
    return row;
  });
  return tx();
}

export function markTagged(db, id, tags) {
  db.prepare("UPDATE images SET status='tagged', tags=?, error=NULL, updated_at=? WHERE id=?").run(
    JSON.stringify(tags),
    Date.now(),
    id
  );
}

// Increment attempts; mark failed once attempts reach maxAttempts, else requeue. Returns true if failed.
export function failOrRequeue(db, id, error, maxAttempts) {
  const row = db.prepare("SELECT attempts FROM images WHERE id=?").get(id);
  const attempts = (row ? row.attempts : 0) + 1;
  const status = attempts >= maxAttempts ? "failed" : "pending";
  db.prepare("UPDATE images SET status=?, attempts=?, error=?, updated_at=? WHERE id=?").run(
    status,
    attempts,
    String(error).slice(0, 500),
    Date.now(),
    id
  );
  return status === "failed";
}

// Recover rows stuck in 'processing' (e.g. after a crash) back to pending.
export function recoverStuck(db, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  return db.prepare("UPDATE images SET status='pending' WHERE status='processing' AND updated_at < ?").run(cutoff)
    .changes;
}

function today() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function usageToday(db) {
  const row = db.prepare("SELECT count FROM ai_usage WHERE day=?").get(today());
  return row ? row.count : 0;
}

export function bumpUsage(db) {
  db.prepare(
    "INSERT INTO ai_usage (day, count) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET count = count + 1"
  ).run(today());
}

// Delete a row; returns its filename (caller removes the files) or null if missing.
export function deleteImage(db, id) {
  const row = db.prepare("SELECT filename FROM images WHERE id=?").get(id);
  if (!row) return null;
  db.prepare("DELETE FROM images WHERE id=?").run(id);
  return row.filename;
}

// Reset an image back to the tagging queue. Returns true if it existed.
export function reprocessImage(db, id) {
  const info = db
    .prepare("UPDATE images SET status='pending', tags='[]', attempts=0, error=NULL, updated_at=? WHERE id=?")
    .run(Date.now(), id);
  return info.changes > 0;
}
