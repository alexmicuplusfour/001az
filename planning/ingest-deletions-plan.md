# Ingestion deletion memory — history, bring-back, and hash identity (2026-09-15)

**Status: PLANNED.**

The problem, as hit on the stocks test board: the ingest ledger (`ingest_log`)
records "every source_key ever admitted" and dedups against it forever. Delete
a test run's items and the feed reports "1433 already ingested" against a
near-empty board, with no way back short of hand-editing the database. The
ledger conflates three different facts under one bare row:

1. **it's on the board** (dedup) — derivable from live membership, never
   should have been a durable ledger fact;
2. **the user deleted it** (rejection) — the fact worth remembering, but
   currently *inferred from absence* rather than recorded;
3. **it can't be processed** (bad bytes, size cap) — deterministic skip,
   correctly ledgered-and-forgotten today, but indistinguishable from #2.

Research (Sonarr/Radarr import lists, Plex/Immich mirrors, Airbyte
clear/refresh) says the systems that get this right separate "currently
present" (derived live) from "user rejected" (explicit, reversible). Their
per-item exclusion UI does NOT fit here — arr lists are curated, the user
knows every title; our windows are thousands deep. So the reversal surface is
**bulk, in the ingest modal**, not per-item.

## Decisions made (conversation, 2026-09-15)

- **Deletion stays deletion by default.** No prompt at delete time. The feed
  must not overturn a delete on the next tick.
- **Rejection is recorded, not guessed.** The delete flow stamps the item's
  ledger row `user-deleted` at the moment of deletion, silently. Absence for
  any other reason (derived-identity merge, restore, future tooling) is never
  read as rejection — merges carry the ledger link to the surviving item.
- **History section in the ingest modal, rows = runs.** Date · scanned ·
  admitted · ignored · errors. The job log (`kind: "ingest"`) already holds
  these rows; `ignored` (matched but held back as user-deleted) is a new
  count. Per-run numbers are **informational only** — a watch ignores roughly
  the same set every tick, and an old run's set is stale — so there is exactly
  ONE action, on present state: **"bring back the ignored N"** (clear their
  deleted marks → the next run re-considers them). All-or-nothing is the
  accepted trade; anything finer is the per-item list we rejected.
- **Two buckets, two verbs.** "You deleted N" → bring back. "N couldn't be
  processed" (unprocessable skips, with reasons) → retry. A corrupt PDF is
  not a rejection and must not sit behind an import button that can never work.
- **"Remember deletions" toggle**, default ON, forward-looking. Flipping OFF
  asks once about the present backlog ("N currently held back — bring back /
  leave them") so the toggle's temporal ambiguity dies at flip time. No mirror
  mode (auto-removing items that fall out of the filter) — separate feature,
  not asked for.
- **Keep top backfills.** A user-deleted item does NOT consume a `total`
  slot: delete one of the top 1500 and rank 1501 fills the slot on the next
  run. "Keep top N" means the board keeps itself at N eligible members.
  (Reverses today's behaviour, where the `total` cap runs over the raw
  candidate list before the known-subtraction — worker.js `ingestDue`.)
- **Files remember content, connectors remember keys.** File deletion memory
  keys on a content hash so "I deleted that thing" survives renames (renamed
  file stays deleted) and path reuse (a different file at an old path is
  eligible, not held back for a rejection it never earned). Connector memory
  stays key-based (symbol) — ticker reuse is rare and history is the escape
  hatch.
- **Hash economics: never hash during a scan.** Scans stay listings (names,
  sizes, dates) — zero new cost at any source size, local or S3. A file is
  hashed once, at admit, on bytes already fetched and being decoded anyway;
  the hash lands on its ledger row. The hash is a TIEBREAKER on the paths
  that already pay a fetch:
  - *new path* → fetch → hash → matches a deleted hash? hold back and ledger
    the new path (one download, once, then cheap forever); else admit.
  - *known path, size/mtime drifted from the ledgered pair* → probably a
    different file → fetch + hash once to decide.
- **Clear ingestion history** button — the blunt Airbyte-style reset, wipes
  the board's ledger outright (confirm required). Needs none of the above and
  ships first.
- **Preview stops lying.** "1433 already ingested" becomes a split the user
  can act on — on board / held back (deleted) / unprocessable — with the
  held-back figure linking into the history section. The link is load-bearing:
  the rejection happened in the gallery, its undo lives in this modal, and the
  preview line is the only bridge.

## Schema

`ingest_log` grows: `reason` (`admitted` | `deleted` | `skipped`), `item_id`
(nullable link to the born item; merges rewrite `entity_ids` on the same item
row, so the link survives them with no re-pointing), and for file boards
`content_hash`, `size`, `mtime`. Migration backfills `reason='admitted'`;
existing rows have no item link or hash — they behave exactly as today (held
back by key) until touched, and "bring back" / "clear history" both work on
them regardless.

**Provenance ALSO lands on the item** (source key + hash in the item's
payload), not only on the ledger row — stage-1 deep dive finding: the clear
button deletes the rows any ledger-side link lives on, so a ledger-only link
can't answer "is this source file already on the board" after a wipe. With
item-side provenance a post-clear file run recognizes present files and
skips them (re-ledgering the key), the same self-healing shape the connector
adapter gets free from its unique constraint.

Note `deleted` replaces inference everywhere: the sweep's holdback, the
history's ignored count, and the preview split all read the stamp, never
"ledgered but absent".

## Stages

1. **Clear — SHIPPED 2026-09-15 (uncommitted).** `POST /api/boards/:id/ingest/clear`,
   `requireBoardManager`, returns `{ cleared: N }`. No configured-ingest gate:
   ledger rows outlive a removed config on purpose, and clearing a
   deconfigured board's haunting is legitimate. Deletes the board's
   `ingest_log` rows and reuses `clearIngestSuperseded` (drain_left +
   last_error — a wiped memory supersedes the old run's verdicts the same way
   a new config does; a mid-drain budget over vanished premises must die).
   Leaves the job log (transparency; stage 4 reads it), last_run_at /
   last_added, ingest_next_run_at, and the window caches (ledger applies
   downstream of cached candidates) untouched. Sweep race is benign: a tick
   that read `ingestedKeys` pre-clear re-inserts rows only for candidates it
   is admitting right now, which are true rows.
   - **File-board hazard**: the ledger is a file board's ONLY dedup (no
     unique constraint ties a source file to its minted stored filename), so
     clear + items-still-on-board = the whole folder re-imported as
     duplicates on the next run. Connector boards are safe (constraint →
     `.duplicate` → re-ledgered). The warning is a warning, not a gate —
     and the stakes it states come from the adapter, not from the modal
     guessing: `descriptor().identityDedup` (true on connector, false on
     files, listed with the other optional adapter pieces in
     ingestion/index.js's header). The modal renders it blindly, so a future
     adapter gets the right sentence by declaring one, and stage 2 flips
     files.js to `true` on the same line as the provenance work rather than
     leaving a stale warning in a UI file three modules away.
   - **UI**: settings view near the status line, manager-gated, native
     `confirm()` (house pattern), default dark toast. Label says what it
     does — "Forget all ingested items", NOT "clear history" (the run
     history is exactly what it preserves). `GET /ingest` grows `ledger: N`
     so the button hides at zero and the confirm is concrete ("Forget all
     1,433…?").
   - **Tests**: routes (gates, count, rows gone, unconfigured board,
     drain_left cleared), sweep (post-clear connector re-add + dup absorb),
     modal (render, confirm, toast).
2. **Schema + stamps — SHIPPED 2026-09-15 (uncommitted).** Behavior-neutral except
   where noted: this stage writes the facts; stages 3–4 read them. Holdback
   stays "any ledger row" — `ingestedKeys` is untouched.
   - **Migration**: `ingest_log` gains `reason TEXT NOT NULL DEFAULT
     'admitted'` (values `admitted` | `deleted` | `skipped`), `item_id
     BIGINT` (NO foreign key — house pattern, `entity_ids` carries none
     either; item ids are `GENERATED ALWAYS` so a dangling id is inert, and
     an FK's SET NULL would erase the link the stamp exists to keep),
     `content_hash TEXT`, `file_size BIGINT`, `modified_at BIGINT`. Existing
     rows backfill to `admitted`. Connector rows also backfill their
     `item_id` by exact join — `source_key` IS the entity identity by
     construction, entity → vehicle item via `entity_ids` — so old connector
     boards get real links for free. File rows stay `item_id NULL` (the
     stored filename is unrelated to the source key); stages 3–4 treat a
     null-link `admitted` row as legacy: neither provably on board nor
     deleted. Plus a partial expression index on items for the self-heal
     probe: `(board_id, (payload->'provenance'->>'key')) WHERE payload ?
     'provenance'`.
   - **`recordIngest` becomes an upsert.** `ON CONFLICT DO NOTHING` is now
     wrong twice over: a bring-back re-admission must flip `deleted` →
     `admitted`, and a linkless write (the sweep's dup path) must not wipe a
     good link — so DO UPDATE with `item_id = COALESCE(EXCLUDED.item_id,
     ingest_log.item_id)` (hash trio likewise) and `created_at` refreshed
     (it's "when last ledgered", which is what stage 4's time grouping
     wants). Signature grows an opts bag: reason, itemId, hash, size,
     modifiedAt. The sweep's skip path passes `skipped`; its dup path passes
     `admitted` + the item id when the thrown `.duplicate` carries one.
   - **Admit paths.** File admit hashes the tmp it already fetched (sha256,
     streaming — the decode it feeds is the expensive part) and stamps
     item-side provenance into the payload: `provenance: { key, hash, size,
     modified }`. FILES ONLY — a connector item's identity already IS its
     source key, and uploads never get one (`admitFile` takes provenance as
     an opt the upload route doesn't pass). The hash trio is written NOW,
     ahead of its stage-5 reader, because it cannot be backfilled later
     without re-reading every file in every source. Connector admit passes
     the vehicle item id it already has (`addConnectorEntity` returns the
     row); its constraint-violation `.duplicate` carries no item id — tag
     the throw with the existing vehicle's id where cheap, else the COALESCE
     upsert keeps whatever link the row already had.
   - **Deletion stamps: exactly three sites, all already in db.js** — the
     choke point comes free. (1) `deleteEntity`: the orphaned sole-home item
     ids are in hand in-tx — stamp them. Shared instances survive the entity
     and are correctly NOT stamped. (2) `deleteInstance`: one more CTE arm
     on its single statement. (3) `cancelBoardQueue`: the unfetched-shell
     DELETE returns ids — stamp them too. Cancelling a queued feed add IS
     "don't re-add": unledgered, the next tick would silently un-do the
     cancel; stamped, the cancel holds and stage 4 can bring them back.
     Board delete needs nothing (ingest_log cascades on board_id). Merge
     needs NOTHING — the close look killed the plan's "merge re-points
     item_id": extraction merges by rewriting `entity_ids` on the SAME item
     row (`setItemEntities`) and reaping emptied shell ENTITIES; the item id
     never changes, so the link survives untouched.
   - **File self-heal + `identityDedup: true`** (the one behavior change,
     observable only post-clear). `files.admit` probes the provenance index
     for a live item carrying the candidate's key BEFORE paying the fetch;
     a hit throws `.duplicate` (tagged with the item id) and the sweep
     re-ledgers it — the ledger rebuilds itself with links, the exact
     self-healing shape the connector gets from its unique constraint. Key
     match = present (same promise the ledger made; hash-based drift
     refinement is stage 5's). files.js flips `identityDedup: true` in the
     same commit; the modal's warning switches to "items still on the board
     stay put" BY ITSELF (descriptor-driven — the stage-1 simplification
     paying off), and the stage-1 sweep test that pins duplicate re-import
     flips to pin the heal instead. SHIPPED DEVIATION: the flag stays FALSE
     for now — items admitted before provenance existed are invisible to the
     probe, so flipping would false-promise "stay put" on legacy boards
     ahead of an irreversible act (the false-safe direction). The heal
     itself ships and is pinned by tests; flip the flag once
     pre-provenance file items are not a population worth protecting.
   - **Tests**: migration default + connector backfill; file admit writes
     provenance + ledger link + trio; connector admit link; skip → `skipped`;
     dup upsert keeps links; the three delete stamps (entity / instance /
     cancel-queued); merge leaves the link; upload path writes no provenance;
     post-clear file run heals instead of duplicating; file-board confirm
     copy now reads "stay put".
3. **Keep-top backfill + preview split — SHIPPED 2026-09-16 (uncommitted).**
   - **The slot rule, one predicate**: a key consumes a `total` slot iff its
     ledger reason is `admitted` (which includes legacy null-link rows — they
     can't prove absence). `deleted` AND `skipped` both backfill: "the board
     keeps itself at N eligible members", and a corrupt file is no more an
     eligible member than a rejected one — this extends the decided rule to
     skips, deliberately. Either way the key stays OUT of admission (held
     back); membership and admission are now two different subtractions,
     where `known` used to do both jobs with one Set.
   - **Sweep math** (worker.js `ingestDue`): with `total`, the membership
     pool becomes candidates minus non-`admitted` ledger keys (they neither
     hold slots nor can be re-admitted), then `fresh` = member minus ALL
     known, exactly as today. Without `total` the subtract-known-first hot
     path survives untouched (order is invisible without a cap — the mature
     continuous board keeps re-sorting ~0 rows). The fork lives in ONE new
     known-aware function in filter-engine.js (`runWindow(candidates, cfg,
     catalog, known)` → { member, fresh }) that the sweep and the preview
     both call — the membership() promise extended to the reason era. Budget,
     drain, prewarm, job detail: untouched (the `ignored` run count is
     stage 4's).
   - **`ingestedKeys` returns a Map** (key → reason) instead of a Set.
     `.has`/`.size` are shape-compatible, so every existing caller keeps
     working unchanged; the new math reads `.get`. `ingestedAmong` likewise,
     for the sample page.
   - **MIGRATION 0049 — legacy reconciliation, and it is load-bearing for
     the motivating board.** The user's 1,433 stocks were deleted BEFORE the
     stamps existed: their rows sit at `admitted` + null link (0048's
     backfill only linked rows whose entity still exists), so the preview
     split would report them ON BOARD — wrong in the worst direction, on the
     exact board this arc is for. For CONNECTOR boards absence IS proof:
     source_key is the entity identity by construction, so `reason='admitted'
     AND item_id IS NULL` after the 0048 backfill means the entity is gone —
     deleted or cancelled, both of which read correctly as "held back". One
     UPDATE flips them to `deleted`, scoped to boards whose
     `mapping->'input'->>'connector'` is set. File-board legacy rows stay as
     they are (absence is unprovable there) and keep consuming slots —
     documented cost, same population as the identityDedup deferral.
   - **Named consequence**: the first run after this ships, the stocks test
     board backfills to its Keep-top — the 1,433 freed slots fill with
     next-ranked stocks. That is the semantics chosen out loud ("deleting
     one thing makes rank 1501 appear — that's how it should work"), named
     here so it isn't a surprise.
   - **Preview response grows the split**, tallied over the filtered window
     (membership with `total` stripped — the same set the count used to
     read): `held` (deleted), `unprocessable` (skipped), `on_board`
     (admitted). `count`/`new`/`capped`/`scanned` keep their meanings, with
     `count` now reading the slot-aware membership when `total` is set.
     Sample rows upgrade `ingested: bool` → `ledger: reason | null` so the
     results badge can say Ingested / Held back / Can't process.
   - **Modal**: the count sentence becomes the split — "N new · X on board ·
     Y held back · Z can't process ›", zero buckets omitted; the held-back
     figure is the future link into stage 4's history. Results-table badge
     per `ledger`.
   - **Tests**: a deleted member's slot backfills next run (the headline);
     a skipped file's slot likewise; without `total`, a deleted key stays
     held back and nothing resurrects; preview split counts + sample
     `ledger`; 0049 flips exactly the connector null-link rows and leaves
     file rows alone; the existing keep-top tests pass unchanged (they never
     delete).
4. **History + bring-back + toggle — SHIPPED 2026-09-16 (uncommitted).
   RESHAPED — the history list already existed. ITS UI IS SUPERSEDED BY
   STAGE 6 BELOW: the mechanism and the routes stand, but the
   "Ingestion memory" section, the three verb buttons, the ledger-wide
   counts line and the Run-history link are all replaced.** `openJobsModal({ kind })` (public/
   jobs-modal.js, 712 lines) is the board's run history: it already renders
   ingest rows via `summaryFor` (`+N admitted · M scanned · skips with
   labels · duplicates · drain`), with keyset paging, kind pills, seen-marks,
   failure ack and the fold display — reading it is member-visible
   transparency (`GET /jobs` is `requireAuth`, not manager). Building a
   second run list inside the ingest modal would duplicate all of it, which
   the house rule forbids (reuse > generalize > create). So:
   - **History = a link, not a list.** One row in the ingest modal —
     "Run history ›" — opening the jobs modal filtered to `kind: "ingest"`.
     STACKED over the ingest modal, not replacing it: `mountModal`'s scroll
     lock is ref-counted precisely for "a modal opened from another modal",
     so the ingest modal's buffered unsaved edits survive the trip. A
     `#jobs/ingest` hash deep-link already exists (app.js) if a second entry
     point is ever wanted.
   - **`ignored` joins the run detail**, so a row reads "+0 admitted · 5000
     scanned · 1433 ignored". Computed in `runWindow` (it holds the window
     and the ledger map already): matches-the-filters AND reason `deleted`.
     Cheap by construction — a FILTER pass over the full candidate list is
     O(n) predicate evaluations; what stage 3's hot path protects is the
     SORT, which this never needs.
   - **`ignored` must NOT make a tick eventful, and must NOT enter the fold
     comparison.** It is a STANDING number, not an event of that run — a
     continuous watch would otherwise stamp a fresh "1433 ignored" row every
     30 s, the exact tag_snapshots volume lesson the retract-and-fold logic
     exists for. It rides the detail of rows that earned their place some
     other way.
   - **Bring-back lives in the ingest modal, not in a history row** — it
     acts on PRESENT state (settled with the user: per-run numbers are
     informational, an old run's ignored set is stale, so one action on now).
     Semantics: FORGET the `deleted` rows, then arm a run — never flip them
     to `admitted`, which would both claim they are on the board and keep
     them out of `fresh`. Consequence to state in the copy: with Keep top
     set, brought-back items COMPETE for slots again and may not return if
     they have since fallen out of the top N.
   - **One route, generalized rather than cloned.** Stage 1's
     `POST /ingest/clear` already means "forget ledger rows"; bring-back and
     retry-unprocessable are the same verb with a narrower scope. It grows
     `{ scope: "all" | "deleted" | "skipped", run: bool }` — defaults
     `"all"` / `false`, so every stage-1 caller and test is unchanged — and
     commits both halves server-side, because a bring-back that forgets rows
     without arming the run leaves the user staring at an unchanged board
     (the drawer arc's "one primary that cannot half-apply").
   - **The counts move onto one object.** `GET /ingest` serves
     `ledger: { total, on_board, held, unprocessable }` from a single GROUP
     BY, replacing stage 1's bare `ledger: N` (its modal test updates). The
     three buttons — Forget all / Bring back N / Retry N — each hide at
     zero. NOTE these are LEDGER-WIDE counts, deliberately unlike the
     preview split's filter-scoped tallies: the actions are ledger-wide too,
     and the copy must say "held back from future runs", not "matching".
   - **The toggle is forward-only, enforced at the stamp sites.**
     `ingest.rememberDeletions` (default true, `validateIngest` type-checks
     it like `enabled`, rendered with the `switchRow` the modal already
     imports). "Forward-only" is what makes "off, but leave the backlog out"
     expressible at all — the alternative (sweep ignores the stamp) is the
     retroactive reading, a mass-import wearing a preference's clothes. So
     the three stamp sites stop stamping instead, gated in SQL with no extra
     round-trip: `COALESCE((b.ingest->>'rememberDeletions')::boolean, true)`
     — NULL config, NULL key and no ingest at all all read as true.
     Flipping OFF prompts once about the present backlog ("N held back —
     bring them back / leave them"), which is the same bring-back call.
   - **Tests**: `ignored` in run detail + summaryFor; a flat tick with a
     nonzero ignored still retracts (the volume guard); fold ignores it;
     bring-back forgets only `deleted` rows, arms, and the next run
     re-admits; retry scope forgets only `skipped`; scope defaults keep
     stage 1 exact; remember-deletions off → a delete leaves the row
     `admitted`; on → still stamps; ledger object counts; modal renders the
     three buttons by count and the history link stacks.
5. **Content identity — SHIPPED 2026-09-16 (uncommitted). Reframed mid-arc; see the correction below.**
   **CORRECTION.** This stage was first written as "hash tiebreakers", with
   the path-reuse case deferred as a rare papercut. That call assumed the
   watched folder is a LIBRARY (files land and stay, so a path is a stable
   name). The user's actual model is a SPOOL: files are dropped, ingested,
   and removed — by hand now, automatically later. Under a spool a path is
   not a name, it is a SLOT, and slots get reused constantly. The deferred
   case is the normal workflow, and its worst form is one nobody had named:
   a reused path whose original item was never deleted (you cleared the
   folder, you did not reject anything) is silently skipped with NO trace at
   all — no error, no held-back badge, nothing in the run history. The
   deleted variant at least shows "Held back" in the preview.
   So: CONTENT is the identity for file boards; the path is just where a
   file happened to land.
   - **The recognition ladder**, in admit, cheap gates first:
     1. path + size + mtime all match the ledger row → the same file is
        still sitting there → skip, no read. The common case, and it costs
        exactly what today costs.
     2. otherwise fetch + hash (stage 2 already hashes here, before the
        transaction — no extra I/O over an admission we were making).
     3. hash matches a LIVE item's `payload.provenance.hash` → already on
        the board (a rename, or a re-drop): throw `.duplicate` with that
        item id; the sweep re-ledgers the new key against the SAME item.
        Fixes a standing bug — today renaming a watched file births a second
        item. Probing ITEMS not the ledger is deliberate: the item-side copy
        survives a Forget-all, so this doubles as the by-content half of the
        self-heal.
     4. hash matches a `deleted` ledger row → you deleted this content;
        hold it back and ledger the new key `deleted` with the same hash.
        INSERT, never move the old row — a copy and a rename are
        indistinguishable from here, and moving would un-hold the original.
     5. otherwise admit.
     Live beats deleted at 3 vs 4: you had two copies and deleted one, so
     the surviving item is the better answer.
   - **Step 1 is the un-deferred drift check, and it is now core.** A known
     key whose recorded size/mtime no longer match the listing is a
     DIFFERENT file in a reused slot, so it must reach admit. That means
     `ingestedKeys` returns Map(key → { reason, size, modified }) rather
     than key → reason, and the comparison is adapter-declared —
     `descriptor().driftFields` maps candidate value names to the ledger's
     columns (files: `{ size: "file_size", modified: "modified" }`;
     connector declares none and can never drift) — so the shared engine
     still learns no file-specific vocabulary. Drift applies whatever the
     reason: an `admitted`, `deleted` or `skipped` slot that now holds
     different bytes all deserve a fresh look.
   - **Every held-back / duplicate / skip path must re-record size+mtime**,
     or a file whose mtime merely moved (a `touch`, a metadata edit) drifts
     forever and is re-fetched every tick. The adapter attaches the facts to
     the thrown error (`err.ledger = { hash, size, modifiedAt }`) and the
     sweep's three ledger-and-forget arms pass them through; the sweep stays
     adapter-blind because it never reads the candidate's values itself.
   - **A held-back rename is EVENTFUL**, exactly like a skip and for the
     stated reason: it ledgers a key out of every future scan permanently,
     so the run row naming it is the only trace. `eventful` and the fold's
     `sameStory` both grow a `held` term — unlike `ignored` (stage 4), which
     is standing and must not.
   - **The toggle does not special-case this.** `rememberDeletions: false`
     is forward-only — it stops new stamps, it does not un-hold old rows —
     and the hash holdback reads those same rows, so it behaves identically
     to the key holdback. One rule; the flip-off prompt's bring-back is the
     escape hatch for both.
   - **Known wrinkle, accepted:** a drifted key is both a `total` slot
     holder (its old item is still on the board) and a fresh candidate, so a
     Keep-top board can finish a run at N+1 items. Keep-top is a feed
     concept and a spool board is unlikely to set one; the stale item is the
     user's to delete. Not worth special-casing.
   - **Legacy**: rows ledgered before stage 2 carry no hash, size or mtime —
     they can neither drift nor match by content, so they behave exactly as
     today (held back by path). No migration can fix it (the bytes are
     gone); Forget all is the reset.
   - **Follows from the spool model, NOT in this stage:** the ledger grows
     forever, one row per file ever dropped, and every scan loads it. Once
     content is the identity a pruning rule is easy to write (a row whose
     key has been absent from the listing for N scans is dead weight, and
     dropping it is safe because content recognition still catches a
     re-drop). Deliberately deferred — it wants its own decision about what
     "dead" means.
   - **Migration 0050**: two partial indexes — `ingest_log (board_id,
     content_hash) WHERE reason='deleted' AND content_hash IS NOT NULL`, and
     `items (board_id, (payload->'provenance'->>'hash')) WHERE payload ?
     'provenance'`.
   - **BUILD FINDING (not in the design above):** stage 2's key probe —
     "a live item was born from this key, so the ledger row was lost, heal
     it" — encodes the very assumption this stage overturns, and it fires
     BEFORE the fetch, so it swallowed both the spool case and the touched
     case before content could be consulted. It now short-circuits only when
     the item's RECORDED size and mtime still match the listing; any
     disagreement (or a missing pair) falls through to the bytes.
     `itemBySourceKey` therefore returns `{ id, size, modified }`, not an id.
     The cheap no-fetch heal survives for the case it was written for.
   - **Tests**: the spool case end-to-end (ingest, clear the folder, drop
     DIFFERENT bytes at the same path → imported, not skipped); the same
     path with identical bytes and a moved mtime → recognized, re-stamped,
     and NOT re-fetched next tick; a renamed live file → one item, two
     ledger keys, both stamped on delete; a renamed deleted file → held back
     and ledgered with its hash; live beats deleted; a held-back run is
     eventful while a pure-`ignored` tick still retracts; a legacy hashless
     row still holds back by path; connector boards never drift.


## Stage 6 — the IA correction (SHIPPED 2026-09-16, uncommitted)

Stage 4's surface was reviewed against the running app and rejected. Ten
rounds went into renaming that section — memory / history / seen / status /
runs / skipped — and every name failed. **That was the finding.** The naming
was impossible because the section was not one thing: it held three unrelated
human intents that had been blendered together, so every candidate word
covered two of them and lied about the third.

    a POLICY          "what's the rule on items I delete?"
    a SIMULATION      "if I run this now, what happens?"
    a MAINTENANCE     "why is this number odd, and how do I reset it?"
        HATCH

The fix is architectural, not lexical: give each intent the room where its job
is already done, and the fake section evaporates along with the need to name
it. (Credit where due — the blender diagnosis came from the user running the
problem past Gemini, after this thread had spent itself on synonyms.)

    POLICY      -> Filters. Whether a deleted item can return is an
                   exclusion rule, and Filters is where exclusion rules live.
                   It also supplies the context every floating label was
                   missing: "skip" — out of what? Out of what's eligible.
    SIMULATION  -> Preview, which now EXPLAINS ITS OWN NUMBER inline. Nobody
                   cares what was left out until the count looks too small,
                   and that is exactly when they are looking at it.
    HATCH       -> the far side of the run-state line, out of the task flow.
                   NOT the footer: that row is Save and Run now, the two
                   things the modal is for, and a footer `button` rule
                   outranks .im-link there — a quiet maintenance link came
                   out looking like a third primary. It pairs naturally with
                   the run line anyway: what happened, and how to undo what
                   the app remembers about it.

### The modal

```
Source
  This board feeds from its connector's universe — nothing to configure.

Filters
  [Type] [equals] [Stock]                                    x
  + filter
  No filters = everything in the source is eligible. All filters must match.
  (o) Skip items you've deleted from this board
      Off, deleting an item no longer keeps it out.

Sort & limit          (unchanged)
Trigger schedule      (unchanged)

Preview
  [Preview]  1,500 to ingest >
  1,497 already on the board.
  2,336 excluded because you deleted them.        Re-include >
  3 couldn't be read.                             Retry >

  Last run 18h ago - added 0           Clear ingestion records...
--------------------------------------------------------------
[Save] [Run now]
```

Every line under the count renders only when non-zero, so a first run shows
the count alone and nothing about exclusion ever crosses the reader's mind.

### Why each word (all of these were argued down from something worse)

- **"to ingest"**, not "N new" and not "N would be added". "New" only ever
  described the LEDGER'S ignorance: re-include a deleted item and it is
  eligible without being new. "Would be added" over-promises — `limit` paces
  a run across ticks, and some of the count turns out unreadable or already
  on the board under another name once the bytes are read. "To ingest" is
  eligibility, which is the one claim that survives all three.
- **"excluded" / "Re-include"** share a verb family with the Filters switch,
  so the rule and its undo read as one idea instead of three vocabularies.
- **"couldn't be read" / "Retry"** — plain, and audibly not a rejection.
- **"Clear ingestion records"** — current bookkeeping, not an archive
  ("history" implied archive and collided with the Jobs modal's run log);
  concrete, not implementation ("memory", "ledger"); and "clear" is a verb
  people already apply to lists.
- **No heading** for the old block, because four unrelated things are not a
  category. Nothing in this layout needs a name that did not already exist.

### Build notes

Everything in stages 1-5 stands — this is IA, copy, and ONE behavioural fix.
The list below already folds in the stage-6 review (2026-09-16), which caught
one false claim in the first draft and two things it had not decided.

1. **The switch is FORWARD-ONLY and the first draft's sublabel denied it.**
   `rememberDeletions` gates the STAMP (db.js `REMEMBERS_DELETIONS`, the three
   deletion sites), not the sweep — so flipping it off stops future deletions
   from sticking and does nothing whatever to rows already stamped `deleted`.
   "Off, a later run can add them back" was simply untrue of the backlog.
   Stage 4 covered that gap with a `confirm()` offering to clear it.

   That confirm now DIES, because the new IA answers it structurally: the
   backlog has a visible home three lines below. Two controls, two jobs — the
   switch is policy from here on, Re-include is the backlog. Replacing a
   blended question with two separated controls is the whole point of the
   stage; keeping the confirm would have been the same mistake one layer down.

2. **Scoped Re-include — and it must NOT arm a run.** The exception lines sit
   inside Preview, so their numbers are filter-scoped; the action must be too,
   or the board shows 2,336 and acts on 2,385. But stage 4's bring-back armed
   a run, and that cannot survive scoping: the scope comes from the BUFFERED
   config while the run executes the SAVED one, so an edited filter makes the
   run admit a different set than the number just acted on — the two-numbers
   trap again, wearing a schedule. So: forget the rows, then RE-FIRE THE
   PREVIEW. The exception line empties and the count jumps by 2,336 in front
   of the user, which is better feedback than a silent background run, and
   Run now is inches away. `run` thereby loses its last caller (the confirm
   in note 1 was the other) and comes out of the route, db.js and its test.

   Cost: the clear route now needs the same enumeration the preview does. It
   is usually free — connector windows cache for INGEST_FEED_CACHE_MS (60s
   default, extended by fill cost) — but NOT always: files.js caches remote
   listings only, so a local folder re-walks, and a cold connector cache is a
   real catalog walk. Usually free, occasionally a re-walk; not never.

3. **One `previewWindow(db, board, cfg)` helper**, called by both routes.
   Adapter resolve, validateIngest (`trigger: false`), validateSource,
   enumerate at the window cap, runWindow. Copying those twenty-five lines
   into the clear route would set up preview/action disagreement, which is
   the exact bug class this arc has hit at every stage.

4. **Keep `on_board`** — the first draft dropped it. A settled board is the
   state a board spends its life in, and there "0 to ingest" with nothing
   explaining it reads as broken; the mockup only looked fine because it
   showed a first run. It renders as a plain actionless line. It is not the
   positive shadow the user rejected: that was "skipped", and this is the
   board.

5. **Truncation marks the exception counts too.** `capped` currently means
   "the MEMBERSHIP is a lower bound" (`truncated && set.length < total`),
   which is the wrong predicate for a tally; ship `truncated` and suffix the
   exception counts with it. This also makes scoped Re-include consistent
   rather than merely correct — the number shown is exactly the number acted
   on, truncation included.

6. **Client**: delete the memory section; move the switch into Filters below
   the hint (a standing rule, not an editable filter row, and inert for
   non-editors like every other control); relabel the count; add the
   on-board line and the two exception lines under it; put the reset on the
   run-state line, pushed right; drop the Jobs-modal link and its import.
   One shared `.im-line` — a fact with the verb answering it on the far side
   — serves both the exception rows and that last row. `invalidatePreview()` must
   hide the whole block, not just the count — a stale "2,336 excluded" after
   a filter edit is precisely the lie it exists to prevent.

7. **`.im-preview-count` -> `.im-link`** — four callers now (count,
   Re-include, Retry, the footer hatch), so it is genuinely a shared
   text-action style and the old name described only its first caller. It is
   borderless 13px/600, so the footer instance needs alignment against Save
   and `.ghost`; it will not just drop in.

### Carried forward, knowingly

- The exception counts now cost a Preview click, where stage 4 had them free
  at modal open. Right trade: that click is the moment anyone cares.
- **The footer quotes a different number than the lines above it.** Inline is
  filter-scoped; the hatch's confirm quotes the ledger-wide total, because
  that is what it acts on. "2,336 excluded" above a confirm saying "2,385
  records" is noticeable. It stands — the hatch is explicitly the whole-ledger
  nuke, below a rule, in its own vocabulary ("records", not "excluded") — but
  it is a real seam and is written down here rather than left to be
  rediscovered as a bug.
- A deleted file reappearing under a NEW name is held by the hash probe and
  ledgered `deleted` under the new key (worker.js), so it joins the excluded
  count from the SECOND preview on, not the first. Not worth fixing.
- The stored config key stays `ingest.rememberDeletions` while every visible
  word is now "skip". Renaming is cosmetic and would silently flip any board
  that had saved it off.
- The reset hides when the board has no records at all.
- **The count on the door is smaller than what opens behind it.** The button
  says "1,500 to ingest" and the results view pages the whole matching window
  — every row badged with what happened to it. That is deliberate: the rows
  the count leaves out are exactly the ones worth inspecting when it looks too
  small, and paging only the fresh set would make "why is this excluded?"
  unanswerable. The button's title says so, and the badges now speak the same
  words as the lines above them ("Excluded" / "Couldn't be read" / "On the
  board"), so the list reads as the per-row form of the tally rather than a
  second vocabulary. Stage 4's label had the same property and never named it.
- The scoped forget ships a key array sized by the matching window — bounded
  by SAFETY_CAP (100k) in the worst case, realistically thousands. `ANY(...)`
  handles that; no chunking machinery until something measures a problem.

### Build order

1. `previewWindow` extraction, scoped clear, `run` removed — server + tests.
2. Switch into Filters with the corrected sublabel; memory section and its
   `confirm()` deleted.
3. Preview block: relabel, on-board line, two exception lines, footer hatch.
4. `.im-link` rename + CSS.
5. Rewrite the two modal tests (they break wholesale: the switch moves, the
   verbs vanish, and the exception lines need a `/preview` stub the modal
   test's fetch mock does not yet have).

### Build findings

- **The modal test file could hang forever, and had been able to all along.**
  An open modal runs a 1s `setInterval` (the header chip's tick) that clears
  only when the overlay disconnects — so a test that leaves a modal open holds
  the event loop open and the FILE NEVER EXITS. Every test happened to close,
  by hand or by Save, so it stayed invisible until a stage-6 assertion failed
  mid-test; three runs were then eaten by a file whose tests had all reported
  in 3.7s. `openBuilt(t)` now registers a `t.after` close, which runs on
  failure too, so cleanup is structural rather than discipline. Worth knowing
  for any future jsdom surface with a timer: the symptom is a green-looking
  `duration_ms` an order of magnitude larger than the tests' own times.
- The scoped-forget tests need REAL fixture keys, because the scoped path
  enumerates. The two reaches are only distinguishable with a deleted key the
  filters exclude AND a deleted key that has left the source — the fixture
  carries both (`c.md`, `gone.txt`).
- `truncated` is a new key in the preview response, and one connector test
  asserted the response shape with `deepEqual`. That is the assertion doing
  its job; it was updated, not loosened.
- **A second latent test race, in the sweep file.** `runOnce` waits for the
  run-state stamp; the job-log row is written separately, and the disarm it
  also waits for on a MANUAL board is what had been keeping those reads off a
  half-written row. A SCHEDULED board re-arms instead — no second signal — so
  the flat-tick test could snapshot the log a row short, watch that row land
  during the next run, and blame the next run for writing it. Failed only
  under full-suite load, passed in isolation every time. Fixed two ways: a
  `jobRowsAtLeast(id, n)` wait, and by proving the retraction from the ROW
  COUNT after the following eventful run rather than asserting it the instant
  the flat run stamps — that assertion would have passed just as happily
  against a row still in flight, which is how it sat there unnoticed.

Suite: 1553 non-browser tests green, lint clean. No browser test touches
ingestion.
