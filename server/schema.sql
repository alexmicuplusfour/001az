-- Final schema, applied idempotently at startup (see initDb in db.js).
-- Conventions: ms-epoch BIGINT timestamps (Date.now()), JSONB for JSON blobs,
-- real booleans, FKs with ON DELETE CASCADE doing what db.js transactions
-- used to do by hand under SQLite.

CREATE TABLE IF NOT EXISTS users (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    BIGINT NOT NULL,
  last_login_at BIGINT
);

-- Named API keys for the AI tagger. Multiple providers can coexist; boards
-- pick one (boards.ai_key_id) or inherit the app default (settings.default_key_id).
CREATE TABLE IF NOT EXISTS ai_keys (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name       TEXT NOT NULL,
  provider   TEXT NOT NULL,  -- 'anthropic' | 'openai'
  api_key    TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  facets       JSONB NOT NULL DEFAULT '[]',
  glosses      JSONB NOT NULL DEFAULT '{}',
  context      TEXT NOT NULL DEFAULT '',
  -- ask the tagger for a per-facet justification (stored in images.tag_reasoning)
  ai_reasoning BOOLEAN NOT NULL DEFAULT TRUE,
  -- per-board tagger override; NULL = app default (settings / env)
  ai_key_id    BIGINT REFERENCES ai_keys(id) ON DELETE SET NULL,
  ai_model     TEXT,
  -- auto-tagging: off = uploads wait as 'held' until it's re-enabled;
  -- periodic = the whole board is re-tagged every N minutes (for content
  -- that goes stale; optionally skipping weekends, server-local time)
  auto_tag               BOOLEAN NOT NULL DEFAULT TRUE,
  auto_tag_periodic      BOOLEAN NOT NULL DEFAULT FALSE,
  auto_tag_every_min     INTEGER NOT NULL DEFAULT 1440,
  auto_tag_skip_weekends BOOLEAN NOT NULL DEFAULT FALSE,
  auto_tag_next_run_at   BIGINT,
  created_at   BIGINT NOT NULL
);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_reasoning BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_key_id BIGINT REFERENCES ai_keys(id) ON DELETE SET NULL;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_model TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_periodic BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_every_min INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_skip_weekends BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_next_run_at BIGINT;

CREATE TABLE IF NOT EXISTS board_members (
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_bm_user ON board_members(user_id);

-- status: pending -> processing -> tagged | failed
-- ('held' sits before pending: uploads wait there, untagged, while the
--  board's auto-tagging is off)
CREATE TABLE IF NOT EXISTS images (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filename      TEXT UNIQUE NOT NULL,
  original_name TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  tags          JSONB NOT NULL DEFAULT '[]',
  -- AI's per-facet justification: { facetKey: sentence, fit: sentence }
  tag_reasoning JSONB NOT NULL DEFAULT '{}',
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  undecided     BOOLEAN NOT NULL DEFAULT FALSE,
  thumb_w       INTEGER,
  thumb_h       INTEGER,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
ALTER TABLE images ADD COLUMN IF NOT EXISTS tag_reasoning JSONB NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_images_status ON images(status);
CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at);
CREATE INDEX IF NOT EXISTS idx_images_board ON images(board_id);

CREATE TABLE IF NOT EXISTS invites (
  token      TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL,
  used_at    BIGINT,
  permanent  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorites (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  image_id   BIGINT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_image ON favorites(image_id);

CREATE TABLE IF NOT EXISTS crates (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, board_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crates_user ON crates(user_id);

CREATE TABLE IF NOT EXISTS crate_images (
  crate_id   BIGINT NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
  image_id   BIGINT NOT NULL REFERENCES images(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (crate_id, image_id)
);
CREATE INDEX IF NOT EXISTS idx_crate_images_image ON crate_images(image_id);

-- Legacy global counter, superseded by ai_board_usage; kept because
-- sqlite-to-pg imports it and old rows are the only pre-board history.
CREATE TABLE IF NOT EXISTS ai_usage (
  day   TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 0
);

-- Tagger usage per board per day: call count plus token counts as reported by
-- the provider. Cache reads are broken out from input because they bill at a
-- fraction of the input rate.
CREATE TABLE IF NOT EXISTS ai_board_usage (
  day               TEXT   NOT NULL,
  board_id          TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  count             INTEGER NOT NULL DEFAULT 0,
  input_tokens      BIGINT NOT NULL DEFAULT 0,
  output_tokens     BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, board_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
