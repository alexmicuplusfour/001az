-- Spaced retries for transient worker failures. failOrRequeue stamps the
-- earliest next claim time here when a tag/extract/face attempt fails with a
-- transient error (429/5xx/network), so retries are spread over minutes
-- instead of burning every attempt within seconds of a rate-limit burst.
-- The claim queries skip rows whose retry_at is in the future; every path
-- that wants an immediate run (retag/reprocess/release/mark*) clears it.
ALTER TABLE items ADD COLUMN IF NOT EXISTS retry_at BIGINT;
