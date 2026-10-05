-- "A step asked for this PDF's text", stored (planning/pdf-conversion-plan.md,
-- C4). With the PDF card's "Convert PDFs to text" switch off, a step sends the
-- PDF file itself where its provider reads one, and no PDF waits for a read;
-- where it can't, the step marks the PDF (payload.pdf_text_wanted) and puts it
-- back, and the claim, the read job and the waiting counts treat it as they
-- treat every unread PDF with the switch on. Stored for the reason 0057
-- measured: with the switch off, asking the payload would unpack every unread
-- PDF's jsonb on every claim.
--
-- Read only beside awaiting_pdf_text (db.js awaitingPdfTextSql), so it needs no
-- PDF test of its own. Backup skips generated columns (backup.js tableColumns);
-- restore recomputes it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS pdf_text_wanted BOOLEAN NOT NULL
  GENERATED ALWAYS AS (COALESCE(payload ? 'pdf_text_wanted', FALSE)) STORED;
