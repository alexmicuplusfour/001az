# Audio: tagging starts when the transcript lands (2026-09-27)

**Status: Stages 1-2 BUILT, second-passed and checked in the real app.
Stage 3 REVERTED by Stage 4. Stages 4-6 and the garbled-filename fix BUILT
and second-passed 2026-09-27. All uncommitted; migrations 0055-0057 applied
to the local app. Still owed: a real-app look at Stages 4-6 (needs an
upload).**

## The ask

On the "transcriber test" board, the last clip went transcription → embedding
→ "1 waiting — Tagging", sat there a long time, then finished. History says
tagging took 1s. Why the wait, and what's the fix?

## What happens today

### The measured run (item 7221, from job_log and the app log)

| time | what |
|---|---|
| 17:42:06 | clip uploaded; item lands `pending` (the tag queue) |
| ~17:42:07 | tag step picks it up, finds no transcript, puts it back with "try again in 60s". App log: `tag error #7221 …: awaiting transcription — will retry (requeued)` |
| 17:42:07.8 → 17:42:41.9 | transcription (34s) |
| 17:42:43.9 | embed, from the transcript alone |
| 17:42:44 → 17:43:07 | **24s of nothing.** The item is `pending` with `retry_at` = 17:43:07, so the tag step skips it. This is the "1 waiting — Tagging" |
| 17:43:07.9 → 17:43:09.2 | tag (1.3s) |
| 17:43:10.9 | embed again, because the new tags cleared the vector |

The clip before it (7220) did the same: uploaded 17:40:32, tagged 17:41:37.

### The wait

- Transcription runs on its own, apart from the tag/extract steps. Nothing
  stops the tag step from picking up a clip before its transcript exists.
- When it does, `modelInputFor` throws "awaiting transcription"
  (worker.js:1797). That error is marked "don't count as an attempt".
- `failOrRequeue` gives every such error the first retry delay, 60s
  (db.js:4139, `RETRY_BACKOFF_MS` at db.js:4116), and stamps `retry_at`.
- `landTranscript` (db.js:474) writes the transcript but never touches
  `retry_at`. So the tag step waits out whatever is left of the 60s, however
  early the transcript arrived.
- Long clips are worse. The tag step only checks again at 60s, 120s,
  180s… A 61s transcription waits almost a full minute more.
- Nothing wakes the tag step either. Transcription keeps its own list of what
  it's working on, and a finished job only wakes the loops that share that
  list (resource-loop.js:84). So even with `retry_at` cleared, tagging would
  wait up to one poll (3s).

The code treats the bounce as the plan. `retranscribeSql`'s comment says
"the tag leg's awaiting-transcription wait does the sequencing"
(db.js:1027), and `pipelineWork` has a comment about the claim-then-bounce
overlap (db.js:3914).

### Why History says 1s

A bounce doesn't write a History row (worker.js:2452 skips logging these
errors). So the only tag row is the real 1s run. The wait shows up only as a
`console.warn` in the app log.

### Why embedding runs twice

The embed sweep picks up audio as soon as it has a transcript, whatever state
the item is in (`needsEmbeddingSql`, db.js:3870). Commit e501921 did that on
purpose: audio on a board that doesn't tag should still be searchable by
speech. But on a board that does tag, that first vector is thrown away seconds
later when the tags land (`markTagged` clears it). It costs nothing on the
local bge model, but a paid embedder is charged twice per clip.

The wire already disagrees with the sweep here. The embed backlog count
(`boardLaneQueues`, db.js:3889) leaves out items that are still in the tag
queue, so it never counts that first embed as waiting work.

### Other paths that hit the same wait

- **Extraction.** `modelInputForExtract` (worker.js:1850) has the same gate,
  so audio on a board with extraction fields bounces there too.
- **Re-transcribe.** It drops the transcript and sets `pending` in one go
  (db.js:1030), so the tag step bounces and waits 60s after the new
  transcript lands.
- **Reprocess with a changed engine.** It drops the transcript the same way
  (db.js:3769).
- **A host with no transcription engine.** Every waiting clip bounces every
  60s, forever, and writes a warn line to the app log each time.

## Target

- An audio clip doesn't enter the tag or extract step until its transcript is
  there, or its transcription has failed for good (`transcript_error`).
  Neither step picks it up early, so there's no bounce and no `retry_at`.
- When transcription finishes (or fails for good), the tag and extract steps
  are woken right away, the way the refresh and ingest jobs already do
  (worker.js:3138).
- A clip on a tagging board is embedded once, after its tags land. A clip that
  isn't headed for tagging (held, failed, already tagged) is still embedded
  from its transcript, as today.

After this, History reads Transcription → Tagging → Embedding. Tagging starts
within about a second of the transcript, and the app log has no "awaiting
transcription" lines.

## Stages

1. **The tag and extract steps skip audio that has no transcript yet.**
   - One extra line in `claimFairBatch`'s WHERE (db.js:2894-2900). A
     `pending` or `pending_extract` row is left alone when it's audio that
     still matches `NEEDS_TRANSCRIPT_SQL` (db.js:3867). Reuse that constant,
     don't write a second copy.
   - Keep the two "awaiting transcription" throws as a safety net. A
     Re-transcribe can drop the transcript between the pick-up and the read.
     Update their comments to say that's now their only job.
   - Update the comments that describe the bounce as the design: db.js:1027
     (`retranscribeSql`) and db.js:3912-3915 (`pipelineWork`). The
     `excludeIds` frame stays because it's harmless, but the overlap it
     describes goes away.
   - Proof, at the database level (queue.test.js):
     - a `pending` audio item with no transcript isn't picked up, and its
       `retry_at` stays empty;
     - once it has a `transcript` it is picked up; the same goes for
       `transcript_error` and for an empty transcript (silence);
     - the same checks for `pending_extract`;
     - a non-audio `pending` item next to it is picked up normally.
   - Removal check: take the line out, and the first assertion fails.

   **Built.**
   - Close look changed one thing: the clause is written
     `(… AND NEEDS_TRANSCRIPT_SQL) IS NOT TRUE`, not `NOT (…)`. A file-less
     row (a connector vehicle) has a NULL kind, so `NOT (…)` comes out NULL and
     the row drops out of the queue. As first planned, the line would have
     stopped every connector board from tagging. db.js:165 has the same
     wording for the same trap in `notPaused`.
   - The clause is in `claimFairBatch` (db.js), with a comment saying why.
     The comments at `retranscribeSql` and `pipelineWork` no longer call the
     bounce the design. `pipelineWork`'s exclusion is still needed: a clip
     being transcribed is `pending` too, and would otherwise count twice.
   - The two "awaiting transcription" throws stay as the safety net (D3). The
     tag-side comment says so.
   - Proof: "audio waits unclaimed for its transcript, then claims — no
     bounce" (test/queue.test.js). It covers a `pending` clip and a
     `pending_extract` clip, beside a file-less row and an image; then an
     empty transcript and a `transcript_error` each make their clip
     claimable.
   - Removal checks:
     - clause removed: fails ("only the rows whose input exists");
     - clause written as `NOT (…)`: fails the same way, because the file-less
       row goes missing.

2. **A finished transcription wakes the other steps.**
   - In `transcribeKind.run` (worker.js:3050), call `wakeAll()` when
     `transcribeOne` returns "ok" or "parked". Those are the two answers that
     make a row ready. The two retry answers ("backoff-item",
     "backoff-lane") don't wake anything.
   - Proof, through the real worker: a stand-in whisper (audio.test.js's
     pattern, `primeSidecars`) plus a stand-in AI (alerts-worker.test.js's
     `ANTHROPIC_BASE_URL` pattern), with `POLL_MS=60000` so that only a wake
     can make tagging quick.
     - an audio item on a board with facets ends `tagged` within ~5s of its
       transcript landing, with `attempts` 0 and no `error`;
     - a clip the stand-in whisper refuses (422 → `transcript_error`) is also
       tagged promptly, from its filename.
   - Removal checks: without the wake, both cases wait out the 60s poll and
     time out. Without Stage 1, the tag step bounces, `retry_at` blocks it,
     and they time out the same way. The deadline is 5s against 60s, so the
     test can't flake into passing.
   - The close look should settle the test setup: whether "served" comes
     from `primeSidecars` or from a board pinned to a stand-in cloud
     transcriber.

   **Built.**
   - In `transcribeKind.run` (worker.js), `wakeAll()` is called on "ok" and
     "parked". The wake roster comments now list four callers (worker.js at
     `let wakeAll` and at `wakeAll =`, and resource-loop.js).
   - Proof: the new test/audio-handoff-worker.test.js. It runs a live worker
     with `POLL_MS=60000`, a stand-in whisper over `TRANSCRIBER_URL`
     (`primeSidecars` marks it present) that holds each job until the test
     lets it go, and a stand-in Anthropic over `ANTHROPIC_BASE_URL`.
     Embedding is off in this file, so no on-device model loads.
     - "a clip is left alone while it transcribes, then tagged the moment its
       transcript lands": the tag prompt contains the transcript text.
     - "a clip whose transcription fails for good is tagged from its name,
       just as promptly": the prompt names the file and says "no discernible
       speech".
   - Found while building:
     - The tag step only picks up rows once the worker knows a default key
       exists, and the maintenance pass sets that. So "the clip wasn't picked
       up" could be true just because the tag step hadn't run yet. The test
       queues a file-less control row beside the clips and waits for it to be
       tagged first. That proves a pick-up ran that could have taken the
       clips.
     - Transcription takes the newest clip first. The test ages the clips so
       the one it holds first is the one the first test is about.
   - Removal checks:
     - no wake: both tests fail at their 5s windows ("tagged after the
       transcript — not within 5000ms", "tagged after the park — not within
       5000ms");
     - no Stage 1 clause: the first test fails on the untouched check with
       `error: 'awaiting transcription — will retry'`. The worker logs
       `tag error #2 speech: awaiting transcription — will retry (requeued)`,
       the same line the real app logged for items 7220 and 7221.

3. **One embed per clip on a tagging board.**
   - In `needsEmbeddingSql`'s audio branch (db.js:3873), skip rows whose
     status is in `TAG_QUEUE` (db.js:154). The existing comment for that list
     says it means "this item's tags are about to be rewritten". Held, failed
     and tagged audio still embed from the transcript.
   - This also removes a race Stage 2 would otherwise make more likely. With
     the wake, the embed and the tag step start at the same moment, and
     `setItemEmbedding` has no fence (see "Found on the way"). An embed that
     finishes after the tags land would store a transcript-only vector, and
     the item would never be embedded again.
   - Proof (embed-sweep.test.js, first-class-work.test.js):
     - audio with a transcript is due when `held`, `failed` or `tagged`, and
       not due when `pending`, `processing`, `pending_extract` or
       `extracting`;
     - "embed backlog mirrors the sweep's predicate" gets a queued-audio case,
       and the count and the sweep agree on it (today they don't).
   - Removal check: take the status line out, and the "not due" assertions
     fail.

   **Built.**
   - `needsEmbeddingSql`'s audio branch skips `status NOT IN TAG_QUEUE`
     (db.js), and the comment above it says why. The comment above
     `itemsNeedingEmbedding` mentions the exception.
   - Close look: only two things read this predicate, the sweep and the
     backlog count. The comment above them says the two "can never drift",
     but they had: the count already left out queued rows and the sweep
     didn't. They agree now.
   - Proofs:
     - "transcribed audio embeds from its transcript unless its tags are on
       the way" (test/embed-sweep.test.js): of seven statuses, exactly
       `held`, `failed` and `tagged` are due;
     - "embed backlog mirrors the sweep's predicate"
       (test/first-class-work.test.js) gains a queued clip with a transcript,
       and a check that the sweep takes exactly what the count reports.
   - Removal check: with the status line removed, both fail. The status
     matrix comes back with every status; the sweep takes 3 where the count
     says 2.

**Suite:** 2133/2133, and eslint is clean on every touched file. The first
full run had two browser-test failures: work-cadence's embed chip and
ui-updates' favorites Enter key. Neither touches audio, transcription or
pending rows. Both passed alone, and the whole suite passed on the rerun.
That looks like timing under the 8-way parallel run, not this change.

**Real-app check (after Stage 3):** rebuild the local app and upload a clip
to "transcriber test". In job_log, tagging should start within ~1s of the
transcription ending, with one embed row after it. The app log should have no
"awaiting transcription" line. Then Re-transcribe the same card and check the
same things.

**Passed**, on the three clips uploaded after the rebuild (items 7223-7225,
job_log):
- 7225 (HORCHATA): transcription 18:30:09.3 → 18:31:46.8 (97s). Tagging
  started at 18:31:46.8, the same tenth of a second, with one embed after.
  Before, a 97s transcription waited for the 120s retry, about 23s idle.
- 7223 and 7224: transcripts came back instantly (same audio as before), and
  tagging started in the same tenth of a second. One embed each.
- The "no awaiting transcription line" check can't be done: those uploads ran
  in a container that has since been replaced, and its log went with it.
  job_log shows no wait, which is what the log line would have explained.
- Not yet checked: Re-transcribe.

## Second pass (2026-09-27)

One read-only reviewer compared the diff with HEAD without seeing the plan.
I checked the tests' setups and re-read every finding in the code.

Fixed:
- **The queue test left rows that made later tests load the on-device
  embedding model.** It parked its rows as `failed`, and a failed clip with a
  transcript is embeddable, so the worker tests later in queue.test.js
  embedded it (`embedded 1 item(s) [Xenova/bge-small-en-v1.5]`). It deletes
  its rows now. It also reuses `seed` with a `files` argument instead of
  having its own helper.
- **The embed-sweep test left a `tagged` clip carrying an embed error.**
  `embeddingStats` counts that as failed, which is a trap for a later test.
  It deletes its rows now.
- **Three stale spots still described the claim-then-bounce:** the `workFor`
  comment (server.js), the retranscribe route's comment (server.js), and the
  first-class-work test "a clip the tag leg claimed…".
  - That test seeded `processing`, which the claim can't produce any more.
    It now seeds `pending` (the real overlap: a clip queued to tag while it
    transcribes).
  - Removal check: with pipelineWork's waiting count no longer excluding the
    clip, the test fails.
- **The safety-net comment was wrong.** The tag leg reads the claim's own
  payload snapshot (worker.js `tagOne` → `modelInputFor(DIRS, row.payload…)`),
  so a Re-transcribe after the claim can't reach the throw. Only a write
  committing inside the claim statement, between its read and its lock, can.
  The comment says that now.
- **Simplified the claim clause** to `(NEEDS_TRANSCRIPT_SQL) IS NOT TRUE`. The
  hand-written `status IN ('pending','pending_extract')` guard is gone: no
  audio clip ever waits in the face or fetch queues, and db.js's header rule
  is to derive status lists, not copy them. The `NOT (…)` removal check still
  fails the queue test.
- **Worker test:** the second test releases both whisper jobs itself. If the
  first test stopped early, the one-clip whisper slot left the second test
  failing for the wrong reason. It now fails for the right one ("tagged after
  the park — not within 5000ms").
- A comment line in worker.js I'd pushed past the wrap width was rewrapped.

Open, for a decision:
- **D2 was framed too narrowly, and Stage 3 should probably be reverted.**
  Boards tag automatically by default (baseline `auto_tag DEFAULT TRUE`), and
  uploads queue as `pending` whether or not a key exists (ingest.js). So on
  an install with no AI key, audio is never embedded, and speech search (a
  free, fully local setup: whisper plus the on-device embedder) stops working.
  The same holds, for a while, for a board whose key's provider was
  uninstalled, and for clips in tag retry backoff (up to about an hour).
  Recommendation: revert Stage 3. The double embed is free on-device and tiny
  on a paid key. Close the stale-vector race with the embed-write fence (see
  "Found on the way") instead, which fixes it for every path, not only audio.
- **The wire still counts clips waiting on transcription as tag work.**
  - `pipelineWork` counts every `pending` row as "Tagging: N waiting", and
    the transcribe backlog (`boardLaneQueues`) leaves out in-flight statuses.
    So 20 clips queued for whisper read "Transcription: 1 running, Tagging:
    19 waiting".
  - This was true before, but the claim now guarantees the tag leg won't take
    those rows, which breaks the wire's own rule (what the wire reports as
    waiting is what the lane will claim).
  - The fix: count them under transcription. It changes the "transcribe
    backlog counts claimable, invisible clips only" test's expectation.
    `tagQueueDepth` and `boardTagActivity.busy` count them too.
- **The claim now reads each queued row's payload.** Measured on a throwaway
  DB with 20k pending rows:
  - payloads your size (the real DB averages 486 bytes, none stored out of
    line): 15ms → 18ms per claim;
  - 6KB payloads (stored compressed out of line): 15ms → 550ms.
  - Claims run up to several times a second while work flows, so a retag of a
    board of long recordings (big transcripts) would feel it. The
    transcription sweep's own every-3s scan (`NEEDS_TRANSCRIPT_SQL` over every
    item) already pays that cost.
  - The clean fix is a stored generated column (`awaiting_transcript`) that
    every reader shares. It needs a migration and a check of backup/restore
    and board duplication against a generated column.
- **A race inside the claim statement** (recorded, not built). Under READ
  COMMITTED, the `claimed` CTE's lock re-checks only `id IN (pick)`. A write
  that commits between the claim's read and its lock is claimed on its new
  version:
  - a clip whose transcript was just dropped comes out without one, and the
    old 60s bounce is back for that one row;
  - the older form of the same gap: a row cancelled to `held` gets flipped to
    `processing` by `CLAIM_CASE`'s ELSE.
  - Repeating the status and transcript conditions in `claimed` closes both.
    The window is microseconds inside one statement, so no test can drive it
    deterministically.

## Stages 4-6 (agreed 2026-09-27: "yes, sounds good")

The first three open items above, as stages. The race inside the claim
stays recorded, not built.

4. **Revert Stage 3, and fence the embed write instead.**
   - `needsEmbeddingSql` goes back to embedding every transcribed clip,
     whatever its status.
   - Every writer that changes an item's embed text goes through one SQL
     fragment, `CLEAR_EMBEDDING` (landTranscript, setItemTags, markTagged).
     That fragment also bumps a new counter, `items.embed_gen` (migration
     0056).
   - The sweep reads the counter with the row. `setItemEmbedding` and
     `setItemEmbedError` land only while it is unchanged. A vector computed
     from text that has since been cleared is dropped, and the row stays due.
   - Proof: an embed whose text is cleared while its call is in the air
     stores nothing and stays due; the same run without the clear lands.
     Plus a status matrix: a transcribed clip is due in every status.
5. **Clips waiting on transcription count under Transcription.**
   - `pipelineWork`'s waiting count leaves them out.
   - The transcribe backlog counts queued clips (`pending`,
     `pending_extract`) too.
   - Close look first: `tagQueueDepth`, `boardTagActivity.busy`, the client's
     Cancel-queued visibility, and the poll cadence.
6. **A stored `awaiting_transcript` column.**
   - A generated column (migration 0057), and `NEEDS_TRANSCRIPT_SQL` reads
     it. So the claim, the transcription sweep and the counts stop unpacking
     payloads.
   - Backup's column list must skip generated columns (backup.js
     `tableColumns`), or restore would try to insert into it.
   - Proof: the claim-cost measurement repeated; the backup round-trip tests
     with the column in place.

### Built (2026-09-27)

**Stage 4.**
- `needsEmbeddingSql` is back to HEAD. The embed-sweep matrix test now pins
  the reverse: a transcribed clip is due in all seven statuses ("a keyless
  install searches by speech"). The first-class-work embed test is back to
  HEAD.
- Migration 0056 adds `items.embed_gen`. `CLEAR_EMBEDDING` bumps it, the
  sweep selects it, and `setItemEmbedding` / `setItemEmbedError` take it and
  land only while it's unchanged. `setItemEmbedding` answers whether it
  landed. A null gen writes unfenced (for callers seeding a vector).
- Close look found:
  - **The salvage round.** A batch 400 retries each item alone, and it used
    `if (!embedded) throw new Error(failures[0].message)`. Once writes can be
    fenced out, every single call can answer while nothing lands, so
    `failures[0]` would be undefined. It checks `usages.length` now (calls
    that answered). The happy path counts `embedded` as landed writes.
  - **`CLEARED_VERDICT`** (retag, reprocess) clears tags without clearing the
    vector. That's older than this change and harmless here: the old vector
    stays until the tag lands and clears it. Not touched.
- Proof: "a vector whose text changed mid-call is dropped, and the row stays
  due (the gen fence)" (embed-sweep.test.js). A stand-in embed call lands the
  tags on one row while it's in the air:
  - that row's vector is dropped and the row is due again; the other lands;
    `embedded` is 1;
  - then the salvage round with every write fenced out returns
    `{ embedded: 0, skipped: 0 }`.
- Removal checks, each failing the fence test: the write unfenced; the clear
  without the bump; the salvage check back on landed writes. Stage 3's clause
  put back fails the matrix test too.
- Found while building: `sed -i` on a CRLF file rewrote the whole of db.js to
  LF. Put back byte for byte. Kept edits go through Edit or a byte-level
  Python patch; `sed -i` only for removal checks that are restored with `cp`.

**Stage 5.**
- `LANE_NEED` entries carry `skip`: the statuses the wire shows as the legs'.
  Transcription skips only the claimed half (`Object.values(IN_FLIGHT_FOR)`),
  and embed keeps both halves. `pipelineWork`'s waiting count leaves out
  `NOT awaiting_transcript` rows. The `workFor` and `pipelineWork` comments
  say what the exclusion does now.
- Close look:
  - The page's check rate doesn't drop. A running transcription is a running
    row, which keeps the fast tier (data.js `pollDelay`). Only a transcription
    backlog with nothing running goes slow, as designed (embed-work-plan D2).
  - "Cancel queued" is offered only for `leg` entries. So a board whose only
    waiting work is clips behind their transcripts no longer offers it. That
    is honest: the verb never stopped a transcription, it only parked the
    clips so they wouldn't be tagged afterwards. Recorded, not changed.
    **Wrong — reversed in the second pass** (the lane's `pull`).
  - `tagQueueDepth` (the capabilities "N waiting" on a blocked tagger) and
    `boardTagActivity.busy` (holds back facet diagnosis) still count these
    clips. Both are right to: the clips are waiting on the tagger too, and
    their tags are about to be written. Not touched.
- Proof (first-class-work.test.js):
  - the transcribe-backlog test now counts a queued clip and not a claimed
    one (3, 2 with a running clip excluded);
  - new: "clips waiting on their transcript count under transcription, not
    the leg that will take them", checked on `pipelineWork` and on the wire
    (`/jobs/errors`): transcribe 2, tag 1, extract none.
- Removal checks: without the waiting-count exclusion the new test fails.
  With transcription skipping both halves, both tests fail.

**Stage 6.**
- Migration 0057: `awaiting_transcript BOOLEAN NOT NULL GENERATED ALWAYS AS
  (COALESCE(<the rule>, FALSE)) STORED`. `NEEDS_TRANSCRIPT_SQL` is now
  `i.awaiting_transcript`, and the claim and the waiting count use a plain
  `NOT` (the column is never NULL, so the `IS NOT TRUE` note went).
- backup.js `tableColumns` skips `attgenerated <> ''` columns, on both the
  dump and the live check at restore. Restore only needs an archive's
  columns to exist, so a missing generated column is simply recomputed.
- Proof:
  - Measured again on the throwaway 20k-row, 6KB-payload DB: no check 13.5ms;
    payload 560ms; column 14ms.
  - Removal checks: without the backup filter, 6 backup round-trip tests fail
    (test/backup.test.js). Without the claim's check, the queue test and both
    worker tests fail.
- Applied locally: "db: applied migration 0056_embed_gen" and
  "0057_awaiting_transcript". 5,571 items, 0 awaiting a transcript (the 3
  clips are transcribed), every embed_gen 0.

**Suite:** 2138/2138, eslint clean on server/ and test/.

**Owed:**
- A real-app look: upload two or three clips at once, and the Jobs panel
  should read "Transcription: 1 running, N waiting" with no "Tagging: N
  waiting", and "Cancel queued" on offer. History will again show an embed
  after the transcript and another after the tags (Stage 3 reverted).

### Second pass on Stages 4-6 and the filename fix (2026-09-27)

One read-only reviewer again compared the diff with HEAD without seeing the
plan. I re-read every finding in the code, and checked the plan's claims
and the tests' setups myself.

Fixed:
- **"Cancel queued" vanished on audio boards.** The modal offers it only for
  `leg` entries, and Stage 5 moved clips waiting on their transcript under
  the transcription lane, which isn't one. The verb still pulls those clips
  to held, and that's what saves the tagging after each transcript. So the
  "honest" reasoning recorded under Stage 5 was wrong.
  - `boardLaneQueues` now returns `pull`, how many of a lane's rows sit in a
    leg's queue (the queued statuses derived from `LEG_KIND`), present only
    when non-zero. workFor passes it through.
  - jobs-modal.js reads it for both the offer and Abort's count (`pulled`).
  - Proofs: the two first-class-work wire tests expect `pull`; new
    jobs-modal test "clips queued behind their transcript are still the
    verb's to pull". It checks the offer, and "Abort — 13 left" (one claimed
    leg plus twelve pulled, not the lane's 19).
- **Migration 0055 could mangle names that never went through multer.** A
  folder-ingested "3×½ scale.png" is valid UTF-8 as Latin-1 bytes (D7 BD),
  so repairName alone turns it into "3׽ scale.png". Rewritten:
  - uploads only (no `payload.provenance`);
  - the one key written in place with `jsonb_set`, not the array
    round-tripped through JSON;
  - `job_log.target` and, newly, `alert_matches.label` (the frozen label the
    first version missed) repaired only where they belong to a repaired item
    and still read its misread name;
  - the `jsonb_array_elements` input wrapped in a CASE, because Postgres
    doesn't promise to evaluate the `jsonb_typeof` test first, and a
    non-array there would have failed the boot.
  - Local DB check: the first version already ran here. It changed no
    provenance item (the five non-ASCII ones are the five it left alone),
    and no alert label is garbled, so the local result is the same as the
    new version's. Production hasn't run it yet and gets the new one.
  - Proof: the migration test now also holds a provenance item with that
    name, a non-upload History label of the same shape, and an alert match,
    plus the re-run check.
- **A fenced-out embed error still logged a failure.** It wrote a `failed`
  row (lighting the dot) and counted as skipped, though nothing was marked.
  `setItemEmbedError` answers whether it marked the row, and the salvage
  round skips the row and the count when it didn't. Proof: a third part of
  the fence test.
- **The claim and the legs disagreed on an empty `transcript_error`.** The
  column tests the key; the legs tested truthiness. So a parked failure with
  an empty message was claimable, yet bounced forever as "awaiting
  transcription". Both legs now test the key. Proof: model-input.test.js
  "a clip whose transcription failed with an empty message is answered".
- **False comments.**
  - `CLEAR_EMBEDDING` and 0056's header now say the reset verbs (retag,
    reprocess, re-transcribe) blank text without clearing, so the fence
    doesn't cover a vector in the air across one of those (it self-heals at
    the next landing).
  - The safety-net comment names every verb that can race the claim.
  - The lane-need header no longer claims the count is exactly what the lane
    claims.
  - The overlap test (first-class-work) now describes the double count it
    actually guards (the transcription backlog), and its removal check fails.
- Every fix above has a removal check that fails. The files are restored
  byte for byte.

Recorded, not changed:
- **A board with no transcription engine.** Queued audio is on the wire
  nowhere now (not a leg count, and the lane isn't served), and the pending
  cards hold the 4s check open for good (that part predates this change).
  This follows the "a backlog nobody will claim is a config gap, not work"
  rule. The capabilities page is where the gap shows.
- **The tag leg and the embed sweep often take the same clip at once** now
  that a landing wakes both. For the few milliseconds of a local embed, the
  embed batch's item_ids hide the clip's running tag row, so the chip reads
  "Embedding". The spend is unchanged, and the fence now usually drops that
  first vector.
- **0057 rewrites the whole items table under a lock, inside the boot
  migration.** Trivial locally (5,571 rows). Production's size decides how
  long its first boot takes.
- Two tests are regression pins rather than proof of this change: "a clip
  being transcribed is one unit of work" and the embed status matrix.

**Suite:** 2140/2140, eslint clean. Local app rebuilt with this pass.

## Decisions

All three taken as recommended, 2026-09-27 ("go ahead").

- **D1. Boards with no facets.** Today, audio on such a board is marked done
  at once (there's nothing to ask), before transcription. After Stage 1 it
  waits for the transcript first: the card shows queued while transcription
  runs, and alerts on system facets (~uploaders) fire after it.
  Recommendation: accept. It keeps one rule ("audio isn't picked up until its
  text is ready"), and exempting these boards would mean joining the board's
  facets into the busiest query in the app.
- **D2. Boards waiting for an AI key.** Their audio sits `pending` until a key
  appears. Today it's searchable by speech in the meantime. After Stage 3 it
  isn't, which matches every image on that board, and matches what the embed
  backlog count already says. Recommendation: accept.
  **Reversed 2026-09-27 (Stage 4).** The second pass showed it isn't an edge
  case: every install with no AI key queues its audio as `pending`, so speech
  search would never work there.
- **D3. Keep the safety-net throws.** Recommendation: keep them (see Stage 1).
  Without them, a clip whose transcript was dropped between pick-up and read
  would be tagged from its filename.

## Found on the way (not in this plan)

- **The embedding write has no fence.** `setItemEmbedding` (db.js:3846)
  writes by id alone. If an item's text changes while its embed is still
  running (a tag landing, a manual tag edit, a new transcript), the old
  vector is written over the cleared one, and the item counts as embedded
  from then on. It's rare today, and Stage 3 closes it for audio. The general
  fix needs something to tell "cleared since I read it" apart (a counter that
  `CLEAR_EMBEDDING` bumps). Its own small plan if you want it.
- **Garbled filenames.** "Are moms still like thisï¼" is "this？"
  (fullwidth ?) read as Latin-1. multer 2.2.0 reads multipart filenames as
  Latin-1 unless told otherwise (`defParamCharset`, default `'latin1'`), and
  the upload route doesn't set it (ingest.js:120). The stored bytes confirm it
  (`c3 af c2 bc c2 9f` = UTF-8 of `ï¼\x9F`). The fix is
  `defParamCharset: "utf8"`, plus a decision about the names already stored.

  **Built 2026-09-27** (asked for after the second pass):
  - `defParamCharset: "utf8"` on the upload route's multer (ingest.js). The
    backup upload's multer is left alone: its route turns every non-ASCII
    character in the name into `_`, so it can't show a garbled name.
  - Migration 0055_utf8_upload_names.js repairs the stored names in the two
    places they were kept: each file entry's `original_name` (card title,
    download name) and `job_log.target` (History). No stored file field
    carries the name; only the extension, which is ASCII.
  - `repairName` changes a name only when re-encoding it as Latin-1 gives
    bytes that decode as valid UTF-8 and encode back to the same bytes, and
    the name has nothing past U+00FF. A genuine "café" or "1979–90" is left
    alone.
  - Tests, in test/upload-names.test.js:
    - the rule: four misread names repaired; ASCII, genuine Latin-1, CJK, and
      a name whose low bytes happen to spell valid UTF-8 all left alone;
    - a real upload keeps "this？ café’s notes.txt" in the response and in
      the DB;
    - the migration repairs a file entry and a History row, leaves the others
      alone, and a re-run changes nothing.
  - Removal checks: without the charset, the upload test fails. With the
    repair off, or without the round-trip check, the rule test and migration
    test fail. Without the past-U+00FF guard, the rule test fails.
  - Dry run against the real names before the migration ran:
    - 37 non-ASCII file names: 32 repaired (e.g. "tÄu … cumpÄrÄturi" →
      "tău … cumpărături"), 5 left alone, all of which were already right
      ("1979–90", "3,277×4,096", "eclipsse™");
    - 61 History targets: all 61 repaired.
  - Applied: the rebuild ran 0055 ("db: applied migration
    0055_utf8_upload_names"). The three "transcriber test" cards now read
    "That’s what they’re not prized for？ …", "…if you could meet him？ …"
    and "HOMEMADE HORCHATA!!!! Where this man at？ …". No garbled History
    target is left.
  - Suite 2136/2136, eslint clean.

## Not touched

- Transcription's own retry and backoff (one clip failing doesn't hold up the
  rest). It's per clip, and works.
- The 60s first retry for real failures. That's still right for a 429 or an
  engine error.
- How History shows a gate wait. After this there's no wait left to show.
