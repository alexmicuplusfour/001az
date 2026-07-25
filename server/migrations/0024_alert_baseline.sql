-- Alerts shipped (0023) without a baseline: detection only ever ran at tag
-- landings, so entities that already matched when an alert was created had
-- no alert_matches row — and the next board retag (periodic auto-tag, admin
-- retag, retag-on-refresh) would re-land their tags and announce the entire
-- pre-existing matching set as "new". Creation now seeds the already-
-- matching set as claimed baseline rows: firing_id = 0, a sentinel no
-- alert_firings row ever carries (identities start at 1), invisible to the
-- pending sweep (firing_id IS NULL) and to history (real firing joins).
--
-- This heals alerts created before the fix by baselining whatever matches
-- TODAY: anything matching now was either already announced (its row wins
-- the ON CONFLICT) or predates the alert — either way, not news. The
-- matcher below is the SQL mirror of matchesCondition (alerts.js): every
-- condition key must have at least one of its "key/value" tags present in
-- the entity's union tag set across instances.
INSERT INTO alert_matches (alert_id, entity_id, firing_id, matched_at)
SELECT a.id, e.id, 0, (extract(epoch from now()) * 1000)::bigint
FROM alerts a
JOIN entities e ON e.board_id = a.board_id
WHERE jsonb_typeof(a.condition) = 'object' AND a.condition <> '{}'::jsonb
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_each(a.condition) AS c(facet, vals)
    WHERE NOT EXISTS (
      SELECT 1 FROM items i
      CROSS JOIN LATERAL jsonb_array_elements_text(i.tags) AS t(tag)
      WHERE i.entity_id = e.id
        AND t.tag IN (SELECT c.facet || '/' || v.val FROM jsonb_array_elements_text(c.vals) AS v(val))
    )
  )
ON CONFLICT (alert_id, entity_id) DO NOTHING;
