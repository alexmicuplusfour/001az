-- Per-board job history (the transparency ledger): one row per execution
-- attempt — a transcription, an ingest run, later the pipeline legs. The
-- queue itself lives on items and overwrites its own evidence on success
-- (status/attempts/error reset); this table is where the evidence survives.
-- `running` rows exist only for the sweep families (transcribe, ingest) —
-- the pipeline legs are already visible via items.status while in flight.
-- entity_id/item_id are plain columns, NOT foreign keys: history outlives the
-- rows it describes (the ingest_log stance), with `target` freezing a display
-- label at execution time so old rows still read after deletion. board_id
-- does cascade — a deleted board takes its log with it.
CREATE TABLE IF NOT EXISTS job_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  board_id   TEXT   NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  entity_id  BIGINT,
  item_id    BIGINT,
  target     TEXT,
  kind       TEXT   NOT NULL, -- 'transcribe' | 'ingest' | (stage 3: 'tag' | 'extract' | 'face')
  outcome    TEXT   NOT NULL, -- 'running' | 'ok' | 'failed' | 'requeued' | 'discarded' | 'interrupted'
  error      TEXT,
  detail     JSONB  NOT NULL DEFAULT '{}',
  started_at BIGINT NOT NULL,
  ended_at   BIGINT
);
CREATE INDEX IF NOT EXISTS idx_job_log_board ON job_log (board_id, started_at DESC, id DESC);
