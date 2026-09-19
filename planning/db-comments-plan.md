# The comments in db.js outweigh the code (2026-09-20)

**Status: STAGES 1-6 DONE (2026-09-20). Suite 1808 green throughout,
comments-only diffs, LF clean.**

| stage | section | comment lines | cut | big blocks |
|---|---|---|---|---|
| — | mechanical pass (7 fixes, cut nothing) | — | -733 bytes | — |
| 1 | embeddings + failure routing | 165 → 115 | -30% | 8 → 6 |
| 2 | usage meter + rate map | 244 → 204 | -16% | 6 → 5 |
| 3 | facet confidence roll-up | 232 → 187 | -19% | 11 → 6 |
| 4 | boards | 184 → 150 | -18% | 11 → 6 |
| 5 | run fence + automatic ingestion | 150 → 123 | -18% | 8 → 4 |
| 6 | job log | 178 → 158 | -11% | 7 → 6 |

**File vs `ddd41e0`: 4,952 → 4,734 lines, 1,900 → 1,681 comment lines, -15,386
bytes, density 41.2% → 38.2%. Stages 7-10 open.**

### Measurement correction (2026-09-20)

Stages 1-3 were first reported at -48%, -56% and -50%. **Those numbers were
wrong** — they measured only the lines sitting inside blocks of 8+ comment
lines, which is a biased denominator: a 20-line block cut to 7 lines leaves that
census entirely and reads as "20 → 0" although 7 lines are still in the file.
The table above uses **all comment lines in the section**, which is the honest
measure. The file-level totals were never affected.

Both numbers are worth tracking and they answer different questions — "big
blocks" counts walls of text a reader has to wade through, and it really has
roughly halved; "comment lines" counts volume. Report them separately and never
let the first stand in for the second.



**Recalibration:** on the honest measure the rate is **~18% per section**, and
the spread is the interesting part: 30, 16, 19, 18, 18, 11. Stage 1's 30% was
the most pure narration in the file; stage 6's 11% is the most contract, and a
section that gives up a ninth of its comments because the rest are traps is a
correct outcome, not a failed one. **The rate a section yields is a measurement
of that section**, not of how hard the pass tried. The rubric keeps far more than the first read of this file
suggested, because most long blocks here turn out to be a trap or a contract
rather than a defence of a choice. That is the finding, not a failure to cut
hard enough.

**The orphaning pattern is the most common defect in this file, not the bloat.**
Five instances found so far, one of them stale and one a duplicate:
`BOARD_COL_LIST`, `usageRows`/`USAGE_DIMS`, `claimFairBatch`, `failOrRequeue`
(parked on `RETRY_BACKOFF_MS`), and `meter()` (whose doc sat on `APP_SCOPE`
while `meter()` itself had none). Stage 2 also found the first genuinely STALE
comment in the file — a paragraph describing the token-bucket pivot that
`boardUsageSummary` no longer does, contradicted by an inline comment 30 lines
below it — and a paragraph duplicating `costOf`'s own doc. **Check every block
for which symbol it actually describes before judging its length.**

## The rubric

One question per block, and it is checkable rather than a matter of taste:

> **Delete this comment, then make the most plausible wrong edit it was warning
> against. Does the suite catch it?**

- **Suite catches it** → the comment is decoration. The test is the guard; the
  prose is a second, weaker copy of it. **Cut to a line or delete.**
- **Suite does not catch it** → load-bearing. **KEEP, verbatim.** These are the
  ones worth the reader's attention, and they only get that attention once the
  essays around them are gone.

Three destinations, and every block goes to exactly one:

**KEEP** — an invariant a future edit breaks silently. The bigint type parsers at
the top are the type specimen: delete them and `expires_at < Date.now()` breaks
everywhere with a green suite. Also the `IN_FLIGHT_FOR` derivation guards, the
`notPaused` roster, the `facetExamples` freshness-key note. Expect ~15–20% of
blocks. Do not touch the wording.

**CUT TO A LINE** — design rationale. One line saying what holds, plus a pointer
to the plan doc that already tells the story at length. This file already cites
`planning/*.md` 23 times; the machinery exists and is under-used. The test: if
the reasoning is already written down in `planning/`, the code does not get a
second copy of it.

**DELETE** — tombstones, restatements of the code below, postmortem narration,
and duplicates of prose living elsewhere. Precedent from the mechanical pass: the
15-line `facetEvidenceIds` tombstone in db.js was a *worse second telling* of a
story already told properly at [facet-diagnosis.js:475-497](../server/facet-diagnosis.js#L475-L497),
stranded 3,500 lines from the code it described.

### Register rules for anything rewritten

- Say what holds, not what was tried. No `was`, `used to`, `for four days`.
- No incident dates and no postmortem narration — those belong in the commit
  message, which is where they already are and where they read well.
- Drop `rather than Y` unless Y is something a reader would plausibly reach for
  *next week*. Defending against an alternative nobody is considering is noise.
- At most one shouted word per block, and only where the sentence genuinely
  turns on it.
- Cap a block at ~8 lines. Past that, the content belongs in `planning/`.

## Staging

Ordered to calibrate on low-risk sections first and reach the most load-bearing
one last, when the rubric has been exercised. **One stage per sitting, each its
own commit**, so a bad call is one `git revert` rather than an archaeology
project.

| # | Section | Blocks | Lines | Notes |
|---|---|---|---|---|
| 1 | semantic search embeddings | 8 | 129 | Calibration. Self-contained, low coupling, no job-control entanglement. |
| 2 | the rate map + usage meter | 5 | 91 | Mostly rationale; `metering-plan.md` already holds the story. |
| 3 | the facet confidence roll-up | 11 | 146 | Largest. `facet-diagnosis-plan.md` exists. |
| 4 | boards | 11 | 130 | Watch `BOARD_COL_LIST` / `NOT_DUPLICATED` — real invariants live here. |
| 5 | the run fence + automatic ingestion | 8 | 115 | `job-control-plan.md` Stage 5 holds the narrative. |
| 6 | job log | 7 | 97 | `job-log-plan.md` exists. |
| 7 | AI tagging queue helpers + entities + connector liveness | 6 | 84 | `claimFairBatch`'s 38-liner. |
| 8 | long tail: MCP tokens, crates, alerts, AI keys, users, membership | 11 | 128 | Mostly small, mostly cuttable. |
| 9 | **top-of-file** (parsers, status maps, derivations) | 8 | 106 | **Last.** Highest KEEP density in the file. |
| 10 | `cancelBoardQueue` | 1 | 50 | Alone — see below. |

### Why stage 10 is last, and why it touches code

`cancelBoardQueue` holds the single biggest block in the file (50 lines) and is
the heart of job control — and it is physically parked at the tail of the
**pricing** section, between `boardUsageSummary` and the alerts header, with no
job-control code near it.

Part of why that comment runs to 50 lines is that it has to rebuild its entire
context from nothing, because none of its siblings are in sight. **Move the
function to sit with the other job-control verbs first, then re-read the
comment.** A good fraction of it stops being necessary once the reader arrives
with context. This is the one stage that touches code, and it is a pure move —
no behaviour change.

## Guardrails

Every stage, before commit:

**1. The diff must be comments-only** (stage 10 excepted: a pure function move).
Run this and it must print nothing:

    git diff -U0 server/db.js | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' \
      | grep -vE '^[+-][[:space:]]*//' | grep -vE '^[+-][[:space:]]*$'

**2. LF line endings, no stray CR.** Must print `0`:

    python -c "print(open('server/db.js','rb').read().count(b'\r'))"

**3. Green:** `npx eslint server/db.js && npm test`

**On the line endings:** this repo is LF throughout, including `HEAD`. Git is
configured `core.autocrlf=true`, so it prints `LF will be replaced by CRLF the
next time Git touches it` on every diff — that warning describes the *config*,
not the file, and acting on it converts the whole file and adds ~5KB. Worse,
**Git Bash `grep` text-translates**, so a `\r$` match reports CRLF on files that
have none. Check line endings at byte level or not at all. This was learned the
expensive way during the mechanical pass.

Report per stage: blocks touched, lines removed, byte delta, suite count.

## The target

Revised on measurement. The original "55-60% off 1,076 lines in large blocks"
was written against the biased metric and is not reachable on the honest one.

At ~18-20% per section over the remaining stages, the file lands near **1,570
comment lines and a density around 36%** — down from 1,900 and 41.2%. Roughly
330 comment lines gone in total, not 600.

The number was never the point, and the measurement error is a good reminder of
why: the rubric decides each block, and a section that gives up 18% because it
is mostly contract is a correct outcome. The measure that actually matters is
unchanged — **after this, a reader who sees a 20-line comment in db.js should
believe it earned the space.** On that one the "big blocks" count is the better
signal, and it has gone from 36 blocks to 23 across the four sections done.

## Appendix: the work queue

Every block of 8+ lines, by stage. `LINE` is the first comment line as of
commit `ddd41e0` + the mechanical pass; re-derive with the inventory script
(below) before starting a stage, since earlier stages shift them.

### Stage 1 — semantic search embeddings  
*8 blocks, 129 comment lines*

| line | lines | anchor |
|---|---|---|
| 3852 | 23 | `oneAudioNeedingTranscription` |
| 3901 | 20 | `boardEmbeddings` |
| 3948 | 18 | `entityIdsFor` |
| 4014 | 17 | `RETRY_BACKOFF_MS` |
| 4078 | 16 | `recoverStuck` |
| 3968 | 13 | `bestByEntity` |
| 4050 | 12 | `(inline)` |
| 3807 | 10 | `boardLaneQueues` |

### Stage 2 — rate map + usage meter  
*5 blocks, 91 comment lines*

| line | lines | anchor |
|---|---|---|
| 4394 | 27 | `unpricedMeterModels` |
| 4133 | 21 | `APP_SCOPE` |
| 4313 | 18 | `USAGE_DIMS` |
| 4271 | 17 | `priceUnpricedMeter` |
| 4339 | 8 | `usageRows` |

### Stage 3 — facet confidence roll-up  
*11 blocks, 146 comment lines*

| line | lines | anchor |
|---|---|---|
| 762 | 25 | `setFacetDiagnostic` |
| 883 | 20 | `facetExamples` |
| 839 | 17 | `demoteFacetDiagnostics` |
| 797 | 16 | `supersedeFacetDiagnostics` |
| 1092 | 13 | `refreshEntityData` |
| 618 | 12 | `(section header)` |
| 687 | 9 | `facetSplitValues` |
| 979 | 9 | `routingCase` |
| 1015 | 9 | `reextractSql` |
| 631 | 8 | `(section header)` |
| 922 | 8 | `queuedAmong` |

### Stage 4 — boards  
*11 blocks, 130 comment lines*

| line | lines | anchor |
|---|---|---|
| 2094 | 18 | `requeueSettledSql` |
| 2031 | 17 | `boardPreviewFaces` |
| 1756 | 15 | `BOARD_PIN_COLS` |
| 2142 | 15 | `retagBoardFacets` |
| 1867 | 13 | `duplicateBoard` |
| 1782 | 11 | `BOARD_COL_LIST` |
| 1836 | 9 | `NOT_DUPLICATED` |
| 1803 | 8 | `NEW_BOARD_DEFAULTS` |
| 1920 | 8 | `(inline)` |
| 1982 | 8 | `anyBoard` |
| 2125 | 8 | `retagBoard` |

### Stage 5 — run fence + automatic ingestion  
*8 blocks, 115 comment lines*

| line | lines | anchor |
|---|---|---|
| 2285 | 37 | `ingestRunGate` |
| 2438 | 17 | `FORGET_SCOPES` |
| 2240 | 14 | `dueIngestBoards` |
| 2346 | 10 | `stopIngestRun` |
| 2389 | 10 | `itemByContentHash` |
| 2490 | 10 | `itemBySourceKey` |
| 2370 | 9 | `ingestedKeys` |
| 2514 | 8 | `REMEMBERS_DELETIONS` |

### Stage 6 — job log  
*7 blocks, 97 comment lines*

| line | lines | anchor |
|---|---|---|
| 3452 | 22 | `LATEST_JOB_FAILURE_SQL` |
| 3726 | 21 | `markTagged` |
| 3673 | 16 | `reprocessEntity` |
| 3337 | 10 | `openJob` |
| 3482 | 10 | `BOARD_FAILURES_SQL` |
| 3694 | 10 | `STRIPPED` |
| 3658 | 8 | `floorOverdueRefreshes` |

### Stage 7 — queue helpers + entities + connector liveness  
*6 blocks, 84 comment lines*

| line | lines | anchor |
|---|---|---|
| 2842 | 38 | `claimFairBatch` |
| 2919 | 11 | `markExtracted` |
| 2947 | 9 | `advanceFetched` |
| 3148 | 9 | `reapEmptyEntities` |
| 3248 | 9 | `landEntityFetch` |
| 3167 | 8 | `deleteEntity` |

### Stage 8 — long tail  
*11 blocks, 128 comment lines*

| line | lines | anchor |
|---|---|---|
| 1559 | 18 | `entitiesOnBoard` |
| 1293 | 17 | `resolveMcpToken` |
| 1200 | 14 | `(inline)` |
| 4839 | 14 | `BOARD_ALERT_UNSEEN_SQL` |
| 1495 | 12 | `(inline)` |
| 1332 | 10 | `setMcpToken` |
| 4702 | 10 | `pruneAlertStaleClaims` |
| 1358 | 9 | `listMcpTokens` |
| 1706 | 8 | `deleteAiKey` |
| 1736 | 8 | `clearBoardModelPins` |
| 2638 | 8 | `setUserBoards` |

### Stage 9 — top-of-file  
*8 blocks, 106 comment lines*

| line | lines | anchor |
|---|---|---|
| 128 | 23 | `TAG_QUEUE` |
| 174 | 19 | `routedEntities` |
| 254 | 15 | `listItems` |
| 153 | 13 | `notPaused` |
| 113 | 10 | `legHalves` |
| 520 | 10 | `boardFileBytes` |
| 48 | 8 | `reconcileLiveSchedules` |
| 593 | 8 | `addTagSnapshot` |

### Stage 10 — cancelBoardQueue (move, then re-read)  
*1 block, 50 comment lines*

| line | lines | anchor |
|---|---|---|
| 4463 | 50 | `cancelBoardQueue` |

### Re-deriving this table

Line numbers shift as stages land. Regenerate before each sitting:

```python
import io, re
L = io.open("server/db.js", encoding="utf-8").read().split("
")
i, out = 0, []
while i < len(L):
    if L[i].strip().startswith("//"):
        s = i
        while i < len(L) and L[i].strip().startswith("//"): i += 1
        if i - s >= 8:
            j = i
            while j < len(L) and not L[j].strip(): j += 1
            out.append((s + 1, i - s, L[j].strip()[:60] if j < len(L) else "?"))
    else:
        i += 1
for ln, n, a in sorted(out, key=lambda t: -t[1]):
    print("%-6d %-4d %s" % (ln, n, a))
print("%d blocks, %d lines" % (len(out), sum(n for _, n, _ in out)))
```

