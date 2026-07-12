-- Poison-input marker for the embedding sweep: when a single item's text is
-- rejected by the embedder (a content 4xx that survives one-by-one isolation),
-- the error lands here and itemsNeedingEmbedding skips the item — one bad
-- input can no longer wedge the whole backfill batch. Cleared wherever the
-- embed text changes (markTagged, setItemTags) and on a later success.
ALTER TABLE items ADD COLUMN IF NOT EXISTS embed_error TEXT;
