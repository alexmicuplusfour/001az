# Sorted loading: a sorted board fills in without reshuffling (2026-09-30)

**Status: PLANNED 2026-09-30. Stage 1 close-looked, amended and built
2026-09-30, uncommitted (go-ahead: "sure"). Stage 2a close-looked, amended
and built 2026-09-30, uncommitted (go-ahead: "yes"). Stage 2b close-looked,
amended and built 2026-09-30, uncommitted (go-ahead: "go ahead"). Stage 3
close-looked, amended and built 2026-09-30, uncommitted (go-ahead: "go
ahead"). Stage 4, the second pass, done 2026-09-30, uncommitted: five fixes,
the lane's the one you'd see. The arc is complete; nothing is committed.**

Self-contained for a fresh session. Written from a read of the loading and
sort code, plus web research: how other products load a sorted list in
pieces, and where that goes wrong. Parents: `list-pagination-plan.md` (the
first page and the background load this plan replaces) and
`board-sorting-plan.md` (the sorts, all done in the page, which this plan
keeps).

The user's method applies (memory: close look, then build, then a second
pass): one close read of each stage before building it, a fresh-eyes pass
after. The Stage 1 close read is expected to rewrite parts of this document.

Line links show the code as of 8091eb1.

## The ask

"when i sort the gallery on a property other than date added ... you can see
in the gallery the cards shuffling around very fast as new items are received
from the server and moved to the top. what are some robust solutions?"

Then two constraints:

- "i don't want to not render items until the whole board has drained. i
  don't want reshuffling either." Cards show as soon as the first answer
  lands, and a card on screen never moves because more of the board arrived.
- "i don't want it biting me on the ass down the line." Hence the research
  below, and the list of known failures the design is checked against.

## Why it happens

The server knows one order: newest first
([db.js:305](../server/db.js#L305)). Loading a board:

1. The page asks for the newest 200 ([app.js:154](../public/app.js#L154)).
2. `drainItems` fetches the rest, 500 at a time, walking back in time
   ([data.js:521](../public/data.js#L521)), and adds each batch to the end
   ([data.js:507](../public/data.js#L507)).
3. Every batch re-sorts everything loaded so far
   ([filters.js:161](../public/filters.js#L161)), and the grid redraws its
   first 60 cards ([grid.js:604](../public/grid.js#L604)).

Under oldest-first, every batch is older than everything already loaded, so
all of it lands on top. A 5,000-item board shows about 10 different sets of
top cards before the real one, and starts loading pictures for cards that are
replaced a moment later. Every sort except newest-first does a version of
this. So does a connector board that opens on its manifest's sort (market
cap): the page draws in date order first, then re-sorts when
`/api/connectors` lands ([sort.js:313](../public/sort.js#L313)).

board-sorting-plan accepted this ([board-sorting-plan.md:172](board-sorting-plan.md#L172)):
"a correctly-sorted partial list that grows as pages land". The user no
longer accepts it.

The page can't fix this alone. To draw the true top of a sort it needs every
item's sort value first, and today it only learns them as the batches arrive.

A smaller cousin: the newest-first view trusts the order items arrived in. A
poll that brings back an item the load hasn't reached yet puts it at the
front of the list ([data.js:224](../public/data.js#L224)), and it stays at
the top of the newest-first view until a reload.

## What the research says

Other products that load a sorted list in pieces:

- Twitter's timelines store an ordered list of tweet ids, then fetch the
  tweets for a batch of ids in one go.
- Notion's internal table query returns the ordered row ids and a total, with
  the rows in a separate map.
- Immich fetches the library's shape first (months and their counts), then
  loads each month as you scroll. Google Photos also sizes the page from
  counts before the photos load.
- AG Grid, for its scrolling list: "The grid cannot do sorting or filtering
  for you, as it does not have all of the data. Sorting or filtering must be
  done on the server-side."
- PhotoPrism sorts on the server and pages by offset. That's the simple
  version, and the one that goes wrong when data changes (first row below).

What goes wrong, and which decision answers it:

| What goes wrong | Why | Answered by |
|---|---|---|
| Items skipped or shown twice | Paging by a value that changes mid-load: Date updated, Hearts, a live price. Elastic: "If a refresh occurs between these requests, the order of your results may change, causing inconsistent results across pages." | D1, D4 |
| Server and browser order text differently | Postgres orders text by the OS's rules, which change on upgrades. Node and browsers ship different versions of ICU, the library that decides text order. The language changes everything: in the app container, Swedish puts "Åsa" and "Ärger" after "Zebra", and English puts them next to "Aerger". | D2, D3, D5 |
| Engines disagree on a sort | If the compare function isn't consistent (numbers and text mixed in one field), the JS spec leaves the result up to each engine. | D4 |
| An old answer lands after a sort change | A slow earlier fetch finishes after a newer one. | D10 |
| A gap that never fills | An item deleted after the order was taken never arrives. | D3 |
| "414 URI Too Long" | nginx allows 8KB of headers by default, and Cloudflare caps requests at about 16KB on Free/Pro. Other people will run this behind both. | D8 |
| Another board's items leak | A route that takes raw ids is a classic place for it. | D8 |

Checked 2026-09-30 in the running app container: Node 22.23.3 with ICU 78.3
and CLDR 48, every language present (sv, de, ja and fr tried), default en-US.

## The design, plainly

Loading a board becomes:

1. The page asks for the board's first 200 items **in the viewer's sort**.
   It says which sort (the viewer's saved pick, if any) and which language
   it sorts text in.
2. The server settles the sort (the saved pick if it still fits the board,
   else the connector's default, else newest first), puts the whole board in
   that order, and answers with:
   - the first 200 items, whole;
   - for every item on the board: its id, its date added and its sort value
     (its name, date, heart count, file field). A few dozen bytes an item;
   - the sort it applied.
3. The page sorts that list itself. That's the order. The server's order only
   chose which 200 came first.
4. The grid draws cards in that order, **up to the first one that hasn't
   loaded yet**. The first 200 are there, so the first screen draws at once.
5. The page fetches the rest by id, 500 at a time, in its own order. Each
   batch extends the run of loaded cards at the bottom. Nothing above can
   move: every card that sorts above the stopping point is already drawn.

The rule in step 4 does the work. However the server and the browser differ
on order, and whatever arrives late, a card can only be added below what's
drawn. A disagreement costs an extra fetch, never a jump.

After the load finishes, nothing changes from today: every item is in hand,
and sorting, filtering and searching are instant and happen in the page.

Cards still move when something actually changes: a heart, a retag while
sorted by Date updated, a live price. That's a different problem (D12).

## The contract

Confirmed and amended at the Stage 2a close look.

**First page:** `GET /api/items/sorted?board=<id>&by=<key>&dir=asc|desc&locale=<tag>&limit=200`

- Its own address, not the old `?limit=` request (Stage 2a close look,
  finding 1): the page keeps sending that one unchanged until 2b, and a
  first page it didn't ask to be sorted would break its walk back in time.
- No `by`/`dir`: the viewer has no saved pick. The server may still apply the
  connector's default.
- `locale` is `Intl.Collator().resolvedOptions().locale` in the page, so the
  server sorts text in the viewer's language. A tag the server can't use
  falls back to its default.
- `limit` defaults to 200 and is held to 1-500, as the old first page's was.
- The answer: `{ items, keys, sort, now, work }`.
  - `items`: the first `limit`, in the server's order, and every card in
    flight past them (added at the Stage 4 pass: the progress lane draws
    them all, in its own order).
  - `keys`: one entry for every entity on the board, `[id, created_at,
    value]`. Newest-first sends `[id, created_at]`, since the date is the
    value.
  - `sort`: what was applied, or `null` for newest first. `{ by, dir }` for
    the viewer's own pick, whose label the page already has; `{ by, dir,
    label }` when the server picked the connector's default, whose name the
    page doesn't know yet at boot.
  - `now` and `work`: as today.
- A board the viewer can't see answers 404 (the old request answered `[]`).
- `nextCursor` and `&after=` go away with the old paging request (D9).

**Batch:** `POST /api/items/batch` with `{ board, ids }`, at most 500 ids.

- The answer: `{ items }`, the whole items for the ids that are on that
  board. Missing ids are simply absent. No ids, no query: `{ items: [] }`.
- Ids must be positive whole numbers, at most 500 (else 400). A board the
  viewer can't see answers 404. `listItems`' `ids` mode already scopes to
  the board ([db.js:278](../server/db.js#L278)).

**Unchanged:** the poll (`?since=`). (The plan had its id list drop the keys
of deleted items too; the Stage 2b close look found the load doesn't need
it, D3.)

## What's there to build on

- `listItems` already takes a list of ids
  ([db.js:278](../server/db.js#L278)); the MCP tools use it
  ([mcp-tools.js:713](../server/mcp-tools.js#L713)).
- The server already imports pure page modules: facet-match.js
  ([alerts.js:8](../server/alerts.js#L8)) and cluster-core.js
  ([server.js:170](../server/server.js#L170)). A shared sort module takes the
  same path.
- The server has every connector manifest, `browse.defaultSort` included
  ([connectors/index.js:131](../server/connectors/index.js#L131)), so it can
  settle the sort a board opens on.
- The server already computes every sort value in the items it ships:
  hearts, file count, connector fields, the file metadata. The one exception
  is Name, which the page derives in `toItem`
  ([utils.js:28](../public/utils.js#L28)).
- search.js guards against stale answers (`searchReq`); the load's
  generation number follows that pattern.
- The poll's answer carries every entity id on the board
  ([data.js:396](../public/data.js#L396)).
- Every view draws from one filtered list through batches.js. The cut in
  step 4 lives in that list, so the grid, List, Rows, the lightbox and the
  count all see the same thing.

## Decisions (for the close reads to confirm or overturn)

- **D1: one list of sort values per load, not pages by cursor.**
  - A cursor on a value that changes mid-load skips or repeats items (the
    research), and Date updated, Hearts and prices all change. The list is
    taken once, every id in it is fetched exactly once, and changes during
    the load arrive through the poll, as today.
  - Precedent: Elastic's "point in time", a frozen view you page through.

- **D2: the page is the one judge of order.**
  - The server's order picks the first 200 and nothing else. The page sorts
    the keys with its own compare function and fetches in that order.
  - Why: text order can differ between Node and the browser (versions,
    language). Correctness must not depend on the two agreeing.

- **D3: draw only up to the first card that hasn't loaded.**
  - The filtered, sorted list is cut just before the first key that hasn't
    loaded. A filter, a crate or an alert's `?event=` view just picks cards
    inside the cut, so they fill in at the bottom as the load goes on. (All
    but one, found at the Stage 3 close look: the tag-clusters lens, whose
    groups are carved from the cards loaded so far. See Risks.)
  - No cut while a search is on: its hits are fetched first (D11), and its
    order is by score, not by the sort.
  - Every id a batch asked for leaves the queue when the batch answers,
    whether it came back or not. A card deleted after the keys were taken
    just comes back missing, so the cut can't stop at it. (Amended at the
    Stage 2b close look: the load asks for every card once, in order, so the
    poll's id list isn't needed, and the poll doesn't touch the queue. A card
    the poll brings early waits past the cut for its batch, the next one.)

- **D4: one compare function, in one file, shared by the server and the
  page.**
  - Empty values last in both directions, numbers before text, numbers by
    value, text by the viewer's language. Ties go by date added (newest
    first), then id. Never by the order items arrived in.
  - A card with no date added yet counts as newest. (Amended at the Stage 1
    close look: the case is a card added from connector browse, whose row
    carries no date until the next poll, not an upload; uploads carry one.)
  - It lives in a new `public/sort-core.js` (the cluster-core.js precedent),
    beside the sort value of an item. The other pure pieces (the Name
    derivation, whether a saved sort fits a board, the connector default,
    the built-in sort entries) join it in Stage 2a, with the server code that
    first calls them (amended at the Stage 1 close look).
  - The same tiebreak orders search ties and the progress lane (amended at
    the Stage 1 close look).

- **D5: text is sorted in JS on both sides, never by Postgres.** Postgres's
  text order depends on the OS it runs on and changes on upgrades.

- **D6: the server settles the sort and says what it applied.**
  - The saved pick if it fits the board's mapping; else the connector's
    `defaultSort` if the board binds that field; else newest first. One
    function in sort-core.js, called by the server at load and by the page
    after a mapping save ([toolbar.js:364](../public/toolbar.js#L364)).
  - That removes the date-first draw on connector boards: the first answer
    is already in market-cap order.

- **D7: sort values come from the code that builds the items.**
  - For every sort except newest-first, the server builds the whole-board
    listing (`listItems` with no limit), reads each value with sort-core.js,
    and slices the first 200 from it. No SQL per sort key and no stored
    copies, which would each be a second place to keep right.
  - Newest-first reads the two columns and keeps today's first-page query.
  - The cost: one whole-board pass on the server per sorted load (Risks).

- **D8: batches go by POST, at most 500 ids, checked against the board.**

- **D9: one loader for every order.** Newest-first uses the same keys and
  batches. The old paging request (`?limit=`, `&after=`, `nextCursor`,
  `listItems`' `after`) is deleted in 2b, once nothing uses it. (Stage 2a
  close look: a tab left open across that deploy then falls through to the
  route's whole-board answer, which the old page already boots from.)

- **D10: changing the sort while the board is loading.**
  - A new sort asks for its own first page and keys. The old order stays on
    screen until that answer lands, then the page swaps once.
  - That includes flipping the direction and going back to newest first.
    (Amended at the Stage 2b close look. The plan had them skip the request,
    since the keys hold the values and the dates. But the cards loaded are
    the top of the old order, the new order starts with a card that hasn't
    loaded, and the cut drew nothing until the next batch.)
  - Each change takes a number when its request goes out. An answer that
    isn't the latest does nothing, and the batch loop of an older number
    stops (search.js's pattern). (Amended at the Stage 2b close look: the
    plan numbered answers as they landed, so of two quick changes the slower
    one won.)
  - One door: the menu, List's headers and a mapping save all change the
    sort through it.
  - After the load finishes, sorting stays in the page, as today.

- **D11: search and links fetch what they need.**
  - A search's hits (at most 60) that haven't loaded are fetched before the
    results show; otherwise they'd pop in by score as the load reaches them.
    "Similar by tags" ranks loaded items only, as today.
  - The fetch sits in `fetchResults`, which both server searches go through,
    so each one's check for a newer search covers the wait. The fetched
    cards leave the load's queue alone, as the poll's do (D3). A fetch that
    fails still shows the search. (Amended at the Stage 3 close look.)
  - `?item=` fetches its item at once, instead of watching the load for up
    to a minute ([app.js:321](../public/app.js#L321)). A card deep in the
    board opens on its own, past what's drawn; a card that's gone says so.
    (Amended at the Stage 3 close look.)

- **D12: not in this plan.**
  - Holding cards still when something actually changes (the "Re-sort"
    pill idea).
  - A lighter values-only query for very large boards, only if D7's pass
    shows up.
  - Fetching an alert's items ahead of the load: the cut already keeps
    `?event=` in order, and it fills in as the load goes.

## Stages

### Stage 1: one order, written once

(Close-looked 2026-09-30 and amended. Go-ahead the same day: "sure", which
also accepts finding 1's upload order.)

**Stage 1 close look (2026-09-30): what the plan assumed vs what the code
does.**

1. Assumed nothing visible changes on a normal load. Every file in one
   upload request gets the same date
   ([ingest.js:145](../server/ingest.js#L145)), and the page puts the first
   file picked on top ([upload.js:150](../public/upload.js#L150)). Sorted by
   date, the tie goes by id, so a batch shows the last file picked on top:
   the order a reload shows today, now shown from the start. The progress
   lane kept picked order ([data.js:107](../public/data.js#L107)), so a batch
   would have flipped moving from the lane to the grid. The lane now sorts
   each of its groups by date added too (it had been parked for 2b).
2. The plan didn't mention the tests that pin the old order: about 17
   assertions. board-sort.test.js checks that no sort keeps the array's
   order ([board-sort.test.js:144](../test/board-sort.test.js#L144));
   cached-counts.test.js and lane.test.js build cards with no date and check
   array order ([cached-counts.test.js:94](../test/cached-counts.test.js#L94),
   [lane.test.js:65](../test/lane.test.js#L65)). Where a test is about which
   cards show, it compares without order; where it's about order, its cards
   get dates.
3. Stage 1 moved four pieces nothing in Stage 1 uses: the Name derivation,
   whether a saved sort fits, the connector default, the built-in entries.
   They move in 2a with the server code that first calls them, and the Name
   proof moves with them.
4. Search ties fell back to arrival order too
   ([filters.js:160](../public/filters.js#L160)); "Find similar" by tags
   ties often. Same tiebreak.
5. The dateless card is real but comes from connector browse
   ([connectors/add.js:35](../server/connectors/add.js#L35)), not uploads,
   which carry a date ([ingest.js:180](../server/ingest.js#L180)). It shows
   in the grid only with the Processing or Queued pill on. D4 reworded.
6. The pure tests go in a new test/sort-core.test.js loaded with no browser
   stub, like cluster-core.test.js and facet-match.test.js. Loading it bare
   is proof 5. board-sort.test.js loads the stub first, so it can't show it.
7. Ingestion has a third copy of the rule
   ([filter-engine.js:72](../server/ingestion/filter-engine.js#L72)), and
   sort.js's header said the two matched. Left alone: it picks which feed
   entries a run takes in, by the field's declared type, and changing it
   changes what boards ingest. sort.js's comment is corrected. Recorded, not
   fixed: its number sort turns a text value ("N/A" from a plugin) into NaN,
   which the sort treats as equal to everything, so the pick order depends
   on the engine.
8. Small: connectors/add.js sends a `displayLabel` the page ignores
   ([add.js:41](../server/connectors/add.js#L41)), a second copy of the Name
   rule; dropped in 2a when the rule moves. The newest-first view now sorts
   each time its list is rebuilt, as every other sort already did.

Checked and fine: connector values reach the page as the provider sent
them ([runtime.js:378](../server/connectors/runtime.js#L378)), plugins
included, so one field can mix numbers and text; a new public/ file needs
no build or lint setup; the lightbox paging tests read the order from the
page; clustering refuses to depend on arrival order
([patterns.js:137-140](../public/patterns.js#L137-L140)).

- **What:** `public/sort-core.js`, pure (no state, no fetch, no storage):
  the sort value of an item and the compare function (D4), with the
  tiebreak (date added, newest first, then id) exported on its own. sort.js
  sorts with it, and with no sort chosen it sorts by Date added, newest
  first, instead of trusting the array's order
  ([filters.js:161](../public/filters.js#L161),
  [sort.js:249](../public/sort.js#L249)). Search ties and the progress
  lane's groups use the tiebreak. List reads the sort value from
  sort-core.js.
- **What the user sees:** a batch you upload shows the last file picked on
  top, in the lane and in the grid (the order a reload shows). A card the
  poll brings back mid-load lands in its place, not at the top. Ties, and
  fields that mix numbers and text, come out the same way every time.
- **Proofs:**
  1. Newest-first ignores arrival order: a card the poll brings back that
     is older than what's loaded sorts into its place, through the real
     poll (cached-counts.test.js).
  2. A field mixing numbers and text sorts the same way from 50 shuffled
     starting orders, numbers first (sort-core.test.js).
  3. A card with no date added sorts as newest (sort-core.test.js).
  4. Ties go newest first, then by id, whatever order they arrive in
     (sort-core.test.js).
  5. The server can import sort-core.js: sort-core.test.js loads it with no
     browser stub.
  6. The lane orders each group by date added, not arrival
     (lane.test.js).
  7. Search ties go newest first (cached-counts.test.js).
  8. With no sort chosen, applyBoardSort orders by date added
     (board-sort.test.js).
- **Removal checks:** each change taken out and its test watched failing.

**Built (2026-09-30), uncommitted:**

- `public/sort-core.js` (new): `sortValue` (moved from sort.js),
  `newestFirst` (the tiebreak), `compareItems(sort, collator)`. The page's
  collator is one `new Intl.Collator()`, which is what `localeCompare` used,
  so text order is unchanged.
- sort.js (CRLF kept): `applyBoardSort` sorts by the chosen sort, or by Date
  added, newest first, with none chosen. Its header no longer claims
  ingestion's rule.
- filters.js: search ties go newest first. data.js: `inProgress` sorts the
  in-flight cards newest first before splitting them into groups. list.js
  reads `sortValue` from sort-core.js.
- Tests: test/sort-core.test.js (new, 6 tests). board-sort.test.js (CRLF
  kept): the `sortValue` and text tests moved to sort-core.test.js, the
  no-sort test restated. cached-counts.test.js: its test cards are dated
  newest first in id order, the way the server sends a board; the new card
  from the poll is dated newest; 2 new tests (proofs 1 and 7). lane.test.js:
  the lane test's cards are dated and its order restated; the status-gate
  tests compare which cards show, without order.

Found while building (the close look's count missed a fourth file): the
first full run failed cards.test.js's two Shift-click tests. They draw the
first 60 of a 70-card board and click cards 3 and 5; undated, those cards
sat past the first batch under the new rule. cards.test.js's test cards are
now dated like cached-counts', and its List test sets its dateless card
explicitly (its message now names connector adds, not uploads). The same run
failed ui-updates.test.js:616, a menu caret read after a fixed 250ms wait for
its 0.12s turn: unrelated to sorting, and green when run alone. A load flake
from a sleep-based wait, the kind the CI-flakes note says to replace with a
condition wait; recorded, not fixed here.

Removal checks, each fix taken out and its test watched failing (a script
restored every file byte-identical after each):

| removed | failed |
|---|---|
| R1: no sort chosen trusts the array again | board-sort "with no sort chosen…", cached-counts "a poll that brings back an old card…" |
| R2: mixed numbers and text compared as text (the old rule) | sort-core "a field mixing numbers and text…" |
| R3: a dateless card not counted as newest | sort-core "a card with no date added…" |
| R4: no tiebreak | sort-core: the empty-values, mixed, dateless and ties tests |
| R5: the lane keeps arrival order | lane "inProgress: … each newest first" |
| R6: search ties keep arrival order | cached-counts "a search's equal scores…" |
| R7: sort-core touches a browser-only global | sort-core.test.js fails to load |

Lint clean (`eslint .`). Full suite green after the cards.test.js fix:
2,231 of 2,231.

Real-app check (Chromium, the real server on a throwaway database, a
scratchpad script through test/browser/harness.js; HEAD's public/ served as
FRONTEND_DIR for the old run): three files picked in one go, read off the
grid right after the upload and again after a reload.

| frontend | after the upload | after a reload |
|---|---|---|
| HEAD | a, b, c | c, b, a |
| Stage 1 | c, b, a | c, b, a |

No page errors in either, the cached-counts check included. The lane isn't
shown there (the harness board has auto-tagging off, so a file lands
finished); lane.test.js covers it.

### Stage 2a: the server answers in the viewer's order

(Close-looked 2026-09-30 and amended. Go-ahead the same day: "yes".)

**Stage 2a close look (2026-09-30): what the plan assumed vs what the code
does.**

1. Assumed the new first page could ride the old `?limit=` request. The page
   doesn't change until 2b: it sends `?limit=200` with no sort
   ([app.js:154](../public/app.js#L154)), then walks back in time from the
   last card it got ([data.js:532](../public/data.js#L532)). A first page in
   market-cap order would start that walk from the wrong card and never
   fetch some items. The new first page gets its own address,
   `GET /api/items/sorted`, so 2a only adds; 2b deletes the old paging
   request. Then a tab left open across that deploy falls through to the
   whole-board answer the old page already boots from, not a partial board.
2. Proof 1 compared the server's sort with sort-core.js, the code the server
   sorts with, so it could only prove the slice. Small hand-built boards
   with the expected order written out, per kind of sort, instead.
3. 600 cards aren't needed: the new address takes `limit`, and `limit=3`
   over a handful of cards makes the first page a real slice.
4. The label: the server can only name a sort it picked itself (the
   connector default, named in its manifest). Naming the viewer's own pick
   would copy the page's menu naming onto the server. `sort` carries a label
   only when the server picked it.
5. The connector default looked the field up by the wrong name: restoreSort
   finds the field whose key equals the manifest's field name
   ([sort.js:296](../public/sort.js#L296)). Keys equal names for connector
   fields today, so nothing showed; moved, it matches on the name and sorts
   by the field's key, with a test that renames a key.
6. Where the code goes: settling needs the connector list, and db.js can't
   import it (connectors/index.js imports db.js,
   [connectors/index.js:8](../server/connectors/index.js#L8)), so the route
   settles. A new `listItemsSorted` beside `listItems` builds the order and
   the keys (db.js's first import from public/; alerts.js and server.js
   already import from there). It sorts copies carrying the Name, so the
   items sent stay exactly what `listItems` built.
7. A garbled language tag throws in `new Intl.Collator`, so it falls back.
   One collator per request, not a cache: a cache keyed by whatever tag a
   client sends could grow without end.
8. Batch: no ids answers `{ items: [] }` without a query; ids must be
   positive whole numbers, at most 500 (else 400); a board the viewer can't
   see answers 404, where the old GET answered `[]` (2b's page handles it).

Checked and fine: `listItems`' ids mode is scoped to the board it's given;
JSON bodies are parsed app-wide ([server.js:353](../server/server.js#L353))
and 500 ids fit the default 100KB; no route clashes with the two new
addresses; utils.js imports nothing and loads in Node, so `toItem` can take
the Name rule from sort-core.js and the tests can check keys against it;
nothing reads the `displayLabel` connectors/add.js sends; `listConnectors()`
is synchronous and carries `browse.defaultSort`.

- **What:** `GET /api/items/sorted` (the contract above): the route settles
  the sort and `listItemsSorted` (db.js) builds the order (D7) and the keys;
  the answer is the first `limit` items, every key and the applied sort. Plus
  `POST /api/items/batch`. The old paging request is untouched until 2b, so
  the page keeps working unchanged.
- **Moves into sort-core.js here** (from the Stage 1 close look): the Name
  rule (`toItem` takes its label from it), the built-in sort entries, the
  card mode, whether a saved sort fits a mapping, the connector default
  (matched by field name), and settling the sort. The unused `displayLabel`
  in connectors/add.js goes.
- **Proofs** (a new test/sorted-items.test.js against the real server, plus
  sort-core.test.js):
  1. Per kind of sort (date added both ways, date updated, hearts, files, a
     connector number field, a connector text field, a file number, a file
     date, Name), `limit=3` returns the hand-written first three, and the
     applied sort comes back.
  2. Every entity has a key, and each key's value equals what the page's
     own `toItem` and `sortValue` make of its item, so a card can't move
     when its item lands.
  3. Name follows the language: with `locale=sv`, "Åsa" comes after
     "Zebra"; with `en`, before it.
  4. Settling: the viewer's pick comes back as asked, with no label; a field
     pick the mapping dropped falls back to the connector default, with its
     manifest label; a board that doesn't bind that field falls back to
     newest first. A garbled `locale` still answers. The connector default
     matches a renamed key by field name (sort-core.test.js).
  4b. The Name rule matches `toItem`'s label in its four cases (AI name,
     derived identity, original filename, stored filename)
     (sort-core.test.js).
  5. Batch: returns only that board's items (another board's ids come back
     absent), leaves out a deleted id, refuses more than 500 and non-numbers,
     answers `{ items: [] }` for none, and 404 for a board the viewer can't
     see.
- **Removal checks:** each fix taken out and its test watched failing (the
  language, the board check, the 500 cap, the fallbacks, the sort before the
  slice, the Name in the keys, the field-name match).

**Built (2026-09-30), uncommitted:**

- `public/sort-core.js` gains `UNIVERSAL`, `INSTANCES_ENTRY`, `cardMode`,
  `defaultDir`, `labelOf`, `boundFields`, `boardConnector`, `validSort`,
  `connectorDefault` (by field name) and `settleSort`. sort.js (CRLF kept)
  calls them with `state.boardMapping`; its own copies are gone, and
  `restoreSort`'s connector branch is one `connectorDefault` call.
  utils.js (CRLF kept): `toItem` names cards with `labelOf`.
- server/db.js (CRLF kept): `listItemsSorted` beside `listItems`.
  server/server.js (CRLF kept): `collatorFor`, `GET /api/items/sorted`,
  `POST /api/items/batch`. server/connectors/add.js: the unused
  `displayLabel` is gone.
- Tests: test/sorted-items.test.js (new, 6 tests: every proof but 4b and the
  renamed key); sort-core.test.js +4 (the Name rule, the connector default,
  settling, and `defaultDir`, moved from board-sort.test.js).

Removal checks, each fix taken out and its test watched failing (a script
restored every file byte-identical after each):

| removed | failed |
|---|---|
| R1: the viewer's language ignored | "Name follows the viewer's language" |
| R2: the batch loses its board | "batch: … nothing else" |
| R3: no 500 cap | "batch: … nothing else" |
| R4: ids not checked as whole numbers | "batch: … nothing else" |
| R5: the GET answers `[]` for a board the viewer can't see | "a board the viewer can't see answers 404" |
| R6: settling drops the connector default | the route's and sort-core's settling tests |
| R7: settling ignores the viewer's pick | 5 tests: every first page, the keys, the language, both settling tests |
| R8: the first page cut before sorting | every first page, the language, settling |
| R9: keys read from the rows without the Name | "every entity has one key…" |
| R10: sorted without the Name | every first page, the keys, the language, settling |
| R11: the connector default matched by key, not the manifest's name | "the connector default finds its field by the manifest's name…" |
| R12: newest first through the whole-listing path | every first page, the keys, settling |

Not pinned by a test: an empty id list skipping the query. It answers the
same either way; it only saves `listItems`' board-level face and crate
queries.

Lint clean (`eslint .`). Full suite: 2,238 of 2,240. The two failures were
the ui-updates.test.js:616 caret flake from Stage 1 and welcome.test.js:291
(the boards page's loading screen read the moment the page lands, the race
recorded in the list-view arc); both files pass alone, 31 of 31. The
production build (`npm run build:frontend`) builds and verifies, and
boot, list-view and card-faces pass against it (`FRONTEND_DIR=public/dist`,
12 of 12): `toItem` now imports sort-core.js on every page.

### Stage 2b: the page loads in its own order and draws only what's settled

(Close-looked 2026-09-30 and amended. Go-ahead the same day: "go ahead".)

**Stage 2b close look (2026-09-30): what the plan assumed vs what the code
does.**

1. Assumed flipping the direction, or going back to newest first, needed no
   request (D10). The cards loaded are the top of the old order, so the
   flipped order starts with a card that hasn't loaded, and the cut drew
   nothing: "No items match these filters" until the next 500 landed. Every
   sort change during the load now asks for its own first page.
2. D10 numbered each answer as it landed, so of two quick changes the slower
   answer won. The number is taken when the request goes out, and an answer
   that isn't the latest does nothing (search.js's `searchReq`,
   [search.js:9](../public/search.js#L9)). The same number stops the old
   batch loop.
3. The proofs as written pass without the cut. Fetched in the page's order,
   each batch already sorts below what's drawn. The cut matters only when a
   card arrives early: the poll or another member's change bringing one the
   load hasn't reached (on a live price board, every refreshed card), the
   cards left from the old order after a sort change, a name the browser and
   the server order differently. And the grid draws 60 cards, which the first
   page of 200 covers. The same for the numbering: the cut hides whatever an
   old loop brings. So the proofs filter to a value few cards carry (the
   drawn list then reaches the cut), heart a card from a second member
   mid-load, and hold the first of two quick sort changes.
4. The sort had two writers. A mapping save calls `restoreSort`
   ([toolbar.js:364](../public/toolbar.js#L364)), which set the sort
   directly and still needs the connector's default (D6), though the plan
   dropped that branch. It stays: it settles with `settleSort` and the
   cached connector list, and goes through the same door as the menu. Its
   test stays in board-sort.test.js (2a already tests the server's
   settling).
5. The poll needn't touch the keys: the plan had batches and the poll both
   take ids out, and the poll's id list drop deleted ones. The load asks for
   every card once, in order, so each batch's ids leave the queue when it
   answers, whatever came back. A card the poll brought early waits at most
   for that batch, the next one. `reconcile` is unchanged.
6. `compareItems` reads cards, and a key is `[id, date, value]`. sort-core.js
   gains `keyOf` (a card's key) and `compareKeys`, sharing one compare body
   with `compareItems`, instead of the page dressing keys up as cards.
7. Tests the plan's list missed. first-class-work.test.js
   ([:116](../test/first-class-work.test.js#L116)) reads `work` off the old
   first page, which now answers with the whole board; it moves to the sorted
   route. events.test.js's `&limit=200`
   ([:344](../test/events.test.js#L344)) goes. `listItems` keeps `limit`,
   since the newest-first first page uses it, so list-pagination.test.js
   keeps its tie check; only the cursor walk and `after=` go.
8. The real-app check named the ui board, the user's real data, and driving
   it takes a login in the real database, which isn't done. A ~5,000-card
   board in a throwaway database instead; the user can look at the ui board.

Small: a sort change that fails during the load keeps the old sort and says
so; List's spoken "Sorted by …" follows the swap, not the click; while a
filter's matches are still loading, the grid says "No items match these
filters", as today, and that stays.

Checked and fine: the saved pick can be read before the boot request
(localStorage); uploads and connector adds are always new cards, never among
the keys; deleting a card on the page doesn't touch the load; the progress
lane reads every card, not the cut; a card past the cut opened by `?item=`
opens on its own in the lightbox ([lightbox.js:908](../public/lightbox.js#L908));
no browser test builds a board over 200 cards, so none runs the load today;
answers are gzipped.

- **What:**
  - Boot reads the saved pick (localStorage) before its first request, asks
    `GET /api/items/sorted` with it and the language, and adopts the sort
    the answer applied: the pick, with its label, when the server kept it,
    else the server's own. `restoreSort` no longer runs at boot.
  - The page keeps the keys of the cards it hasn't loaded in its own order
    (`state.unloaded`: a state field, so the cached list sees it change).
  - The filtered list is cut just before the first of them (D3); no cut
    under a search.
  - The load fetches the next 500 by POST, in order. Each answer takes its
    ids off the queue, whatever came back. A failed batch gets one retry,
    then the load stops at the cut.
  - The sort changes through one door (`setSort`; `restoreSort` after a
    mapping save): at once with the whole board here, else D10.
  - The cursor goes: `drainItems` and its append, `nextCursor` in app.js,
    `?limit=`/`&after=` in the route (a `?limit=` request from an older page
    now gets the whole board, which it boots from), and `after` and
    `nextCursor` in `listItems`, which keeps `limit`.
- **What the user sees:** a sorted board draws its true top at once and
  fills in below; nothing on screen moves. A connector board opens on market
  cap with no date-order flash. The count climbs during the load, as today.
  A sort change during the load keeps the old order on screen until the new
  one's first page lands.
- **Proofs:**
  - Browser (a new test/browser/sorted-load.test.js; real server, Chromium):
    a board of 1,200 cards, 1 in 10 tagged red and filtered to red, so the
    drawn list reaches the cut. The batch requests are held and let go one
    at a time. Every frame, the test records the ids of the drawn cards.
    1. Oldest first, with a heart from a second member landing mid-load on
       a card the load hasn't reached: each frame's list is the start of the
       next one (cards are only ever added at the end), and the first cards
       drew before the load finished.
    2. Name, the same.
    3. A sort change to Hearts mid-load: the list changes once, when its
       answer lands, then only grows.
    4. A flip mid-load (oldest first to newest first): no frame is empty.
    5. Two quick changes, Hearts then Name, with Hearts' answer held until
       Name's lands: the page ends on Name.
    6. A card deleted after the keys were taken: the load finishes and the
       count reaches the rest of the board.
    7. A connector board with no saved pick: the first cards drawn are in
       market-cap order.
  - Unit (a new test/sorted-load.test.js, the DOM stub): the load asks for
    the cards in the page's order, 500 at a time; a sort change that fails
    keeps the old sort and the load goes on; a mapping save during the load
    goes through the door.
  - Existing tests: cached-counts' drain test becomes a batch;
    list-pagination loses the cursor walk; first-class-work reads `work` off
    the sorted route; board-sort's `restoreSort` tests wait for it.
- **Removal checks:** without the cut, 1-3 fail; a flip without a request, 4
  fails; answers numbered as they land, 5 fails; only the ids that came back
  leave the queue, 6 fails; boot not adopting the answer's sort, 7 fails; a
  failed change that doesn't carry on the load, and a mapping save that sets
  the sort directly, each fail their unit test.
- **Real-app check:** a ~5,000-card board in a throwaway database, oldest
  first and by Name, and a connector board with no saved sort. The user can
  look at the ui board.

**Built (2026-09-30), uncommitted:**

- `public/sort-core.js`: `NEWEST` (moved from sort.js), `adoptSort`, `keyOf`
  and `compareKeys` (one compare body with `compareItems`), `viewerLocale`.
- `public/data.js`: the load replaces the cursor walk: `fetchSorted`,
  `loadRest`, the batch loop, `resortLoading` (D10) and `cutAtLoad`. The
  queue is `state.unloaded` (state.js, CRLF kept). filters.js cuts the
  board's sorted list with `cutAtLoad`; a search's isn't cut.
- `public/sort.js` (CRLF kept): one door (`useSort`); `setSort` saves once
  the sort is in effect; `storedSort` for boot; `restoreSort`, now only
  after a mapping save, settles with `settleSort` and goes through the door.
- `public/app.js`: boot sends the saved pick with its first request, adopts
  the answer's sort, and puts the queue in before the first draw; the lazy
  chunks warm after the load. list.js: the spoken "Sorted by …" waits for
  the sort to be in effect.
- server/server.js (CRLF kept): `/api/items` loses its `?limit`/`&after`
  branch. server/db.js (CRLF kept): `listItems` loses `after` and
  `nextCursor`, and keeps `limit`.
- Tests: test/sorted-load.test.js (new, 7 unit tests),
  test/browser/sorted-load.test.js (new, 7 browser tests), sort-core.test.js
  +2 (adopting a settled sort; a card compares as its key does, in every
  kind of sort). cached-counts' drain test is a batch; list-pagination keeps
  its newest-first tie check and adds `?limit=` answering the whole board;
  first-class-work reads `work` off the sorted route; events.test.js drops
  `&limit=200`; board-sort's `restoreSort` tests wait for it; cards.test.js
  waits a tick for List's note. test/browser/harness.js exports its `PIXEL`.

Removal checks, each fix taken out and its test watched failing (a script
restored every file byte-identical after each):

| removed | failed |
|---|---|
| B1: no cut | browser: oldest first, by Name, the change to Hearts, the flip; unit: the cut, the quick changes, the flip |
| B2: a flip without a request (the plan's old D10) | browser and unit: the flip (an empty frame) |
| B3: a change numbered when its answer lands | browser and unit: the two quick changes |
| B4: only the ids that came back leave the queue | browser and unit: the deleted card |
| B5: boot keeps the saved pick, not the answer's sort | browser: the connector board |
| B6: the old batch loop carries on after a change | unit: the quick changes (a card asked for twice) |
| U1: a failed change doesn't carry on the load | unit: the failed change |
| U2: a mapping save sets the sort directly | unit: the mapping save |
| U3: the queue left in the server's order | unit: the load's order, the cut, the quick changes |
| C1: keys compared without the tiebreak | sort-core: a card compares as its key does |

Not pinned by a test: List's spoken note waiting for the swap during a
load (cards.test.js checks it with the board all here).

The browser proofs' frames, to show they have something to catch: oldest
first and by Name, the drawn list went 20, then 60 cards; the change to
Hearts 20, 44 (the swap), 60; the flip 20, 20 (the swap), 60.

Lint clean. Full suite: 2,256 of 2,256. The production build builds, and
boot, list-view, card-faces, list-columns and the new sorted-load pass
against it (`FRONTEND_DIR=public/dist`, 29 of 29).

Real-app check (Chromium, the real server on a throwaway database: a
5,000-card board with names in several languages' letters, added in a
shuffled order, and a 600-card stocks board with no saved sort; nothing
held, only the pictures stubbed). The same script ran against a copy of HEAD
for the before. Each frame the page recorded the cards drawn:

| board, sort | HEAD: screens drawn, reorders | 2b: screens drawn, reorders |
|---|---|---|
| 5,000 cards, oldest first | 11, 10 | 1, 0 |
| 5,000 cards, by Name | 11, 10 | 1, 0 |
| 5,000 cards, newest first | 1, 0 | 1, 0 |
| stocks, no saved sort | 3, 2 (date order first) | 1, 0 (market cap, the right top five) |

In every 2b case the first cards drew before the load finished, and no page
errors, the cached-counts check included.

### Stage 3: search and links fetch what they need

(Close-looked 2026-09-30 and amended. Go-ahead the same day: "go ahead",
which also takes the toast for a link to a card that's gone.)

**Stage 3 close look (2026-09-30): what the plan assumed vs what the code
does.**

1. Assumed `runSearch` and `runSimilarMeaning` would each fetch their
   missing cards "inside the existing stale guard". Both go through one
   function, `fetchResults` ([search.js:13](../public/search.js#L13)), and
   each checks for a newer search right after it
   ([search.js:30](../public/search.js#L30),
   [:92](../public/search.js#L92)). A card fetch placed after that check
   would let a search whose cards land late overwrite the one typed after
   it. The fetch goes inside `fetchResults`: one copy, and the existing
   checks cover the wait.
2. A link to a card deep in the board opens it on its own. The lightbox
   takes its list from what's drawn
   ([lightbox.js:906-908](../public/lightbox.js#L906-L908)), and a card past
   the cut isn't in it: no arrows and no count while it's open. After 2b the
   link waited for the load and opened with arrows. Accepted: the link is
   about that card, and it opens at once. Closing it goes to its place once
   the load has reached it ([batches.js:85](../public/batches.js#L85)).
3. A link to a card that's gone: the page watched the load for a minute,
   then gave up without a word and left `?item=` in the address. The fetch
   knows at once. A plain toast says "That card isn't on this board any
   more" (the filters' wording for a value that's gone,
   [filters.js:451](../public/filters.js#L451)), and `?item=` is removed
   either way. A request that gets no answer says "Couldn't open that card",
   never "gone" (the line api.js draws between a refusal and no answer,
   [api.js:16](../public/api.js#L16)).
4. The proofs missed Find similar by meaning (its fetch could go and nothing
   would fail) and the order in finding 1. The search proof has teeth only
   with its results past the first page and the load held. The results'
   fetch goes to the load's address, so the test holds the load's requests
   and lets the other through by its ids. The test cards have no
   embeddings, so the test answers `/api/search` itself. No test opened an
   `?item=` link before.
5. The plan didn't say what the fetched cards do to the load's queue.
   Nothing, the poll's rule (D3): they join the board and wait past the cut,
   and their batch asks for them again and keeps the page's copy
   ([data.js:554](../public/data.js#L554)). At most 60 cards asked for
   twice, and the queue keeps one writer.
6. No real-app check was planned. One is below.
7. Found outside this stage: the tag-clusters lens carves its groups from
   the cards loaded so far, and again as each batch lands
   ([patterns.js:264-280](../public/patterns.js#L264-L280)), on purpose.
   During a load its row changes, and with a cluster picked, cards on screen
   come and go. D3's "a filter just picks cards inside the cut" holds for
   every filter but this one. Older than this plan; recorded in Risks, not
   fixed here.

Small: the link opens the card the page holds, looked up after the fetch
(`addItems` keeps the first copy, [data.js:556](../public/data.js#L556)),
the one that gets live updates; boot doesn't wait for the link's fetch (the
`#jobs` link is set up after it, [app.js:350](../public/app.js#L350)); a
card fetch that fails still shows the search, the query having been a paid
call ([server.js:3228](../server/server.js#L3228)), and its missing cards
join as the load reaches them, the one case where they still pop in; one
helper in data.js asks for cards by id, for the load, the searches and the
link; the minute-long watcher goes, and with it app.js's last use of
`itemsVersion`.

Checked and fine: the two searches cap their results at 60 and 50
([server.js:3239](../server/server.js#L3239),
[:3269](../server/server.js#L3269)), so one request covers them; result ids
arrive as numbers ([db.js:19](../server/db.js#L19)); search.js can import
data.js without a loop; Find similar by tags scores only the cards in hand,
fixed at the click, so nothing pops in
([patterns.js:368](../public/patterns.js#L368)), and during a load it now
ranks the top of the sort rather than the newest cards; a search isn't cut
([filters.js:164](../public/filters.js#L164)), and once it's cleared the
fetched cards past the cut wait there for their batch; the test boards have
a search box, the flag being the app's embedder
([server.js:1230](../server/server.js#L1230)); opening the lightbox when
the fetch lands keeps it out of the page's draw (what the watcher's
`queueMicrotask` was for); `?event=` stays as planned (D12).

- **What:**
  - data.js: one helper asks for cards by id (the load's batches use it),
    and `fetchItems(ids)` fetches the ones the page doesn't have and adds
    them to the board, leaving the queue alone. False when the request got
    no answer.
  - search.js: `fetchResults` fetches its results' cards before it returns,
    so both server searches show every result together; each caller's check
    for a newer search covers the wait. A failed fetch still shows the
    search.
  - app.js: `?item=` fetches its card (nothing to fetch when it's loaded),
    removes the param, and opens the page's copy; else a toast, gone or
    couldn't open. Boot doesn't wait for it. The minute-long watcher goes.
- **What the user sees:** a search typed while the board loads shows all
  its results at once, in score order, and nothing pops in after. A link to
  a card opens it at once; one deep in the board opens on its own (no
  arrows) while the board loads. A link to a card that's gone says "That
  card isn't on this board any more".
- **Proofs:**
  - Browser (test/browser/sorted-load.test.js, the 1,200-card board, the
    load's batches held):
    1. A search typed mid-load, its answer given by the test (30 results,
       25 past the first page): the first frame with results holds every
       one, in score order, and no frame after changes it while the load
       finishes.
    2. `?item=` for a card deep in the board opens the lightbox on it with
       the load held, and the address loses `?item=`.
    3. A link to a deleted card says it's gone, opens nothing, and the
       address loses `?item=`.
  - Unit (test/sorted-load.test.js, the fetch stub):
    4. Find similar by meaning: every result is on the board before the
       results show, and only the missing ones were asked for.
    5. Two quick searches, the first one's cards held until the second
       shows: the second stays.
- **Removal checks:** the card fetch out of `fetchResults`: 1 and 4 fail;
  the fetch after the check for a newer search (in the callers): 5 fails;
  `?item=` back to watching the load: 2 fails; no toast for a gone card: 3
  fails.
- **Real-app check:** the throwaway 5,000-card board, before Stage 3 (2b's
  page) and after, only the pictures stubbed: a link to its oldest card (the
  last to load, newest first), and a search typed as the first cards draw,
  its answer given by the check (the throwaway board has no embeddings),
  with results among the last cards to load.

**Built (2026-09-30), uncommitted:**

- `public/data.js`: `cardsById`, the one request for cards by id (the
  load's batches use it too), and `fetchItems(ids)`: the cards the page
  doesn't have, added to the board, the queue left alone; false when the
  request got no answer.
- `public/search.js`: `fetchResults` fetches its results' cards before it
  returns.
- `public/app.js`: `openLinked` for `?item=`: fetches the card, removes the
  param, opens the page's copy, else says the card is gone or couldn't be
  opened; boot doesn't wait for it. The minute-long watcher and the
  `itemsVersion` import are gone, and the alert links' comment sits over
  their code again (it had drifted above the "created" one).
- Tests: test/sorted-load.test.js +2 (Find similar by meaning; two quick
  searches), test/browser/sorted-load.test.js +3 (a search mid-load; a link
  to a deep card; a link to a card that's gone). Its `openBoard` lets the
  batch requests a test names through, by their ids, and holds the rest.

Removal checks, each fix taken out and its test watched failing (a script
restored every file byte-identical after each):

| removed | failed |
|---|---|
| S1: the card fetch out of `fetchResults` | browser: the search mid-load; unit: Find similar by meaning, and the two quick searches (their setup) |
| S2: the fetch after the check for a newer search, in the callers | unit: the two quick searches |
| L1: `?item=` back to watching the load | browser: the deep link, the card that's gone |
| L2: no toast for a card that's gone | browser: the card that's gone |
| L3: the link left in the address when its card is gone | browser: the card that's gone |

Not pinned by a test: boot not waiting for the link's fetch (nothing opens
`?item=` and `#jobs` together); the link opening the page's own copy of its
card (`fetchItems` hands back no rows, so there's no other copy to open).

Lint clean. Full suite: 2,261 of 2,261. The production build builds, and
boot, list-view, card-faces, list-columns and sorted-load pass against it
(`FRONTEND_DIR=public/dist`, 32 of 32).

Real-app check (Chromium, the real server on a throwaway database, a
5,000-card board added in a shuffled order, no saved sort; nothing held,
only the pictures and the search's answer stubbed). The same script ran
with `FRONTEND_DIR` at a copy of 2b's page for the before; the server is the
same, Stage 3 changing none of it:

| | 2b's page | Stage 3 |
|---|---|---|
| link to the oldest card (the last to load) | opened once the whole board had loaded (5,000 of 5,000) | opened with 700 of 5,000 loaded, the right card |
| search typed after 1 of 10 batches, 25 of its 30 results among the last 1,000 cards | first screen 5 of 30 results; 4 different screens as the load finished | first screen 30 of 30, best first; 1 screen |

No page errors in either run.

### Stage 4: second pass

Fresh eyes on the whole diff, then simplify.

(Asked 2026-09-30: "go ahead". Two read-only reviewers, never shown this
plan, compared HEAD with the working copy: one the server and sort-core.js,
one the page. Every finding was re-read in the code before acting.)

**Found and fixed:**

1. The progress lane still moved as the load landed. It's drawn above the
   grid in an order of its own (newest first), and under any other sort the
   load brought its cards in that sort's order: a card still being tagged
   could come with any batch and slot in among those on screen, the grid
   below dropping a row as the lane grew. (The page reviewer, and my own
   read.) Every card in flight now comes with the first answer, on both
   paths of `listItemsSorted` (the statuses are db.js's `IN_FLIGHT_FOR`), so
   the lane is whole from the first draw.
2. Newest first read the first page and the keys at the same time, as two
   snapshots. A card added between them was in the keys but not the page:
   first in the queue, it held the first draw at nothing ("No items match
   these filters") until the first batch, during an upload on a busy
   board. (Both reviewers.) The keys are read first, and the page is
   fetched by the ids at their head.
3. An explicit Date added, newest first (the menu's Date added when no sort
   is chosen) took the whole-listing path, building the whole board on
   every open for the order the index already gives. It takes the index
   path; the keys are the same.
4. Picking the order already in effect during the load (Newest first again,
   or Date added ↓ with none chosen) asked the server anew: the batch in
   flight was dropped, and a failed request said "Couldn't change the sort"
   over nothing. `useSort` sets it at once: the queue is already in that
   order.
5. Cards joining the board without a batch (a sort's first page, a
   search's or a link's cards) didn't re-arm the poll, and the event channel
   skips its refresh while `pollDelay()` says the poll has it
   ([events.js:68](../public/events.js#L68)): a card in flight brought that
   way went unfollowed. `addItems` re-arms it for every arrival, in place
   of the batch loop after each batch.

**Simplified, behavior unchanged:**
- The whole-listing path sorts the keys, each value read once, instead of
  copies of the items; `byId` goes, and db.js imports `keyOf` and
  `compareKeys` instead of `compareItems` and `sortValue`.
- `listItems`' `limit` mode had no caller left and went. list-pagination's
  tie check moved to `listItemsSorted`; board-sort's payload test uses the
  ids mode.
- The sorted route reads `work` beside the listing, handing it the board it
  already read.
- `validSort` is sort-core.js's own again, and `listItemsSorted`'s second
  default of 200 went (the route's is the one).
- Stale comments: sort.js ("drain", "newest 200"), state.js ("server
  default"), data.js's lane, db.js's jobs history ("the /api/items cursor
  pattern"). app.js's unused `reconcile` import, older than this arc.

**Recorded, not fixed:**
- Old tabs across the deploy: the Risks entry understated the cost, and is
  corrected there. A compatible answer for a window of seconds isn't worth
  a third response shape.
- Rows mode switching itself on when a batch brings the first card with
  several files (Risks).
- The tag-clusters lens (Risks, from the Stage 3 close look).
- A slow sort change has no cue while it waits, and a second click on the
  same List header meanwhile asks for the same sort again rather than
  flipping it (`nextSort` reads the sort still in effect).
- After a mapping save, a failed sort change says "Couldn't change the
  sort", though the viewer changed the mapping.

**Declined:**
- A search whose card fetch fails showing only the results in hand (the
  page reviewer's suggestion): the Stage 3 close look chose to show every
  result, the missing ones joining as the load reaches them.
- A loading line instead of "No items match these filters" while a
  filter's matches are still loading: 2b's close look kept it.
- The old loop's late batch added instead of dropped after a sort change:
  it would give the queue a second writer.
- List's spoken note taken from the sort in effect instead of the pick: a
  header only offers sorts the board has, which the server keeps, and the
  change would break under a search, where no column is sorted.

**Checked and fine:** both routes check the board and answer 404, and ids
from another board are left out; the Dockerfile copies everything but
public/dist, so the server finds public/sort-core.js as it does
facet-match.js, the worker runs in the same process, and node:22-slim has
full ICU; nothing reads `nextCursor`, `after` or the connector rows'
`displayLabel` any more, and every sort.js import resolves; within one sort
the queue only shrinks and the cut only moves forward; one batch loop is
ever live, and `loadOver` settles on finish or stop; the check for a newer
search covers the card fetch; `?item=` opens the page's own copy and tells
a gone card from no answer.

**Proofs added:**
- sorted-items.test.js +3: an explicit newest first answers as no pick
  does; the first page is the start of the keys when a card lands between
  the two reads (a db wrapper adds one as the keys are read); every card in
  flight comes with the first page, newest first and by Name.
- sorted-load.test.js +2: the order in effect, picked again mid-load, takes
  effect with no request and the load goes on; a card in flight fetched for
  a link re-arms the poll (Node's mock timers, last in the file).
- test/browser/sorted-load.test.js +1: 700 cards by Name, twenty in flight
  spread through them: the lane never changes while the load lands. The
  frame recorder records the lane too.

Removal checks, each fix taken out and its test watched failing (a script
restored every file byte-identical after each):

| removed | failed |
|---|---|
| F1: the first page read beside the keys, on its own | the first page is the start of the keys |
| F2: an explicit newest first through the whole listing | an explicit newest first answers as no pick does |
| F3a: newest first without the cards in flight | every card in flight comes with the first page |
| F3b: the other sorts without them | the same |
| F3c: the same, on screen | browser: the lane never changes while the load lands |
| F4: the order in effect, picked again mid-load, asks the server | unit: the order already in effect takes effect at once |
| F5: only the load's batches re-arm the poll | unit: a card joining the board re-arms the poll |
| R8': the first page taken before the sort (2a's check, on the rewritten path) | every first page, Name, settling, the cards in flight |
| R10': sorted without the Name (2a's check, on the rewritten path) | every first page, the keys, Name, settling, the cards in flight |

Lint clean. Full suite: 2,266 of 2,267; the one failure was
welcome.test.js:291, the boards page's loading screen read the moment the
page lands (the race recorded in the list-view arc, seen at Stage 2a too),
and the file passed alone twice, 10 of 10. The production build builds, and
boot, list-view, card-faces, list-columns and sorted-load pass against it
(`FRONTEND_DIR=public/dist`, 33 of 33).

## Gains, plainly

- A sorted board draws its real first screen at once, and cards never move
  because more of the board arrived.
- Connector boards open on their own sort, not in date order first.
- One file decides order (sort-core.js), with ties and mixed values
  settled, instead of an order that depends on what arrived when.
- Deep links and searches stop waiting on the load.
- One loader instead of a cursor walk plus special cases.

## Risks and edges

- **Server work.** A sorted load costs one whole-board pass (D7). db.js
  notes the whole-board listing at 95ms on the ui board. Fine at thousands
  of items; watch it past tens of thousands.
- **A bigger first answer.** The keys add a few dozen bytes an item: roughly
  120-280KB before compression on the ui board, depending on the sort.
- **Live sorts still move cards** when something actually changes, loading
  or not: Date updated while tagging runs, Hearts, prices (D12).
- **A load that fails** stops at the cut. A reload resumes, as a stopped
  load does today, and so does a sort change, which asks for new keys.
- **Tabs left open across the deploy** still run the old loader. Once 2b
  deletes the old paging request, its `?limit=200` falls through to the
  route's whole-board answer, which the old page boots from with no
  background load (Stage 2a close look). Slower for that one load, but
  whole. An old tab still loading when the server restarts stops where it
  is, as on any restart today. (Corrected at the Stage 4 pass: that answer
  carries no `now`, so an old page that boots from it polls the whole board
  on every tick until reloaded, and an old tab mid-load reads the whole
  board twice before it stops. Pages are served `no-cache`
  ([server.js:3949](../server/server.js#L3949)), so only a boot that races
  the deploy by seconds runs the old page against the new server. Left as
  it is.)
- **Chip counts** during the load include loaded items past the cut. They
  settle when the load ends, as today.
- **The progress lane** ordered each group by arrival, which loading in
  sort order would have changed. Stage 1 sorts its groups by date added.
  Under any other sort the load then brought its cards in that sort's
  order, slotting them in among those on screen; since the Stage 4 pass,
  every card in flight comes with the first answer.
- **Text order is the viewer's language** on both sides: already true in
  the browser, new on the server.
- **"Similar by tags"** ranks only loaded items while the board loads, as
  today.
- **The tag-clusters lens** carves its groups from the cards loaded so far,
  and again as each batch lands (by design: new cards join groups). During a
  load its row changes, and with a cluster picked, cards on screen come and
  go: the one filter the cut can't keep still (D3). Older than this plan;
  found at the Stage 3 close look, not fixed.
- **Rows mode switching itself on** during a filter session
  ([view.js:57-58](../public/view.js#L57-L58)) is a ratchet that engages
  the first time the drawn list holds a card with several files. On a
  card-key board opened from a filtered link, the batch that brings the
  first such card flips the whole page to rows. Deliberate and older than
  this plan (the view waits for the stacks the load brings); found at the
  Stage 4 pass, not fixed.

## Sources (research, 2026-09-30)

- Elasticsearch, paginate search results (point in time, tiebreakers):
  https://www.elastic.co/docs/reference/elasticsearch/rest-apis/paginate-search-results
- Duplicates, gaps and cursor drift when paging changing data:
  https://www.getknit.dev/blog/how-to-preserve-api-pagination-stability
- AG Grid, infinite row model:
  https://www.ag-grid.com/javascript-data-grid/infinite-scrolling/
- PhotoPrism, search endpoints (server-side order, offset paging):
  https://docs.photoprism.app/developer-guide/api/search/
- Twitter's timeline architecture (ordered ids, then fetch the tweets):
  https://highscalability.com/the-architecture-twitter-uses-to-deal-with-150m-active-users/
- Notion's internal collection query (ordered ids plus total), via notionapi:
  https://pkg.go.dev/github.com/kjk/notionapi
- Immich, timeline and asset display:
  https://deepwiki.com/immich-app/immich/3.5-timeline-and-asset-display
- Immich #28861, the timeline freezing on a 70k-photo month:
  https://github.com/immich-app/immich/issues/28861
- Building the Google Photos web UI:
  https://medium.com/google-design/google-photos-45b714dfbed1
- PostgreSQL collation is a massive footgun:
  https://gist.github.com/rraval/ef4e4bdc63e68fe3e83c9f98f56af7a4
- ExtendDB #357, paging skips rows when two collations disagree:
  https://github.com/ExtendDB/extenddb/issues/357
- MDN, Array.prototype.sort (inconsistent compare functions):
  https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/sort
- URL length limits by browser, server and CDN:
  https://urlencodedecode.com/blog/url-length-limits-by-browser.html
- Stale API responses and AbortController:
  https://www.sitepoint.com/how-to-prevent-stale-api-responses-with-abortcontroller/
- Node.js, internationalization support (full ICU by default):
  https://nodejs.org/api/intl.html
