-- Anthropic stops being pre-added (planning/welcome-plan.md 4.4). The welcome
-- screen is the chooser now, so `defaultInstalled` no longer says "anthropic"
-- outright — it says "anthropic, if the operator put ANTHROPIC_API_KEY in the
-- environment", which is reading their choice rather than making one.
--
-- That leaves one population stranded, and this is for them: an admin who added
-- an Anthropic key THROUGH THE UI. They never touched the install toggle
-- because the card was already there, so their row is absent or `installed IS
-- NULL` — which falls to the default that is about to change. Every rung of
-- resolution is install-gated (capability-resolve.js, disqualified), so the
-- flip would stop their tagging on upgrade, with no error and nothing said.
--
-- Narrow on purpose: only where an anthropic key actually exists. That is
-- exactly the set where the old default was load-bearing. A fresh instance has
-- no such row and keeps the clean slate the change is for, and an instance that
-- carried the card without ever using it loses a vendor nobody chose — which is
-- the point of the change rather than a casualty of it.
--
-- Same shape and same reason as 0017, which did this once before: a default
-- changed, so the rows relying on the old one were given an explicit value and
-- nothing moved under them. The `WHERE plugins.installed IS NULL` guard is what
-- keeps an explicit removal explicit — an admin who turned Anthropic OFF and
-- left a key behind meant it, and this must not undo that.
INSERT INTO plugins (id, installed, updated_at)
SELECT 'ai:anthropic', TRUE, (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT
WHERE EXISTS (SELECT 1 FROM ai_keys WHERE provider = 'anthropic')
ON CONFLICT (id) DO UPDATE
  SET installed = TRUE, updated_at = EXCLUDED.updated_at
  WHERE plugins.installed IS NULL;
