-- "This audio clip is still waiting on its transcript", stored
-- (planning/audio-tag-handoff-plan.md Stage 6). The work claim, the
-- transcription sweep and the wire's counts all ask it, and asking the
-- payload meant unpacking every candidate row's jsonb on every ask: measured
-- on 20k queued rows with 6KB payloads, the claim went from 15ms to 550ms,
-- and it runs several times a second while work flows. A generated column
-- answers from the row itself, and Postgres keeps it true on every payload
-- write, so no writer can forget it.
--
-- The rule is db.js NEEDS_TRANSCRIPT_SQL's, which now reads this column: the
-- first file is audio, with neither a transcript nor a parked
-- transcript_error (an empty transcript, a silent clip, is an answer).
-- COALESCE because a file-less row's kind is NULL, and the column is a plain
-- true/false. Backup skips generated columns (backup.js tableColumns);
-- restore recomputes it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS awaiting_transcript BOOLEAN NOT NULL
  GENERATED ALWAYS AS (COALESCE(
    payload->'files'->0->>'kind' = 'audio'
      AND NOT (payload ? 'transcript')
      AND NOT (payload ? 'transcript_error'),
    FALSE)) STORED;
