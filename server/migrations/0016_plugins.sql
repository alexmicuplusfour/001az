-- Plugin state: enabled/config overrides + health ledger, one row per plugin
-- id ("ai:openai", "crypto:coingecko", "media:pdf"). An ABSENT row means
-- enabled with default config — the registry (server/plugins.js) coalesces,
-- so built-ins need no seeding and a fresh install starts empty. `config`
-- holds only schema-declared overrides (rpm/burst …); secrets stay in their
-- existing stores (ai_keys table, `<domain>_key_<provider>` settings).
-- last_error stays structured ({message, status, at}) — the future
-- self-healing loop needs more than a flattened string.
CREATE TABLE IF NOT EXISTS plugins (
  id           TEXT PRIMARY KEY,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  config       JSONB   NOT NULL DEFAULT '{}',
  fail_count   INT     NOT NULL DEFAULT 0,
  last_ok_at   BIGINT,
  last_fail_at BIGINT,
  last_error   JSONB,
  updated_at   BIGINT
);
