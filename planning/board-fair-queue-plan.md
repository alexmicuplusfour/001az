# Board-fair queue — plan (2026-07-19)

Make the worker take turns across boards instead of draining one global FIFO line.
Sibling of `worker-queue-holes.md` §10: that entry fixed **stage-vs-stage** starvation
(the unified `claimNextWork`) and deferred priority tiering. This is the third axis —
**board-vs-board** fairness — still open. Pre-release, no users yet; this is proactive
design, chosen on principle ("treat two boards equally"), not to fix an observed incident.

## The problem

The entire scheduling policy is one line in `claimNextWork` (db.js ~1242):

```sql
ORDER BY i.created_at ASC, i.id ASC LIMIT 1
```

One global queue, ordered by item age, board-blind (boards are joined only for the
key gate). Two boards' work merges into a single age-ordered line, so a burst on
board A delays board B's later-but-smaller work by **A's entire backlog**. Concretely:
A uploads 300 files, B uploads 3 a minute later → B's 3 sit behind all 300 (minutes to
hours, since the extract stage funnels through one single-threaded OCR sidecar). B did
nothing wrong; it has no isolation from A. That lack of isolation is the whole bug.

## Goal

Round-robin across boards: when N boards have ready work, each gets an equal share of
the worker. A small board interleaves ahead of a large board's backlog instead of
waiting behind it. **Single-board behavior is unchanged (stays exact FIFO).** Fairness
is *per board*, not per item — equal share regardless of how much each board queued.

Non-goal: throughput. Taking turns changes *who waits*, not total speed (4 slots + one
OCR sidecar are the fixed ceiling either way). A's 300 still finish in the same wall
time; B's 3 just stop being hostage to them.

## The key realization: why the naive version is a no-op

The intuitive fix — a window function `row_number() OVER (PARTITION BY board_id ORDER BY
created_at)` as a "board rank", ordered `(board_rank, created_at)` — **collapses to FIFO
when claimed one row at a time.** The claim removes the picked row, so board A's 2nd item
is promoted to rank 0 on the next call; if A's items are all older than B's, that promoted
item is still the oldest rank-0 row and wins again. Repeat → A fully drains before B is
touched. Exactly today's behavior.

Fairness only survives if it is decided over **multiple picks in one snapshot**. So the
change is not just a new `ORDER BY` — it is **claim the batch (up to `CONCURRENCY`) in a
single query**, in round-robin order, instead of looping single claims. In one snapshot,
`(board_rank, created_at)` gives: rank-0 of every board first (A's head, B's head), then
rank-1 of every board (A's 2nd, B's 2nd)… — i.e. a batch of 4 with two boards active is
`{a1, b1, a2, b2}`, two each. That is round-robin.

## Design

### Query (db.js) — batch claim, stateless

```sql
WITH ready AS (
  SELECT i.id, i.created_at,
         row_number() OVER (PARTITION BY i.board_id ORDER BY i.created_at, i.id) AS board_rank
  FROM items i
  JOIN boards b ON b.id = i.board_id
  WHERE i.status IN ('pending_extract', 'pending_face', 'pending')
    AND (i.status = 'pending_face' OR b.ai_key_id IS NOT NULL OR $2)   -- key gate, unchanged
    AND (i.retry_at IS NULL OR i.retry_at <= $1)                       -- backoff gate, unchanged
),
pick AS (
  SELECT id FROM ready
  ORDER BY board_rank ASC, created_at ASC, id ASC
  LIMIT $3                                                             -- $3 = CONCURRENCY
),
claimed AS (
  SELECT id FROM items
  WHERE id IN (SELECT id FROM pick)
  FOR UPDATE SKIP LOCKED                                              -- no window fn here → FOR UPDATE legal
)
UPDATE items SET
  status = CASE items.status
    WHEN 'pending_extract' THEN 'extracting'
    WHEN 'pending_face'    THEN 'facing'
    ELSE 'processing' END,
  updated_at = $1
WHERE id IN (SELECT id FROM claimed)
RETURNING *
```

Why the three CTEs: Postgres forbids `FOR UPDATE` on a query containing a window
function ("FOR UPDATE is not allowed with window functions"). So `ready`/`pick` compute
the fair order **without** locking, then `claimed` re-selects those ids `FOR UPDATE SKIP
LOCKED` (legal — no window fn), and the `UPDATE` stamps them. All CTEs share one snapshot,
so pick and lock are consistent. This is the standard SKIP-LOCKED queue pattern with a
window-function pick in front.

### API shape (db.js)

- New primary: `claimNextBatch(db, hasDefaultKey, limit)` → returns `rows[]` (the query above).
- Keep `claimNextWork(db, hasDefaultKey)` as a thin wrapper:
  `return (await claimNextBatch(db, hasDefaultKey, 1))[0] || null;`
  **This is load-bearing for the blast radius:** with `LIMIT 1`, `(board_rank, created_at)`
  picks the oldest rank-0 row = the globally oldest ready row = **identical to today's FIFO**
  (the globally oldest item is always its own board's head, i.e. rank 0). So every existing
  test that calls `claimNextWork` and asserts oldest-first / trickle / key-gate / retry_at
  behavior passes **unchanged**. Fairness is a property of `limit > 1` only.

### Worker (worker.js tick, ~1277)

Replace the single-claim while-loop:

```js
// before
const batch = [];
while (batch.length < CONCURRENCY) {
  const row = await claimNextWork(db, hasDefault);
  if (!row) break;
  batch.push(row);
}
// after
const batch = await claimNextBatch(db, hasDefault, CONCURRENCY);
```

Everything downstream is unchanged: `if (!batch.length) return 0;` then
`Promise.all(batch.map((row) => STEP[row.status](row)))`. The claimed rows still carry
their in-flight status (`extracting`/`facing`/`processing`), so `STEP` dispatch is
untouched.

## Invariants preserved (checked)

- **Key gate** — same `WHERE` clause; faces claim keyless, extract/tag wait for a board
  or default key. Excluded (keyless) items don't appear in `ready`, so they don't inflate
  any board's rank — fairness is over *workable* rows only.
- **retry_at backoff** — same clause; a backed-off item isn't `ready`, so a board with 200
  failing-and-backing-off items gets no unfair weight from them.
- **Stage flow / trickle-completion** — `markExtracted`/`advanceFaced` only change status,
  never `created_at`, so an item keeps its age across extract→face→tag and stays near the
  front *within its board*. Trickle-completion holds per board; boards interleave.
- **Single-flight / fences / recoverStuck** — this touches only *which* rows are claimed.
  Still one query, still called inside the serial tick, `recoverStuck` still at the top of
  the flight, the #7 value-fences (`markTagged AND status='processing'`, etc.) untouched.
  The single-process correctness argument in worker-queue-holes.md §7 is unaffected.
- **No double-claim** — `FOR UPDATE SKIP LOCKED` retained. If a picked row is locked by
  another txn (only possible if the app is ever scaled to multiple worker processes), it's
  skipped and simply not claimed this tick; never claimed twice. Under multi-process it can
  *under*-claim (return fewer than `limit`), which self-corrects next tick — strictly safe,
  mildly suboptimal, same posture as today.

## Fairness properties & the one real limit

- **Exact round-robin when `active_boards ≤ CONCURRENCY`** (default 4). Each active board
  gets ≥1 slot per tick. This covers the motivating case (2 boards) perfectly: trace with
  A=6 old, B=2 new, C=4 → batch1 `{a1,b1,a2,b2}`, batch2 `{a3,b3,a4,a5}` → B fully served
  by batch 2 instead of after A's 6.
- **Degrades to FIFO for the excess when `active_boards > CONCURRENCY`.** With 10 active
  boards and 4 slots, each tick serves the 4 boards with the oldest ready work; the other 6
  wait behind them (the `created_at` tie-break among rank-0 heads favors older boards, and
  since claimed heads are replaced by same-board rank-0 items next tick, the oldest boards
  keep winning). **This is no worse than today** (today all non-oldest boards wait), just
  not perfectly fair. Raising `TAG_CONCURRENCY` widens the fair set (fairness is exact while
  slots ≥ active boards) — at the cost of more parallel API calls.
- **Equal per board, not per item** (intended): 1 big board + 9 one-item boards → the big
  board gets 1/10 of throughput *while those 9 have work* (seconds), then 100% again. Matches
  the "boards are equal" intent; a per-item scheme would be the opposite choice.

## Trade-offs / costs (honest)

1. **Prompt-cache locality.** Batching same-board items back-to-back can reuse provider-side
   prompt caching (stable system prompt per board); interleaving boards lowers that hit rate
   slightly → marginally more input-token cost / latency. **Action: check whether
   `providers.js` actually sets prompt caching (`cache_control`) before claiming this cost is
   real — it may be nil today.** Either way it's pennies at this scale.
2. **Complexity in the riskiest line.** Today's claim is a trivially-correct one-liner; this
   is a 3-CTE window-function query interacting with row locking. That is the cost the user
   was right to be wary of. Mitigations: the `claimNextWork` wrapper keeps all existing
   invariant tests exercising the single-claim path, and new tests pin the batch behavior.
3. **No migration, no new state.** Stateless by construction (fairness read off the queue
   each claim) — nothing to backfill, nothing to keep in sync. This is the main reason to
   prefer it over the stateful alternative below.

## Changes (files)

- `server/db.js` — refactor the `claimNextWork` body into `claimNextBatch(db, hasDefaultKey,
  limit)`; re-express `claimNextWork` as the `LIMIT 1` wrapper. (~15 lines net.)
- `server/worker.js` — import `claimNextBatch`; replace the while-loop with one call. (~4 lines.)
- **No migration.** Optional, deferred: a partial index
  `CREATE INDEX idx_items_board_created ON items (board_id, created_at) WHERE status IN
  ('pending_extract','pending_face','pending')` to back the partition/sort. Unnecessary now
  (largest board ~300; planner seq-scans + sorts in microseconds) — matches §10's "composite
  only matters at ~10k+" stance. Note-only.

## Tests (test/queue.test.js)

Existing 5 tests pass unchanged (they use the `claimNextWork` wrapper = FIFO single-claim).
Add:

1. **Two boards interleave** — board A: 6 items (older), board B: 2 items (newer).
   `claimNextBatch(db, true, 4)` → the batch contains **both** of B's heads (not `a1..a4`).
   Assert set membership by board, and that B is exhausted within 2 batches, proving the
   small board isn't stuck behind the large one.
2. **Single board = strict FIFO** — one board, 4 items; `claimNextBatch(db, true, 4)` returns
   them oldest-first, in order. (No regression.)
3. **Wrapper = globally oldest** — mixed boards; `claimNextWork(db, true)` returns the single
   globally-oldest ready row (pins the wrapper's FIFO-equivalence that keeps the blast radius
   small).
4. **(Optional) documented limit** — 6 boards × 1 item, `limit 4` → the 4 oldest boards'
   items claim, 2 wait. Pins the known `boards > concurrency` degradation as intended
   behavior, not a bug, so a future reader doesn't "fix" it by accident.

Key-gate and retry_at interplay with batching are already covered by the existing
single-claim tests via the wrapper; add a batch-level variant only if worth the belt.

## Deferred / documented alternatives

- **Stateful last-served (exact for any board count).** Add `boards.last_claim_seq` (or a
  side counter); each claim serves the ready-work boards with the smallest `last_claim_seq`
  and bumps them. True round-robin even when `boards > CONCURRENCY`. Cost: a migration + a
  write per claim + tie-breaking never-served boards. **Defer** — the stateless version is
  exact for the realistic board counts here, and "revisit if many boards are routinely active
  at once" mirrors §10's discipline.
- **Per-member fairness (`uploaded_by`).** The user raised *members*, not just boards. Board
  is the right unit for the stated scenario (two members on two *different* boards) and matches
  the access model. If two members ever share *one* board and want fairness between them,
  partition by `entities.uploaded_by` (item → entity → uploader) instead of `board_id` — a
  one-column change to the same query. Not now.
- **`items.priority` (retag-behind-uploads, from §10).** Orthogonal: board-fair queuing does
  incidentally fix the *cross-board* variant (a retag burst on board A no longer starves fresh
  uploads to board B), but the *same-board* retag-vs-upload priority still wants the deferred
  `priority DESC, created_at ASC` column. Left as §10 has it.

## Rollout

Ship on by default, no feature flag: single-board behavior is byte-identical to today, the
change is one query + one loop, and a flag would just add a second code path to test. If the
user wants an escape hatch, the cheapest is `CONCURRENCY`-gated (a `QUEUE_FAIR=0` that calls
`claimNextBatch` in a `LIMIT 1` loop reproduces today exactly) — but recommend against.
```
