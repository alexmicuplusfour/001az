-- Indexes for the paginated/delta list endpoint. Keyset pagination walks
-- entities in (board_id, created_at DESC, id DESC) order page by page, and
-- delta polls (?since=) filter both tables by board + updated_at, so each
-- gets a composite index instead of leaning on the single-column board index
-- plus a sort/filter over the whole board.
CREATE INDEX IF NOT EXISTS idx_entities_board_created ON entities(board_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_entities_board_updated ON entities(board_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_items_board_updated ON items(board_id, updated_at);
