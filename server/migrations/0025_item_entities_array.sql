-- Native multi-membership. An item now CARRIES the ordered set of entities it
-- belongs to (entity_ids; [0] is the canonical entity for logging/faces/search),
-- replacing the single entity_id FK. Single-membership is just the length-1
-- case, so extract-mode boards behave identically after the cutover.
--
-- The ON DELETE CASCADE FK (and idx_items_entity) go with the column: an item
-- can belong to several entities, so deleting one entity must NOT cascade the
-- instance away. deleteEntity() does explicit orphan cleanup in code instead.
ALTER TABLE items ADD COLUMN IF NOT EXISTS entity_ids BIGINT[];

UPDATE items
   SET entity_ids = CASE WHEN entity_id IS NULL THEN '{}'::bigint[] ELSE ARRAY[entity_id] END
 WHERE entity_ids IS NULL;

ALTER TABLE items ALTER COLUMN entity_ids SET DEFAULT '{}'::bigint[];
ALTER TABLE items ALTER COLUMN entity_ids SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_items_entities ON items USING GIN (entity_ids);

ALTER TABLE items DROP COLUMN IF EXISTS entity_id;
