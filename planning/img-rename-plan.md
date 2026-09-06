# img → item — the rename the agnostic migration missed (2026-09-06)

Self-contained for a fresh session. Written after a git-archaeology pass into
why the client still said `img` two months after the app stopped being an
image gallery.

## The debt

fbc9961 (2026-07-05, "Rename image-named core identifiers and copy to items")
renamed the *spelled-out* word — `state.images` → `state.items`, `image_id` →
`item_id`, `toImage()` → `toItem()`, the UI copy — and left the abbreviation:
123 lines containing `img` before the commit, 123 after. Same commit, same
hunk:

    -    const img = state.images.find((i) => i.id === id);
    +    const img = state.items.find((i) => i.id === id);

The residue was never written down, so every later file matched the surviving
idiom: 123 img-lines grew to 340 by 2026-09-06, including code born fully
agnostic (`entityHasValue(img, …)`, all of rows.js, `anchorLabel(img)`). And
from day one `img` never named an actual `<img>` element — those were `im`
(kinds.js) — it always meant "the record". The fossil squatted on the name;
real elements got the worse one.

## The rule

- `img` meaning **the entity** → `item` (matches `state.items`, `toItem()`,
  `kindFor(item)`).
- `img`/`im` naming **a real `<img>`/`Image` element** → `img`, now that the
  name is free: promote `im` in [kinds.js](../public/kinds.js) (4 sites),
  [rows.js:211](../public/rows.js#L211), the
  [lightbox.js:677](../public/lightbox.js#L677) preloader; the element vars
  already named `img` ([boards.js:567](../public/boards.js#L567),
  [detail-view.js:212](../public/detail-view.js#L212),
  [lightbox.js:141](../public/lightbox.js#L141)/156) keep it.
- Compounds follow meaning: `imgs` → `items` (bulk.js), `lightboxImg` →
  `lightboxItem`; `imgEl` — the handle property exposing the element
  (detail-view/lightbox renderer contract) — is element-true and keeps its
  name. [crates.js:44](../public/crates.js#L44)'s entity `im` → `item`.
- Strings and markup untouched: `createElement("img")`, `<img>` in prose,
  CSP `img-src`, the `im-*` ingest-modal CSS class prefix (unrelated), the
  docx `img` CSS rule.
- Out of scope, classified genuine: server (providers.js `desc.images`
  dimension validator, server.js CSP, docx.js CSS — 7 lines), tests that
  exercise real images (ai-image, model-input, detect, research — sharp
  builders, buffers, request parts), object-detector PIL code. One entity
  fossil in tests rides along: crate-pop.test.js fixtures.

## Scope (word-boundary img lines before the sweep)

grid 61, rows 43, lightbox 36, filters 35, crates 17, jobs-modal 15, data 14,
detail-view 13, bulk 13, boards 13, search 9, tag-editor 7, patterns 5,
kinds 4, sort 3, app 3, detail-chart 2, upload 1, alerts-modal 1 — 295 lines /
384 occurrences across 19 files; plus `imgs` ×16, `lightboxImg` ×22, and
crate-pop.test.js ×5.

## Mechanics

Guarded sed — `img` → `item` unless preceded by quote/backtick/`<`/identifier
char, so `createElement("img")` and `<img` survive — with element scopes
sentineled first (boards 567–592, detail-view 212–233, lightbox 141–142 +
156–161), promotions after the entity pass frees the name, every hunk
diff-reviewed. Known prose fix-up: detail-chart.js:113 ("no img:" means the
element).

## The net

`npm test` (pretest = eslint `no-undef` + template build, then the suite), an
eslint `no-shadow`/`no-redeclare` before/after diff (baseline: 4042
pre-existing findings — anything new is sweep-introduced shadowing), and a
final `\bimg\b` audit: every surviving line must name a DOM image.

## Status

- [x] sweep + promotions + test fossil (2026-09-06)
- [x] verified: suite 1414/1414 green (eslint `no-undef` rides pretest); the
  `no-shadow`/`no-redeclare` before/after diff is empty; surviving `\bimg\b`
  in public/ is 79 lines / 95 occurrences (was 295 / 384) — every one a DOM
  image (boards 13, detail-view 13, kinds 35, lightbox 8, rows 6,
  detail-chart 2, tag-editor 1, upload 1); `im` outside the ingest-modal CSS
  prefix, `imgs`, `lightboxImg`, and the crate-pop test fossils: all zero.

## Second pass (2026-09-06)

A meaning-level re-audit after the mechanical sweep.

- **One real catch:** jobs-modal.js `imageNote`/`imageTitle` params —
  pre-sweep `img` there meant the job's image-rendition record (`d.image`:
  preset, source, fallback, bytes, ms), a third meaning that is neither
  entity nor element. The sweep had renamed them `item`; corrected to
  `image`. Suite re-run green (1414/1414).
- Verified absent: destructuring/object-key renames in the diff (every brace
  line was a `${…}` interpolation; the `imgEl:` key kept), regex-literal
  hits, cased compounds (`IMG`/`curImg`-style: none), fossils in
  HTML/CSS/mjs/JSON/root configs (CSS carries only the image-kind
  `.image-face`), bare `image`/`images` identifiers in client code (the nine
  word-hits are prose about real images), photo/pic wording (all about
  actual photos), server `requireValidImages` (image-config validator,
  correctly out of scope).
- Left alone on purpose: the fifteen historical planning/*.md that mention
  `img` — dated records of the code as it was then; this plan is the naming
  authority now.
