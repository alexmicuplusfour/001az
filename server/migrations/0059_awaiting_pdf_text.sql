-- "This PDF is still waiting for its text", stored
-- (planning/pdf-conversion-plan.md, C4). A PDF is read once, in its own job,
-- and the text kept beside it; the work claim doesn't hand a step a PDF whose
-- text isn't there yet, the read job looks for the ones that need it, and the
-- wire counts them. Stored for the reason 0057 measured for audio: asking the
-- payload meant unpacking every candidate row's jsonb on every claim.
--
-- The rule is db.js NEEDS_PDF_TEXT_SQL's: the first file is a PDF, with
-- neither its text's stamp nor a parked read's error. COALESCE because a
-- file-less row's kind is NULL. Every PDF already in the app reads true here;
-- the read job only takes the ones queued for a step, so they are read when
-- they next need it, not all at once. Backup skips generated columns
-- (backup.js tableColumns); restore recomputes it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS awaiting_pdf_text BOOLEAN NOT NULL
  GENERATED ALWAYS AS (COALESCE(
    payload->'files'->0->>'kind' = 'pdf'
      AND NOT (payload ? 'pdf_text')
      AND NOT (payload ? 'pdf_text_error'),
    FALSE)) STORED;
