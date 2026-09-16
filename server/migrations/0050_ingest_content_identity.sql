-- ingest-deletions-plan.md stage 5: content is a file board's identity; the
-- path is just the slot it landed in. Two lookups need indexes.
--
-- "Have I seen these bytes, and did you delete them?" — asked once per
-- admission, after the hash the admit path already computes.
CREATE INDEX IF NOT EXISTS idx_ingest_log_deleted_hash
  ON ingest_log (board_id, content_hash)
  WHERE reason = 'deleted' AND content_hash IS NOT NULL;

-- "Are these bytes already on the board?" — asked of the ITEMS, not the
-- ledger, deliberately: the item-side copy survives a Forget-all, so content
-- recognition keeps working after a memory wipe. Sibling of the key-side
-- provenance index (0048), same partial predicate so upload-born and
-- connector items (which carry no provenance) cost nothing.
CREATE INDEX IF NOT EXISTS idx_items_provenance_hash
  ON items (board_id, (payload->'provenance'->>'hash'))
  WHERE payload ? 'provenance';
