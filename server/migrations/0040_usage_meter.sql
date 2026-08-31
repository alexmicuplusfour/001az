-- The usage meter (planning/metering-plan.md, Stage 1): one mechanism for
-- "N units of `unit` consumed by this subject". Narrow rows — one per unit,
-- not a column per unit — so a new billable thing (audio-seconds, images,
-- connector requests) is a new string, never a migration.
--
-- Dimensions are TEXT NOT NULL with '' for "doesn't apply", deliberately NOT
-- nullable: Postgres treats NULLs as distinct in unique indexes, so a nullable
-- PK column would break the ON CONFLICT upsert and turn this rollup into an
-- append-only log by accident. The cost of the sentinel is losing the FK on
-- board_id — deleteBoard purges the meter explicitly instead.
--
-- capability takes the job-log kind vocabulary (CAPABILITY_DEFS ids plus
-- sibling paid work like 'diagnose'); unit takes OTel's gen_ai names for the
-- token buckets, kept MUTUALLY EXCLUSIVE (input does not include cache reads —
-- they bill at different rates, and a meter feeding a price must not
-- double-count; a deliberate divergence from OTel's inclusive input_tokens).
--
-- priced_quantity / cost_micros are Stage 3's columns, stamped at write time
-- so a later price edit never rewrites history; zero until then. Created now
-- so Stage 3 needs no second reshape of this table.
CREATE TABLE usage_meter (
  day             TEXT   NOT NULL,   -- YYYY-MM-DD (UTC)
  board_id        TEXT   NOT NULL,   -- '' = app-level spend
  capability      TEXT   NOT NULL,
  provider        TEXT   NOT NULL,   -- '' = unattributed (pre-meter history)
  model           TEXT   NOT NULL,   -- '' = unattributed / no model axis
  unit            TEXT   NOT NULL,
  quantity        BIGINT NOT NULL DEFAULT 0,
  priced_quantity BIGINT NOT NULL DEFAULT 0,
  cost_micros     BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (day, board_id, capability, provider, model, unit)
);
-- Per-board reads (the chip totals, the admin cell) filter on board_id alone,
-- which the day-led PK can't serve.
CREATE INDEX idx_usage_meter_board ON usage_meter (board_id);

-- Backfill: unpivot the old per-day rollup. Everything it ever recorded was
-- tagger-family spend with no model recorded, so it lands as capability 'tag'
-- with provider/model '' — honestly labelled unattributed rather than guessed.
-- No ON CONFLICT needed: the source PK is (day, board_id), so target rows are
-- unique by construction.
INSERT INTO usage_meter (day, board_id, capability, provider, model, unit, quantity)
SELECT day, board_id, 'tag', '', '', u.unit, u.q
FROM ai_board_usage,
LATERAL (VALUES ('requests',          count),
                ('input_tokens',      input_tokens),
                ('output_tokens',     output_tokens),
                ('cache_read_tokens', cache_read_tokens),
                ('web_searches',      search_count)) AS u(unit, q)
WHERE u.q > 0;

-- The old table goes: its only writer (bumpUsage) and both readers move to
-- usage_meter in the same change, and the sqlite importer never touched it
-- (that coupling is ai_usage, the pre-board global counter, which stays).
DROP TABLE ai_board_usage;
