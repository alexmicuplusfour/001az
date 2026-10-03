-- A tagging consistency finding stands while its question and its % hold
-- (planning/facet-diagnosis-rerun-plan.md). The question it answers was stored
-- as `v3|<stamp>|<more>`: a fingerprint of the twelve worked examples, and on
-- older entries a rate bucket and the examples' ids before it. It is now
-- `v3|<stamp>`, and the `stale` flag and `evidence` list that went with the
-- fingerprint are gone. Rewriting the stored keys keeps every finding standing
-- across the update, where a mismatch would re-ask every one of them once and
-- light a dot on every board with Double-check tags on.
--
-- Only `v3` keys are rewritten: the question a v3 key answers is the same one,
-- whatever else it carried. A `v2` key answers an older question and is asked
-- again either way. Safe to run twice: a rewritten key no longer matches.
UPDATE boards SET facet_diagnostics = (
  SELECT jsonb_object_agg(key, CASE
    WHEN jsonb_typeof(value) <> 'object' THEN value
    WHEN value->>'k' ~ '^v3\|[0-9a-f]{12}\|'
      THEN jsonb_set(value - 'stale' - 'evidence', '{k}', to_jsonb(substring(value->>'k' from '^v3\|[0-9a-f]{12}')))
    ELSE value - 'stale' - 'evidence'
  END)
  FROM jsonb_each(facet_diagnostics)
)
WHERE facet_diagnostics <> '{}'::jsonb;
