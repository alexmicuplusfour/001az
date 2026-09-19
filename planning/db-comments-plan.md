# The comments in db.js outweigh the code (2026-09-20)

**Status: STAGE 1 DONE (2026-09-20). Mechanical pass first (7 fixes, -733 bytes)
— tombstone deleted, three doc blocks reattached to the symbol they describe, one
TODO made greppable; that pass cut nothing. Stage 1 then cut the embeddings region
8 blocks → 6, 129 → 67 lines (-48%). Running total vs `ddd41e0`: -53 lines, -4,339
bytes, 41.2% → 40.5% comment density. Suite 1808 green throughout. Stages 2-10 open.**

**Recalibration from stage 1:** the 55-60% target is too aggressive as a blanket
number. That region held more genuine contract than expected — the three error
classes in `failOrRequeue`, the item-id/entity-id sequence OVERLAP hazard in
`entityIdsFor`, the facet-scope clearing rule, and recovery's ownership test all
survived the rubric intact. 48% was the honest answer there. Expect the same
where a section is mostly mechanism and a much deeper cut where it is mostly
narrative.

## The measurement

```
4,948 lines · 1,897 comment lines · 41% of non-blank lines
129,275 bytes of comment vs ~120,000 bytes of code
76 blocks of 8+ lines, holding 1,076 comment lines
longest single block: 50 lines (cancelBoardQueue)
```

The comments are physically bigger than the code they describe. 267 exported
symbols, and the prose outweighs the implementation.

Counted tics, which are the fingerprint of how this was written — each comment
composed immediately after the debugging session that produced it, in the voice
of someone justifying a choice to a reviewer:

| pattern | count |
|---|---|
| `rather than` | 55 |
| `deliberately` / `on purpose` | 29 |
| SHOUTED words for emphasis (`ONE` 17x, `NOW` 5x) | 241 |
| comments about what is **not** there | 35 |
| past-tense history narration | 56 |
| hardcoded incident dates | 4 |

241 shouted words is one every 8 comment lines. Past roughly three per file,
emphasis stops being emphasis and becomes texture — which is the core failure:
there is no signal difference between *"this parser is load-bearing, deleting it
silently breaks every `expires_at` comparison"* and *"here is why I used a
deny-list."* Both shout. So a reader skims both, or neither.

## What this is NOT

The comments are **accurate**. This was spot-checked, not assumed:

- the `notPaused` roster names 7 functions; there are exactly 7 call sites
- `"imports nothing"` on `schedule.js`, `field-sources.js`, `units.js`,
  `capabilities.js` — all four verified, zero imports each
- `IN_FLIGHT_FOR` → "eight in total", `STATUS_PRIORITY` ordering — both correct

Only 2 dead identifier references existed in the whole file, and the mechanical
pass removed both. **Nothing here is rot.** This is not a correctness cleanup and
must not be run as one. It is a volume and register problem, and the risk runs
the other way: the file contains perhaps 150–200 lines of genuinely load-bearing
invariant that a careless pass would take out along with the essays.

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

Roughly **55–60% off the 1,076 lines in large blocks**, landing near 600 lines
removed and a density around 30% instead of 41%. That is a direction, not a quota
— a stage that removes 20 lines because the section was genuinely load-bearing is
a correct outcome, and the rubric decides, not the number.

The measure that actually matters: **after this, a reader who sees a 20-line
comment in db.js should believe it earned the space.** Right now that inference
is unavailable, which is what makes the load-bearing ones cost as much to read as
the essays.

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

