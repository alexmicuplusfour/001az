-- The storage gauge (planning/storage-plan.md, Stage 1): one row per store per
-- day — "the level of `store`, as measured on `day`". A LEVEL, not a flow:
-- deletes and prunes move it without any meterable event landing, which is why
-- this is a sibling table to usage_meter and not a unit in it (the dropped
-- metering Stage 5e). Writes upsert, so re-measuring a day refreshes it and
-- never doubles it — recording a level is idempotent; that is the whole
-- difference from the meter, whose writes add.
--
-- Narrow rows, not columns — the meter's own lesson: a new store (an S3
-- bucket someday, a new sidecar cache) is a new string, never a migration.
-- `store` today: the walked roots (gallery, thumbnails, backups, plugins,
-- npm_cache), db (pg_database_size), and the disk pair disk_total/disk_free —
-- the disk rows ride the same table because they are the same kind of fact,
-- a level on a day, and the series reader would otherwise need a second
-- query shape for them.
--
-- files is NULL where counting files is meaningless (db, the disk pair) —
-- absence, not a fake zero.
CREATE TABLE storage_sample (
  day   TEXT   NOT NULL,   -- YYYY-MM-DD (UTC), db.js day()
  store TEXT   NOT NULL,
  bytes BIGINT NOT NULL,
  files BIGINT,
  PRIMARY KEY (day, store)
);
