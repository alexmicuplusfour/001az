# Worker / queue deep dive — holes found (2026-07-12)

Audit of the tagging/extraction/face pipeline: `server/worker.js`, the claim/advance/recover
layer in `server/db.js`, `server/connectors/runtime.js`, `server/providers.js`,
`server/ingest.js`, and the status-flipping routes in `server/server.js`.
Ordered by severity. Top-three picks to fix first: **1, 2, 3**.

## Big ones

### 1. `retagBoard` yanks items out of the extract/face legs mid-pipeline — FIXED
**Status: fixed (local, with the sibling `reprocessEntity` face-leg fix). 204 tests
green. Original analysis kept below.** `retagBoard` now touches only
tagged/failed/held and routes them releaseHeld-style (held adopts the current
mapping); `reprocessEntity` gained the `pending_face` branch for connector vehicles
(zero-files or generated-file), which is also the first manual re-render path for
non-live faces. Known cost: pre-`extracted_at`-era extracted items re-extract once on
their next retag (no migration backfills the stamp) — self-healing, bounded.
`db.js` `retagBoard` (~line 711) is one UPDATE: every non-pending status → `pending`,
attempts/error reset. Verified per-status blast radius:

| status at retag        | result                                                          | damage |
|------------------------|-----------------------------------------------------------------|--------|
| `tagged`               | re-tagged from existing fields                                  | none — the intent |
| `processing` (in-flight) | in-flight `markTagged` overwrites → `tagged`                  | benign |
| `extracting`/`facing` (in-flight) | in-flight `markExtracted`/`advanceFaced` overwrite    | converges (via the unfenced writes of #7) |
| **`pending_extract`**  | claimed by the TAG leg: no fields, no derived identity          | **unrecoverable by the system** |
| **`pending_face`**     | vehicle (zero files) tagged from name+fields dossier, no chart  | **non-live face lost for good** |
| `failed`               | tag leg regardless of which leg failed                          | failed *extraction* resumes in the wrong leg |
| `held`                 | tag leg, no mapping adoption                                    | wrong for unstamped held on later-mapped boards |

The `pending_extract` case: item is tagged bare, `extracted_at` never stamped, and
nothing automatic revisits it (`releaseHeld`/`queueUntagged` only touch held /
`tags='[]'` rows — this row is now tagged). Derived identity stays the provisional
filename forever; merge/split never ran. Only a manual per-card reprocess heals it.
Timing is not exotic: `retagDue` runs at the top of every tick before the claim loops
(worker.js ~909), so a periodic board's `next_run_at` landing anywhere inside a big
upload's extract backlog (minutes–hours; the sidecar serializes PDFs) flips the entire
remaining backlog in one statement. The admin "Retag all" route (server.js ~765) does
the same at any moment, no guard.

The `pending_face` case: for a NON-live connector face, `pending_face` at creation
(server.js ~1194) is the only path to a first render — and **`reprocessEntity` has no
`pending_face` branch either** (db.js ~1175: CASE only knows pending_extract/pending; a
connector vehicle has no AI work so extractOne passes straight through to tagging). So
the face leg is unreachable even by the card-level "full pipeline" reprocess: a static
face is a tile forever, short of deleting and re-adding the entity. Live faces do heal
(boot `reconcileLiveSchedules` / mapping-save reschedule treat `face_at=null` as due).

Historical note: this is the third sibling of the family the 2026-07-12 loose-ends
sweep fixed — `releaseHeld` and `queueUntagged` got the adopt-current-mapping stamp and
the face/extract CASE routing; `retagBoard` was missed.

**Fix shape (sharpened):** items in `pending_extract`/`extracting`/`pending_face`/
`facing` already end in the tag leg (`markExtracted`/`advanceFaced` advance to
`pending` on auto-tag boards), so retag gains nothing by touching them. Therefore:
1. `WHERE status IN ('tagged','failed','held')` — terminal states only.
2. Route those through the same CASE + mapping-adoption block `releaseHeld` uses; it
   already handles every case (failed face → `pending_face`, failed extract →
   `pending_extract`, extracted → `pending`).
3. Sibling fix: give `reprocessEntity` a `pending_face` branch (connector face + zero
   files → `pending_face`) — also gives static faces a manual re-render path for the
   first time.

### 2. Transient provider errors permanently fail items — no backoff, no classification — FIXED
**Status: fixed (local). 211 tests green. Original analysis kept below.** Shipped as
designed: `compatError` stamps `e.status`/`e.retryAfter`; migration
`0011_items_retry_at.sql` adds `items.retry_at`; `failOrRequeue` classifies —
permanent 4xx (≠408/429) fail on the first attempt, transient requeue with spaced
`retry_at` (1m/5m/15m, honoring Retry-After, capped 1h) and +2 headroom over
MAX_ATTEMPTS, `err.noCount` ("no API key configured") consumes no attempt; all three
claim queries skip future `retry_at`, and every explicit requeue/advance path
(retag/reprocess/reextract/release/sweep/requeue/mark*/advanceFaced) clears it so the
user's hand beats the backoff. `queueUntagged` now routes by definition state like
retagBoard (failed extraction → extract leg). `processOne`'s try is narrowed: a write
failure after a successful paid call leaves the row processing for recoverStuck
instead of re-billing.

- **Anthropic wire** (providers.js ~116): SDK client built with defaults (~line 42) →
  `maxRetries: 2` built in — 408/429/5xx/connection errors retried twice internally
  with backoff honoring retry-after. Softer than it first looked, but each worker
  attempt is still ≤3 API tries inside ~10–30 s.
- **Compat wire** (OpenAI/Gemini/GLM/OpenRouter, providers.js ~155): raw fetch, zero
  retries — and `compatError` (~51) throws a bare `new Error(message)` with **no
  status attached**. The worker cannot classify a 429 vs a 400 even in principle;
  the HTTP status is discarded at the wire.

Timeline math: `failOrRequeue` requeues with no delay; claims order by `created_at
ASC` so the failing (oldest) item is re-claimed next tick; the loop fast-polls at
400 ms after any work (worker.js ~967). Compat: all 3 attempts burn in ~2–5 s.
Anthropic: ~a minute. Rate-limit windows are per-minute buckets (10–60 s+), so all
attempts land inside the window with high probability. TAG_CONCURRENCY=4 amplifies:
four items fail in parallel and their instant retries sustain the 429. A 50-item
upload on a briefly throttled key can permanently fail dozens of items in <1 min.

No classification cuts both ways:
- transient (429, 529/overloaded, 5xx, network, "model did not call record_tags" in
  research/auto mode, GLM's malformed-JSON parse throw) → too few, too-fast tries;
- permanent (400, 401 bad key, 413, the deliberate "can't read PDF" throw, ENOENT)
  → pointlessly retried 3×, wasting calls;
- "no API key configured" burns attempts, breaking the claim gate's own "never
  failed for a missing key" promise (comment on `claimNextPending`);
- `processOne`'s catch wraps `markTagged`/`bumpUsage` too — a DB blip AFTER a
  successful paid call requeues the item for a second paid call.

Residual routing hole (post the #1 fix): **`queueUntagged` still sends failed items
to the tag leg** (`status <> 'held' THEN 'pending'`) — a failed *extraction* swept in
when auto-tag turns on tags with no fields and never re-extracts. Same one-line class
of fix as retagBoard got.

**Fix design:**
1. Attach `e.status` (+ retry-after) in `compatError` — the enabler for everything.
2. `retry_at` column (one ledger migration). `failOrRequeue` classifies: transient →
   requeue with `retry_at = now + backoff(attempts)` (~1 m/5 m/15 m, higher ceiling);
   permanent (other 4xx) → fail on the FIRST attempt. Claims add
   `AND (retry_at IS NULL OR retry_at <= now)`. Explicit column over deriving from
   `updated_at` — too many hands write updated_at (retag/reprocess/recovery) for it
   to double as a timer.
3. NO new in-call retry layer (the SDK already retries Anthropic twice; layers
   multiply). Spaced attempts ARE the retry mechanism; at most one immediate compat
   429 retry honoring a short Retry-After.
4. "no API key configured" → requeue without incrementing attempts.
5. Narrow `processOne`'s try to the AI call (mark/bump failures shouldn't re-bill);
   fix `queueUntagged`'s failed-item routing to match retagBoard.

### 3. Embedding sweep wedges on a poison item — and fails invisibly on config errors — FIXED
**Status: fixed (local). 216 tests green. Original analysis kept below.** Shipped as
designed: `embedTextFor` capped at 8k chars; new exported `embedBatch` — happy path is
one call, a request-content 4xx (≠401/403/404/408/429) triggers one-by-one isolation,
lone failures marked via `items.embed_error` (migration `0012`) and skipped by
`itemsNeedingEmbedding`, zero-success isolation throws (config-shaped 400 → backoff,
nothing wrongly marked); marker cleared by `setItemEmbedding`, `markTagged`, and
`setItemTags`; `embeddingStats` gained a `failed` count and the admin panel says
"N skipped after embedding errors — re-tagging retries them" instead of reading stuck.

Verified in depth. `embedDue` (worker.js ~632) embeds the batch as one all-or-nothing
call; error handling is batch-granular (60 s `embedBackoffUntil`), no per-item marking.

**Wedge dynamics (sharper than "same batch forever"):** `itemsNeedingEmbedding` takes
the top-64 by `updated_at DESC`. While a poison item is inside the window every batch
fails; as newer tagged-unembedded items accumulate past 64 the poison falls out, that
pure-newer batch succeeds, then the window slides back down and wedges again. Net:
items NEWER than the poison embed in delayed bursts; everything OLDER never embeds.
The newest-first ordering (meant to prioritize fresh uploads) is what makes the
poison recurrent.

**Poison likelihood is provider-dependent:** OpenAI limits (8192 tok/input, 300k/req)
comfortably exceed `embedTextFor`'s practical bound (tagger max_tokens 2048 caps the
reasoning) — size-poison unlikely. Gemini's `gemini-embedding-001` has a 2048-token
per-input limit — the realistic size-poison path (compat-layer overflow behavior
unverified). Local ONNX embeds per-item and truncates at 512 tokens — immune. Other
item-triggered batch killers: provider content rejections, pathological unicode, the
compat wire's own length-mismatch throw.

**The more common wedge is config-level, and it's invisible:** bad key / wrong model /
dead billing fails every batch; retry-forever is arguably correct (heals when fixed)
but the only signal is one console warn per minute, search silently degrades
(unembedded items are just absent from the corpus), and admin `embeddingStats` shows a
stuck count with no why. Nothing distinguishes "not yet reached" from "failed 500×".

**Fix design** (synergy: embed failures flow through the same `compatError` that now
carries `err.status` after the #2 fix, so classification is already enabled):
1. Defensive cap in `embedTextFor` (~8k chars) — truncation beats wedging; local
   already truncates harder.
2. Per-item isolation on 4xx (item-specific by nature): re-run the failed batch
   one-by-one; items that fail alone get marked + skipped, innocents proceed.
   Non-4xx (429/5xx/network) keeps the 60 s batch backoff — not item-specific.
   One-by-one over bisect: ≤64 calls once per poison discovery; simple wins.
3. Skip marker: `items.embed_error TEXT` (one ledger migration).
   `itemsNeedingEmbedding` adds `AND embed_error IS NULL`; cleared by
   `setItemEmbedding`, `markTagged`, AND `setItemTags` (the user tag-edit path also
   clears the vector — fresh text = fresh chance).
4. Visibility: fold a failed/skipped count into `embeddingStats` for the admin panel.

### 4. `recoverStuck`: no path to `failed` for crash-loop items — and deploys strand in-flight work — FIXED
**Status: fixed (local). 218 tests green. Original analysis kept below.** Shipped as
designed: `recoverStuck(db, olderThanMs, maxAttempts)` is one UPDATE — attempts+1,
per-leg routing kept, per-row spaced `retry_at` (the #2 schedule, so a crash loop
throttles and stops re-leading the FIFO), and `status='failed'` + "interrupted
mid-flight repeatedly (crash or shutdown)" at `maxAttempts + TRANSIENT_EXTRA` — the
path to `failed` that didn't exist for uncaught crashes. Worker passes MAX_ATTEMPTS;
the boot-time `resolveDefaultAi(...).then` got its `.catch`. Note-only leftovers: the
5 s drain cap (compose `stop_grace_period` to raise) and its deploy re-bill window.

Verified in depth; two claims sharpened, one corrected:

- **CORRECTED — the OOM vector is mostly closed by the ingest cap:** uploads are
  capped at 10 MB/file (ingest.js ~16), so the document-block fallback peaks ~40 MB
  transient/item (×4 ≈ 160 MB) — not a credible OOM. Larger files would hit
  Anthropic's 32 MB request cap → 413 → permanent fail-fast (post-#2). Remaining
  realistic crash vectors: container OOM-kill under combined load on a tight droplet,
  native sharp edge cases (nil — self-generated SVG), unhandled rejections
  (`resolveDefaultAi(db).then(...)` at worker start has no `.catch` — boot-time DB
  blip = instant crash, not item-caused), kill -9/power loss.
- **SHARPENED — bumping attempts alone would NOT fix it:** claims never check
  attempts; `failOrRequeue` is the only path to `failed` and only runs on *caught*
  errors. A crash-only poison item never reaches it — attempts would grow forever and
  it would still be claimed forever. `recoverStuck` must itself fail items at the cap.
- **NEW — stuck rows are ordinary deploy debris, not rare-crash evidence:** the
  graceful drain races a 5 s cap (server.js ~1394, deliberately inside Docker's 10 s
  SIGKILL grace). Any in-flight call >5 s (research tagging = minutes, OCR = tens of
  seconds) is abandoned on every `docker stop`: the provider bills the severed
  request, the result is lost, the item re-claims and re-bills — up to 4 wasted paid
  calls per deploy-during-backlog. Any fix must tolerate a few recovery increments.

With `restart: unless-stopped` (compose), an item-deterministic crash loops forever
today: recover (≥3 min, STUCK_MS) → claim first (FIFO) → crash → restart → repeat,
killing up to 3 innocent co-claimed items' work per cycle.

**Fix design:** one UPDATE in `recoverStuck(db, olderThanMs, maxAttempts)` —
`attempts+1`; per-row spaced `retry_at` (1/5/15 m by attempts, the #2 schedule) so a
crash loop throttles and other items claim first; `status='failed'` + explanatory
error at `attempts+1 ≥ maxAttempts + TRANSIENT_EXTRA` (an interruption is
transient-shaped evidence; 5 separate interruptions before an innocent
deploy-straddler could be wrongly failed); keep the per-leg status mapping.
Adjacent note-only: raising the 5 s drain needs compose `stop_grace_period`; the
worker-start `.then` wants a `.catch`.

### 5. No timeout on any outbound fetch + `Promise.all` batches = head-of-line blocking
No fetch in the server has an AbortSignal — tagger calls, the extractor POST
(worker.js ~450), all connector calls. Only bound is undici's default ~5-min headers
timeout, plus unbounded token-bucket `acquire` and Retry-After sleeps on top. `tick()`
awaits the whole batch and the loop is single-flight, so one hung call stalls **every
leg and every sweep** — a 1-min live crypto price stops refreshing because one PDF is
stuck in the single-threaded extractor (which serializes ~40 s OCR jobs; 4 concurrent
extract claims already queue ~3 min there).

**Fix shape:** `AbortSignal.timeout(...)` on every outbound fetch; consider decoupling
the sweeps (embed/refresh/retag) from the claim batches so they can't be starved.

## Worth knowing about

### 6. Extractor downtime silently reverts PDFs to the expensive path
`documentTextFor` swallows the fetch error and returns `""` (worker.js ~456); on an
Anthropic board the tag leg then quietly ships the whole PDF as a document block — the
exact per-page billing the sidecar was built to avoid. Non-Anthropic boards fail visibly
(by design), but on Anthropic boards there's no log line and no flag; a flaky sidecar
just makes the bill drift up. At minimum log the fallback; consider a metric/flag.

### 7. `markTagged` / `markExtracted` are unfenced writes
They update `WHERE id=$1` unconditionally — no check the row is still
`processing`/owned by this claim. Single-process it mostly self-heals, but any second
consumer (scaling the app container, or HTTP routes flipping statuses concurrently)
produces double-tagging with double billing, and a stale slow call stamping over a
fresher result. Cheap insurance: `AND status='processing'` guard (or a claim token).
Related: `failOrRequeue` does a non-atomic read-then-write on `attempts`.

### 8. `reparentInto` isn't transactional and `items.entity_id` is `ON DELETE CASCADE`
worker.js ~719 does `reparentItem` then `deleteEntityIfEmpty` as separate autocommit
statements. If a concurrent path deletes the *target* entity in the window (its own last
instance just re-parented away), the cascade eats the freshly re-parented instance —
row and file vanish silently. Window is one statement wide with today's single worker,
so theoretical-ish, but nothing structural prevents it. Wrap reparent+delete in a tx.

### 9. `tag_snapshots` grows forever
`markTagged` appends a snapshot on every tagging (db.js ~1191). `field_snapshots` got a
retention prune; `tag_snapshots` didn't. A live board with `retag_on_refresh` plus
periodic retags writes one row per item per pass, unbounded. Mirror the field-snapshot
prune.

### 10. Queue-fairness gaps (design choices with sharp edges)
- Extract leg's early `return` in `tick()` (worker.js ~924): a 500-file upload
  completely starves the tag and face legs until the extract queue is dry.
- FIFO by `created_at` + `retagBoard` resetting whole boards: a scheduled retag of
  1,000 old items queues ahead of every fresh upload — the user watching
  "Processing…" waits behind the entire retag. No priority tiering.

### 11. Assorted minor
- `dueLiveEntities` joins instances by `payload ? 'source'` — an entity holding two
  connector vehicles (possible via manual merge of two connector cards) appears twice
  per sweep and refreshes twice.
- Key-existence race: claim gate passes (`hasDefault` true / `ai_key_id` set), key
  deleted before the call → "no API key configured" burns attempts → permanent
  `failed`, violating the stated "never failed for a missing key" invariant
  (comment on `claimNextPending`, db.js ~863).
- `getBoardPrompt` doesn't cache the facet-less-board `null` → extraction-only boards
  pay a `getBoard` query per item per tick, twice (processOne + extractOne paths).
- Concurrent `generateFace` renders (face leg vs. a mapping-save backfill) can orphan a
  webp on disk — the loser's new file is never unlinked.
- In `processOne`, `bumpUsage` throwing *after* `markTagged` lands in the catch →
  `failOrRequeue` flips a successfully-tagged item back to pending → duplicate AI call.
