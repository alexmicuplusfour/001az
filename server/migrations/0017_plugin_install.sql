-- Plugins move from enabled/disabled to installed/available. `installed` is a
-- NEW nullable column: NULL = "no explicit choice" → the registry
-- (server/plugins.js) coalesces to a per-tier default — core capabilities
-- (media handlers, the on-device embedder) and the pre-added flagship AI
-- provider are installed; every other connection is AVAILABLE until added.
--
-- A phase-1 *disable* carries real intent and becomes a removal. A phase-1
-- enabled/health-only row does NOT — everything was on-by-default then, and a
-- row often exists only because the plugin was CALLED (health telemetry); those
-- stay NULL so they fall to their tier default rather than reading as an
-- explicit install. The old `enabled` column is left in place, unread, so this
-- step is trivial and reversible (drop it in a future squash).
ALTER TABLE plugins ADD COLUMN IF NOT EXISTS installed BOOLEAN;
UPDATE plugins SET installed = FALSE WHERE enabled = FALSE AND installed IS NULL;
