-- Collapse historical consecutive-duplicate judgment snapshots. addTagSnapshot
-- now dedupes on append (a snapshot = a judgment change), but rows recorded
-- before that fix — periodic retags re-recording a stable item's unchanged
-- judgment every pass — are still on disk. Keep the first row of every run of
-- identical (tags, undecided) per item. jsonb equality is order-sensitive,
-- which is conservative here: model output is schema-ordered, so unchanged
-- judgments repeat byte-identically; an order-shuffled repeat survives, which
-- only costs a row.
DELETE FROM tag_snapshots t
USING (
  SELECT id,
         tags      = LAG(tags)      OVER w AS same_tags,
         undecided = LAG(undecided) OVER w AS same_verdict
  FROM tag_snapshots
  WINDOW w AS (PARTITION BY item_id ORDER BY tagged_at, id)
) d
WHERE t.id = d.id AND d.same_tags AND d.same_verdict;
