-- External (dynamically-loaded) plugins: the install record for code fetched
-- from a URL, npm-installed onto the /data/plugins volume, and registered at
-- runtime. One row per catalog id ("crypto:vendor.name", "ai:vendor.name").
-- This is ONLY the provenance/record; per-plugin config + health still live in
-- the `plugins` table exactly like a built-in. The row is authoritative (boot
-- reloads each row's `dir`); the on-disk dir holds the code. `load_error` is set
-- when the last load attempt failed (bad apiVersion, throwing factory, npm
-- failure) so the page can show an errored card + Retry without re-fetching.
CREATE TABLE IF NOT EXISTS external_plugins (
  id           TEXT PRIMARY KEY,
  kind         TEXT   NOT NULL,   -- ai-provider | connector-provider | connector-domain
  source_url   TEXT   NOT NULL,   -- what the admin pasted
  resolved_ref TEXT,              -- commit sha / npm version actually installed
  dir          TEXT   NOT NULL,   -- absolute path under PLUGINS_DIR
  manifest     JSONB  NOT NULL,
  installed_at BIGINT,
  load_error   JSONB              -- {message, at} when the last load failed
);
