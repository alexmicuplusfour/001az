-- Comments on cards (planning/comments-plan.md, D5).
--
-- One thread per card. Deleting a card deletes its thread, as it deletes its
-- hearts. Deleting an account does NOT delete its comments: user_id goes empty
-- and the thread signs them "Former member" (D3), the way a deleted uploader
-- leaves a card with no uploader (0009).
--
-- entity_id, not item_id like favorites: that column's name is history.
--
-- (entity_id, created_at) serves a thread read oldest first and each card's
-- count in the board listing. user_id is indexed because deleting an account
-- finds its comments by it.
CREATE TABLE IF NOT EXISTS comments (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_id  BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  user_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  body       TEXT   NOT NULL,
  created_at BIGINT NOT NULL,
  edited_at  BIGINT
);
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_user ON comments(user_id);
