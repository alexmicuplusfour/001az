-- Extracted fields are embed text now (planning/field-embedding-plan.md).
--
-- "This item has something to embed", stored (D9): the sweep's claim asks it
-- every tick and the jobs chip's count on every poll, and asking the payload
-- meant unpacking every row without a vector each time. Measured on 20k rows
-- with nothing to say, the claim took 76 ms and the count 408 ms, against
-- 4 ms and 3 ms reading this column; with 6 KB payloads, 2.7 s and 2.5 s
-- against 3 ms. A 20k-row UPDATE costs the same with it as without. Postgres
-- keeps it true on every write, so no writer can forget it.
--
-- The rule is the SQL half of worker.js embedTextFor's, and a test holds the
-- two to the same answer row for row: a tag, a reasoning sentence, a
-- transcript, or an answered AI field — a stored field not stamped src "file"
-- whose value is a non-empty string, a number or a non-empty list (a detect
-- field's boxes are such a list). An unanswered field is no text, key and all,
-- or "snow: No objects detected" would match a search for snow. Lax JSON paths
-- because payloads are free-form and a strict one errors on a shape it doesn't
-- expect; COALESCE because a missing transcript is NULL, and the column is a
-- plain true/false. Backup skips generated columns (backup.js tableColumns);
-- restore recomputes it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS has_embed_text BOOLEAN NOT NULL
  GENERATED ALWAYS AS (COALESCE(
    tags <> '[]'::jsonb
      OR jsonb_path_exists(tag_reasoning, 'lax $.* ? (@.type() == "string" && @ like_regex "[^[:space:]]")')
      OR (jsonb_typeof(payload->'transcript') = 'string' AND payload->>'transcript' ~ '[^[:space:]]')
      OR jsonb_path_exists(payload, 'lax $.fields.* ? (@.type() == "object" && !(@.src == "file") && ((@.v.type() == "string" && @.v != "") || @.v.type() == "number" || (@.v.type() == "array" && @.v.size() > 0)))'),
    FALSE)) STORED;

-- A vector built before this read only the item's tags, reasoning and
-- transcript, and fell back to its file name when there were none. Two kinds
-- are stale, then: one whose item has an answered AI field (file fields
-- aren't embed text, so an item whose fields are all file fields keeps its
-- vector), and one whose item has nothing to say at all, which was embedded
-- from a name. Both are cleared the way db.js CLEAR_EMBEDDING clears a vector,
-- a rejection mark included, and the sweep embeds again whatever has text; an
-- item with none stays without a vector. Not for running twice: a vector built
-- after this already carries its fields.
UPDATE items
   SET embedding = NULL, embedding_model = NULL, embed_error = NULL, embed_gen = embed_gen + 1
 WHERE (embedding IS NOT NULL OR embed_error IS NOT NULL)
   AND (jsonb_path_exists(payload, 'lax $.fields.* ? (@.type() == "object" && !(@.src == "file") && ((@.v.type() == "string" && @.v != "") || @.v.type() == "number" || (@.v.type() == "array" && @.v.size() > 0)))')
        OR NOT has_embed_text);
