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

### 5. No timeout on any outbound fetch + `Promise.all` batches = head-of-line blocking — FIXED (items 1+2)
**Status: fixed (local) per the fix design's ship-1+2-first call. 221 tests green.**
Shipped: `withRetry`'s Retry-After honor capped at 30 s (env `CONNECTOR_RETRY_CAP_MS`);
`AbortSignal.timeout` on every raw fetch — connectors 15 s via a shared
`providerSignal()` in runtime.js (env `CONNECTOR_TIMEOUT_MS`), compat chat 180 s
(`AI_CHAT_TIMEOUT_MS`), compat embeddings 60 s (`AI_EMBED_TIMEOUT_MS`), key tests 30 s
fixed, extractor 240 s (`EXTRACTOR_TIMEOUT_MS` — budgeted for queue-behind-3-OCR-jobs);
plus #6's minimum: `documentTextFor` now warns on extractor non-OK/unreachable instead
of silently falling back to the per-page-billed document block. Anthropic SDK left on
its 10-min default (research tagging runs minutes). Deferred as designed: extractor
capacity alignment (item 3, note-only) and sweep decoupling (item 4 — blocked on #7's
write fences, and may be unnecessary now the max stall is minutes).

Loose-ends sweep after the fix: (a) the Anthropic keyTest (`countTokens`) was riding
the SDK's 10-min default on the same interactive admin button the compat keyTest now
bounds at 30 s — given a per-request `{ timeout: 30000 }`; (b) compose passed NONE of
the env knobs into the container — not the new five, and not the pre-existing
CONNECTOR_RPM/BURST (env-tunable since the rate-limiter, unreachable in the stack) or
the extractor's OCR_MAX_PAGES (which needs a real default in compose: `int("")`
crashes the sidecar at boot) — all passed through now, code keeps owning the Node
defaults (empty string falls through `Number(...) ||`); (c) verified non-issues: the
local ONNX embedder's model is pre-baked into the image (Dockerfile pre-download), so
no unbounded hub fetch hides inside embedDue; per-fetch signals are constructed after
the token-bucket acquire, so pacing waits don't eat the timeout budget, and each
withRetry attempt gets a fresh signal. Original analysis kept below.

No fetch in the server has an AbortSignal — the extractor POST (worker.js ~510), all
four compat-wire calls (providers.js chat ×2 / models probe / embeddings), every
connector call (coingecko ×7, cmc, fmp). Only bound is undici's default ~5-min headers
timeout, plus Retry-After sleeps on top. `tick()` awaits the whole batch and the loop
is single-flight, so one hung call stalls **every leg and every sweep** — a 1-min live
crypto price stops refreshing because one PDF is stuck in the single-threaded extractor.

Verified in depth; one claim corrected, the bounds inventory sharpened, two new
interactions found:

- **CORRECTED — Anthropic tagger calls ARE bounded:** the SDK client is built with
  defaults (providers.js ~42) → 10-min per-try timeout + `maxRetries: 2` built in.
  Long (worst ~30 min) but not signal-less. The genuinely unbounded surfaces are the
  compat wire, the extractor POST, and the connectors.
- **Bounds inventory (undici defaults):** connect ~10 s, headersTimeout 300 s,
  bodyTimeout 300 s — but bodyTimeout is *per-chunk idle*, so a trickling response
  body is unbounded in total. The realistic hang quantum is 5 minutes; the truly
  unbounded cases are slow-drip bodies and the Retry-After honor below.
- **NEW — `withRetry`'s "(bounded)" comment is false** (runtime.js ~49): a numeric
  Retry-After is honored verbatim (`ra * 1000`); only the exponential fallback is
  capped at 30 s. A provider/CDN sending `Retry-After: 3600` sleeps the whole worker
  an hour — per retry, up to 3 tries, inside `refreshDue` or the face leg. Contrast
  `failOrRequeue`, which caps its Retry-After at 1 h (db.js ~1322). The one truly
  unbounded sleep that's trivially reachable.
- **NEW — the safety net lives inside the blast radius:** `recoverStuck` (#4's fix)
  runs at the top of `tick()` — the same single flight a hung call blocks. While the
  loop is wedged nothing recovers anything; STUCK_MS (3 min) < undici (5 min) < SDK
  (10 min), so recovery in practice waits for the hang to resolve itself. (Flip side:
  the single flight is also what keeps #7's unfenced writes mostly theoretical —
  see the ordering constraint in the fix.)
- **NEW — extractor queueing already self-inflicts pseudo-timeouts (feeds #6):** the
  sidecar is stdlib `HTTPServer`, strictly serial (main.py ~196; kernel backlog holds
  the queue with undici's headers clock running). 4 extract claims fan into 1 worker;
  the 4th waits out ~3 jobs. Text-layer PDFs are sub-second, but OCR jobs run ~40 s+
  (20-page cap × ~2 s/page) — a few heavy scans ahead and the trailing request blows
  the 300 s headersTimeout → `documentTextFor` swallows it (worker.js ~516) → `""` →
  Anthropic boards silently ship the whole PDF as a document block (#6's expensive
  path); non-Anthropic boards fail the item. A naive short `AbortSignal.timeout` on
  the extractor call makes this MORE frequent, not less.
- **NEW — client aborts don't shed sidecar load:** `BaseHTTPRequestHandler` finishes
  the OCR job and only hits the broken pipe on write. A timed-out extract requeues
  (status-less abort → transient under #2) while the sidecar still chews the
  abandoned copy — head-of-line *inside the sidecar* survives any client-side
  timeout. That half is a capacity problem (extract fan-in vs. 1 sidecar worker),
  not a signals problem.
- **Sharpened — token-bucket `acquire` is bounded per-waiter, but additive:** pacing
  sleeps run inside the serialized per-provider chain (k-th waiter ≈ k/rpm min), and
  `refreshDue` is a *sequential* loop of up to REFRESH_BATCH=20 entities, each
  acquiring (twice with a face). At default rpm a full healthy sweep adds tens of
  seconds of pure pacing inside `tick()`, ahead of all claims. Not a hang — a
  standing tax.
- **Good news — #2's machinery already classifies timeouts right:**
  `AbortSignal.timeout` throws a status-less TimeoutError → `failOrRequeue` treats it
  as transient → spaced `retry_at`. No classifier work needed.

Severity framing: availability/latency, not data loss — the typical stall is
5-minute-shaped, not forever-shaped. Realistic worst cases: raw Retry-After (hour+
freeze), trickling body (unbounded), extractor backlog (repeated 5-min stalls plus
silent bill drift via #6).

**Fix design:**
1. Cap the Retry-After honor in `withRetry`: `Math.min(ra * 1000, 30_000)` — one
   line, makes the comment true (`failOrRequeue` already caps at 1 h).
2. `AbortSignal.timeout(...)` on every raw fetch, budgeted per call type: connectors
   ~15–30 s (retries exist); compat chat ~180 s; embeddings ~60 s; extractor
   *generous* — must cover queue-behind-3-OCR-jobs (~240 s) or it manufactures the
   #6 fallback. Leave the Anthropic SDK's 10-min default (research tagging
   legitimately runs minutes).
3. Extractor capacity, note-only: either drop extract fan-in toward the sidecar's 1
   worker, or accept queueing and budget the timeout for it. `ThreadingHTTPServer`
   is NOT an option (PyMuPDF isn't thread-safe); multiple sidecar processes would
   be. Fix #6's silent fallback (a log line) first either way so timeouts are
   visible when they fire.
4. Sweep decoupling (the bigger surgery, defer): moving recoverStuck + the sweeps to
   their own loop ends the starvation class, but concurrent flights widen #7's
   unfenced-write window (recoverStuck requeues a row whose original in-flight call
   later stamps `markTagged` → double claim, double bill). **Fence writes (#7)
   before or with any decoupling.** With per-fetch timeouts in place the max stall
   drops to minutes — ship 1+2, measure, then decide if this is still needed.

## Worth knowing about

### 6. Extractor downtime silently reverts PDFs to the expensive path — FIXED
**Status: fixed (local) as designed, user-approved reversal of the original
fallback decision. 223 tests green.** `documentTextFor` lifted to module scope
(exported for tests, `galleryDir` param — the generateFace precedent) and its
outcomes split: extractor infra failure (unreachable / non-OK) THROWS status-less
→ #2's classifier spaces the retries and nothing bills — which also kills the
double-bill and double-wait (the throw propagates before extractOne's `??`
fallback ever evaluates); `res.ok`+empty returns `""`, so the document block
survives for genuinely textless scans only, now with a warn naming the per-page
cost; the compat "use an Anthropic tagger" error only fires when it's true; and
empty-text docx/text throws a permanent-shaped 422 ("has no extractable text")
instead of tagging a blank document. Original analysis kept below.

`documentTextFor` swallows the fetch error and returns `""` (worker.js ~506); on an
Anthropic board the tag leg then quietly ships the whole PDF as a document block — the
exact per-page billing the sidecar was built to avoid. Non-Anthropic boards fail visibly
(by design), but on Anthropic boards there's no log line and no flag; a flaky sidecar
just makes the bill drift up. At minimum log the fallback; consider a metric/flag.

Verified in depth (the #5 fix shipped the log-line minimum — warns now fire on both
non-OK and unreachable). The full picture is worse than the entry above:

- **NEW — BOTH legs fall back, so downtime double-bills:** the entry only names the
  tag leg, but `extractOne` does `modelInputForExtract(...) ?? modelInputFor(...)`
  (worker.js ~832) — extractor down → the extract call ships the document block too,
  then the tag leg ships it AGAIN. Every PDF in flight during downtime pays the
  per-page bill twice (each page ≈ image + text tokens, ~1.5–3k/page; a 10-page PDF
  ≈ 20–30k input tokens per call vs ~3–5k once via the text path — the 18-résumés->$1
  bill that motivated the sidecar).
- **NEW — the `??` fallback doubles the hang budget:** within one `extractOne`,
  `documentTextFor` runs twice (once in `modelInputForExtract`, once inside the
  `modelInputFor` fallback). A hung-not-down extractor costs 2×EXTRACTOR_TIMEOUT_MS
  ≈ 8 min per item per extract attempt (plus two warn lines), and the tag leg adds
  another 4 min — the longest stall anywhere in the system post-#5.
- **SHARPENED — "non-Anthropic boards fail visibly" is half-true, and accidentally
  self-healing:** `compatWire.tag` throws pre-fetch, and that error is status-less →
  `failOrRequeue` classifies it TRANSIENT → spaced retries (1/5/15 m, +2 headroom).
  If the extractor returns inside the window, the item recovers untouched — compat
  boards ride out blips for free. But the eventual `items.error` says "use an
  Anthropic tagger for this board" — blaming the provider choice when the real cause
  was extractor downtime. Misleading on a board whose PDFs worked yesterday.
- **The asymmetry is backwards:** Anthropic boards — the ones for which waiting is
  free and correct — pay instantly and irreversibly; compat boards — which have no
  alternative — get the free self-healing retry loop.
- **Downtime is routine, not exotic:** deploy.ps1 recreates the extractor container
  on every ship; any queued PDF in flight during that window hits the fallback. The
  sidecar's own kernel backlog + a blown 240 s budget under OCR load (#5's analysis)
  produce the same "" without the sidecar ever being down.
- **Root cause — one `""` means two different things:** (a) `res.ok` + empty
  markdown = genuinely textless document (image-only scan past the OCR cap, no text
  layer) — the document block is the RIGHT move there (visual OCR is exactly
  Anthropic's strength, and compat's "use an Anthropic tagger" message is then
  accurate); (b) infra failure (non-OK / refused / timeout) — where waiting minutes
  is strictly better than paying per page. `documentTextFor` conflates them.
- **Side finding (adjacent):** the text/docx branches prompt the model even when the
  text is empty — an image-only docx passes ingest (only mammoth *failure* rejects;
  empty text writes an empty `.txt` sidecar) and gets tagged/extracted against a
  blank document, `extracted_at` stamped, never revisited, no warn. Garbage-in with
  no signal, extractor healthy or not.

**Fix design:** make `documentTextFor` throw on infra failure (readable message,
status-less → #2's classifier already spaces the retries; explicit reprocess clears
`retry_at` as always) and return `""` only for `res.ok`+empty = genuine no-text.
One change, three effects: Anthropic boards ride out blips like compat boards
already do (no automatic spend), the double-bill AND double-wait die (the throw
propagates before the `??` fallback evaluates), and the compat error message becomes
truthful (it only fires for genuinely textless PDFs). Keep the document block for
the textless case — that fallback is content-driven and correct. ⚠️ This reverses a
deliberate design call ("document block = extractor-down fallback" was chosen so
Anthropic boards keep working through downtime) — needs the user's sign-off: the
trade is "PDFs tag minutes later during a blip" for "no silent per-page billing,
ever". Optional extra: fail empty-text docx/text items visibly ("document has no
extractable text") instead of tagging a blank.

### 7. `markTagged` / `markExtracted` are unfenced writes — FIXED
**Status: fixed (local) as designed. 250 tests green (5 new in
test/fences.test.js).** Shipped: value fences on the three advances
(`markTagged`+`AND status='processing'`, `markExtracted`+`'extracting'`,
`advanceFaced`+`'facing'`), each returning landed/discarded; the tag snapshot
appends only when the stamp lands (also removes #9's known-benign dedupe race
and the delete-during-tagging FK noise); `failOrRequeue` fenced via the 1:1
requeueStatus→in-flight map (closes its attempts read-then-write race as a side
effect; a discard returns false); `requeueItemForTag` guarded to tagged/failed
and its caller now reports what actually happened; worker callers log "stale …
discarded (re-routed or deleted mid-flight)" — `stampExtracted` helper covers
extractOne's nine sites, `bumpUsage` stays unconditional (tokens were spent).
Per-card routes stay unfenced ON PURPOSE (that's how the user wins). Test churn
landed as re-verified: tag-snapshots helper stamps 'processing' first,
extraction/embed-sweep seeds set the in-flight status, retry.test.js's one loop
resets per iteration; the new tests pin land-vs-discard for all four writers,
the full user-wins race (claim → retagItem → stale stamp discards →
re-claimable), and the cascade guard. Double-check bonus: the fence also closes
#11's bumpUsage-after-landing re-bill in the EXTRACT leg (a trailing bumpUsage
throw used to yank the landed extraction back to pending_extract via
failOrRequeue; the fence discards that flip — the row is no longer
'extracting'). Original analysis kept below.

They update `WHERE id=$1` unconditionally — no check the row is still
`processing`/owned by this claim. Single-process it mostly self-heals, but any second
consumer (scaling the app container, or HTTP routes flipping statuses concurrently)
produces double-tagging with double billing, and a stale slow call stamping over a
fresher result. Cheap insurance: `AND status='processing'` guard (or a claim token).
Related: `failOrRequeue` does a non-atomic read-then-write on `attempts`.

Verified in depth; the frame shifts — the entry leads with the scale-out risk, but
there's a live single-process bug, and it's the fourth sibling of the #1 family:

- **CONFIRMED:** `markTagged` (db.js ~1224), `markExtracted` (~954), `advanceFaced`
  (~975), and `failOrRequeue` (~1309) all write `WHERE id` unconditionally;
  `failOrRequeue` additionally reads `attempts` in a separate statement.
  `markTagged` is also two non-tx statements — a stale stamp would append a
  `tag_snapshots` row for a result that was never current. Claims are properly
  `FOR UPDATE SKIP LOCKED`.
- **SHARPENED — no double-billing in today's deployment:** the single-flight tick
  is an accidental global fence between worker actors. Claims happen only at tick
  start, the batch is awaited before the next tick, and `recoverStuck` runs at the
  top of the serial loop — so it only ever sees rows left by a crash/drain (or
  processOne's deliberate left-for-recovery). Two flights on one row cannot happen
  in-process. "Mostly self-heals" undersells it; in-process the claims never
  collide at all.
- **The LIVE bug is HTTP-route vs in-flight call.** The per-board paths
  (`retagBoard`/`releaseHeld`/`queueUntagged`/`cancelBoardQueue`) all exclude
  in-flight statuses — the #1/#2 fixes did that. The per-card/per-instance paths do
  NOT: `reprocessEntity` (`WHERE entity_id`, no status filter at all),
  `reextractItem`, `retagItem` (both `WHERE id` unconditional), and `setItemTags`
  (the user tag-edit, which also sets `status='tagged'`). Any of them can flip a
  claimed row mid-call; the unfenced stamp then silently undoes the user.
- **Concrete failure, minutes-wide window:** user edits the identity hint, hits
  card Reprocess while that instance's research-tagging call is in flight (minutes;
  extractor waits up to 240 s) → the route stamps `pending_extract` + the new
  mapping → the stale `markTagged` lands `tagged` with old-mapping output →
  extraction never runs, and `queueUntagged` won't revisit (tags non-empty). The
  reprocess button looks broken. A mid-flight `setItemTags` loses the user's manual
  tags the same way. Stale `failOrRequeue` is worse: it stamps `error`/`retry_at`
  AND re-routes to its own `requeueStatus` — a freshly re-extracted item yanked
  from `pending_extract` back to `pending`, tag leg with no fields.
- **The attempts race reduces to the missing fence:** every writer that resets
  `attempts` also changes `status`, so fencing the UPDATE closes the
  read-then-write race as a side effect. No transaction needed.
- **Multi-process sharpened — and a limit on what fences buy:** scale-out
  double-billing is not just possible but routine — STUCK_MS (3 min) is BELOW
  legitimate call durations (research tagging minutes, extractor 240 s, SDK
  retries ~30 min worst), so process A's `recoverStuck` would "recover" process
  B's healthy in-flight rows as a matter of course: second claim, duplicate paid
  call, flip-flopping stamps, duplicate snapshots. And a status-VALUE fence is
  not ownership: after the requeue + re-claim the row is back in `processing`,
  so B's stale stamp passes the fence again — it can even beat A's fresh call
  (stale lands `tagged`, fresh stamp then discards). Fences are sound ONLY under
  the single-flight/single-process invariant, where a stale stamp always executes
  before any re-claim (routes flip mid-batch; the next claim is next tick, after
  the batch — and its stale stamp — has fully settled). Multi-process correctness
  genuinely needs the claim token/lease (plus STUCK_MS above worst-case call
  duration for the spend). That's the real blocker list for ever scaling the app
  container, alongside #5's deferred sweep decoupling.
- **Adjacent:** `requeueItemForTag` (the `retag_on_refresh` cascade, ~1141) is
  unconditional too — it can yank a `pending_extract` instance (user just
  re-extracted a live entity) into the tag leg. Benign for pure-connector vehicles
  (extract is a no-op passthrough), wrong when the mapping has AI fields.
- **Adjacent (found in the double-check) — the embedding writers race the same
  way:** `setItemEmbedding` (~1237) stamps `WHERE id` unconditionally. A user
  `setItemTags` while the embed batch's API call is in flight clears the vector
  for the NEW text — then the sweep's stale stamp lands a vector computed from
  the OLD text, and the sweep never revisits (embedding non-NULL). One stale
  search vector until the next tag edit; minor, self-correcting, and an
  `embedding IS NULL` fence can't discriminate (both states are NULL). If ever
  worth fixing: optimistic `AND updated_at=$asRead`. Note-only.
- **Verified clean:** `updateItemPayload`/`updateItemPayloads` are single-statement
  jsonb merges (`payload || $1`), so concurrent payload writers (generateFace's
  files swap vs a reprocess mapping restamp) compose without lost updates; the
  per-board sweeps and `cancelBoardQueue` (pending-only, both statements) exclude
  in-flight rows; migrations and ingest inserts are out of scope.

**Fix design:**
1. Fence each advance to the in-flight status it owns, returning rowCount:
   `markTagged … AND status='processing'`, `markExtracted … AND
   status='extracting'`, `advanceFaced … AND status='facing'`. `markTagged`
   appends the tag snapshot only when the UPDATE landed. Callers log "stale result
   discarded (item re-routed mid-flight)". `bumpUsage` stays unconditional — the
   tokens were spent either way. In `processOne`, a DISCARD is not an error:
   don't confuse it with the left-for-recovery path (that's for markTagged
   THROWING) — log, still bumpUsage, done. Bonus: this also silences the old
   delete-during-tagging race (row deleted mid-call → rowCount 0 → snapshot
   skipped, instead of the tag_snapshots FK error the logs show today).
2. `failOrRequeue`: same fence; the in-flight status derives 1:1 from
   `requeueStatus` (pending→processing, pending_extract→extracting,
   pending_face→facing). rowCount 0 → return false, log only.
3. Leave `reprocessEntity`/`reextractItem`/`retagItem`/`setItemTags` touching
   in-flight rows ON PURPOSE — post-fence that's the mechanism by which the user
   wins the race (their flip is what makes the stale stamp discard). Document,
   don't "fix".
4. One-line guard on `requeueItemForTag` (only touch tagged/failed).
5. `recoverStuck` needs no fence — it IS the crash-recovery writer, already
   restricted to in-flight statuses + age.
6. Known gap the fence does NOT cover (accept, don't chase): the extract leg's
   entity-side writes (`reparentItem`/`setEntityIdentity`/`deleteEntityIfEmpty`)
   run BEFORE `markExtracted` — a stale extract call can still re-parent or
   rename mid-race. Self-healing: the user-routed `pending_extract` survives the
   discard, and the fresh extraction re-derives identity and re-merges. (The
   transactional wrap belongs to #8.)
7. Test churn, sized honestly: retry.test.js seeds `processing` by default BUT
   its multi-attempt loops call `failOrRequeue` repeatedly without re-claiming —
   after the first call the row is `pending`, so each iteration needs a status
   reset (or a claim). embed-sweep's direct `markTagged`-on-tagged calls and
   extraction.test.js's `markExtracted`-on-held calls need their seeded status
   set to the in-flight one (a more honest simulation anyway); faces.test.js
   already seeds `facing`. New tests pin the discard behavior.
8. Unlocks: with fences in, #5's deferred sweep decoupling loses its stated
   blocker — but note the fence-vs-ownership limit above if decoupling ever
   makes recoverStuck run concurrently with a batch: that specific pairing
   reintroduces the re-claim window in-process, so decoupling must keep
   recoverStuck in the claim loop's flight (or bring the claim token forward).

**Re-verified 2026-07-13 against post-#8/#9/#10 code — design unchanged, three
interplays confirmed, churn list refreshed:**
- **#10 (unified queue) changes nothing structural:** `claimNextWork` stamps the
  same three in-flight statuses, so the fences map 1:1 exactly as designed;
  recoverStuck stayed inside the single flight (the constraint held); the new
  worker-loop test in queue.test.js flows a `facing` item through `advanceFaced`
  with the status the fence expects — it passes unchanged and becomes a live
  regression net for the fence work.
- **#9 (snapshot dedupe) composes and gets a bonus:** `markTagged`'s fence makes
  the snapshot conditional on the stamp landing, which removes #9's documented
  known-benign race (the stale append that could slip one duplicate row past the
  dedupe no longer happens at all).
- **#8 (tx reparent) narrows the accepted gap:** the entity-side writes that
  escape the fence are now themselves transactional (`reparentInstance`), so the
  mid-race self-heal story is cleaner — a discarded stamp leaves either the old
  parent or a consistent new one, never a half-move.
- **Implementation notes settled:** the three advances return landed/discarded
  (rowCount); `extractOne`'s ~9 `markExtracted` sites gate their success logs on
  the return (mechanical); `processOne` treats a discard as success-shaped (log,
  still `bumpUsage`) distinct from markTagged THROWING (left-for-recovery);
  `failOrRequeue` fences via the 1:1 requeueStatus→in-flight map and returns
  false on discard — the caller's "(requeued)" log line is cosmetically wrong in
  that rare case, accepted.
- **Test churn, final list:** tag-snapshots.test.js (didn't exist at analysis
  time) has 11 `markTagged`-on-tagged calls → one local helper that stamps
  'processing' first; embed-sweep.test.js has 1; extraction.test.js has 2
  `markExtracted`-on-unclaimed calls → seed 'extracting'; retry.test.js needs a
  per-iteration status reset in exactly ONE loop (line ~74) — its other five
  failOrRequeue calls already ride the 'processing' default; faces.test.js
  already seeds 'facing', unchanged. New tests: each fence discards on a
  re-routed row (status/tags/attempts/error untouched, no snapshot, false
  returned) + the user-wins integration (claim → retagItem flips → stale stamp
  discards → item stays where the user put it).

### 8. `reparentInto` isn't transactional and `items.entity_id` is `ON DELETE CASCADE` — FIXED
**Status: fixed (local) as designed. 227 tests green (4 new).** Shipped: new db.js
`reparentInstance` wraps re-parent + display-name + delete-if-empty in one tx
(worker's `reparentInto` now calls it — fixes ghost-entity-on-crash and the EPQ
corner); `deleteEntity` rebuilt lock-first inside a tx (`SELECT … FOR UPDATE` before
the payload read — the cascade can no longer eat a merge-in whose files were never
listed); `deleteBoard` gained the same one-line lock in its existing tx; the
`deleteInstance` route heals the TOCTOU ghost with a post-delete
`deleteEntityIfEmpty`. The lock mechanism is pinned by an integration test: a held
`FOR UPDATE` provably blocks a concurrent `reparentItem`, which then fails 23503
(the retry-heal path) instead of being cascade-eaten. Ingest's unlink-on-insert-
error remains note-only. Original analysis kept below.

worker.js ~719 does `reparentItem` then `deleteEntityIfEmpty` as separate autocommit
statements. If a concurrent path deletes the *target* entity in the window (its own last
instance just re-parented away), the cascade eats the freshly re-parented instance —
row and file vanish silently. Window is one statement wide with today's single worker,
so theoretical-ish, but nothing structural prevents it. Wrap reparent+delete in a tx.

Verified in depth; the entry's own scenario mostly CAN'T happen, and the real loss
window lives in the delete routes instead:

- **CORRECTED — worker-vs-worker self-heals:** concurrent extract flows DO
  interleave in-process (the batch is `Promise.all` of up to 4 `extractOne`s), but
  the dangerous interleavings resolve safely: `deleteEntityIfEmpty` is one atomic
  statement whose `NOT EXISTS` guard sees a merge-in that landed first (no delete),
  and a merge-in that lands after the delete hits a clean FK 23503 (`entity_id`
  references a gone row) → `extractOne` throws → `failOrRequeue` (transient) →
  the retry re-derives, finds no holder, creates a fresh entity. Converges, no
  loss. Same for two instances leaving one entity (second `deleteEntityIfEmpty`
  is a rowCount-0 no-op). One murky corner remains — Postgres's qual re-evaluation
  when the DELETE waits out a concurrent reparent's FK lock (EvalPlanQual doesn't
  re-run subplans against a fresh snapshot) — sub-millisecond alignment, and the
  tx wrap makes it moot rather than worth reasoning about.
- **The REAL window is `deleteEntity` (db.js ~1073), and it doesn't self-heal:**
  SELECT payloads → DELETE entity (cascade) as two autocommit statements. A
  merge-in landing between them: the cascade eats the freshly re-parented row and
  its files were never in the cleanup list. Correction to the entry: the ROW
  vanishes, the FILES don't — they orphan on disk, unreferenced by any item, which
  on a résumé board means sensitive files lingering in /gallery. Trigger is
  ordinary: user deletes a card while an upload batch is extracting into it.
- **`deleteBoard` (~684) is the instructive sibling: it's ALREADY tx-wrapped, and
  the tx doesn't close the window.** READ COMMITTED: the payload SELECT's snapshot
  misses an item that a concurrent ingest/reparent commits a moment later; the
  DELETE's cascade still eats it → orphan file. Transactionality was the wrong
  lens — the fix is lock ordering, not atomicity: the entity/board row must be
  locked (`FOR UPDATE`) BEFORE the payload read, so any FK reference attempt
  (`FOR KEY SHARE`) blocks until the delete commits and then fails cleanly into
  the retry-heal path. Note children-first delete does NOT work: deleting the
  items rows doesn't stop a new reparent from referencing the still-live entity
  row before the entity DELETE lands.
- **NEW — `deleteInstance`'s last-instance guard is TOCTOU** (server.js ~1129):
  `entityInstanceCount <= 1 → 409` is a separate read; two concurrent deletes of
  an entity's two remaining instances both count 2, both delete, and the entity is
  left EMPTY — a ghost card the route's own 409 exists to prevent, and nothing
  sweeps empty entities. (The route never calls `deleteEntityIfEmpty` — by design,
  but that design assumed the guard holds.)
- **What the entry's tx wrap actually buys:** a crash/kill between `reparentItem`
  and `deleteEntityIfEmpty` leaves an empty ghost entity (no data loss — the
  instance moved first). Worth having, but it fixes the ghost, not the cascade.
  `reparentInto` is three statements (reparent, display-name update, delete-if-
  empty) — wrap all three.
- **Bounded blast radius, verified:** hearts/crate memberships cascade with a
  deleted empty entity — that's the entity-instances design (merge keeps the
  target's hearts), not new damage. `withTx` already exists (~48).

**Fix design:**
1. `reparentInto` → `withTx` (all three statements). Fixes ghost-on-crash,
   erases the EvalPlanQual corner.
2. `deleteEntity` → tx with lock-first: `SELECT 1 FROM entities WHERE id=$1 FOR
   UPDATE` → SELECT payloads → DELETE. A concurrent merge-in either committed
   before the lock (its files make the cleanup list) or blocks on the FK lock,
   fails 23503 after commit, and heals via the extract retry.
3. `deleteBoard`: add the same lock-first line (`SELECT 1 FROM boards WHERE id=$1
   FOR UPDATE`) before its payload SELECT — one line into the existing tx.
4. `deleteInstance`: keep the 409 guard for the sequential case, add
   `deleteEntityIfEmpty` after the delete as the race heal (atomic guard makes it
   idempotent; a raced-empty entity gets cleaned instead of ghosting).
5. Adjacent note-only: ingest writes the file to disk before the row insert — a
   board/entity delete racing an upload can orphan the file via ingest's own FK
   failure path; unlink-on-insert-error in ingest.js would close it. Separate,
   small, not #8's core.

### 9. `tag_snapshots` grows forever — FIXED
**Status: fixed (local) as designed. 233 tests green (6 new in
test/tag-snapshots.test.js).** Shipped: dedupe-on-append in `addTagSnapshot`
(order-insensitive tags + undecided vs the item's latest snapshot; reasoning and
source excluded) — kills the periodic-retag, retag_on_refresh, and facet-less
empty-row growth paths at the source; `pruneTagSnapshots` backstop wired into the
hourly prune block behind its own `TAG_SNAPSHOT_RETENTION_DAYS` knob (default 0 =
keep forever — post-dedupe every row is a real judgment change), compose
passthrough + .env.example entry included. Double-check additions: migration
`0013_dedupe_tag_snapshots.sql` collapses the HISTORICAL duplicate chains the
forward fix can't touch (keeps run heads; jsonb equality is order-sensitive =
conservative); known-benign: the dedupe's read-then-insert isn't atomic, so the
#7 stale-write race can still land one duplicate row — hygiene not correctness,
and #7's fence removes the stale append. Original analysis kept below.

`markTagged` appends a snapshot on every tagging (db.js ~1191). `field_snapshots` got a
retention prune; `tag_snapshots` didn't. A live board with `retag_on_refresh` plus
periodic retags writes one row per item per pass, unbounded. Mirror the field-snapshot
prune.

Verified in depth; the growth engine turns out to be duplicates, not the missing
prune — and the entry's fix would delete the wrong rows:

- **CONFIRMED, and then some:** two writers (`markTagged` → source 'ai',
  `setItemTags` → source 'user', both via `addTagSnapshot`, db.js ~261), and ZERO
  readers anywhere — server, client, scripts. The table is write-only today; its
  schema comment states the purpose: "scheduled retags accrue a timeline instead
  of overwriting the only copy" — the thesis-then-vs-now feature the entity-boards
  plan wants, not yet built.
- **SHARPENED — the discipline mismatch is the bug:** `field_snapshots` writes
  only on MOVEMENT (`addFieldSnapshot` runs under `if (moved.length)`; its schema
  comment: "a flat refresh writes nothing"). `tag_snapshots` writes on EVERY
  tagging event, changed or not. The unbounded growth is overwhelmingly identical
  rows re-recording an unchanged judgment:
  - `retag_on_refresh` live board, 1-min cadence, volatile symbol: movement →
    requeue → markTagged → snapshot ≈ 1,440 rows/day/item at ~0.5–2 KB each
    (reasoning JSONB) — order of a GB/year per item;
  - periodic `retagBoard`: one row per item per pass — a daily retag of a
    1,000-item board is ~365k rows/year, identical for every stable item;
  - pure junk: extraction-only (facet-less) boards — `processOne`'s no-facets
    path calls `markTagged(id, [], false, {})`, appending an EMPTY snapshot per
    item per pass.
- **SHARPENED — a bare age prune is the wrong primary fix for this table:** it
  deletes exactly what the table exists for (the long-term "then" of
  then-vs-now) while keeping the noise — 90 days of per-minute duplicates is
  still ~130k rows/item inside the window. The true mirror of `field_snapshots`
  is not its prune but its write-on-change discipline.
- Adjacent: the composite index `(item_id, tagged_at)` serves a latest-per-item
  lookup perfectly, but neither snapshot table has an index for an age prune
  (`WHERE …_at < cutoff` is a seq scan) — same for field_snapshots today, fine
  at this scale, note-only.
- #7 interplay: the fence work will make `markTagged` skip the snapshot when the
  stamp is discarded; dedupe composes with that cleanly.

**Fix design:**
1. Dedupe-on-append in `addTagSnapshot`: fetch the item's latest snapshot (the
   existing index fits exactly), skip the INSERT when tags (order-insensitive) +
   `undecided` match. Reasoning is EXCLUDED from the comparison — the model
   re-words it every call; it's presentation, not judgment. Source is excluded
   too (a user's no-op save appends nothing). This kills all three growth paths
   at the source and gives a snapshot the same meaning as a field snapshot: the
   judgment CHANGED.
2. Prune as backstop, mirroring `pruneFieldSnapshots` and wired into the same
   hourly `pruneSnapshots` block — but its own knob (`TAG_SNAPSHOT_RETENTION_DAYS`),
   NOT the shared 90-day one: post-dedupe the surviving rows are real judgment
   changes, i.e. the product's data. Recommend default 0 (keep forever — growth
   is now bounded by actual judgment churn, which is small) with the knob there
   for ops; compose passthrough for it (the #5 lesson).
3. Tests: dedupe (same tags reordered → skipped; undecided flip → appended;
   changed tags → appended; facet-less empty repeat → one row total; user no-op
   → skipped) + prune cutoff mirroring liveness.test.js's.

### 10. Queue-fairness gaps (design choices with sharp edges) — FIXED (starvation half; tiering deferred)
- Extract leg's early `return` in `tick()` (worker.js ~924): a 500-file upload
  completely starves the tag and face legs until the extract queue is dry.
- FIFO by `created_at` + `retagBoard` resetting whole boards: a scheduled retag of
  1,000 old items queues ahead of every fresh upload — the user watching
  "Processing…" waits behind the entire retag. No priority tiering.

Verified in depth; blast radius corrected post-#5, one self-correcting nuance, and
a throughput argument the entry missed:

- **CORRECTED — the sweeps are NOT starved:** recoverStuck, retagDue, embedDue,
  refreshDue, and the prunes all run at the top of every tick BEFORE the claim
  legs, and the loop re-enters tick between batches (400 ms). A huge extract
  backlog therefore does not stop live prices, embeddings, or retag scheduling —
  post-#5 (bounded calls) those only pause per-batch, minutes at worst. The
  starvation is leg-vs-leg only: `pending_face` and `pending` rows don't move
  while `pending_extract` is non-empty.
- **Quantified:** 500 OCR-heavy PDFs ≈ hours of extract-leg monopoly (the sidecar
  serializes; up to ~40 s/doc at the OCR cap, plus each doc's AI extract call).
  For that whole window nothing tags on ANY board and new connector entities get
  no chart — cross-board collateral from one bulk upload.
- **Nuance the entry missed (half self-correcting):** on a MAPPED board a fresh
  upload enters via the extract leg — which has priority — so during a scheduled
  retag it JUMPS the 1,000-item tag queue for its definition: fields and identity
  appear promptly, only its tags land at the back of the FIFO (a card with fields
  but no tags — visible progress). On an unmapped board the entry is fully right:
  straight to `pending`, behind the entire retag (old `created_at` wins FIFO).
- **The fairness fix is also a throughput fix:** extract-leg concurrency is
  mostly wasted — 4 concurrent `extractOne`s serialize at the single-threaded
  sidecar (#5's queue math), so an all-extract batch does ~one doc's work while
  three slots sit in the sidecar queue. Mixing legs in one batch puts those idle
  slots on tag calls AND drops the sidecar queue depth from ~3-deep toward
  1–2-deep, easing the 240 s extractor budget (#5/#6 interplay).

**FIXED (starvation half) — shipped as a unified queue, not round-robin.** The
first design here was round-robin claim filling across the three legs; on
reflection (user pushback: "aren't we over-optimizing for this setup?") that
rebalances the starvation with a tuned ratio instead of removing its cause. The
legs themselves were the scheduling artifact. Shipped instead: ONE claim,
`claimNextWork` (db.js) — oldest ready item across
pending_extract/pending_face/pending, stamped to its stage's in-flight status,
which tells `tick()` which step to run (`STEP[row.status]`). The three claim
functions and the three early-return loops are deleted. Consequences, all by
construction rather than tuning:
- no stage can starve another (there are no stages to serve unfairly, only age);
- items complete end-to-end oldest-first — during a bulk upload, finished cards
  trickle out from minute one instead of hours of extraction then a wall of
  tags (the item re-enters the queue with its original created_at, so its next
  step stays at the front);
- the key gate lives in the one query (AI stages wait for a key; faces claim
  keyless), retry_at gating unchanged, recoverStuck untouched and still in the
  same flight (the #7 constraint);
- scheduling policy is now literally one ORDER BY — which makes the deferred
  half below a column away, not a redesign.
245 tests green: 5 new in test/queue.test.js (cross-stage FIFO + step dispatch,
trickle-completion, keyless face claim with AI stages waiting unfailed, retry_at
parking one row without blocking younger work); retry.test.js migrated to
`claimNextWork`. Double-check adds: the 5th test RUNS startWorker for real —
seed a pending_face item (needs no key), watch the loop claim → dispatch →
advance it to pending — the first test ever to exercise tick()'s wiring (the
STEP map is only evaluated when startWorker runs; a typo there was previously
invisible to the suite). Verified clean: zero claimNext* residuals, no stale
extract-first comments, and the new 3-status claim uses the same
idx_items_status/idx_items_created support the old claims did (a composite
(status, created_at) only starts mattering at ~10k+ queue depth — note-only).

**Priority tiering (retag-behind-uploads) — still DEFER, design noted:** the
honest fix is an `items.priority` column (default 0; the scheduled-retag path
alone stamps -1) with the claim ordering `priority DESC, created_at ASC` —
orderings derived from `updated_at` can't express intent. At this deployment's
scale (largest board ~300 items) a scheduled retag occupies the queue ~20–40 min
worst-case, and unified-FIFO already interleaves a fresh upload's steps with the
retag's by age. Revisit when 1,000-item scheduled retags are real.

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
  (FIXED as side effects: the #2 try-narrowing closed the tag leg; the extract leg's
  analog — extractOne's trailing `bumpUsage` throw yanking a landed extraction back to
  pending_extract for a re-bill — is closed by the #7 fence, which discards that
  stale flip because the row is no longer 'extracting'.)
