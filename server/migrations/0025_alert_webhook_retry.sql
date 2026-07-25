-- Webhook retries were paced by the sweep tick alone (POLL_MS, ~3s): the
-- three attempts burned out in seconds, so any endpoint blip longer than
-- that — a restart, a deploy — became a permanent 'failed'. retry_at (the
-- items-table retry column, same idea) spaces them: immediate first attempt,
-- then +1 min, then +5 min, then 'failed'. NULL means due now, so existing
-- pending firings just retry on the next sweep.
ALTER TABLE alert_firings ADD COLUMN IF NOT EXISTS retry_at BIGINT;
