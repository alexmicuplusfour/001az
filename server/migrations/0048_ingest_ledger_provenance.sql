-- ingest-deletions-plan.md stage 2: the ledger learns WHY each row exists and
-- WHICH item it produced, so later stages can tell "you deleted this" from
-- "it's on the board" from "it can't be processed" instead of inferring intent
-- from absence.
--
--   reason      admitted | deleted | skipped. Stamped 'deleted' by the three
--               item-deletion sites (db.js deleteEntity / deleteInstance /
--               cancelBoardQueue); 'skipped' by the sweep's unprocessable
--               ledger-and-forget. Existing rows backfill to 'admitted' —
--               the only thing a bare row ever meant.
--   item_id     the born item. NO foreign key, deliberately: entity_ids
--               carries none either, item ids are GENERATED ALWAYS (never
--               reused) so a dangling id is inert, and an FK's SET NULL
--               would erase the link the 'deleted' stamp exists to keep.
--   content_hash / file_size / modified_at
--               file-board provenance (sha256 + the listing's size/mtime),
--               written at admit because it cannot be backfilled without
--               re-reading every file in every source. Readers arrive in
--               stage 5 (rename/drift tiebreakers). Connector rows keep all
--               three NULL — their source_key IS the entity identity.
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS reason TEXT NOT NULL DEFAULT 'admitted';
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS item_id BIGINT;
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS content_hash TEXT;
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS file_size BIGINT;
ALTER TABLE ingest_log ADD COLUMN IF NOT EXISTS modified_at BIGINT;

-- The deletion stamps arrive by item id; without this the stamp UPDATE walks
-- the board's whole ledger per delete (a 300-card bulk delete = 300 walks).
CREATE INDEX IF NOT EXISTS idx_ingest_log_item ON ingest_log(item_id) WHERE item_id IS NOT NULL;

-- The file adapter's self-heal probe: "is a LIVE item on this board already
-- carrying this source key" (files.js admit), asked before paying the fetch.
-- Partial on the provenance marker so upload-born and connector items (which
-- never carry one) cost nothing.
CREATE INDEX IF NOT EXISTS idx_items_provenance
  ON items (board_id, (payload->'provenance'->>'key')) WHERE payload ? 'provenance';

-- Backfill connector links: a feed candidate's key IS the entity identity by
-- construction (connector.js: "the ledger, on_board flags and the unique
-- constraint all agree on what 'already here' means"), and the tag vehicle is
-- the item whose payload carries `source`. File rows stay NULL — the stored
-- filename is unrelated to the source key — and read as legacy: neither
-- provably on the board nor provably deleted.
UPDATE ingest_log l SET item_id = i.id
FROM entities e
JOIN items i ON i.entity_ids @> ARRAY[e.id]::bigint[] AND i.payload ? 'source'
WHERE l.item_id IS NULL
  AND e.board_id = l.board_id
  AND e.identity = l.source_key;
