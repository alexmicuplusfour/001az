-- The ingestion sweep no longer filters on ingest.enabled — ingest_next_run_at
-- alone decides whether a board fires, which is what lets "Run now" fire a
-- paused feed once without resuming its watch.
--
-- The save path has always nulled the stamp when a board went disabled or
-- manual, so this should be a no-op. But a run that landed concurrently with a
-- disable could have re-armed the stamp afterwards, and until now the enabled
-- predicate quietly swallowed that row. Without the predicate it would start
-- running the moment this ships, so clear those stamps once, up front.
UPDATE boards
   SET ingest_next_run_at = NULL
 WHERE ingest_next_run_at IS NOT NULL
   AND (ingest IS NULL
        OR NOT COALESCE((ingest->>'enabled')::boolean, false)
        OR ingest #>> '{trigger,mode}' = 'manual');
