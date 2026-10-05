# Search by meaning reads extracted fields (2026-10-05)

Self-contained for a fresh session. Written from a deep dive the same day.
Line links show the code at commit aad3718. The numbers come from read-only
queries on the local compose database.

**Status:** Stage 1 close-looked, built, checked in the real app and
second-passed 2026-10-05, uncommitted. Stage 2 close-looked, built, checked
in the real app and second-passed 2026-10-06, uncommitted; the plan's one
pass over the two together is next, when asked. D2 decided 2026-10-05:
the recommended version ("sure, go with recommended"). D8 decided
2026-10-06: one message, whatever the cause.

## The ask

The user made an "icons" board: auto-tag off, no facets, one extract field
("what icons are present in this image?"). The extracted answers were better
than expected. A search by meaning found nothing.

- "turns out embedding is not available for boards that have tagging disabled?"
- "there's field extraction which needs to be embedded, and then there's the
  tags which i assume trigger the embedding. and we want to avoid doing double
  work. so, do we enable embedding for just the extracted fields when tagging
  is disabled? how about when tagging is enabled but there are not fields
  defined?"

## What is actually happening

- **Who gets a vector.** `needsEmbeddingSql`
  ([db.js:3937](../server/db.js#L3937)) takes a row whose status is `tagged`,
  or an audio clip with a transcript, in any status. Nothing else qualifies,
  whatever it holds.
- **What the vector is made of.** `embedTextFor`
  ([worker.js:125](../server/worker.js#L125)): the tag reasoning (description
  first), the tags as words, and a transcript. Never `payload.fields`. With
  none of those it embeds the file name.
- **Extraction never touches the vector.** `markExtracted`
  ([db.js:2943](../server/db.js#L2943)) writes the fields and leaves the
  vector alone, since fields were never an embed input. The writers that clear
  it are the ones `CLEAR_EMBEDDING` names ([db.js:486](../server/db.js#L486)):
  `markTagged`, `setItemTags`, `landTranscript`.
- **A board with auto-tag off** parks each item at `held` once its extraction
  lands (`markExtracted`'s park branch). A `held` image never qualifies, so the
  icons board has no vectors and a search there answers with nothing.
- **The search pays for the query first.** `/api/search`
  ([server.js:3250](../server/server.js#L3250)) embeds the query, then reads
  the board's vectors. With none, the grid says "No items match these
  filters." ([grid.js:596](../public/grid.js#L596)) on a board with no filters
  on.
- **A board with no facets and auto-tag on** runs a tag step that asks nothing
  and lands `tagged` with no tags ([worker.js:2725](../server/worker.js#L2725)).
  Those items qualify and are embedded from their file names, so search there
  ranks by file name.
- **Boards that tag and extract** leave the fields out of the vector. The
  tagger reads the fields ([worker.js:2262](../server/worker.js#L2262)), so the
  tags can echo them, but the vector never reads them directly.
- **The admin numbers** (`embeddingStats`, [db.js:4236](../server/db.js#L4236),
  read by [capability-status.js:46](../server/capability-status.js#L46)) count
  `tagged` items only. Transcribed audio on a board that doesn't tag is already
  missing from them.

### The compose database (2026-10-05)

| Board | Tagging | Fields | Items | Vectors | What the vectors hold |
|---|---|---|---|---|---|
| icons | auto off, no facets | 1 extract (text) | 7 `held`, all answered | 0 | — |
| boats | auto on, no facets | 2 detect | 6 `tagged`, no tags | 6 | the file name (`10417406_original-900x600.jpg`) |
| are.na | auto off, no facets | none | 190 `held`, 1 `tagged` | 1 | the file name |
| wardrobe | 12 facets | file fields only (size, dimensions…) | 459 `tagged` | 459 | tags + reasoning; its fields stay out (D5) |
| resumes test, emma, invoice, cars | 1–5 facets | yes | 84 (1 `failed`) | 83 | tags + reasoning, no fields |

The embedder is the built-in one, Xenova/bge-small-en-v1.5
([local.js:11](../server/ai-providers/local.js#L11)). It reads about 512
tokens and drops the rest.

### This was tried once, for audio

[audio-tag-handoff-plan.md](audio-tag-handoff-plan.md) Stage 3 (2026-09-27)
made a transcribed clip wait for its tags, so it was embedded once instead of
twice. Stage 4 reverted it the same day
([audio-tag-handoff-plan.md:302](audio-tag-handoff-plan.md#L302)). Uploads
queue for tagging whether or not anything can tag them, so with no key, a
removed provider, a retry backoff (up to an hour) or a credit wait, the clip
was never searchable. The double embed was kept as the price ("free
on-device, tiny on a paid key"), and the `embed_gen` fence (migration 0056)
made it safe: a vector built from text that has since changed is dropped.

Fields would hit the same wall, behind a backoff, a credit wait or a key
removed after the extraction. (Not on an install with no AI key: nothing
extracts there at all, detect-only boards included, since the pipeline's
claim takes an extraction only with a key, `claimFairBatch`. This plan first
said such a board would extract fine; the second pass found otherwise.)

## Decisions

- **D1 — Fields join the embed text on every board.** No rule reads the
  board's settings: an item is embedded when it has something to say, and its
  answered fields are part of that.
  - "AI fields" are what the lightbox lists under "AI-extracted fields": every
    stored field without `src: "file"`
    ([lightbox-panel.js:388](../public/lightbox-panel.js#L388)).
  - A text, number, url, date or list answer adds `key: value` (a list joins
    its options). Its "why" sentence joins too. On the icons board that's
    where "black outline symbols on a red background" lives.
  - A detect field adds `key: Detected: barge, boat`, which is its why
    ([worker.js:3069](../server/worker.js#L3069)). The boxes are coordinates
    and stay out. "A detect field with hits" is `objectKeysOf`'s answer
    ([db.js:223](../server/db.js#L223)), which the lightbox and the objects
    filter already go by.
  - An empty answer (null, "", []) adds nothing, key included. Otherwise
    "snow: No objects detected" would make a search for snow match.
  - The ask's two cases: tagging off with fields → the fields are the text.
    Tagging on with no fields → unchanged, tags and reasoning.

- **D2 — An item is due when it has text and no step holds it. DECIDED
  2026-10-05: this, the recommended version.**
  - Held back: the claimed states (`fetching`, `extracting`, `processing`,
    `facing`). A step is mid-call, and its landing changes the text.
  - Due if it has text: everything else. The queued states, `held`, `failed`,
    `tagged`.
  - A normal upload to a board that tags and extracts gets one embed.
    Extraction lands `pending`, and the legs wake each other
    ([resource-loop.js:92](../server/resource-loop.js#L92)), so the tag step
    claims it at once. The embed sweep isn't in that group and looks every 3s
    ([worker.js:2196](../server/worker.js#L2196)): it finds the item
    `processing` and leaves it. The tags land, then one embed. (A tick that
    falls in the milliseconds between the landing and the claim embeds the
    fields once more. Rare, and the fence keeps it harmless.)
  - Tags stuck behind a backlog (a bulk upload, a slow or rate-limited tagger)
    cost two embeds: the fields while the item waits, then fields and tags.
    Free on the built-in embedder, cents per thousand items on a paid one.
  - A key or provider removed after the extraction, a backoff, a credit wait:
    the item waits `pending` and is searchable from its fields meanwhile. The
    audio revert's failure doesn't come back.
  - Audio changes a little: a clip mid-tag-call waits for its tags instead of
    being embedded from the transcript alone. A landed transcript wakes every
    kind at once (`wakeAll`), the embed sweep included, so whether a clip on a
    tagging board gets one embed or two is a race; fields have no such race,
    since an extraction landing wakes only the steps. "A keyless install
    searches by speech" still holds, since nothing claims a clip there.
  - **The strict alternative:** hold back the queued states too. Always one
    embed, but an item whose tags never come is never searchable. That's what
    audio Stage 3 did and Stage 4 reverted. Not recommended.
  - **Considered, not recommended:** hold back queued items only on boards
    whose tagger resolves. Items in a backoff or a credit wait still strand,
    and the sweep's claim would need a per-board resolve, all to save an embed
    that's free on the built-in embedder.

- **D3 — `markExtracted` clears the vector when the item's run ends there.**
  - The park branch (`held`) is the item's last text change, so it clears, as
    `markTagged` does.
  - The branch that hands the item to the tag step leaves the vector alone, and
    `markTagged` clears it when the tags land. Clearing there would take the
    item out of search for the length of the tag call, or, behind a backlog,
    buy one more embed. Retag and reprocess already work this way
    (`CLEAR_EMBEDDING`'s comment, [db.js:486](../server/db.js#L486)).
  - The park branch needs it because an item can already have a vector at its
    first extraction: a clip on a board that doesn't tag is embedded from its
    transcript while it waits to be extracted. Re-extract and reprocess drop
    `park` ([db.js:954](../server/db.js#L954),
    [db.js:3799](../server/db.js#L3799)), so they always go on to tagging.
  - Recorded, not fixed: the vector from before stands for as long as the tag
    landing doesn't come. Through the tag step's wait (a backoff, a credit
    wait, a paused board) it carries the old answers. If the tag step fails
    for good, or Cancel queued sends the item back to `tagged` or `held`
    (`cancelBoardQueue`), it keeps them until the item's next tag landing, tag
    edit, transcript landing or parking extraction; a re-extract that hands on
    to tagging again doesn't clear it either. It's the gap the reset verbs
    already have for tags (`CLEAR_EMBEDDING`'s comment): retag, then cancel,
    and a card with no tags is still found by its old ones. Closing both
    would be a clear wherever a run ends without its landing (a cancel, a
    final failure). Found in the second pass; offered, not built.
  - How: `markExtracted` answers which status it landed, and a landing in
    `held` is followed by `CLEAR_EMBEDDING`, fenced on `held`. The one
    fragment stays the one spelling, and the `embed_gen` bump drops any vector
    still in the air from before.

- **D4 — No text, no vector.**
  - The file-name fallback goes. A file name is search text only by accident
    (hashes, on these boards), and it makes a board with nothing to say answer
    with confident nonsense instead of nothing.
  - The sweep never sends an empty text. If a due row's text comes out empty
    (the SQL rule and the builder disagree), it's marked `embed_error`
    "nothing to embed", with no call and no History row, so a mismatch can't
    embed a name or hold up a batch. `CLEAR_EMBEDDING` lifts the mark when the
    text changes, as it does for an item the embedder rejected.
  - The mark is made in `embedBatch`, before the rows are split by board, so
    the batch's History row (opened per board, before its call) never counts
    a row that wasn't sent. Nothing in today's data would trip it: every
    stored field is `{v, why, kind?, src?}`, `src` is only ever `"file"`, and
    no answer, reasoning or transcript is blank. It takes over the fallback's
    one job, never sending an empty string.

- **D5 — What stays out.**
  - File fields (`src: "file"`: size, dimensions, dates). Filters and sorts
    already serve them, and every mapping save that re-projects them would
    re-embed the board.
  - Connector fields (`entities.fields`). They refresh on a schedule, so a
    stock board would re-embed on every price move.
  - PDF text. It lives in a file beside the PDF, not in the row the sweep
    reads, and `landPdfText` says it isn't an embed input
    ([db.js:519](../server/db.js#L519)). Its own change, if wanted.
  - The images. A board with no tags and no fields (are.na) has only pixels to
    go on. That's image embeddings, a different arc.

- **D6 — Order, for the built-in embedder's 512 tokens.** Description, field
  values, per-facet reasoning, tags, field whys, transcript (the longest, last,
  as today). The 8,000-character cap stays, for the paid embedders.
  - Measured in the close look (bge-small's own tokenizer, the newest 40 rows
    of each board, in this order): nothing is cut anywhere but one long
    transcript, which is last. Medians, today → with fields: resumes test
    251 → 371 tokens, invoice 96 → 209, emma 114 → 177, cars 85 → 118, icons
    0 → 101. ui comes closest to the window (median 434, max 492), and has no
    fields. A board shaped like ui that also extracted fields is why the
    values go near the front: appended, they'd be what the window drops.

- **D7 — Existing vectors catch up in a migration.** 0061 clears, the way
  `CLEAR_EMBEDDING` does, every vector built without its item's answered
  fields, and every vector built from a name. That's 89 here (cars 26, emma
  25, resumes test 19, invoice 13, boats 6) plus are.na's one. Wardrobe's 459
  stay: its fields are file fields, which D5 keeps out, so its text doesn't
  change. The sweep refills them newest first. Free on the built-in embedder;
  on a paid one it's a one-off re-embed of every item with AI fields, and the
  commit message says so. As after a model change, an item is out of search
  until its turn.

- **D8 — A search on a board with no vectors says so, and spends nothing.
  DECIDED 2026-10-06, in Stage 2's close look.**
  - `/api/search` checks access, the embedder and an empty query (still
    answered with nothing), then reads the board's vectors before the
    query's. None for the current model: a 409, "Nothing on this board can be
    searched by meaning yet.", with no query embed and nothing metered.
  - One message, whatever the cause: the cards have nothing to search by,
    they're waiting their turn (new uploads, a model change), the embedder is
    set up but failing, the board is paused, or their text was refused. The
    user: "how about something more generic. the board could lack embeddings
    for other reasons also". Two messages that named a cause ("no card here
    has…", "N cards are waiting…") were proposed and dropped, and so was this
    plan's second sentence ("Search reads tags…"), which pointed at one cause.
  - With no embedder at all the search box doesn't show (the board's `search`
    flag), so that case never reaches the message; an embedder gone while the
    page is open still answers 404 "semantic search is not enabled".
  - Find similar by meaning on a card with no vector: a 409, "This card can't
    be searched by meaning yet." It was a 404 "item not embedded yet", which
    on a card with nothing to say is now for good. 409 so the page can tell
    both refusals from a missing board.
  - The page shows these refusals as a plain toast for 8s, not the red error
    toast: nothing failed. It already left the grid and the box as they were
    (`runSearch`, [search.js:31](../public/search.js#L31)). The refusals are
    marked `declined: true`, and the page goes by the mark, not the 409: the
    error handler passes a provider's own status through (Stage 2's second
    pass).
  - The MCP tool's `rank()` already reads the vectors first, then embedded and
    metered the query anyway. With none it now says the same sentence and
    skips the embed.
  - Not chosen: a third sentence in the grid's empty note (more UI for a rare
    state); hiding the box on such a board (it would vanish without saying
    why, and the board is read once per load, so its first vectors wouldn't
    bring it back until a reload).

- **D9 — One rule for the claim, the count and the numbers.**
  - `needsEmbeddingSql` already serves the sweep's claim
    (`itemsNeedingEmbedding`) and the jobs chip's count (`LANE_NEED`).
    `embeddingStats` reads the same "has text" piece now, so the admin page's
    waiting count is items with text, less embedded, less marked.
  - The builder says the same thing in JS. A test runs both over one set of
    rows and checks that "due" matches "has non-empty text", row for row.
  - Cost: every 3s the sweep looks at each row without a vector, and a 20k-image
    feed into a board that neither tags nor extracts is 20k such rows. The
    audio branch already unpacks their payloads; the fields check adds a pass
    over each one's fields. Stage 1 measures it at 20k rows. If it costs what
    0057 measured for the claim, "has text" becomes a stored column, the way
    `awaiting_transcript` did.
  - **Measured in the build, and it did.** 20k rows with nothing to say, the
    rule spelled out in the query: the sweep's claim 5.5 → 76.5 ms and the
    chip's count 10.4 → 408 ms; with 6 KB payloads 526 → 2,696 ms and 496 →
    2,486 ms. As a stored column, `items.has_embed_text` (migration 0061):
    3.9 and 3.3 ms, and 3.0 and 2.9 ms at 6 KB, cheaper than today's rule,
    whose audio branch already unpacked every payload. A 20k-row UPDATE costs
    the same with the column as without (329 against 339 ms; 1,426 against
    1,901 ms at 6 KB, noise). A generated column takes no subqueries, so the
    rule is written with lax JSON paths there; the prototype agreed with the
    subquery form on 28 shapes before it went in.

## What stays the same

- Tagging on, no fields: the same text, one embed after the tags.
- `markTagged`, `setItemTags` and `landTranscript` clear as before, and the
  `embed_gen` fence is untouched.
- Ranking and its 0.15 cutoff, similar by meaning, clusters by meaning, the MCP
  tools: they read vectors, and there are more of them.
- Paused boards are skipped, as before.
- The jobs chip: a queued row shows under its step, not as an embed waiting
  (`LANE_NEED`'s skip).

## Noted, not in this plan

- are.na-style boards stay unsearchable (D5).
- "Find similar by meaning" shows on every card while an embedder is on,
  including cards with no vector. Those answer "This card can't be searched
  by meaning yet" (Stage 2; it was "item not embedded yet").
- A partly embedded board answers from what's embedded without saying so. The
  MCP tool says so ([mcp-tools.js:964](../server/mcp-tools.js#L964)); the web
  search doesn't.
- An extract field dropped from the mapping keeps its stored answer until the
  item is re-extracted (reconcile leaves AI fields alone,
  [field-reconcile.js](../server/field-reconcile.js)). So it stays in the
  embed text, as it stays in the tagger's input and the lightbox.
- An install with no AI key extracts nothing, detect-only boards included:
  the pipeline's claim takes an extraction only with a key
  (`claimFairBatch`; detect.test.js gives its board a key just to open it).
  On-device detection needs none, so the gate may deserve its own look. Older
  than this plan; found in Stage 1's second pass.

## Stages

Each stage gets a close look before it's built and a second pass after. After
Stage 2, one pass over the two together.

### Stage 1 — fields are embed text; an item with text is due

Build:
- `embedTextFor`: answered AI fields, in the D6 order (D1). No file-name
  fallback (D4).
- `needsEmbeddingSql`: has text (tags, reasoning, an answered AI field, a
  transcript) and isn't claimed (D2). `embeddingStats` reads the same piece
  (D9). "Has text" is the stored column `items.has_embed_text` (D9's
  measurement).
- `markExtracted`: clears on the park branch (D3).
- `embedBatch` ([worker.js:790](../server/worker.js#L790)): the empty-text
  mark, before the rows are split by board (D4).
- Migration 0061 (D7).
- Ten tests seed a `tagged` item with no tags and count on it being due to
  embed. Their seeds get a tag: first-class-work ×3 (the backlog mirror, the
  `fast` carriers, the running batch), job-log's `seedDue` (its embed tests),
  board-pause ×1, browser/work-cadence ×2. browser/events.test.js stamps
  `embed_error` on a bare item to keep it out of the embed queue; under the new
  rule it's out already, so the stamp and its comment go.

Proofs:
- The builder: answers in, whys after the reasoning, a detect field as its
  why, empty answers and file fields out, nothing from a file name. Today's
  fallback assertions change ([prompt.test.js:71](../test/prompt.test.js#L71),
  [audio.test.js:749](../test/audio.test.js#L749)).
- Due, by status and text: claimed never, everything else exactly when there's
  text. This replaces "transcribed audio embeds from its transcript in every
  state" ([embed-sweep.test.js:466](../test/embed-sweep.test.js#L466)).
- Agreement (D9): due matches non-empty text on every row of that matrix.
- `markExtracted`: the park branch clears and bumps `embed_gen`; the branch
  that goes on to tagging leaves the vector.
- "embed backlog mirrors the sweep's predicate"
  ([first-class-work.test.js:84](../test/first-class-work.test.js#L84)): a
  tagged item with no text stops counting, and a held item with answers
  starts.
- The admin numbers count transcribed audio and held items with answers.
- The guard: a row the SQL calls due whose text comes out empty is marked,
  with no call.
- The migration clears vectors built without answers or from a name, and
  leaves tags-only ones and file-fields-only ones (wardrobe's shape).
- One embed per normal upload, through a live worker with stand-in extract,
  tag and embed servers (audio-handoff-worker.test.js's pattern): an upload to
  a board that tags and extracts makes one embed call. With the tag step held
  back, it makes two, and the second carries the tags.
- The sweep's cost at 20k rows with nothing to say (D9), old predicate against
  new.
- A removal check for each piece.

Real app (the compose app needs a rebuild, so ask first; the checks are
read-only queries, no session minted):
- icons: 7 vectors. The user searches it ("car", "red").
- boats: 6 vectors rebuilt from the "Detected: …" lines.
- are.na: its name vector gone, its 190 items still without vectors.
- cars, emma, invoice and resumes test re-embedded once; wardrobe untouched.

**Close look (2026-10-05)** — what the plan had wrong, before a line was
built:
- **The migration was ten times too big.** The plan counted wardrobe's 459
  items as fields left out of their vectors. Their fields are all file fields,
  which D5 keeps out, so their text doesn't change. 89 vectors are rebuilt,
  plus are.na's name one; the migration's test now has to keep a
  file-fields-only vector.
- **Ten tests, not one, lean on a bare `tagged` item being due.** The shared
  `seedInstance(db, b, "tagged")` makes an item with no tags, and ten tests
  across first-class-work, job-log, board-pause and browser/work-cadence call
  it "due to embed". Their seeds get a tag (Build, above).
- **The empty-text mark was in the wrong function.** `embedGroupCalls` runs
  after the batch's History row is opened, so the row would have counted a
  row never sent. It moves to `embedBatch` (D4).
- **Audio's one embed is a race.** `wakeAll` on a landed transcript wakes the
  embed sweep with the steps (D2). Fields don't race: tagging starts 6 ms
  (median) after extraction lands, 259 ms at worst, across 44 items in the
  job log.
- **D6's "~450 tokens for wardrobe" was a guess from characters.** Measured
  with the tokenizer: 374. Nothing is cut today (D6).
- **Reuse:** `objectKeysOf` for a detect field with hits (D1); the transcript
  check drops "the first file is audio", since only audio ever carries one.
- **Checked and holds:** every stored field is `{v, why, kind?, src?}` and
  `src` is only `"file"` (2,192 entries); mapped items on an auto-tag-off
  board start at `pending_extract` with `park`, so D3's audio case is real;
  the admin wording is generic ("N of M items processed"); no test pins the
  tagger's field lines.

**Built (2026-10-05), uncommitted.**
- `embedTextFor` (worker.js): the D6 order. An answered AI field gives
  `key: value` (a list joined), a detect field (`objectKeysOf`) its "Detected:
  …" line or "detected" when it has no why, and each scalar or list field's why
  comes after the tags. `fields` is read only as a map. Nothing to say is "";
  the file-name fallback is gone.
- Migration 0061 adds `items.has_embed_text`, a stored generated column
  holding the rule (lax JSON paths, COALESCEd, never NULL), then clears the
  stale vectors (D7). db.js's `HAS_EMBED_TEXT_SQL` is `i.has_embed_text`;
  `needsEmbeddingSql` is it, plus no current vector, no mark, and not claimed
  (`IN_FLIGHT_SQL`). `embeddingStats` counts by it and answers `total` where it
  answered `tagged`; capability-status.js reads `total`.
- `markExtracted` answers the status it landed (`RETURNING status`); a `held`
  landing is followed by `CLEAR_EMBEDDING`, fenced on `held`.
- `embedBatch` builds each row's text once and marks an empty one "nothing to
  embed" before the per-board split; `embedGroupCalls` sends `r.text`.

Found while building:
- **The cost D9 asked about was real, so the rule became a stored column.**
  Numbers in D9. The first version spelled the rule out as subqueries in the
  claim; a generated column takes none, so the column says it with lax JSON
  paths. A throwaway database checked the two forms on 28 shapes before the
  switch, and the agreement test carries the four new ones.
- **The first 0061 would have kept every name-only vector.** Its "nothing to
  say" test was `NOT (… OR transcript is a string …)`, and for an item with
  no transcript that piece is NULL, so the NOT was NULL and the row didn't
  match. The migration test caught it; the column COALESCEs.
- **The builder read `fields` stored as a list** (`[{v: "x"}]`) as a map with
  key "0", where the SQL rule refuses it. One of the prototype's new shapes;
  `isMap` now.
- **Two embed-sweep tests retired their rows by marking them `failed`,**
  which the old rule never embedded. A failed item with text is due now (D2),
  so the rows came back and doubled the next test's batch. They delete their
  rows.
- **The gen-fence test seeded its racing clip as `processing`.** The new rule
  never hands the sweep a claimed row, so it would have passed testing
  nothing. The clip is queued, the stand-in claims it mid-call, and the
  salvage round counts its rows so it can't run empty.
- **No test read the status feed's embed numbers,** so the `tagged` → `total`
  rename was unguarded (a slip shows "NaN waiting"). capabilities.test.js's
  fresh-instance test now checks embed's progress line.
- **The live test switches the embedder on only once the tag call is in the
  air.** With it on throughout, the milliseconds between an extraction
  landing and the tag step's claim would make the test a coin toss.

Tests:
- New: in embed-sweep, the due matrix (7 kinds of text × 11 statuses), the
  agreement test (28 shapes), the park/hand-on test, the empty-text mark, the
  admin numbers, 0061; in prompt, the field order and the unanswered/file
  fields; field-embed-worker.test.js (a live worker with stand-in extract, tag
  and embed calls): one embed for a normal upload, and two when the tag call
  fails and the item waits out its retry.
- Changed: the ten seeds; events.test.js's stamp and comment; the fallback
  assertions in prompt and audio; the gen-fence test's statuses; the two
  `failed` retirements; capabilities.test.js's fresh instance gains a held
  item with an answer.

Removal checks, each undone alone, the original bytes put back by hash, the
test template rebuilt around the four that edit the column — 21 of 21 caught:
R1 values left out of the text, R2 whys left out, R3 values appended last, R4
an unanswered field keeps its key, R5 file fields as text in the builder, R6
the file-name fallback back, R7 claimed rows due, R8 the strict alternative
(queued held back too), R9 the old rule, R10 the column ignores fields, R11
the column counts file fields, R12 the column's path strict, R13 the column
NULL-able, R14 parking leaves the vector, R15 every extraction clears it, R16
an empty text sent, R17 the numbers count tagged only, R18 the status feed
reads the old key, R19 0061 keeps name-only vectors, R20 0061 counts file
fields, R21 the builder reads a list-shaped `fields`.

Suite: lint clean; unit 2,235 passed, 0 failed (2 skipped: the Linux-only
poppler tests); browser 229/229 (unit 8 files at a time, browser 4, 300s
each). Two earlier whole runs, 8 at a time with a 120s cap, each failed 5
different browser tests and cut off lightbox-panel.test.js: the cap counts a
whole file, and that file takes 112s alone. One failure was Chromium itself
("Target crashed"); every failed file passed alone (104/104), with no leftover
processes; Photoshop was running.

**Real app (2026-10-05, "rebuild and do a 2nd pass").** The app alone,
rebuilt from the working copy (`docker compose build app && docker compose up
-d --no-deps app`; old image 999fb302, rollback `docker compose pull app &&
docker compose up -d app`). A dry run of 0061's WHERE beforehand counted 90,
as the close look did. 0061 applied over 7,204 items, and the built-in
embedder refilled 97 in six batches within seconds:
- icons 0 → 7, each from its answer and its why ("icon: speedometer gauge,
  needle, circular dial" then the sentence).
- boats: 6 rebuilt, from "boat: Detected: boat" and "snow: Detected: snow".
- cars 27: its 26 rebuilt, plus its one `failed` item, which has answers and
  is due under D2.
- emma 25, invoice 13, resumes test 19: rebuilt, once each.
- are.na: its name vector gone; all 191 without one.
- wardrobe, ui, logos, stocks test, crypto, transcriber test: untouched
  (`embed_gen` unchanged). No embed errors anywhere.

Searched inside the container the way `/api/search` does, without its meter
row: icons "car" puts #9865, which lists a car, first, but all 7 come back
inside the 0.15 cutoff (scores 0.46 to 0.56: a sheet's long list of icons
blurs its vector, and #9866, which lists a car too, is third). boats "boat":
the four boat photos, the two snow ones cut. The user's own search in the
browser is theirs to try.

**Second pass (2026-10-05).** Two read-only reviewers, never shown the plan:
one compared the server diff with HEAD and ran about 75 odd shapes through
the column and the builder on a throwaway database; the other listed every
writer of the embed inputs and every path that copies item rows. Each finding
was re-read in the code.

Fixed:
- **A mapping save could leave a vector made from an answer it replaced.**
  The file-field reconcile lets a file field take over an AI field's key
  (extract "title" turned into a file field): the answer goes and nothing
  cleared the vector, so a search still found the card by it, and a card left
  with nothing to say kept a vector (against D4). The reconcile now flags
  those items and `updateItemPayloads` clears their vectors; re-projecting
  file fields alone still re-embeds nothing (D5). New test in
  media.test.js, both sides.
- **A row whose text can't be built would have stalled the sweep for good.**
  A tag that isn't a string is text to the column and a throw to the
  builder, and the claim hands the same newest rows back every tick. HEAD
  threw too, but inside the batch, with a History row each time; Stage 1
  moved the build ahead of the History row, so the stall went silent. Now the
  row is marked ("its text can't be built: …") like an empty one, and the
  batch goes on. No writer makes such a tag, and the real data has none. The
  "nothing to embed" test now covers it.
- Simpler: `answeredField` uses `isMap`; the warning prints only when the
  mark lands; `CLEAR_EMBEDDING`'s comment names the new writer and no longer
  reads as if a hand-off extraction clears.

Corrected above: an install with no AI key extracts nothing (the audio
section and D2); D3's recorded gap names Cancel queued and the waits.

Recorded, not fixed:
- The hand-off gap (D3), found by both reviewers. Also: an item already
  marked (its text rejected) stays out of search through a hand-off, until
  its tags land.
- `markExtracted`'s clear is a second statement. A sweep tick between the
  two costs one extra embed (the fence drops the first), and a database error
  between them would leave the old vector beside the landed fields. Closing
  it takes a transaction on every extraction or a second spelling of the
  clear.
- The column and the builder disagree on shapes no writer makes: tags that
  aren't a list, reasoning stored as a list or a string, a `src` that isn't a
  string, fields as a list of maps, text made only of no-break spaces (JS
  calls them space, Postgres on musl doesn't) or of U+0085 (the other way
  round). Where the column says text, the guard marks the row; the other way,
  the row is never embedded. None of these is in the real database, and
  neither is a whitespace-only answer (which both sides count).
- Find similar's "item not embedded yet", and the MCP tools' note, are now
  for good on an item with nothing to say. For Stage 2's close look.
- While a queued item's fields-only embed is in the air, the jobs chip shows
  it under embedding, not under its step, as transcribed audio already did.
- The admin numbers' `total` counts claimed items, which the sweep takes
  after their landing, and paused boards' items (already counted before).

Checked and holds:
- Every caller of the changed functions and return shapes (`embedTextFor`,
  `markExtracted`, `embeddingStats`, `needsEmbeddingSql`, `embedBatch`)
  across server/, public/, scripts/ and the plugins.
- Backup skips generated columns by kind, not by name (backup.js
  `tableColumns`), and a 0060 archive restored into 0061 is cleared the way
  0061 clears. Nothing copies item rows with `*` or a catalog column list.
- No route edits a field value. `setItemTags` is the one user edit of an
  embed input, and it clears.
- Every race between a landing and an embed in the air ends with the fence
  dropping the stale vector.
- The real data's list fields all carry `kind: "list"`, so none reads as a
  detect field.

Removal checks, each undone alone, the bytes put back by hash — 7 of 7
caught: R4 and R5 again on the folded `answeredField` (an unanswered field
keeps its key; file fields as text), R16 again on the new loop (an empty text
sent), R22 the reconcile never flags a takeover, R23 `updateItemPayloads`
ignores the flag, R24 every re-projection re-embeds (D5's side), R25 a
builder throw not caught. The media test also failed before the db.js half
existed.

Suite: lint clean; unit 2,236 passed, 0 failed (2 skipped: the Linux-only
poppler tests); browser 229/229 (unit 8 files at a time, browser 4, 300s
each).

Not in the running app: the two fixes above came after the rebuild, so the
compose app has Stage 1 as built. Neither touches what the real-app check
read; a rebuild brings them in.

### Stage 2 — a board with nothing embedded says so

Build (D8):
- server.js `/api/search`: the board's vectors after the empty-query check
  and before the query embed; none → 409 with the board's sentence.
- server.js `/api/search/similar`: an anchor with no vector → 409 with the
  card's sentence.
- mcp-tools.js `rank()`: no vectors → the board's sentence as a note, before
  the query embed.
- search.js: `fetchResults` keeps the status; `runSearch` and
  `runSimilarMeaning` show a 409 as a plain toast, anything else as before.

Proofs:
- embed-sweep: a board with nothing embedded, and one whose only vector is
  another model's, refuse a search with the sentence, no provider call and no
  meter row, while an empty query is still answered first. The metering test
  ([embed-sweep.test.js:214](../test/embed-sweep.test.js#L214)) searched a
  board with no vectors, so it seeds one. The similar route's un-embedded
  anchor: 409 and the card's sentence.
- mcp-tools: a query on a board with nothing embedded: the note, the facet
  answer, no provider call, no meter row.
- Browser, against the real route: on a board with cards and no vectors, a
  search shows the sentence as a plain toast, the grid keeps its cards, no ×;
  Find similar by meaning on a card shows the card's sentence the same way;
  nothing metered.
- ui-updates' "clearing a search with its × puts the caret back in the box"
  stubs its search (below).
- A removal check for each.

Real app (needs a rebuild, so ask first): the user searches are.na and sees
the sentence; icons still searches; nothing metered to are.na.

**Close look (2026-10-06)** — what the plan had wrong:
- **It broke a browser test it didn't list.** ui-updates' "clearing a search
  with its × puts the caret back in the box" runs a real search on a board
  with no vectors and waits for the ×, which only comes with results. It gets
  a stubbed search, as its neighbours have; it tests the caret, and ran the
  on-device embedder to embed "red".
- **"Vectors first" comes after the empty query:** access.test.js answers an
  empty query with nothing before anything else is read.
- **The MCP tool had the same waste**, and **"not embedded yet" is for good
  on a card with nothing to say** (D8 has both).
- Checked and holds: the box shows on every board once any embedder
  resolves, so are.na and a brand-new board both reach this; the metering
  test's stub and the resolved model match, so a seeded vector works; the
  similar route's test checked only the status; the user's
  conversational-search plan lifts `/api/search`'s body into a shared
  `rankQuery`, so whichever lands second carries the no-vectors rule.

**Built (2026-10-06), uncommitted.**
- server.js `/api/search`: the board's vectors are read right after the
  empty-query check; none → 409, "Nothing on this board can be searched by
  meaning yet.", before the query embed and its meter row. The same read
  feeds the ranking, so it's the one read it was, moved up.
- server.js `/api/search/similar`: an anchor with no vector → 409, "This card
  can't be searched by meaning yet." (was 404, "item not embedded yet").
- mcp-tools.js `rank()`: no vectors → the board's sentence as a note, before
  the query embed.
- search.js: `fetchResults` carries the status on its error, and `toastFor`
  shows a 409 as a plain toast for 8s and anything else as the red error,
  for a typed search and for Find similar by meaning.

Tests:
- New: embed-sweep, "a search on a board with nothing embedded is refused
  before the query is embedded" (a board whose card has text and no vector,
  and one whose only vector is another model's: the sentence, no provider
  call, nothing metered, an empty query still answered first); mcp-tools, "a
  query on a board with nothing embedded embeds nothing, and says so" (a paid
  embedder stubbed at fetch, so a call would show); browser
  search-refusal.test.js (a typed search: the plain toast, the grid keeps its
  cards, no ×, the query stays in the box, the one 409, nothing metered; Find
  similar by meaning: the card's sentence, plain).
- Changed: the metering test seeds a vector; the similar route's un-embedded
  anchor expects 409 and the card's sentence; ui-updates' × test stubs its
  search.

Removal checks, each undone alone, the bytes put back by hash — 9 of 9
caught: S1 the query embedded before the vectors are read, S2 a board with
nothing embedded answered with no results, silently, S3 the vectors read
before the empty-query check (access.test.js caught it too), S4 the MCP tool
embeds anyway, S5 find similar back to 404 "item not embedded yet", S6 the
page shows a 409 as the red error, S7 `fetchResults` drops the status; and
the two setups the stage needed: S8 the × test without its stub, S9 the
metering test without its vector.

Suite: lint clean; unit 2,238 passed, 0 failed (2 skipped: the Linux-only
poppler tests); browser 231/231 (unit 8 files at a time, browser 4, 300s
each).

**Real app (2026-10-06, "rebuild and 2nd pass").** The app alone, rebuilt
(old image 7f812b81, Stage 1's build; new 820f8821); no migration. The
running image carries the stage: its server.js and mcp-tools.js hold both
sentences, and the served bundle the new toast rule. Read inside the
container with the app's embedder (the built-in one) and `boardEmbeddings`,
the way the route reads: only are.na (191 items) and "empty board" have
nothing embedded, so only they get the sentence; the other twelve boards
search as before. The user's own search of are.na in the browser is theirs to
try; are.na's embed meter has one row, from 2026-09-26, to compare after. The
rebuild also brought in Stage 1's second-pass fixes.

**Second pass (2026-10-06).** One read-only reviewer, never shown the plan,
compared the three files with HEAD, read every consumer of both routes and ran
a probe. I checked the plan's claims, the tests' setups and the packaging.

Fixed:
- **A provider's own 409 would have shown as the calm note.** The page read
  any 409 as the decline, but the error handler passes a provider's status
  through (`providerError`), so an embedder answering 409 would have read as
  "nothing failed". No built-in wire does, but Google's API uses 409, and a
  plugin's wire can throw anything; the reviewer's probe showed it. Both
  routes now mark their refusal (`declined: true`), and the page goes by the
  mark. New browser test: a 409 without the mark is the red error.
- Comments: the similar route's argued against its own sentence; the search
  box's said every query is a paid call.

Recorded, not fixed:
- `/api/search/similar` with an id that isn't on the board (another board's,
  a deleted card's) gets the card's sentence and a 409; it was a 404 "item
  not embedded yet", no truer. Only the page calls it.
- A typed search declined while "Similar to X" (by tags) is showing leaves
  that view, and the typed text in the box, as any failed search does.
- MCP: `similar_to` on a board with nothing embedded gets the board's
  sentence (was "Item N has no stored vector yet"); a whitespace-only query
  there gets the note where it got none.
- MCP still pays for a query when the board has vectors but none of the
  cards its filters left has one, then says "None of the matching cards…",
  even when nothing matched. Older than this stage; the same check could move
  ahead of the embed. Offered, then built ("sure go ahead"; Follow-up, below).
- Clusters by meaning on a board with nothing embedded shows no rail row and
  says nothing. The MCP notes keep "not embedded yet".
- Not taken: one constant for the board's sentence (each door's test pins its
  own text, and the web route's words would live in the MCP module); moving
  embed-sweep's fetch stub into helpers.js (six copies now; its own tidy).
- Not settled: a provider that changed vector size under one model name would
  still embed, meter and answer nothing, the old silent empty result. No
  known provider does.

Checked and holds:
- The order: access, embedder, empty query, vectors, then the embed and the
  meter. A board with vectors on some cards searches as before, from the
  same read. A model change counts as nothing embedded (tested).
- The stale-response guard, the spinner and the box's text are untouched.
  Toasts dedupe by message and type, so pressing Enter again stacks none.
- The MCP path returns before the embed and the meter, and the facet answer
  still comes back.
- public/search.js is the only consumer of both routes; README and PLUGIN.md
  don't describe their answers.
- Each new or changed test fails without its fix. The browser tests act within
  the first second, before the 4s poll, and toasts live outside the page's
  render.

Removal checks, 3 of 3 caught: P1 the page reads a decline from the 409
again, P2 the board's refusal unmarked, P3 the card's.

Suite: lint clean; unit 2,238 passed, 0 failed (2 skipped: the Linux-only
poppler tests); browser 232/232 (unit 8 files at a time, browser 4, 300s
each).

Not in the running app: the mark came after the rebuild. The running image
goes by the 409, which shows the same plain note for the routes' own
refusals.

**Follow-up (2026-10-06, "sure go ahead"): the MCP tool skips a query no
matching card can answer.** `search_board` narrows the board by its facets
and crate first, then ranks what's left; the query was embedded and metered
before anyone looked at whether those cards had vectors. On a partly embedded
board, a filter that leaves only unembedded cards paid for an embed that
ranked nothing. Now, in `rank()`'s query branch, the cards left are checked
for a vector before the embed; with none, the same "None of the matching
cards…" note and no call. And when the filters matched nothing, no note at
all: it said "none of the matching cards has been embedded" about cards that
don't exist, and the answer already says nothing matched. The web search
has no such case: it ranks the whole board and the page filters afterwards.
- Proof (mcp-tools): a board with vectors on some cards, a facet that leaves
  only unembedded ones, and a query: the note, no provider call, no meter
  row; a facet that matches nothing: no call, no note. A removal check for
  each.
- Built: the check sits in the query branch, just before the embed (the only
  place money is spent; `similar_to` reads stored vectors and is free). The
  note moved into one `unranked()` that both places return, silent when
  nothing matched. Before, a match of nothing answered 'No cards on "…"
  matched.' followed by "None of the matching cards has been embedded yet".
  The new test shares a `withPaidEmbedder` helper with the Stage 2 MCP test
  instead of a second inline stub.
- Removal checks, 2 of 2 caught: M1 the query embedded before the check, M2
  the note back when nothing matched. Suite: lint clean; unit 2,239 passed, 0
  failed (2 skipped); browser not re-run, since nothing it loads changed
  after its 232/232.
- Not in the running app (needs a rebuild).
