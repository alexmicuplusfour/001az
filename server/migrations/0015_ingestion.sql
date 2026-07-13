-- Automatic ingestion (the third leg, upstream of extract/tag). boards.ingest
-- mirrors boards.mapping (user-saved config); ingest_next_run_at mirrors
-- auto_tag_next_run_at (the sweep timer); ingest_state is sweep-owned run
-- status, a separate column so user saves never clobber sweep writes.
-- ingest_log is the per-board dedup ledger: one row per source_key ever
-- admitted. Entity deletion does NOT remove the row — that is what keeps a
-- feed from resurrecting a user-deleted item.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ingest JSONB;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ingest_next_run_at BIGINT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS ingest_state JSONB;

CREATE TABLE IF NOT EXISTS ingest_log (
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  source_key TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  PRIMARY KEY (board_id, source_key)
);
