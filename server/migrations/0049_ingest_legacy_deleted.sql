-- ingest-deletions-plan.md stage 3: reconcile LEGACY connector ledger rows.
-- Items deleted before the stamps existed (stage 2) left rows at
-- reason='admitted' with no item link — 0048's backfill could only link rows
-- whose entity still exists. For CONNECTOR boards, absence is proof: the
-- source_key IS the entity identity by construction, so an unlinkable row
-- means the entity is gone — deleted by the user or cancelled from the
-- queue, both of which must read as "held back", not "on board". (The
-- motivating board's 1,433 pre-stamp deletions live exactly here.)
--
-- File-board rows are untouched: a stored filename is unrelated to its
-- source key, so absence is unprovable there — those rows stay 'admitted'
-- and keep consuming Keep-top slots, the same documented legacy population
-- as the identityDedup deferral (files.js descriptor).
-- Absence is tested DIRECTLY (no entity carries this identity), not via
-- "0048 failed to link an item". The two are not the same: a connector entity
-- that extraction merged away leaves its instance alive under another entity,
-- so 0048 can't link it and a null-link test would stamp a row whose item is
-- still on the board — backfilling its Keep-top slot and offering it for
-- "bring back" as a duplicate.
UPDATE ingest_log l SET reason='deleted'
FROM boards b
WHERE b.id = l.board_id
  AND b.mapping->'input'->>'connector' IS NOT NULL
  AND l.reason = 'admitted'
  AND NOT EXISTS (
    SELECT 1 FROM entities e WHERE e.board_id = l.board_id AND e.identity = l.source_key
  );
