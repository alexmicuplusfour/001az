-- Final schema, applied idempotently at startup (see initDb in db.js; live
-- DBs from before the modular-boards refactor are renamed images -> items by
-- a one-time migration there first).
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
  provider   TEXT NOT NULL,  -- 'anthropic' | 'openai' | 'gemini' | 'glm' | 'openrouter'
  api_key    TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS boards (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- legacy (board-type era): kept for old rows, read by nothing. Drop in a
  -- future schema pass.
  type         TEXT NOT NULL DEFAULT 'image',
  facets       JSONB NOT NULL DEFAULT '[]',
  glosses      JSONB NOT NULL DEFAULT '{}',
  context      TEXT NOT NULL DEFAULT '',
  -- ask the tagger for a per-facet justification (stored in items.tag_reasoning)
  ai_reasoning BOOLEAN NOT NULL DEFAULT TRUE,
  -- let the tagger use the provider's web-search tool before judging
  -- (Anthropic only so far; other providers tag from the given input)
  ai_research  BOOLEAN NOT NULL DEFAULT FALSE,
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
  -- per-board entity mapping (AI fields only in v1; connector fields arrive later).
  -- NULL = plain file upload, no extraction; board behaves exactly as today.
  mapping      JSONB,
  created_at   BIGINT NOT NULL
);
ALTER TABLE boards ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'image';
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_reasoning BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_research BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_key_id BIGINT REFERENCES ai_keys(id) ON DELETE SET NULL;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ai_model TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_periodic BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_every_min INTEGER NOT NULL DEFAULT 1440;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_skip_weekends BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS auto_tag_next_run_at BIGINT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS mapping JSONB;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS gather_every_min INTEGER;

-- role: 'member' (view only) | 'admin' (may edit this board's content from the
-- gallery — name/context/facets/toggles/schedule; not the AI key, retag, or
-- delete). Global users.is_admin outranks this and needs no row here.
CREATE TABLE IF NOT EXISTS board_members (
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT   NOT NULL DEFAULT 'member',
  created_at BIGINT NOT NULL,
  PRIMARY KEY (board_id, user_id)
);
ALTER TABLE board_members ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';
CREATE INDEX IF NOT EXISTS idx_bm_user ON board_members(user_id);

-- status: held -> pending_extract -> extracting -> pending -> processing -> tagged | failed
-- ('held' gates all AI spend; items with a stamped mapping go through the
--  extract leg first, plain items skip straight to pending)
-- payload is one generic shape for every item:
--   { identity, files: [{ name, original_name, w, h }], fields: {} }
-- identity is the item's per-board unique key (for uploads, the stored
-- filename), files its material, fields reserved for extraction.
CREATE TABLE IF NOT EXISTS items (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id      TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending',
  tags          JSONB NOT NULL DEFAULT '[]',
  -- AI's per-facet justification: { facetKey: sentence, fit: sentence }
  tag_reasoning JSONB NOT NULL DEFAULT '{}',
  undecided     BOOLEAN NOT NULL DEFAULT FALSE,
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  payload       JSONB NOT NULL DEFAULT '{}',
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);
ALTER TABLE items ADD COLUMN IF NOT EXISTS tag_reasoning JSONB NOT NULL DEFAULT '{}';
-- Semantic search: one vector per tagged item (raw Float32Array bytes) from
-- the app-global embedding model (settings: embed_enabled/embed_key_id/
-- embed_model). NULL = not embedded yet; a model mismatch means stale — the
-- worker sweep (re)embeds both cases.
ALTER TABLE items ADD COLUMN IF NOT EXISTS embedding BYTEA;
ALTER TABLE items ADD COLUMN IF NOT EXISTS embedding_model TEXT;
CREATE INDEX IF NOT EXISTS idx_items_status ON items(status);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at);
CREATE INDEX IF NOT EXISTS idx_items_board ON items(board_id);
-- identity is unique per board (successor of the old global UNIQUE(filename);
-- per-board is the real semantic — the same file may exist on two boards)
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_board_identity ON items (board_id, (payload->>'identity'));

-- Judgment history: one row per tagging event (AI run or manual edit), so
-- scheduled retags accrue a timeline instead of overwriting the only copy.
-- items.tags/tag_reasoning stay the latest state; this is the log behind it.
CREATE TABLE IF NOT EXISTS tag_snapshots (
  id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id   BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  source    TEXT NOT NULL DEFAULT 'ai',  -- 'ai' | 'user'
  tags      JSONB NOT NULL DEFAULT '[]',
  reasoning JSONB NOT NULL DEFAULT '{}',
  undecided BOOLEAN NOT NULL DEFAULT FALSE,
  tagged_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_item ON tag_snapshots(item_id, tagged_at);

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
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_fav_item ON favorites(item_id);

CREATE TABLE IF NOT EXISTS crates (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  public     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, board_id, name)
);
CREATE INDEX IF NOT EXISTS idx_crates_user ON crates(user_id);

-- Saved filter configurations: a named snapshot of the facet selection.
-- Applied one-shot (loading one just sets the filters; nothing stays
-- "active"). Per user per board — facets differ across boards.
CREATE TABLE IF NOT EXISTS filter_configs (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  config     JSONB NOT NULL DEFAULT '{}',  -- { facetKey: [values] }
  created_at BIGINT NOT NULL,
  UNIQUE(user_id, board_id, name)
);
CREATE INDEX IF NOT EXISTS idx_filter_configs_user ON filter_configs(user_id, board_id);

CREATE TABLE IF NOT EXISTS crate_items (
  crate_id   BIGINT NOT NULL REFERENCES crates(id) ON DELETE CASCADE,
  item_id    BIGINT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (crate_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_crate_items_item ON crate_items(item_id);

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
  -- web searches (ai_research boards) bill per search, on top of tokens
  search_count      BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, board_id)
);
ALTER TABLE ai_board_usage ADD COLUMN IF NOT EXISTS search_count BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
