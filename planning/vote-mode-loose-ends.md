# Loose ends: vote mode (`tagging-accuracy-plan.md` §1–§2, uncommitted on 74c26c5)

Findings from the post-implementation deep dive, 2026-08-06. Work item 3 (facet
diagnosis, `facet-diagnosis-plan.md`) is out of scope here — it isn't built yet.
Ordered by severity; check off as fixed.

Baseline: the full suite passes (677 tests, two clean runs). §1 (temperature) and
§2.1–§2.8 are built as specified. What follows is what the sweep turned up
around them.

## Defects

- [x] **1. `fit.reasoning` lost its normalisation, on every board** —
  *(fixed: `parseRun` now normalises `fit` on the same terms as `description`
  beside it — one `rawFit` shape-reconcile, then `typeof === "string" &&
  .trim()` before the key is set at all. Both merge paths inherit it, since
  `mergeVotes`' `best.fit?.reasoning` reads a parseRun output and its
  single-run identity path returns one; `tagOne:1451` re-checks nothing, as
  the plan intended. Regression test in `votes.test.js` covers all three
  inputs. Re-probed: whitespace → dropped, `"  spaced  "` → `"spaced"`,
  non-string → dropped — old behaviour restored exactly)*

  The plan made `parseRun` "the one place the reasoning-off shape is
  normalised," and every field moved there except this one; the comment above
  `parseRun` asserted the invariant while one field broke it. `parseRun`
  returned `fit` verbatim and the old call-site guard became a bare truthiness
  test. Probed against the live module before the fix:

  ```
  whitespace-only  -> stored: {"fit":"   "}          (was: dropped)
  untrimmed        -> stored: {"fit":"  spaced  "}   (was: trimmed)
  non-string       -> stored: {"fit":{"oops":1}}     (was: dropped)
  ```

  Not confined to voting boards — `mergeVotes`' single-run identity path passes
  `fit` straight through, so every single-pass board was affected too.

  **Reachable because the schema requires the field.** `properties.fit.required`
  is `["reasoning", "verdict"]` (`worker.js:283`), so a model with nothing to
  say pads rather than omits. Untrimmed and whitespace reach every provider;
  a non-string needs `strictTools: false` (glm, openrouter) or Anthropic's
  advisory tool schema.

  **Severity, corrected on a second look.** Only two readers exist. `embedTextFor`
  re-guards with its own `typeof v === "string" && v.trim()`, so embeddings were
  never at risk. `lightbox.js:546` (`why.fit || "The AI couldn't apply…"`) is
  the only exposed path, and it renders only inside `if (subject.undecided)` —
  so the visible fault needed an item that was *both* undecided and padded with
  whitespace, which is the case where a model is least likely to pad. `""` is
  falsy and was dropped regardless. Real rating: stored-data hygiene with a
  narrow render path, not a broad break. Worth fixing because the guard existed
  and the invariant was stated in the code, not because it was burning.

- [x] **2a. A dropped selection keeps the reasoning of a value that isn't there**
  — *(fixed: the `|| runs[0]` fallback is gone — `runs.find(...)` with `src?.`,
  so a selection no run made carries no sentence at all. Companion change in
  `lightbox.js:566`: a facet renders when the passes split even with no values
  and no text, so the case that now loses its sentence gains a row instead of
  vanishing. Regression test in `votes.test.js` covers partial-majority,
  no-majority, and the single-value path that must keep behaving as before)*

  `worker.js:383` read `runs.find(...) || runs[0]`, against the plan's "take it
  from the earliest run that actually made that selection, not from run 0
  blindly." The fallback fires whenever **no run made exactly the merged
  selection** — which is a multi-value-facet condition only. Probed:

  ```
  A. multi-value, NO majority (3 disjoint answers)      <- rare tail
     construction [0/3]  —
       "a single even stroke throughout"

  B. multi-value, PARTIAL majority                      <- the common case
     construction [0/3]  monoline
       "even stroke, and the fill blends"

  C. single-value, 3-way split                          <- never affected
     shape [1/3]  round      (run 1 picked exactly ["round"], so src exists)
  ```

  **B, not A, is the everyday case** — `chosen` is empty only when nothing
  reaches `floor(n/2)+1`, i.e. three fully disjoint answers, which at
  `construction`'s measured 0.85 mean agreement is the tail. The ordinary shape
  is: runs agree on a core value, each adds a different extra, the extras drop,
  and the surviving sentence still argues for one of them.

  **Exposure lands where it hurts.** 4 of 9 facets on the logos board are
  multi-value (`construction`, `typography`, `motif`, `industry`) and the two
  least-stable measured facets — `construction` 60% unanimous, `industry` 64% —
  are both multi. The fallback fired hardest on exactly the facets vote mode
  exists to expose.

- [x] **2b. The agreement badge misdescribed its own number** — *(fixed:
  `lightbox.js:588` now says "N of M passes selected exactly this set", and the
  no-majority case gets its own line, "no value reached a majority across M
  passes", with the tally reading "proposed:" rather than "also proposed:" when
  nothing was kept. The number is unchanged — it is the plan's metric)*

  Found while tracing 2a, on the same line of output:

  ```
  kept:   ["monoline"]
  tally:  {"gradient":1, "monoline":3, "fusion":1, "3d":1}
  badge:  [0/3]  "0 of 3 tagging passes chose this — also proposed: …"
  ```

  `monoline` was chosen by 3 of 3 passes. `agreed` is deliberately an
  exact-set-match so it "reads the same whether the facet is single- or
  multi-value" (§2.2) — the number was right, the copy described a per-value
  measure. The two coincide on single-value facets, which is why it read fine
  there and false here.

## Plan items not built

- [ ] **3. §2.9 item 2 — the board-level confidence roll-up — is missing** — no
  aggregate query, no endpoint, no UI anywhere in the tree. What shipped is the
  per-item lightbox badge only. The plan calls the roll-up "the readout that
  tells a user *which of their own facets is unreliable*, on any board, without
  anyone running an experiment," and §2.9 opens with "The reason to build this."
  Today that question still needs hand-written SQL — which is the thing §2.9
  existed to remove. `facet-diagnosis-plan.md` carries a `{items, unanimous}`
  tally, but gated behind ≥20 items, only unstable facets, and an AI call, so it
  is not a substitute for the plain readout.

- [x] **4. Bulk retag still shows the unmultiplied count** — *(fixed: the retag
  confirm and button title now carry the pass count and an "up to ~N paid
  tagging calls" estimate; the `tag held` title carries the same figure for its
  own count. Single-pass boards render byte-identical copy to before)*

  `admin-boards.js:106` confirmed with `Re-tag all ${b.item_count} item(s)`,
  against blast radius' "at three votes on a 4.5k-item board that is ~13,700
  paid calls from one click". `/api/admin/boards` spreads the whole row
  (`...b`), so `b.ai_votes` was already on the client.

  **"Up to" is load-bearing in both directions**, which is why the estimate
  isn't stated flat:

  - `item_count` is `COUNT(*)` over **every** status (`db.js:913`), while
    `retagBoard` only re-queues `status IN ('tagged','failed','held')`
    (`db.js:1023`). The confirm has always over-promised — note that the toast
    afterwards reports the route's real `queued`, so the two numbers already
    disagree on any board with work in flight. Pre-existing and cosmetic on its
    own; multiplying it by 5 is what made it worth naming.
  - A vote round that loses passes merges fewer, so the achieved call count can
    also come in under `items × votes`.

  An exact figure isn't derivable client-side — `boardItemStats` returns total,
  pending and held, not the tagged/failed split — and adding a server count for
  a confirm dialog isn't worth a round trip.

  **`tag held` is the same trap and has no confirm at all** (`admin-boards.js:126`),
  firing `held_count × votes` paid calls on one click. Adding a confirm where
  there wasn't one is a friction change beyond this plan's ask, so the pass
  count and estimate ride the button title instead. Flagged rather than
  silently widened — worth a decision of its own.

  (Checked while here: `pg.types.setTypeParser(20, Number)` at `db.js:11` means
  `COUNT(*)` arrives as a Number, so the arithmetic and `toLocaleString()` are
  safe — `boardItemStats` does not cast, unlike `boardEntityCounts`.)

- [ ] **5. The `AI_INFLIGHT` decision was never made or written down** — the
  plan: "Either divide the effective lane count by the vote count when claiming,
  or document that a high-vote board wants `AI_INFLIGHT` lowered. Worth a
  decision, not a surprise in production." Neither happened: no votes-awareness
  at `worker.js:2111`, and no mention in `docker-compose.yml` or any doc. 8
  lanes × 5 votes = 40 concurrent against OpenAI's `burst: 25`
  (`openai.js:13`). `provider-pacing.js` waits rather than fails, so this is
  latency, not breakage — but it is still an open decision, which is what the
  plan asked for.

- [ ] **6. `GET /api/boards/:id` doesn't expose `ai_votes`** — §2.6 named both
  board response shapes (`server.js:813` and `:916`); only `/settings` got it.
  `server.js:813` is still `ai_reasoning`-only. No consumer today, but #3 would
  want it.

- [ ] **7. Modal copy is silent on scheduled retagging** — blast radius: "Same
  for `retag_on_refresh` and scheduled retags, which the board modal copy must
  state." The copy stops at "roughly 3× the tagging cost." The two settings sit
  in the same modal and multiply each other; a user turning both on is the case
  the plan wanted named.

## Design intent vs. implementation

- [ ] **8. The research-pair carve-out is dead against its own UI** —
  `server.js:1149` deliberately validates the pair only when the request
  *touches* votes or research, so a board already holding both stays editable;
  `votes.test.js` proves it by PATCHing `{name}` alone. But the modal's save
  payload always includes both keys (`board-modal.js:578-579`), so for such a
  board **every** modal save 400s, a pure rename included. `syncAi` compounds
  it: with both on, both switches disable, so the user cannot clear either side
  to escape. Only reachable by editing the column directly or restoring an
  archive — but as written the carve-out buys nothing the UI can use. Either
  send only changed keys, or let the modal clear one side.

- [ ] **9. A degraded vote round is invisible** — if 2 of 3 runs fail,
  `runs.length` is 1, so `mergeVotes` takes the identity path
  (`confidence: {}`) and `votes` is omitted from the job log
  (`worker.js:1794`, gated on `votes > 1`). The item is then indistinguishable
  from one tagged on a single-pass board. A board quietly degrading to one pass
  — the exact failure the `allSettled` design tolerates — leaves no trace
  outside a `console.warn`. Recording the *configured* count alongside the
  achieved one in `legLog` detail would cost nothing.

## Smaller

- [ ] **10. Tags are now stored sorted within each facet** — `parseRun` sorts
  (`worker.js:314`); the old loop preserved model order. Verified: a model
  returning `[r, p, q]` now stores `["p","q","r"]`. Applies to every board,
  voting or not. Benign by inspection: `addTagSnapshot` compares via
  `sameTagSet`, which sorts both sides, so the first retag after this ships
  writes no history rows. Visible effect is chip order in the lightbox and the
  order of `items.tags`. Recorded because it is an undocumented change to
  stored data.

- [ ] **11. Migration 0029's comment describes the old shape** — `0029:14` says
  `tag_confidence` is "the fraction of runs that agreed"; the code stores
  `{of, agreed, votes}` (`worker.js:331`). The plan carries the same stale
  wording in §2.2 and §2.9 ("< 1", "mean confidence"). The object is the better
  call — it is what work item 3 reads — but three places still describe the
  fraction.

- [ ] **12. Each failed vote run records a plugin health error** —
  `trackedTagger` wraps every call in `withPluginHealth`, so a partial vote
  round reddens the Plugins dot on a board that tagged fine. Defensible (a real
  provider call did fail) and arguably the point of the ledger; noted because it
  is a new way for a healthy board to look unhealthy.

## Verified sound (no action)

- **The merge threshold.** `Math.floor(n/2)+1` (`worker.js:351`) is a strict
  majority at even run counts, where the plan's `ceil(n/2)` would have let a
  value supported by exactly half survive. The implementation is stricter than
  the plan and right to be; `votes.test.js` pins it at N=2 and N=4.
- **The confidence shape.** Storing `{of, agreed, votes}` rather than a bare
  fraction is a deliberate improvement over §2.2 — the losing tally is what
  work item 3 needs, and it cannot be recovered later.
- **The research guard's placement.** `getBoardPrompt` (`worker.js:559`) clamps
  and forces a single pass under research, so a hand-edited column can't fan
  out. The route check is the courtesy; this is the fence. Covered by test.
- **`bumpUsage` fires once per paid call**, `markTagged` / `addTagSnapshot` /
  `evaluateItemAlerts` / `legLog` / the embedding clear each fire once per item.
  The pipeline-event invariant holds; the integration test asserts it end to
  end.
- **Only run 1 failing fails the item** — runs 2..N are `allSettled`, so a late
  timeout costs precision, not the item's attempts.
- **Backup/restore.** Both new columns are `NOT NULL DEFAULT`, `loadTable`
  INSERTs only the archive's named columns, so pre-0029 archives restore
  cleanly. The plan's load-bearing claim holds.
- **`setItemTags` drops confidence** alongside reasoning for facets the user
  changed, over the union of both key sets. (The *reset* paths don't — see #13.)
- **Board prompt cache invalidation** fires on both PATCH routes
  (`server.js:952`, `:1537`), so a votes change takes effect on the next item.
- **The lightbox distinguishes `{}` from zero agreement** — the badge requires
  `c.of > 1 && c.agreed < c.of` (`lightbox.js:573`), so a single-pass board
  renders exactly as it does today and never claims "1 of 1".
- **`temperature: 0` is quirk data, not a global** — the `noTemperature`
  o-series guard is anchored and tested (including that `gpt-4o` still gets it);
  GLM and OpenRouter correctly send nothing, for the two different documented
  reasons.

## Found on the second pass (while tracing #1's readers)

- [x] **13. The retag reset paths clear reasoning but keep confidence** —
  *(fixed alongside stage 1 of facet-addressable tagging, which rewrites the
  same two statements: `retagItem` and `reprocessEntity` now reset
  `tag_confidence='{}'::jsonb` beside `tag_reasoning`. Not split into its own
  commit because the change is on the same lines — separating it would have
  meant editing them twice. `cancelBoardQueue` needed nothing: its `cleared`
  branch only ever sees rows those two already reset)*

  `setItemTags` was correctly taught to drop confidence alongside reasoning
  (blast radius, "Manual tag edits must drop stale confidence"), but the two
  statements that reset an item back to the tag leg were not:

  - `retagItem` (`db.js:453`) — the lightbox's per-instance Retag
  - `reprocessEntity` (`db.js:2007`) — the card-level full reprocess

  Both write `tags='[]'::jsonb, tag_reasoning='{}'::jsonb` with no
  `tag_confidence='{}'`. A successful retag overwrites it wholesale via
  `markTagged`, so the window is usually short — but it does not need a failure
  to close on a stale state. `cancelBoardQueue`'s `cleared` branch
  (`db.js:2306`) commits one: it lands any still-`pending` item at
  `status='tagged', undecided=TRUE` **without touching tags, reasoning or
  confidence**. So `lightbox → Retag` on an instance, then `admin → retag
  cancel` on the board, is a two-click path to an item permanently holding no
  tags, no reasoning, and a full set of agreement figures describing an answer
  that no longer exists.

  It doesn't render today — the lightbox skips a facet with neither values nor
  text — so this is latent rather than visible. But it's the same principle the
  plan already applied to `setItemTags`: confidence must not outlive the answer
  it describes. Two words of SQL each.

  Checked and *not* affected: `retagBoard` (`db.js:1010`) resets only
  status/attempts and leaves tags, reasoning and confidence in place together —
  self-consistent, and they're replaced as a set when the retag lands.
  `markTagged`'s facet-less path passes the `{}` default.

## Not vote mode (identified, recorded so the next sweep doesn't chase it)

- **`backup.test.js:448` is flaky on Windows, and it isn't ours.** "a corrupt db
  member refuses the restore before anything is wiped" failed once in four
  full-suite runs with:

  ```
  EPERM: operation not permitted, rename
    '…\backups\001az-…-db.tar.partial' -> '…\backups\001az-…-db.tar'
  ```

  A `rename()` losing to a transient handle on the source file — the ordinary
  Windows antivirus/indexer race, not a logic fault, and nothing in the vote
  path touches `backups/`. Worth a retry-on-EPERM in the writer if it recurs;
  no action for this plan.

- **`ingest-sweep.test.js:141` is flaky under full-suite load.** "continuous
  trigger reschedules itself on the continuous cadence" failed once with
  `rearmed in the future`, and passed in isolation immediately after (26/26 with
  backup.test.js). A wall-clock assertion losing to scheduler jitter when ~700
  tests are competing for the box. Both flakes appeared in the same run and
  neither reproduced; if either becomes frequent, they want fake timers rather
  than wider tolerances.
