ALTER TABLE entities ADD COLUMN IF NOT EXISTS uploaded_by BIGINT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_entities_uploaded_by ON entities(board_id, uploaded_by);
