-- MCP tokens belong to people (planning/mcp-members-plan.md §3).
--
-- Until now one token lived in `settings.mcp_token` and every call through /mcp
-- acted as whoever `ADMIN_EMAIL` named. That was two problems wearing one row:
-- an agent could not be told apart from the person who set it up, and on any
-- instance whose admin came from first-run setup the variable is empty, so the
-- tools answered "this instance has no admin account configured" while the tab
-- showed a working command (§1).
--
-- user_id is INDEXED, NOT UNIQUE. One token per person is what the page mints;
-- that is a property of the page, and allowing a second one costs nothing here
-- while adding it later would cost a migration.
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT   NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id);

-- Carry the instance's existing token, or every client connected today breaks
-- on deploy.
--
-- It goes to the EARLIEST ADMIN ACCOUNT, deliberately not to the one
-- ADMIN_EMAIL names: that variable is optional automation and is empty on a
-- normal install, which is the bug above. An instance with several admins
-- therefore hands the old token to the first one created — if that is not the
-- person who set MCP up, the other admin mints their own from the tab and
-- nothing is lost but a paste.
--
-- Both halves are conditional by construction: no `mcp_token` row (MCP was
-- never switched on) or no admin at all (a schema migrated before anyone signed
-- up) and the SELECT returns nothing, so nothing is inserted.
INSERT INTO mcp_tokens (user_id, token, created_at, last_used_at)
SELECT a.id,
       t.value,
       (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT,
       -- Stored as a millisecond string; anything else is not a stamp and is
       -- better dropped than cast into an error that fails the whole boot.
       CASE WHEN lu.value ~ '^[0-9]+$' THEN lu.value::BIGINT END
  FROM settings t
  CROSS JOIN (SELECT id FROM users WHERE is_admin ORDER BY created_at ASC LIMIT 1) a
  LEFT JOIN settings lu ON lu.key = 'mcp_last_used'
 WHERE t.key = 'mcp_token' AND t.value <> '';

-- Both rows go, including the one nothing carried. "Last used" is a fact about
-- a client now, and an instance-wide leftover that no code reads is the kind of
-- row a later reader mistakes for state.
DELETE FROM settings WHERE key IN ('mcp_token', 'mcp_last_used');
