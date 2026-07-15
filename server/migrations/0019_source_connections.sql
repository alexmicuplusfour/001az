-- Saved source connections: reusable, admin-managed credentials for REMOTE
-- ingestion sources (ftp, s3, …), mirroring ai_keys for AI providers. A board's
-- ingest config references one by id (ingest.source.connectionId) plus a
-- subpath; the credentials live here once, never in boards.ingest — so a board
-- manager configuring ingestion picks a connection an admin already made and
-- never sees the password. `config` holds all connection fields including
-- secrets, plaintext, consistent with ai_keys.api_key and the
-- <domain>_key_<provider> settings. Boards reference a row from JSONB (no FK):
-- deleting a connection a board uses is graceful (the board's next run surfaces
-- a readable error), never blocked — flexibility over guardrails.
CREATE TABLE IF NOT EXISTS source_connections (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT   NOT NULL,
  label      TEXT   NOT NULL,
  config     JSONB  NOT NULL DEFAULT '{}',
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);
