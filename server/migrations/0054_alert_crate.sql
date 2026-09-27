-- Alert crating (planning/alert-crating-plan.md, Stage 3): an alert can put
-- each new match into one of its owner's crates on the alert's board. "On" is
-- a crate being set, the way a webhook is a URL being set, so there is no
-- separate flag to disagree with it.
--
-- A real foreign key, unlike alert_matches.entity_id: that column is history
-- and outlives what it names, this one is a live setting. SET NULL, not
-- CASCADE: deleting the crate turns the alert's crating off and leaves the
-- alert watching. Named, because the save routes read the name: a crate
-- deleted between their ownership check and the write fails on this link, and
-- that is "crate not found", not a 500.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS crate_id BIGINT
  CONSTRAINT alerts_crate_id_fkey REFERENCES crates(id) ON DELETE SET NULL;
