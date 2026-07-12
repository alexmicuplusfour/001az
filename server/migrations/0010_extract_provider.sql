-- Per-board extraction provider override (the extract leg's key + model);
-- NULL = the board's tagging provider handles extraction too. Mirrors
-- ai_key_id: BIGINT to match ai_keys.id, ON DELETE SET NULL so deleting a
-- key falls back instead of blocking the delete.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS extract_key_id BIGINT REFERENCES ai_keys(id) ON DELETE SET NULL;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS extract_model TEXT;
