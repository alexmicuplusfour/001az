-- Alerts: a per-user watched facet condition. Detection writes alert_matches
-- the moment an entity's union tag set enters the condition's matching set;
-- delivery (webhook / daily digest / record-only) is a worker sweep that
-- groups pending matches into alert_firings — history is always exact, the
-- webhook is just a consumer. entity_id/item_id are plain columns, NOT
-- foreign keys: history outlives the rows it describes (the job_log stance),
-- with `label` freezing a display name at match time.
CREATE TABLE IF NOT EXISTS alerts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id          BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  board_id         TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name             TEXT   NOT NULL,
  condition        JSONB  NOT NULL DEFAULT '{}', -- { facetKey: [values] }, ≥1 facet (API-enforced)
  delivery         TEXT   NOT NULL DEFAULT 'immediate', -- 'immediate' | 'daily' | 'record'
  daily_at_min     INTEGER,           -- minutes-of-day, delivery='daily' only
  next_delivery_at BIGINT,            -- daily: next due; stamped after each run
  webhook_url      TEXT,              -- NULL for record-only
  webhook_secret   TEXT,              -- optional; X-Alert-Signature when set
  enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       BIGINT NOT NULL,
  UNIQUE(user_id, board_id, name)
);
CREATE INDEX IF NOT EXISTS idx_alerts_board ON alerts(board_id) WHERE enabled;

-- One row per (alert, entity), EVER — the once-only dedupe IS the primary
-- key: re-tags that keep an entity matching are no-ops, and drifting out of
-- the set and back in doesn't re-fire.
CREATE TABLE IF NOT EXISTS alert_matches (
  alert_id   BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  entity_id  BIGINT NOT NULL,
  item_id    BIGINT,            -- the instance whose tagging triggered it
  label      TEXT,              -- display name frozen at match time
  firing_id  BIGINT,            -- NULL until a delivery sweep groups it
  matched_at BIGINT NOT NULL,
  PRIMARY KEY (alert_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_alert_matches_pending ON alert_matches(alert_id) WHERE firing_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_alert_matches_firing ON alert_matches(firing_id);

-- One row per delivery/grouping event — what history shows and ?event= links
-- to. webhook_status NULL = record-only (or webhook-less) grouping.
CREATE TABLE IF NOT EXISTS alert_firings (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alert_id       BIGINT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  fired_at       BIGINT NOT NULL,
  entity_count   INTEGER NOT NULL,
  webhook_status TEXT,           -- NULL | 'pending' | 'ok' | 'failed'
  webhook_error  TEXT,
  attempts       INTEGER NOT NULL DEFAULT 0,
  seen           BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_alert_firings_alert ON alert_firings(alert_id, fired_at DESC);
