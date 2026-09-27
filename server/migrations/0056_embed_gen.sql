-- The embed-write fence (planning/audio-tag-handoff-plan.md Stage 4). Every
-- writer that lands new embed text (a transcript, AI tags, a tag edit) clears
-- the item's vector through one SQL fragment (db.js CLEAR_EMBEDDING), which
-- now also bumps this counter. The embed sweep reads it with the row and its
-- vector lands only while it is unchanged, so a vector computed from text that
-- was replaced mid-call (the tags landing while a transcript-only embed is in
-- the air) is dropped and the row stays due, instead of standing as the item's
-- vector for good. The reset verbs (retag, reprocess, re-transcribe) blank the
-- text without clearing; the landing after them does.
ALTER TABLE items ADD COLUMN IF NOT EXISTS embed_gen INTEGER NOT NULL DEFAULT 0;
