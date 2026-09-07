# Chip exclusion ("NOT") — deep dive (2026-09-07)

> **Status: SHIPPED — all three stages + simplify pass, pushed 2026-09-08
> (a7b8eab + the gesture fixes). Desktop right-click QA'd live (caught the
> swallow bug, fixed, then the whole swallow rig deleted). Still owed:
> Android long-press, a shared `?fx=` link. iOS gesture: none yet, by
> decision.** Stage 0 of
> [conversational-search-plan.md](conversational-search-plan.md), but a
> standalone arc: right-click a rail pill to exclude its value. Serves manual
> filtering on its own; the ask feature inherits it.
>
> **Revised same day.** The first draft encoded exclusion as a `!value`
> sentinel inside the existing value sets and carved alerts out (strip +
> refuse). Rejected on review — the sentinel is stringly-typed metadata every
> consumer must secretly know (the consumer census itself proved the "free
> ride" wasn't free: gone-loops rendered literal `!x` pills, alerts went
> silently dead), and excluding alerts from a selection mechanism is a
> carve-out, not a design. This revision makes exclusion **explicit in the
> selection shape everywhere it flows** — filters, URLs, saved configs, and
> alert conditions — one shape, one rule, no reserved characters, no
> carve-outs.

## The feature

- **Left-click** toggles inclusion — unchanged.
- **Right-click** (`contextmenu`, preventDefault) toggles exclusion. Each
  gesture clears the other state for that value: two independent toggles,
  no hidden three-state cycle, so right-click never surprises on an active
  pill. **Alt+click** does the same — the keyboard-adjacent twin, one line.
- **Touch**: long-press on Android — it fires `contextmenu` natively, so
  the one listener covers it. **iOS has no exclusion gesture yet**
  (revised 2026-09-08): the speculative pointer-timer + click-swallow rig
  built for it was deleted after its swallow flag ate real desktop clicks —
  the iOS path gets built from a real device when QA reaches one. Nothing
  more on mobile — no discoverability affordance (pinned).
- An excluded pill renders with a **struck label + muted-warm border**
  (pinned; extends `.pill`, no new component vocabulary) and its count
  renders as **`−N`** — what the exclusion removes, sign included.
- **Alerts support exclusion natively** (this revision): an alert seeded
  from a selection carries its NOT half, the server matcher honors it, and
  the alert modal's chip editor renders excluded values in the same struck
  style.

## The shape

One explicit per-facet selection object, the same vocabulary at every layer:

    { any: [values...], not: [values...] }     // JSON (configs, conditions)
    { any: Set, not: Set }                     // in memory (state.selected)

- `state.selected` becomes `Map<facetKey, { any: Set, not: Set }>`.
- Saved filter configs and alert conditions: a facet's entry may be the
  legacy array (read as `{ any: [...], not: [] }`) or the object. Writers
  emit the plain array whenever `not` is empty, so configs without
  exclusions stay byte-identical to today's shape and old rows never need
  migrating.
- **URL**: `?f=` keeps its exact current meaning (includes) — old links
  decode unchanged. Exclusions ride a sibling param `?fx=` with the
  identical `key:v1,v2;key2:v3` codec, reusing `encodeSelected`/
  `decodeSelected` verbatim on the `not` halves. An old build ignores
  `?fx=` and shows the less-filtered view — graceful, never a lie.
- **No reserved characters.** The first draft reserved `!` as a value
  prefix server-side; with the explicit shape there is nothing to reserve —
  facet values stay fully free (the flexibility doctrine wins one back).

Why explicit beats the sentinel: with structure, a consumer that ignores
`not` simply doesn't show exclusions — a visible gap, fixed where noticed.
With a sentinel, a consumer that ignores it *misbehaves silently* (renders
`!x` as a value, matches nothing, dead alerts). Wrong-by-default lost to
visible-by-default.

## Semantics (pinned)

The per-facet pass test, written once:

    facetPass(has, { any, not }):
      (any is empty OR some v in any has(v)) AND (no v in not has(v))

- **Cross-facet stays AND**, OR-within-`any` unchanged.
- **NOT keeps unset.** Excluding `dark` keeps items with no theme tag at
  all — "doesn't hold it" includes "never answered". Absence stays absence
  (pattern rule 5); the `−N` count makes the behavior inspectable.
- **System facets participate**: not-this-cluster, no-cars-detected,
  not-uploaded-by. `~clusters` step/flavor-flip deletes the whole key today
  (patterns.js:286/298/300) — whole-key deletes don't care about the entry
  shape, nothing changes.
- **Rows mode is vacuously unaffected**: entity membership is the union
  tagSet, so a surviving entity holds no excluded value ⇒ no instance does ⇒
  `instanceMatches` dims nothing new. It still adopts the shared helper so
  the rule exists once.
- **Odds lens needs zero change** (verified): `chipOdds`
  ([patterns.js:68](../public/patterns.js#L68)) reads only
  `counts`/`ctxAll`/`ctxFail`/`totals`, all of which flow through the shared
  pass test — the conditioning is "the whole selection" by construction.
  Excluded chips show no odds badge (chosen state, like active).
- **Counts** (revised 2026-09-08 — the first reading was wrong and QA
  caught it): the leave-the-facet-out convention stays for INCLUDE chips
  ("add this to the OR and N appear"), but an EXCLUDED chip answers a
  different question — the marginal, "un-strike this and N come back" —
  which must respect the facet's own include half and sibling strikes
  (`negCounts` in computeFacetStats). With comfortable included on a
  single-valued facet, striking roomy shows an honest `0` (inert, still
  clearable), not the leave-facet-out −29; on a multi-valued facet
  (car-but-NOT-truck) it bites and says exactly by how much. Mixed
  include+exclude on one facet is therefore legal everywhere and
  meaningful exactly where items can hold several of its values.
- **Muted rule**: an excluded chip is never muted (it is chosen); at count 0
  it is inert but clearable — the selected-but-gone doctrine.

## The shared rule module (pinned)

`facetPass` plus the tiny shape helpers (normalize legacy array ↔ object,
"is this entry empty") live in a **dependency-free public module from day
one** — the `cluster-core` precedent (browser and node import the same
file). Three importers, one rule:

1. `filters.js` — `matchesExcept`, `instanceMatches`, and the `fails` loop
   in `computeFacetStats` (today the OR-loop is inlined THREE times; the
   unify is step one regardless).
2. `server/alerts.js` — `matchesCondition` becomes a thin wrapper: normalize
   the stored condition, `facetPass` per facet against the entity's tagSet.
   Alerts get NOT with the *same* rule, not a mirror that can drift.
3. (Later) the ask arc's `preview` tool evaluates candidate compositions
   with the same import.

## Alerts, natively

- **Seeding**: the alert modal copies `selectedAsConfig()` as-is — the `not`
  halves travel. No stripping, no refusal.
- **Matching**: `matchesCondition` via the shared module (above). Alert
  semantics stay "entity enters the matching set, once-ever per entity" —
  with NOT, an entity can *enter* by losing a tag at a retag landing; the
  detection hook already re-evaluates on every tag landing, so that case is
  covered by construction.
- **Unset matches NOT** here too: a fresh item tagged only `dark` matches
  "dark, not kanban" immediately. Consistent with the filter semantics; the
  alert modal copy should say "not / doesn't hold" rather than "is tagged
  otherwise".
- **Baseline/prune machinery unchanged**: `seedAlertBaseline` and
  `pruneAlertStaleClaims` are set-defined, not monotonicity-dependent — a
  condition edit re-seeds against whatever the new set is, exclusions
  included. (Verify with a test, not by assertion.)
- **Modal chip editor** ([alerts-modal.js:188](../public/alerts-modal.js#L188)):
  renders `not` values in the struck pill style; toggling in the editor
  moves a value between `any`/`not`/absent with the same gesture pair as
  the rail.

## The consumer census (revised for the explicit shape)

**Untouched (whole-map / whole-key operations):** `clearAll`,
`resetListFilters` ([alert-event.js:15](../public/alert-event.js#L15)), the
queue-jump clear ([grid.js:379](../public/grid.js#L379)), `~clusters`
deletes (patterns.js), boot assignment.

**One-line adaptations:** `filterKey` (canonical JSON of `{any, not}`
entries), `activeCount` (`any.size + not.size` — an exclusion IS an active
filter), `encodeSelected`/`decodeSelected` (run twice, `?f=` + `?fx=`),
`selectedAsConfig`/`applyFilterConfig`/`configMatchesCurrent` (emit/read
both entry forms, canonicalize), server config cleaning
([server.js:631](../server/server.js#L631)) and `parseAlertBody`
([server.js:685](../server/server.js#L685)) (accept both entry forms, clean
string arrays inside).

**The real work:**

1. Unify the three inlined OR-loops into the shared `facetPass` (no behavior
   change, truth-table test first), then teach it `not`.
2. `chip()` ([filters.js:387](../public/filters.js#L387)): read
   included/excluded from the entry, `.neg` class + `−N` count +
   `contextmenu`/Alt+click wiring (post-hoc `classList`/`addEventListener` —
   `pill()` in utils.js stays untouched), skip the odds badge when excluded.
3. `toggle()`/`toggleNeg()`: move the value between `any`/`not`/absent;
   each clears the other.
4. Row visibility gates and selected-but-gone loops (facet loop :530,
   `~objects` :497, clusters :466, uploaders :516): consult
   `any.has(v) || not.has(v)`; gone-loops iterate both sets and render the
   excluded state explicitly. With structure this is plain code — the
   literal-`!x`-pill failure mode of the sentinel draft cannot exist.
5. Alert modal editor + seeding (section above).
6. CSS: `.pill.neg` struck label + muted-warm border.

## Interop notes

- **Old links**: `?f=` semantics unchanged; old builds ignore `?fx=` —
  graceful degradation, never an empty-grid lie (an improvement over the
  sentinel draft, where an old build decoded `!dark` as a literal include).
- **Old configs / alert conditions**: legacy arrays read as include-only
  forever; nothing rewrites them until the user saves with an exclusion.
- **Ask integration**: `record_answer`'s `chip.selected` uses the same
  `{any, not}` entries; the composition stays fully live, and the `preview`
  tool imports the same rule module.
- **Status pills / favorites / crates**: flags, not facets — out of scope.

## Tests

Precedent: [pattern-odds.test.js](../test/pattern-odds.test.js) imports the
public modules into node via `browser-stub.js`. New `filter-exclusion.test.js`:

- `facetPass` truth table: any-only, not-only, mixed, unset-kept,
  system-facet membership, empty entry, legacy-array normalization.
- `computeFacetStats` under exclusion: excluded chip's context count equals
  its removals; untagged/context counters follow.
- `toggle`/`toggleNeg` movement between any/not/absent; `activeCount`.
- Codec: `?f=`/`?fx=` round-trip; legacy `?f=`-only links; config
  round-trip in both entry forms; `configMatchesCurrent` canonicalization
  across forms.
- Gone-loop rendering: a not-only selection still renders a clearable
  excluded chip.
- Alerts: condition with `not` matches/doesn't-match correctly through the
  shared module; entity *entering* the set by losing a tag fires; baseline
  re-seed on a condition edit that adds an exclusion; `parseAlertBody`
  accepts both forms and cleans junk.

## Stages (each green and pushable alone)

The ordering rule that makes staging safe: **the shape must exist everywhere
before the gesture that creates exclusions exists** — otherwise the interim
recreates the alert hole (a `not` half stored somewhere a reader doesn't yet
understand).

- **Stage 1 — the refactor.** BUILT 2026-09-08, uncommitted; suite
  1438/1438 green. The shared rule module (`public/facet-match.js`); the
  three inlined OR-loops in filters.js and `matchesCondition`'s inner test
  all ride it (pure refactor — kills the drift-capable mirror immediately
  and proves the node-import seam). Zero behavior change; the truth-table
  tests (`test/facet-match.test.js`) lock the semantics — including the
  dormant `not` path — before anything moves. Close-up below.
- **Stage 2 — the shape, inert.** BUILT 2026-09-08, uncommitted; suite
  1450/1450 green. `state.selected` entries are `{any, not}` (`selEntry`),
  adaptations landed (filterKey triple, activeCount, toggle sibling-clear,
  config both-forms via shared `cleanSelection`, `?fx=` codec, matcher
  through `halvesOf`). Two finds from the build: (1) the row blocks'
  `[...sel]`/`sel.has` usages were a silent-throw near-miss — no test
  rendered the rail, so `test/rail-render.test.js` (jsdom, whole-rail) now
  exists as the net; (2) migration 0024's baseline-heal SQL is the one
  remaining array-form reader — historical-only (runs once, pre-exclusion
  data or empty DB), never re-runs in production; its heal test cleans up
  anachronistic object-form alerts. No UI can create an exclusion yet.
- **Stage 3 — the feature.** BUILT 2026-09-08, uncommitted; suite
  1459/1459 green (three runs; one earlier lone failure did not recur —
  the known Windows backup.test.js EPERM flake). Gesture (`contextmenu` +
  Alt+click + the iOS pointer-timer via `onExclude`, filters.js-local),
  `.neg` pills + `−N` (plain 0 when it removes nothing), the
  `encodeConditionF` fix + `fx` on firing links, and the alert editor
  rendering/removing `not` chips (working-form normalize at open,
  wire-form serialize at save). Tests: rail-render gestures/`.neg`,
  filter-shape toggleNeg + grid filtering, alerts `f`+`fx` links, new
  alert-editor.test.js (jsdom). Manual QA still owed: real right-click,
  Android/iOS long-press, a shared `?fx=` link. By the time an exclusion
  can exist, every consumer already speaks it — including alerts.
- (Other arc, later) ask `preview` imports the module.

## Simplify pass (2026-09-08, post-build)

Four-angle review (reuse/simplification/efficiency/altitude), applied:
facet-match.js became the selection's full home — `wireEntry` (the
array-when-not-empty writer rule, previously spelled in three places),
`canonEntry` (which FIXED a real gap: `sameCondition`'s canonicalizer still
spread entries as arrays and threw on `{any, not}` at the alert-edit
re-baseline decision — regression test added), `selSize`/`selHas`/`selValues`,
and the URL codec (`encodePairs`/`decodePairs`) now shared with
`encodeConditionF`, so the two sides literally cannot drift. filters.js:
empty-entry skip restored in the hot matchers (abandoned entries linger —
toggle never deletes keys), `toggle`/`toggleNeg` one body (`toggleHalf`),
exclusion gesture DELEGATED to the rail containers (wireExclusion +
data-facet/value — was 7 listeners per pill rebuilt every render). Alert
editor converters at module scope on `selEntry`/`wireEntry`. `.al-chip.neg`
moved beside its base in modal.css; warm tokens are `--neg-ink`/`--neg-border`
in :root. Tests: shared `test/jsdom-stub.js` (was five drifting copies of the
bootstrap, counting three pre-existing), `saveAndCapture` helper, `afterEach`
teardowns. Declined deliberately: folding the row blocks into one
`valueRow` (per-row universe rules genuinely differ), the per-item closure
seam (the pinned membership design; not material), single-pass f+fx encoding
(noise). Suite 1460/1460.

## Stage 1, close up (2026-09-07)

**Exactly four call sites, verified by grep** — three inlined OR-loops in
filters.js (`matchesExcept` :61, `instanceMatches` :83, the `fails` loop in
`computeFacetStats` :205) and the alerts mirror (`matchesCondition`,
[alerts.js:43](../server/alerts.js#L43), two callers: the landing hook :78
and baseline seeding :107). The fourth `for (const v of values)` grep hit
(filters.js:461) is the clusters *render* loop iterating value objects —
not a membership test, untouched.

**The module** — `public/facet-match.js`, dependency-free, imported by
browser and node (the cluster-core precedent). Ships the FULL algebra in
Stage 1 with the `not` path dormant — semantics locked by tests before any
producer of exclusions exists, and Stage 2 never touches the module:

    export function facetPass(has, any, not) {
      let sawAny = false, ok = false;
      for (const v of any || []) { sawAny = true; if (has(v)) { ok = true; break; } }
      if (sawAny && !ok) return false;
      for (const v of not || []) { if (has(v)) return false; }
      return true;
    }

Iterable-agnostic on purpose (Sets in state, arrays in stored conditions);
empty/absent `any` passes — "no includes" constrains nothing. Membership
stays behind the existing seams: callers pass
`(v) => entityHasValue(item, key, v)` / `instanceHasValue` / the tagSet
lookup. Perf note, considered and dismissed: one closure per item × active
facet in the stats loop (~thousands per render) is noise next to the
per-item Map work the same pass already does, and renders are already
`filterKey`-cached.

**The call-site diffs** (each keeps its own outer-loop routing; only the
inner test moves):

- `matchesExcept`: `if (key === exceptKey) continue; if (!facetPass((v) =>
  entityHasValue(item, key, v), values)) return false;` — the explicit
  empty-set skip is subsumed (empty `any` passes).
- `instanceMatches`: keeps the `sys && !sys.instance` skip, same swap with
  `instanceHasValue`.
- `computeFacetStats`: the `fails++/failKey/break` bookkeeping stays; only
  the `ok` loop becomes the call.
- `matchesCondition`: keeps `!keys.length → false` AND the per-facet
  `!Array.isArray(values) || !values.length → false` guard, then
  `facetPass((v) => tagSet.has(\`${key}/${v}\`), values)`. The tagSet
  already carries system-facet projections (`~facet/value`,
  [db.js:3885](../server/db.js#L3885)), so nothing else moves.

**Drift already found in the "mirrors"** (the argument for Stage 1 in one
sentence): `matchesExcept` *skips* an empty value set, `matchesCondition`
returns *false* on one. Both are right for their context — a live selection
with an empty facet is an untouched facet; a stored condition with an empty
array is corrupt and must not match. `facetPass` takes neither side (empty
passes); each caller keeps its own guard, now visibly, in its own file.

**Regression net already standing**: `instance-rows.test.js:124` (OR
within / AND across), `pattern-odds.test.js` (stats counters over
`computeFacetStats`), `alerts.test.js:90` (matcher semantics). New
`facet-match.test.js` adds the truth table: any-only, not-only, mixed,
empty/absent halves, first-match short-circuit — the `not` rows are the
Stage 2/3 contract written a stage early.

## Stage 2, close up (2026-09-08)

**The shape helpers** join facet-match.js (its declared second half):

    export const selEntry = (any = [], not = []) =>
      ({ any: new Set(any), not: new Set(not) });          // live-state form
    export function halvesOf(v) {                          // wire form → arrays
      if (Array.isArray(v)) return { any: v, not: [] };    // legacy = include-only
      if (v && typeof v === "object")
        return { any: Array.isArray(v.any) ? v.any : [],
                 not: Array.isArray(v.not) ? v.not : [] };
      return { any: [], not: [] };
    }

`selEntry` is also the test-fixture vocabulary: `new Map([["color",
selEntry(["red"])]])` — which matters because the census found the real
hidden cost of this stage: **four test files seed `state.selected` with the
old `Map<key, Set>` shape at ~15 sites** (instance-rows, pattern-odds,
pattern-clusters, filter-config-pop). Mechanical churn, but it is most of
the diff's line count.

**Direct-access census (app code, post-Stage-1, verified by grep):** every
`state.selected` touch that sees entry *values* lives in exactly three
files — filters.js (12 sites), app.js (the `?u=` fold, :81–83), and
nothing else. patterns.js/grid.js/alert-event.js only delete keys or
replace the whole map — untouched.

**filters.js, site by site:**
- `filterKey` :14 — entry canonical becomes the triple `[key, anySorted,
  notSorted]`, entries with both halves empty dropped. This is
  load-bearing: `["dark"]` *included* and `["dark"]` *excluded* must never
  collide into the same render-cache key.
- `activeCount` :251 — `any.size + not.size`.
- `toggle` :265 — get-or-`selEntry()`; adding to `any` also deletes from
  `not` (the each-clears-the-other rule, wired now, exercised in Stage 3).
- `selectedAsConfig` — emits the legacy array when `not` is empty (old
  configs stay byte-identical), the `{any, not}` object (both keys, always)
  when not. Skips both-empty entries as today.
- `applyFilterConfig` / `canonConfig` — normalize through `halvesOf`, so an
  array config and `{any:[same]}` compare equal forever.
- Codecs :321/:339 — refactor to an internal `encodeMap`/`decodeMap` over
  `[key, Set]` pairs; `?f=` encodes the `any` halves (meaning unchanged),
  new `?fx=` encodes the `not` halves; decode merges both params into
  entries (an `fx`-only key gets an empty `any`). `syncFiltersToUrl` gets
  the mirror `fx` set/delete block.
- `computeFacetStats` — `activeSel` emptiness test becomes the size sum;
  the fails loop passes `values.any, values.not` to `facetPass`.
- `matchesExcept` / `instanceMatches` — pass the halves; one-line diffs.
- `chip()` :381 — `active` reads `.any.has(value)`.
- The four row `sel` reads (:447 clusters, :478 objects, :495 uploaders,
  :516 facet loop) — `get(k) || selEntry()`; value iteration/`has` reads
  `.any`; row-visibility gates count both halves now (forward-correct, so
  Stage 3 doesn't revisit the gates; inert while `not` is always empty).

**app.js** :76–83 — `decodeSelection(f, fx)`; the legacy `?u=` fold builds
`selEntry(ids)`.

**Server:**
- The config cleaning ([server.js:631](../server/server.js#L631)) and the
  alert-condition cleaning ([server.js:685](../server/server.js#L685)) are
  near-identical twins today (the comment even says so). Fold them into one
  `cleanSelection(raw)` — `halvesOf` per entry, string-filter + caps per
  half, emit array when `not` is empty, drop both-empty entries — used by
  both routes. The dedupe is the don't-inherit-past-decisions move this
  stage was always going to force.
- `matchesCondition` ([alerts.js:43](../server/alerts.js#L43)) — normalize
  each entry through `halvesOf`; the corrupt-condition guard becomes "both
  halves empty → false" (covers the old non-array and empty-array cases);
  then `facetPass(has, halves.any, halves.not)`. From this commit alerts
  *match* exclusions correctly — still unreachable, since nothing can
  store one yet.

**Stage-2 tests** (new `filter-shape.test.js` + additions to
alerts.test.js):
- Codec: `f`+`fx` round-trip; legacy `f`-only; `fx`-only key → empty-`any`
  entry; URL write emits/deletes both params.
- `filterKey`: include-vs-exclude of the same value produce different keys.
- Config: emission (array vs object), `applyFilterConfig` both forms,
  `configMatchesCurrent` equal across forms.
- Server: `cleanSelection` both forms + caps + both-empty drop (config and
  alert routes); `matchesCondition` with a `not` half — held → no match,
  unset → match (absence stays absence, now on the server too).
- Fixture updates in the four existing files, `selEntry` vocabulary.

**Micro-decisions taken here** (flag on review if disagreed): object-form
configs always carry both keys; row-visibility gates count `not` from day
one; the two server cleaning blocks become one function.

## Stage 3, close up (2026-09-08)

**A latent Stage-2 crack, found by this pass, fix rides here (or first):**
`encodeConditionF` ([alerts.js:146](../server/alerts.js#L146)) — the firing
payload's "open this filter" link — spreads `[...condition[key]]` and
throws on an object-form entry. Reachable today only via an API-crafted
condition + a webhook firing, but it's the last array-form reader outside
the historical migration. Fix: encode through `halvesOf`, and the payload's
`filter` URL gains `&fx=` when any `not` half exists (the link must
reproduce the exclusion, not just survive it).

**filters.js**
- `toggleNeg(facetKey, value)`: get-or-`selEntry()`; in `not` → remove;
  else add + `any.delete(value)` — the mirror of `toggle`'s sibling-clear.
  Left-click on an excluded chip routes through plain `toggle` → included
  (each gesture clears the other; no three-state cycle).
- `chip()`: `negated = entry?.not.has(value)`; count renders `−N` (U+2212,
  the odds badge's typographic family) — plain `0` when it removes nothing;
  never muted while negated; `.neg` class added post-hoc; odds badge
  skipped (chosen state, like active); click handler routes
  `e.altKey ? toggleNeg : toggle`; gesture wiring via a local
  `onExclude(el, fn)` helper (single consumer today — promoted to utils.js
  only when a second surface adopts it, per the component doctrine).
- The gesture (revised 2026-09-08, twice): delegated to the rail
  containers (`wireExclusion`, chips carry `data-facet`/`data-value`), and
  then stripped to ONE `contextmenu` listener — desktop right-click and
  Android long-press are the same event. The iOS timer + click-swallow rig
  was deleted: all of that complexity served one untested platform, and the
  swallow misfired on desktop (a mouse right-click trails no synthetic
  click, so the armed flag ate the next real one — caught by the user in
  first-session QA, locked by a persistent-container regression test).

**styles.css**
- `.pill.neg` (and `.al-chip.neg`, one combined selector): struck label +
  the odds lens's down-arm warm family (`#a8400f` ink /
  `rgba(235,104,52,…)` border) — orange already means "less" in this app,
  and green/red stay reserved for price direction. The count span escapes
  the strike via `display: inline-block` (text-decoration does not
  propagate into inline-blocks — the `.mult` badge already relies on this).
- `.pill` gains `-webkit-touch-callout: none` (iOS long-press must not
  summon the system callout; `user-select: none` is already there).

**alerts-modal.js** (simpler than planned — the editor is REMOVAL-ONLY,
chips with an ×, no gesture pair needed):
- Normalize each condition entry through `halvesOf` at open and at
  "Replace with current filter"; work on `{any, not}` arrays; serialize
  back to wire form on save (array when `not` is empty).
- Render `not` values as struck chips (`al-chip neg`), title "must not
  hold this value"; × removes from its own half.
- Condition head copy: "New items matching every facet below (any of its
  values, none of its struck ones) trigger the alert."

**Tests**
- rail-render: a `not` selection renders `.neg` + `−N`, unmuted at zero, no
  odds badge; a dispatched `contextmenu` toggles the exclusion; Alt+click
  routes to `toggleNeg`. (The iOS timer path is manual-QA — jsdom timers
  buy little there.)
- filter-shape: `toggleNeg` ↔ `toggle` sibling-clearing both directions;
  an exclusion actually filters `taggedFiltered`.
- alerts.test: `encodeConditionF` object-form → `f` string + the payload
  link carrying `fx`.
- New `alert-editor.test.js` (jsdom, the filter-config-pop pattern): an
  object-form condition renders both halves, × removes from the right
  half, save body emits the wire form.

**Manual QA** (the one stage where it's owed): desktop right-click, Android
long-press (native contextmenu path), iOS long-press (timer path), and a
shared `?fx=` link round-trip.

Honest size: bigger than the sentinel draft up front (~250–400 lines across
filters.js, codecs, alerts matcher/modal, CSS, plus the test file) — and
smaller forever after: no reserved characters, no secret conventions, no
consumer that can be wrong silently, alerts never diverge from the filter
rule.

## Decisions (all pinned 2026-09-07)

1. Excluded chip count: **`−N`** — the sign says what the number is doing.
2. Visual: **struck label + muted-warm border** — nobody has to learn it.
3. Discoverability: **no hint anywhere** — right-click gets found or it
   doesn't. (Mobile: long-tap only, no affordance.)
4. The rule lives in a **shared dependency-free public module from day one**
   — filters, alerts, and later ask import the same `facetPass`.
5. **Explicit `{any, not}` shape, not a value sentinel** — structure over
   convention; legacy arrays read as include-only; `?fx=` beside `?f=`.
6. **Alerts are in scope** — exclusion works everywhere selections flow, or
   it isn't a selection mechanism.
