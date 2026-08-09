-- Per-board capability pins for transcription and detection (capabilities-plan
-- §5) — the same shape boards already have for tagging (ai_key_id/ai_model) and
-- extraction (extract_key_id/extract_model), plus a provider column those two
-- never needed: a board pin of the BUILT-IN engine ("this board uses Whisper
-- while the app default is paid") names an engine that has no key row, so a key
-- pointer cannot express it. provider and key_id are mutually exclusive by the
-- write path's rule: provider only for an on-device pick, key_id only for a
-- keyed one.
--
-- ON DELETE SET NULL matches ai_key_id: deleting a key clears the pointer at
-- the DB level, and deleteAiKey's registry loop clears the pinned model beside
-- it.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS transcribe_provider TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS transcribe_key_id BIGINT REFERENCES ai_keys(id) ON DELETE SET NULL;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS transcribe_model TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS detect_provider TEXT;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS detect_key_id BIGINT REFERENCES ai_keys(id) ON DELETE SET NULL;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS detect_model TEXT;
