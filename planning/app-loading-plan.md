# App loading — the boot waterfall, and why the data waits for the code (2026-09-16)

**Status: Stages 1, 2 and 3 IMPLEMENTED (uncommitted); Stage 4 DROPPED (measured — see it); Stage 5 PLANNED.**

Stage 1 landed 2026-09-16: specifiers normalised, the `modal.css` comment
fixed, `public/dist/` ignored, `startServer` given a `staticDir` option and the
browser harness a `FRONTEND_DIR` env, `.dockerignore` + `images.yml` updated
together, `scripts/build-frontend.mjs` wired into the Dockerfile with
`STATIC_DIR=/app/public/dist`, and the `/_` immutable mount added to
`server.js`. Verified: suite 1579/1579, lint clean, browser suite 26/26
against built output (`FRONTEND_DIR=public/dist npm run test:browser`), cache
headers correct through the real server, and a real `docker build` producing
byte-identical hashes to the host. Not deployed; not committed. The one thing
deliberately not exercised is running the built container against the live
database, which would start the worker.

Triggered by a network waterfall on a board page: ~53 script rows, all `304`,
all ~0.3 kB, filling the first ~240 ms, and only then `items?board=…`. The
reading that prompted this — "loading board items competes with loading the app
shell" — is right about the symptom and understates the cause. They are not
competing for bandwidth. **The items request cannot be sent until the shell is
completely finished.** One is strictly behind the other, by construction.

Everything below is measured, not estimated. Where a number is unverified it
says so.

## The mechanism

[index.html:81](../public/index.html#L81) loads `app.js` as a module.
`main()` is the last statement of that file
([app.js:282](../public/app.js#L282)), and the first item fetch is inside the
`Promise.all` at [app.js:116](../public/app.js#L116). ES module semantics say
every import in the graph, transitively, must be fetched, parsed and evaluated
before line 1 of `main()` runs. So the shape of the import graph *is* the
time-to-first-byte of the board's data.

That graph, from `app.js`:

```
53 modules · 7 levels deep
  app.js → grid.js → tag-editor.js → kinds.js → lightbox.js → detail-view.js → detail-chart.js
```

Depth is the expensive axis, not count. A browser cannot fetch a module it has
not discovered, and it discovers children only by parsing the parent. Seven
levels is **seven sequential round trips** before the items request leaves the
machine. Measured RTT to `001.itsalex.me` on an established connection is
~48 ms (`time_appconnect` 102 ms, `time_total` 150 ms, repeated 5×), so the
floor is ~340 ms of dependency discovery before the app asks for anything to
show. The ~240 ms ramp of script rows in the waterfall is this, and the 239 ms
on the `items?` row is that request's own duration on top.

### Three different payloads, and the one the screenshot shows

Worth pinning down, because the figure quoted elsewhere in this repo
(`~1.1 MB of JS/CSS -> ~350 KB`, [server.js:284](../server/server.js#L284)) is
the *host-dev* figure, and prod is already better than that:

| where | JS on the boot graph | CSS on index.html | protocol |
| --- | --- | --- | --- |
| `npm run server` on the host | 792 kB raw → **282 kB gzip** | 150 kB → 45 kB gzip | HTTP/1.1 |
| `docker compose up` (:8001) | 467 kB raw → **144 kB gzip** | 89 kB → 19 kB gzip | HTTP/1.1 |
| prod (001.itsalex.me) | 467 kB raw → **144 kB gzip** | 89 kB → 19 kB gzip | HTTP/2 + HTTP/3 |

The container figures are lower because the Dockerfile already reprints every
file without comments (see "Findings that change the shape of the fix" below)
and there is no bind mount over `public/`, so compose serves the baked,
stripped files. Prod serves HTTP/2 and HTTP/3 — confirmed by `Alt-Svc: h3=":443"`
on a live `curl -I`; a local `curl` reporting 1.1 is a Schannel-build
limitation, not the server.

That protocol difference matters for where this feels worst. Over h2/h3 the 53
requests multiplex, so only the *depth* costs anything. On local compose it is
plain HTTP/1.1 against express with a 6-connection-per-host cap, so the
*count* costs too. **Local feels worse than prod**, which means a waterfall
screenshot taken locally over-reports the count problem and correctly reports
the depth problem.

## Half the boot payload is for buttons nobody has clicked

Top of the boot graph by weight (gzip, host-dev figures so the ratios are
visible):

```
20.0 kB  mapping-modal.js          11.0 kB  facet-diagnostics.js
19.3 kB  ingest-modal.js            9.9 kB  filters.js
17.5 kB  board-modal.js             9.5 kB  modal.js
13.7 kB  capability-present.js      9.5 kB  grid.js
13.0 kB  jobs-modal.js              8.3 kB  data.js
12.5 kB  utils.js                   8.2 kB  dropdown.js
12.2 kB  toolbar.js                 7.8 kB  alerts-modal.js
11.4 kB  lightbox.js                7.1 kB  patterns.js
```

The five heaviest modules in the critical path of the first paint are all click
handlers. Counting the modal family plus the lightbox subtree (`lightbox` →
`detail-view` → `detail-chart` / `transcript-paragraphs` / `det-geometry` /
`face-select`, ~25 kB gzip), roughly **half the boot payload is UI that only
exists after a click.**

The cause is one line pattern,
[toolbar.js:13-18](../public/toolbar.js#L13-L18):

```js
import { openIngestModal } from './ingest-modal.js';
import { openBoardModal } from './board-modal.js';
import { openConnectorBrowse } from './connector-browse.js';
import { appendAlertMenu, appendAlertFooter, alertsUnseen } from './alerts-modal.js';
import { openDiagnosticsModal, diagnosticsUnseen, … } from './facet-diagnostics.js';
```

A static import is a promise to have the whole module evaluated before the
importer's first line runs. Written this way, *might be clicked* becomes
*blocks the first paint*. `board-modal.js` then pulls `mapping-modal.js`
(20 kB) and `capability-present.js` (13.7 kB) behind it, and `toolbar.js` is
imported by `app.js` directly — so the chain from "the toolbar needs to render"
to "download the mapping editor" is unbroken.

Two further boot-path pulls of the same kind, each needing its own decision:

- **`kinds.js` → `lightbox.js`.** This is what puts the lightbox, the detail
  view and the chart module in the boot graph. `kinds.js` is 2.5 kB and is
  reached from `grid.js` via `tag-editor.js`; the 25 kB subtree hanging off it
  is not needed until an item is opened.
- **`jobs-modal.js` is imported statically from four places** —
  [app.js:16](../public/app.js#L16), [toolbar.js:4](../public/toolbar.js#L4),
  [signals.js:30](../public/signals.js#L30),
  [announce.js:25](../public/announce.js#L25). Three of those want only the
  small predicates (`jobsUnseen`, `jobsModalOpen`); one wants the modal.

## Every load re-walks the chain

[server.js:3700](../server/server.js#L3700) sets `Cache-Control: no-cache` on
static files — store them, but revalidate before every use. Those are the 53
`304`s at 0.3 kB in the waterfall. Cheap in bytes, not free in time: the 7-deep
discovery happens again on every page load, warm cache or not.

The comment there reasons correctly to a conclusion that has since expired. It
says filenames are not content-hashed, so `no-cache` is the ceiling, and
hashing "would need a build step this frontend does not have." That last clause
is no longer true. `no-cache` was the right call *given* no hashing; hashing is
available for about ten lines of work, and then warm loads make **zero**
requests for JS and CSS.

## A fresh visit to `/` boots the app twice

No `?board=` param → the whole sequence above runs →
[app.js:93](../public/app.js#L93) fetches `/api/boards` →
`location.replace('/?board=X')` → a full navigation, which re-walks the module
graph from the top, and only then are items fetched. Two complete boots to see
one board. There is no `app.get("/")` on the server; `/` is served by
`express.static` with `extensions: ["html"]`, so today the board choice has
nowhere to happen but the client.

The same double-ask is visible in the payload: `/api/boards` is fetched at
line 93 to pick a target, and again at [line 131](../public/app.js#L131) inside
the boot batch.

## Findings that change the shape of the fix

Five things make this far cheaper to fix than it looks. They are the reason
this arc is stages rather than a rewrite.

**1. The build step already exists.** The Dockerfile runs:

```
RUN npx -y esbuild@0.24.2 public/*.js public/*.css --outdir=public \
      --allow-overwrite --format=esm --legal-comments=none
```

esbuild is already in the image build, already pointed at `public/*.js` and
`public/*.css`, already emitting ESM. It strips comments and nothing else.
Bundling, minifying and content-hashing are **flags on a command that is
already there**, not new infrastructure. No change to `images.yml`, no change
to `deploy.ps1`.

**2. It bundles clean, first try.** `esbuild app.js --bundle --minify
--format=esm --splitting` succeeds with no resolution errors and no cycle
errors, despite six import cycles in the graph:

```
grid.js → crates.js → grid.js
grid.js → tag-editor.js → kinds.js → lightbox.js → grid.js
kinds.js → lightbox.js → kinds.js
kinds.js → lightbox.js → detail-view.js → kinds.js
kinds.js → lightbox.js → detail-view.js → detail-chart.js → kinds.js
board-modal.js → mapping-modal.js → board-modal.js
```

Cycles bundle safely here because of finding 3. They are still the thing most
likely to produce a subtle runtime difference, so they are what the stage-1
verification has to look at.

**3. Nothing in the boot graph does real work at import time.** A scan of all
53 modules for top-level executable statements turns up only listener
registrations and the entry call:

```
app.js:67    document.addEventListener('app:render', render)
app.js:282   main()
bulk.js:192  document.addEventListener('app:render', …)
data.js:14   document.addEventListener('app:uploads-pending-tag', …)
upload.js:312-315  four app:* listeners
```

No module mutates the DOM, reads `location`, or fires a fetch on evaluation.
That means bundling cannot reorder side effects that matter, and moving a modal
behind `await import()` cannot skip a registration something else depends on.
It also bounds what must stay eager: those four files are small (`bulk.js`
2.1 kB, `data.js` 8.3 kB, `upload.js` 4.8 kB).

**4. `STATIC_DIR` is already an env override.**
[server.js:200](../server/server.js#L200):

```js
const STATIC_DIR = process.env.STATIC_DIR || path.join(ROOT, "public");
```

So a build can emit to `public/dist`, the Dockerfile can set
`STATIC_DIR=/app/public/dist`, and **host dev and the entire test suite keep
serving `public/` source exactly as they do today.** No dev-loop change, no
watch mode to babysit, no change to `test/browser/harness.js` (which boots the
real server with `frontend: true` against the real `public/`). This is the hook
that makes the whole arc opt-in per environment.

**5. There is already one dynamic import to copy.** `detail-chart.js` lazily
imports `vendor/lightweight-charts.standalone.production.mjs` — 190 kB raw /
61 kB gzip that correctly stays out of the boot payload. It is the only
`import()` in the frontend. The pattern this plan generalises is already in the
repo, working, with precedent for how it reads.

## What the numbers become

Measured by actually running the builds, not projected. Board page, JS + CSS,
in **brotli** — the encoding prod already negotiates with real browsers
(verified live; see Stage 1).

| | eager requests | round trips | eager bytes |
| --- | --- | --- | --- |
| today, prod | 53 JS + 5 CSS = 58 | 7 | **168 kB** |
| Stage 1 — bundle, minify, hash | 2 | 1 | **83 kB** |
| \+ Stage 2 — lazy modals + `modulepreload` | 5 | 1 | **50 kB** |

Net: **168 kB over 7 round trips becomes ~50 kB over 1**, and the items fetch
stops waiting on any of it.

Both stage rows are measured end-to-end, but not equally: Stage 1's output was
loaded in a real browser on all seven pages, Stage 2's was built and sized but
not run. The per-stage sections carry the detail, the caveats, and the two
findings that changed each stage's shape — for Stage 1 that per-entry bundles
beat shared chunking, for Stage 2 that `modulepreload` is what makes the stage
worth doing at all.

## Decisions

- **Keep the build in the Dockerfile, keep source servable.** Build to
  `public/dist`, point `STATIC_DIR` at it in the image, leave host dev and
  tests on raw `public/`. The alternative — bundling in place with
  `--allow-overwrite`, as the comment-strip does today — would make built
  output indistinguishable from source in a dirty working tree, and would make
  `npm run server` serve a stale bundle after every edit. Two directories, one
  env var.
- **Content-hash and cache forever.** `--entry-names=[name]-[hash]` plus a
  ~10-line emitter that rewrites the `<script src>` / `<link href>` in each
  HTML into `dist/`. Then `Cache-Control: public, max-age=31536000, immutable`
  for `dist/`, with the existing `no-cache` left in place for anything served
  from source. This is the clause
  [server.js:3687-3699](../server/server.js#L3687-L3699) says it is waiting for.
- **Lazy-load on user intent, not on file size.** The rule is "a module reached
  only from a click handler is fetched by that click handler." Not a budget,
  not a threshold — a structural rule that reads the same everywhere and does
  not need re-litigating per module.
- **Data must not wait for code.** Decided in principle; the mechanism is a
  stage-4 choice between an early-fetch shim and a server-rendered first
  payload, and the two are not exclusive.
- **No framework, no Vite, no SPA router.** The app is plain ESM against a
  plain express file server and that is working. This arc adds flags to an
  esbuild invocation and converts some imports. Anything that replaces the
  frontend's model is out of scope.
- **`script-src 'self'` stays.** Dynamic `import()` is fine under it. Inline
  `<script>` is not, which rules out the usual "inline a boot script in the
  head" trick — stage 4 needs a real file.

## Stages

Each stage is independently shippable and independently valuable. Stage 1 is
the big one; nothing after it is blocked on the others.

### Stage 1 — bundle, minify, hash, cache hard

**Deep-dived 2026-09-16. Built and browser-verified end to end; still
unshipped.** A working build script came out of the dive and sits at
`scripts/build-frontend.mjs`, deliberately *not* wired into the Dockerfile —
the artifact survives, nothing ships until this stage is taken. Everything
below was measured or run, and the two things that matter most were only found
by actually running it.

#### What it produces

Board page today vs. after, **in the encoding a real browser actually gets**.
Prod already negotiates brotli — verified live: send `Accept-Encoding: br` and
`001.itsalex.me` answers `Content-Encoding: br`, and `br,gzip` prefers br. The
gzip figures elsewhere in this plan are therefore the *pessimistic* reading of
today; these are the real one.

| | requests | bytes (brotli) |
| --- | --- | --- |
| today, prod | 53 JS (7 deep) + 5 CSS = **58** | 148 + 20 = **168 kB** |
| after stage 1 | 1 JS + 1 CSS = **2** | 69 + 13 = **83 kB** |

Whole `dist` is 22 files / 1.1 MB on disk. Every page becomes one JS request
and one CSS request; the charting vendor stays in its own lazy chunk, fetched
only when a detail chart opens.

Part of that gap is not bundling at all — it is compression quality, and it is
only *reachable* once the assets are hashed. `compression` hardcodes
`BROTLI_PARAM_QUALITY = 4` (node_modules/compression/index.js:66), tuned for
latency because it is compressing generated responses on the fly. Measured on
`styles.css`: prod's on-the-fly brotli is **10,391 B**, max-quality brotli is
**8,291 B**, and `gzip -9` is **9,449 B** — so today's brotli is paying brotli
CPU for worse-than-gzip bytes. Content-hashed immutable files can be
compressed once, at quality 11, at build time. That is the ~20 % on top, plus
the per-request CPU disappearing. It needs the build to emit `.br` beside each
hashed file and a ~10-line middleware ahead of the `/_` mount to serve it when
`Accept-Encoding` allows; `compression()` keeps handling `/api` unchanged.
Not built during the dive — sized, measured, and left as the last piece of
"cache hard".

#### One file per page, not shared chunks — measured, counter-intuitive

The obvious move is one build with all seven entries and `--splitting`, so
shared code (`utils`, `state`, `modal`, `dropdown`, `api`) is factored into
chunks both pages reuse. Measured, that is **worse for the board page**:

| config | board page eager | files | dist on disk |
| --- | --- | --- | --- |
| one build, 7 entries, `--splitting` | 87 kB | 9 | 179 kB |
| **one build per entry** | **81 kB** | **1** | 232 kB |

Shared chunking costs the board page both bytes (chunk boundaries block
cross-module minification) and requests. It buys cheaper *navigation* between
page types — `/boards` after `/` reuses 7 of 8 chunks — which is worth less
than the page people actually live on. So: seven separate invocations, each
keeping `--splitting` so its own dynamic `import()` still splits out. The
53 kB of extra disk is duplicated shared code in a Docker image, which is not
a currency worth spending a request on.

CSS goes the same way for the same reason. Each page links a *different* set
(index: styles+modal+toast+dropdown+checkbox; boards swaps in `boards.css`;
admin drops `styles` and adds `panel`; `logs.html` links none at all and is
inline-only), so there are six distinct sets. Hashing each file individually
leaves index.html at 5 render-blocking requests / 17 kB; a generated per-page
`@import` entry makes it **1 request / 15 kB**. Render-blocking is where
request count hurts most, so the per-page bundle wins on both axes.

#### The landmine: CRLF, and a build that lies

Six of the seven HTML files are **CRLF**; `logs.html` is LF. (Same split in
the assets: `styles.css` is CRLF, `app.js` is LF.) The HTML rewriter's
stylesheet-link regex was anchored on `\n`, so it **silently matched nothing**
on all six CRLF pages. The build exited 0. The script tag was rewritten
correctly, so the output looked plausible. Every emitted page pointed its
stylesheet hrefs at `styles.css`, `modal.css` … — names that do not exist in
`dist`. The app would have shipped with **no CSS at all**, and the build would
have reported success.

The fix is `\r?\n` and preserving the matched EOL. The *lesson* is the part
that belongs in the code: a rewrite that matched nothing is indistinguishable
from a rewrite that worked, until someone loads the page. So the build ends
with a verification pass — every `<link rel=stylesheet href>` and
`<script src>` in every emitted HTML must resolve to a file that exists in
`dist`, and every page that had stylesheets must end up with exactly one —
and throws otherwise. Confirmed by deliberately breaking the rewrite: both
checks fire.

That pass also caught its own first false positive, which is worth keeping in
mind when reading it: `profile.html` links `/login.html?change=1&next=…`. Page
navigation is the server's business, not a file that has to sit in `dist`, so
the check is scoped to asset references only.

#### Everything else the dive turned up

- **Absolute specifiers must be normalised.** `esbuild --bundle admin.js`
  fails outright with `Could not resolve "/utils.js"` — to a bundler a leading
  `/` is a filesystem path. It is **66 occurrences across 13 files**
  (`admin.js`, the seven `admin-*.js`, `admin-capabilities.js`,
  `plugin-modal.js`, `plugin-add-modal.js`, `prices-modal.js`, `profile.js`),
  and every one resolves to a flat sibling — no subdirectories — so
  `/x.js` → `./x.js` is a mechanical sed across 13 files, and it deletes a
  split convention that had no reason to exist.
- **`--legal-comments=none` becomes a licensing bug.** Today's flag is safe
  only because the glob is `public/*.js` and the vendor file is
  `public/vendor/*.mjs` — top-level only, exactly as the Dockerfile comment
  says. Under `--bundle` the vendor file *is* pulled in, and `none` strips its
  `/*! @license … Apache License 2.0 */` header. Verified: esbuild's default
  `eof` relocates the notice to the end of the chunk intact. Stage 1 must pass
  `--legal-comments=eof`.
- **No sourcemaps.** With `--sourcemap=linked` the maps are **3.9 MB against
  1.1 MB for the whole rest of `dist`**, and a map embeds the original source
  verbatim — re-publishing to every browser precisely the commentary the
  existing comment-strip exists to keep in the repo. That is a reversal of a
  deliberate decision, not a side effect worth taking silently. Off by
  default; if prod debugging ever needs maps, the honest form is one uploaded
  somewhere that is not the web root.
- **Hashed output goes under `dist/_/`.** Then the cache rule is a path rule
  the server can state plainly, instead of a regex guessing at esbuild's hash
  alphabet. Unhashed leftovers (`notification.mp3`, which `chime.js` fetches
  by name, and the vendor LICENSE) stay at the root and correctly keep the
  revalidating header.
- **esbuild stays an `npx` invocation.** Driving the pinned CLI
  (`npx -y esbuild@0.24.2`) from the script adds no dependency and leaves the
  image's npm layer strategy — deps first, so code changes don't bust it —
  exactly as it is.
- **`modal.css:518` has a comment that closes itself early.** The prose
  `(.mm-row/.mm-key-locked/.mm-live-*/` contains `*/`, which terminates the
  CSS comment four lines before it was meant to; the remaining prose is then
  parsed as CSS and discarded. esbuild warns about it, which is how it was
  found. Checked: the next real rule (`.mm-empty`) survives intact, so there
  is **no live styling damage** — it is a one-character fix
  (`.mm-live-*` → `.mm-live-`), not a bug that is hurting anything today.

#### The server change, verified

```js
// Content-hashed output can never change under a given name, so /_/ is the one
// place a year-long max-age is honest. Mounted ahead of the general handler;
// when STATIC_DIR is source (host dev, the test suite) the directory is absent
// and this is a no-op.
app.use("/_", express.static(path.join(STATIC_DIR, "_"), { immutable: true, maxAge: "1y" }));
app.use(express.static(STATIC_DIR, {
  extensions: ["html"],
  setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
}));
```

Measured responses against built `dist`:

```
200 /                          no-cache
200 /index.html                no-cache
200 /boards                    no-cache
200 /_/index-UG7VDTPB.js       public, max-age=31536000, immutable
200 /notification.mp3          no-cache
200 /vendor/…LICENSE           no-cache
```

…and against source `public/` — host dev and the whole test suite — every
response is `no-cache` and `/_/…` 404s, i.e. **byte-identical to today's
behaviour**. The [server.js:3687](../server/server.js#L3687) comment gets
rewritten at the same time: it will then be describing a road taken.

#### Verification actually run

All seven pages loaded in real Chromium (Playwright is already a devDependency
and the binary is present), from built `dist` and from source `public/`, with
`pageerror`, console errors, failed requests and 4xx/5xx collected, plus a
computed-style assertion that the page's CSS actually applied.

**Result: identical on both. Zero JS errors on every page, bundled or not.**
That settles the one open risk from the parent plan — the six import cycles
bundle correctly, as finding 3 predicted, and now it is checked rather than
assumed. (`logs.html` reports "no CSS applied" in both runs; it links no
stylesheet and sets no `font-family` anywhere, so that is the assertion not
applying to that page, not a build result.)

The remaining verification to run when this ships, which the dive did not:
`npm run test:browser` with `STATIC_DIR` pointed at `public/dist`. The harness
already boots the real server against the real static dir, so it costs one env
var, and it exercises clicking and uploading rather than just evaluation.

#### Second pass, 2026-09-16 — three blockers the first pass missed

All three are infrastructure, not code, which is exactly why writing the
script and watching it work did not surface them.

- **`.dockerignore` excludes `scripts`.** So `RUN node scripts/build-frontend.mjs`
  in the Dockerfile fails outright — the file is not in the build context. The
  fix is a negation directly under the existing rule:

  ```
  scripts
  !scripts/build-frontend.mjs
  ```

  Verified with a real `docker build`: only `build-frontend.mjs` lands in the
  context, and the one-off `bisect-*` / `probe-*` / `verify-*` scripts beside
  it correctly stay out. Un-ignoring the whole directory would drag all of
  those into the image for nothing.
- **`images.yml` would not rebuild the app image.** The path filter is
  `^(server/|public/|examples/|package(-lock)?\.json$|Dockerfile$|\.dockerignore$)`
  — `scripts/` is absent. Edit the build script, push, and CI leaves the app
  image alone: the frontend build changes and the deployed image keeps the old
  output, silently. The filter needs `scripts/build-frontend\.mjs` added. Worth
  noting the comment above that line says "the app's inputs are what
  .dockerignore admits into its context", which will be true again once both
  changes land together — they have to land together.
- **`test/helpers.js:94` hardcodes the static dir.**
  `process.env.STATIC_DIR = frontend ? PUBLIC_DIR : tmp` overwrites whatever
  the environment set, so the verification this stage promised — "run
  `test:browser` with `STATIC_DIR` pointed at `public/dist`" — **does not work
  as written**. `startServer` takes only `{ frontend = false }`. It needs a
  `staticDir` option (or to honour a pre-set `STATIC_DIR`) before built output
  can be tested by the existing suite.

#### Second pass — what came back clean

- **The lazy chunk resolves at runtime.** The smoke test loaded pages but never
  opened a chart, so the dynamic import was never exercised. Checked properly:
  the built entry contains
  `import("./lightweight-charts.standalone.production-NOTPGY3A.js")`, which
  resolves against `/_/` correctly; the chunk is **not** fetched on page load;
  and importing it in the page returns a real module namespace (`AreaSeries`,
  `BarSeries`, `CandlestickSeries`, …). Deferred and reachable, both confirmed.
- **Hashes are deterministic across rebuilds.** Same inputs, same filenames,
  byte-identical output. That matters beyond tidiness: `deploy.ps1` skips a
  ship when the image digest is unchanged, and a build that reshuffled hashes
  every run would defeat it and churn a new image on every commit.
- **The generated CSS entry no longer touches the source tree.** It was being
  written to `public/.css-entry-<page>.css` and deleted in a `finally`; a hard
  crash would have left repo litter that a `public/*.css` glob would then pick
  up. Moved into `dist` with `@import "../x.css"`. Output hashes unchanged,
  which re-confirms determinism.

#### Order of operations

The specifier normalisation is a hard prerequisite, not a cleanup to fold in
afterwards: run the build against the tree as it stands today and it dies on
`admin.js`'s `"/utils.js"`. Confirmed — and confirmed that it dies *loudly*,
with a nonzero exit, rather than emitting a partial `dist`. So:

1. Normalise the 66 absolute specifiers across the 13 files (`/x.js` → `./x.js`).
   Ships and is verifiable on its own: native ESM resolves both spellings
   identically, so the app is unchanged and the existing suite covers it.
2. Fix `modal.css:518`'s self-closing comment. Also independent.
3. Add `public/dist/` to `.gitignore` — it is build output in the source tree
   and nothing currently excludes it.
4. Give `startServer` a `staticDir` option, so step 6 is possible at all.
5. `.dockerignore` negation **and** the `images.yml` path-filter entry, in one
   commit — either alone is broken (no script in the context, or a script the
   image never rebuilds for).
6. Wire `scripts/build-frontend.mjs` into the Dockerfile in place of the
   comment-strip line, set `STATIC_DIR=/app/public/dist`, add the `/_` mount.
7. Run `test:browser` against `dist`, then deploy.
8. Optional, separable, and measured above: precompressed `.br` beside each
   hashed file plus the middleware to serve it.

Steps 1–4 are safe to land before anyone commits to step 6. Step 5 is the one
place where two files have to move together.

### Stage 2 — lazy modals

**IMPLEMENTED 2026-09-16 (uncommitted).** Measured after: the board page is
**51 kB brotli over 5 requests in one round trip** (entry + 3 preloaded chunks
+ 1 stylesheet), against 83 kB / 2 after Stage 1 and 168 kB / 58 / 7 round
trips before the arc. 10 lazy chunks (170 kB br) are fetched on the click that
needs them, or warmed on idle after first paint — verified in a throttled
browser: every boot asset starts at +83 ms in one wave, the modal and lightbox
chunks only at +691 ms. Suite 1582/1582, browser suite 29/29 against both
source and built output, lint clean, docker build green.

The headline changed shape during the dive, twice. It is not "move the modals
behind `import()`". It is **two separations that have to happen first**, and
then **one hint in the HTML without which the whole stage barely pays.**

#### What it produces

| | eager requests | round trips | eager bytes (brotli) |
| --- | --- | --- | --- |
| today | 58 | 7 | 168 kB |
| Stage 1 only | 1 | 1 | 69 kB |
| \+ Stage 2, one lazy root per modal | 12 | 2 | 39 kB |
| \+ Stage 2, single modal barrel | 4 | 2 | 37 kB |
| \+ `modulepreload` for the eager chunks | 4 | **1** | **37 kB** |

Lazy, fetched on the click that needs it: the modal barrel 31 kB br, the
lightbox subtree 9 kB br, the charting vendor 53 kB br (already lazy today).

#### The two separations

Neither is optional, and neither is a "convert the import" change. These are
the stage.

**`switchRow` must come out of `board-modal.js`.** It is imported by
**five** other modules — `alerts-modal.js`, `ingest-modal.js`,
`mapping-modal.js`, `plugin-modal.js`, `source-chooser.js`. So a control lives
inside a modal, and every one of those importers pins the 17.5 kB board modal
(plus the 20 kB mapping modal and 13.7 kB `capability-present.js` behind it)
into the boot graph. Leave it and the largest single item in Stage 2 does not
move at all.

`makeSwitch` (15 lines) + `switchRow` (20 lines) have no dependencies beyond
the DOM, and the repo already has the shelf for them: `checkbox.js`
(`createCheckbox`, `createToggle`) and `select.js` (`fillSelect`, `isUnset`)
are exactly this — one control, one module. So `switch.js`. `makeSwitch`'s
`export` is also dead surface — nothing outside the file calls it, only
`switchRow` does.

Which surfaces something worth naming separately: **there are two switch
controls in this codebase.** `checkbox.js`'s `createToggle` is a hidden real
`<input>` with `role="switch"`, class `.cb--toggle`, styled in `checkbox.css`,
used by `dropdown.js`. `makeSwitch` is a `<button role="switch">`, class
`.switch`, styled in `modal.css`, used by the six modal-family modules. Same
semantics, two implementations, two CSS vocabularies — which
[[feedback_no_component_duplication]] says not to do. **Unifying them is not
Stage 2's job:** they render differently (34×20 px track / 16 px knob against
28 px / 12 px), they have different variants (`.sm` vs `.cb--dark`), and a
merge is a visual migration across six call sites. Extracting to `switch.js`
does not make the duplication worse — it makes it *visible*, as two sibling
control modules instead of one module and something buried in a modal, which
is the precondition for fixing it later.

**`facet-diagnostics.js` is a diagnosis engine with a modal on top.** At 606
lines it splits at `EDITOR_STATES` (line 311) almost exactly in half:

- *above* — `diagnosisState` (110 lines, and its own comment already says it
  "lives here rather than in either surface because both need it"),
  `canSeeDiagnostics`, `refreshFacetStats`, `ensureFacetStats`, `newestAt`,
  `diagnosticsUnseen`, `markDiagnosticsSeen`. All of this computes the header
  dot and runs every render or on a 20-second tick from `signals.js`. **Stays
  eager.**
- *below* — `diagnosisBlock` (177 lines) and `openDiagnosticsModal`. **Goes
  lazy**, and `board-modal.js` (itself lazy) is the other consumer of
  `diagnosisBlock`, so it rides along.

So this file contributes roughly **half** of its 11 kB to the saving, not all
of it. That is the honest number and it is worth stating, because "the modals
are half the payload" invites the assumption that all of it can leave.

#### The eager remainder, precisely

Everything `renderToolbar` touches every render, with its real declaration:

```
jobsUnseen          jobs-modal.js:30    1 line   → jobs-state.js
jobsModalOpen       jobs-modal.js:313   1 line   → jobs-state.js  (see below)
alertsUnseen        alerts-modal.js:19  1 line   → alerts-state.js
canSeeDiagnostics   facet-diagnostics.js:173  1 line  ┐
refreshFacetStats   facet-diagnostics.js:184  small   │ → facet-diagnosis.js
ensureFacetStats    facet-diagnostics.js:210  5 lines │
diagnosticsUnseen   facet-diagnostics.js:228  8 lines ┘ (needs diagnosisState)
presentIngest       ingest-present.js         already split out — the pattern
```

`jobsModalOpen` is the interesting one. It is `() => !!modalEl` — the lazy
module's *own* state, queried by `signals.js:122` to gate a 20-second poll. It
cannot be imported eagerly from a module that may not be loaded. But the
semantics are forgiving in exactly the right direction: **a module that is not
loaded cannot have an open modal**, so `false` is not a fallback, it is the
correct answer. The flag moves to `jobs-state.js` and `jobs-modal.js` writes
it — three lines, no indirection games, and the same shape as `seen-mark.js`,
which already holds shared dot state for these surfaces.

#### One lazy root, not eight — measured

The obvious conversion gives every modal its own `import()`. Measured, that is
worse: each extra lazy root makes esbuild's `--splitting` factor out another
chunk of code shared between boot and that root, and the **boot path then has
to fetch all of them**. Eight lazy roots → 12 eager files. Collapsing the
toolbar's modals behind a single `modals.js` barrel → **4 eager files**, and
2 kB smaller besides.

Per-modal granularity buys nothing a user notices — anyone who opens one modal
will open others — and costs boot requests. The lightbox stays its own root
(different trigger, much more common) and the charting vendor already is one.
Three lazy roots total.

This is the same lesson as Stage 1's per-entry-vs-shared-chunks finding, from
the other direction: `--splitting`'s deduplication is a cost on the critical
path, not a free win.

#### The `modulepreload` hint, without which this stage barely pays

Four eager files means the browser parses the entry, *discovers* three chunks,
and fetches them — a second round trip. Measured against a server with 50 ms
of simulated latency:

```
no hint:   entry at +79ms,  chunks at +140ms   ← second round trip
with hint: chunks at +72ms, entry at +73ms     ← all four in parallel
```

Without the hint, Stage 2 trades 32 kB for a round trip, which at 48 ms RTT
and broadband is roughly a wash and only wins on slow connections. With it,
the board page is **37 kB in one round trip against Stage 1's 69 kB in one** —
strictly better, unconditionally.

The hints belong in the Stage 1 build script, which already rewrites each HTML
and already has the chunk graph in esbuild's metafile. Emitting
`<link rel="modulepreload">` for the entry's eager chunk closure is a few
lines there. **Stage 2 should not ship without it.**

#### The dropdown wrinkle — smaller than the parent plan claimed

This plan previously said `dropdown.js` would have to learn to accept a promise
for its body. It does not, and it should not. `openDropdown`'s `build(body, ctx)`
and `footer(foot, ctx)` are called synchronously (`dropdown.js:126`), and
`toolbar.js`'s alert menu hands them `appendAlertMenu` / `appendAlertFooter`.
The fix is to `await` the import **before** calling `openDropdown` — the click
handler becomes `async`, and `build` stays synchronous over an
already-resolved module. No change to `dropdown.js` at all, which is the right
outcome under [[feedback_no_speculative_complexity]]: a general async-dropdown
facility for one caller is exactly the structural escalation to avoid.

#### First-click latency, and the answer already in the repo

The real cost of this stage is that a click that used to be instant now may
wait on a chunk. Two mechanisms, both already present:

- **Prefetch on idle.** After the first render, `requestIdleCallback` the three
  lazy roots. They land in the HTTP cache — *immutable*, thanks to Stage 1 —
  while the reader is looking at the grid, so the first click is warm and every
  later visit needs no request at all. This is what turns Stage 2 from a
  latency trade into a pure win, and it is the reason Stage 2 is worth
  noticeably more after Stage 1 than before it.
- **`busy()` for the cold case.** `modal.js:181` already wraps a button in a
  spinner + disabled + `aria-busy` with a re-entrancy guard, and is used in 15
  files. Wrapping a lazy opener in it is the existing vocabulary, not new
  machinery. Worth applying only where a cold fetch is plausible — a spinner
  that flashes for 30 ms is worse than no spinner.

A failed `import()` (offline, or a deploy that replaced the chunk mid-session)
must not be a click that silently does nothing. `toast.error` on the catch is
the floor; the hashed-and-immutable naming from Stage 1 makes the
deploy-mid-session case a real one to handle rather than a theoretical.

#### Also in scope

Break `kinds.js` → `lightbox.js`. This edge deserves more than a line, because
it is the single most tangled thing the whole dive found and it is not a
performance problem dressed up as a structural one — it is the reverse.

`kinds.js` is 221 lines of vocabulary: what kinds of thing can sit on a board,
and how to name, thumbnail and URL each one. `lightbox.js` is an 853-line
full-screen viewer. The correct arrow already exists — the viewer imports
`fullUrl` and `kindFor` from the vocabulary. The wrong arrow exists too: each
kind definition carries `openDetail(item) { openLightbox(item) }`, so the
vocabulary imports the viewer.

That is policy in a registry. A module describing *what an item is* should not
know *which surface opens it*; the code handling the click should decide. And
the cost is not abstract:

- **Four of the six import cycles in the codebase are this one edge.**
  `kinds ↔ lightbox`; `kinds → lightbox → detail-view → kinds`;
  `kinds → lightbox → detail-view → detail-chart → kinds`; and
  `grid → tag-editor → kinds → lightbox → grid`. Only
  `grid ↔ crates` and `board-modal ↔ mapping-modal` survive without it.
- **It is the deepest chain in the graph** —
  `app → grid → tag-editor → kinds → lightbox → detail-view → detail-chart`,
  the seven levels this whole plan opens with.
- **It scatters one decision across three places.** `app.js`, `kinds.js` and
  `rows.js` each independently reach for the lightbox, which is why lazy-loading
  it is a three-site change with a cycle in the middle rather than one line.

Removing it does not by itself take the lightbox out of the boot graph —
`app.js` and `rows.js` still reference it. What it does is collapse the deepest
chain, kill four cycles, and reduce "who opens the detail view" to one place,
which is what makes the lazy-load afterwards trivial and safe instead of
fiddly. **Worth doing on its own merits even if the performance work stopped
here.**

Note also that `app.js` calls `initLightbox()` in `main()` — but reading it
(`lightbox.js:786`) it is pure wiring: it creates an overlay div and attaches
listeners to elements `index.html` already carries. **Nothing about it needs
boot.** It folds into the first open, guarded, and the `main()` call goes away.
Same for collapsing the four static `jobs-modal.js` importers (`app.js`,
`toolbar.js`, `signals.js`, `announce.js`) onto `jobs-state.js`.

`capability-present.js` (13.7 kB) needs no work of its own: it is a presenter,
not a modal, and it leaves the board page's boot graph simply by following
`board-modal.js`. It stays eager on `boards.js` and `welcome.js`, which import
`presentTrouble` / `presentChip` directly — correctly, those pages render it.

### Stage 3 — one navigation to a board

**IMPLEMENTED 2026-09-16 (uncommitted).** The dive reversed this stage's
premise: **no server route, no cookie.** Both were solving a problem that does
not need the server. Shipped as the client fix below, plus the two browser
tests the path never had. Measured after: landing on / costs 1 document load
and 1 /api/boards call, and the gap against a direct board URL is 0ms (was
104ms; -2ms at 4x CPU throttle, i.e. noise).

#### What it actually costs, now that Stage 1 has landed

The parent plan says "two complete boots", which was true when written and is
no longer the whole story: after Stage 1 the second navigation re-uses the
bundle from cache. Verified by resource timing across three visits to the same
board:

```
visit 1   NETWORK  transferSize=83159  29ms  index-…js     transferSize=16626  14ms  index-…css
visit 2   CACHE    transferSize=    0   0ms                transferSize=    0   0ms
visit 3   CACHE    transferSize=    0   0ms                transferSize=    0   0ms
```

(`immutable` doing exactly what it promises. Worth noting the trap: Playwright
reports cache-served requests as `request` events, so counting those says the
cache is being missed when it is not. `transferSize` is the honest signal.)

So the wasted first boot no longer re-downloads anything. What it still costs
is one extra document round trip, one extra `/api/boards` call, and a second
parse-and-evaluate of the bundle. Measured against the same server, median of
five runs, to the grid actually having children:

| | `/?board=X` direct | landing on `/` | wasted |
| --- | --- | --- | --- |
| normal CPU | 50 ms | 154 ms | **104 ms** |
| CPU throttled 4× | 109 ms | 234 ms | **125 ms** |

That is on localhost, where the extra document round trip is free. On prod add
roughly one RTT (~48 ms) on top. And it is not a rare path — bare `/` is
reached from `login.js:100` on **every login**, from the "Gallery" back-link in
both `admin.html` and `profile.html`, and from any bookmark or typed domain.

#### The second navigation is not needed at all

`main()` does this at [app.js:93](../public/app.js#L93): fetch `/api/boards`,
pick a target, `location.replace('/?board=…')`. But at that moment **nothing
has rendered and nothing below reads the board out of the URL** — `state.boardId`
is a variable, the `params` object was already captured at line 80, and
`syncFiltersToUrl` ([filters.js:406](../public/filters.js#L406)) only ever
touches `f`, `fx` and `u`, so it preserves `board` rather than deriving from it.
The navigation exists to tell the app something it is already holding.

Replace it with adoption in place — set `state.boardId`, `history.replaceState`
the address, fall through to the boot batch — and reuse the array just fetched
instead of asking again at line 131. Measured with that change built and loaded:

```
document loads:     1   (/)            ← was 2
/api/boards calls:  1                  ← was 2
final URL:          /?board=7d5d92b9-…
```

…and the gap against a direct board URL closes from 104 ms to **0 ms** (11 ms
at 4× CPU throttle). Address still shareable, and the history entry is replaced
exactly as `location.replace` replaced it, so the back button still goes where
the reader came from.

#### Why the server route and the cookie are both the wrong answer

Count the round trips. Writing `D` for a document and `A` for an API call:

```
today                     D(/)  A(/api/boards)  D(/?board=X)  A(batch)   — 4, two parses
server 302 + cookie       D(/)→302  D(/?board=X)  A(batch)               — 3, one parse
adopt in place (client)   D(/)  A(/api/boards)  A(batch)                 — 3, one parse
```

A 302 is itself a round trip, so the server route and the client fix are
**equal** — and the client fix costs no new server surface, no cookie, and no
split-brain between `localStorage.lastBoard` and a cookie mirror that can
disagree with it. The cookie only pays for itself in a design where the server
answers `GET /` with the board's HTML *directly*, no redirect — 2 round trips
instead of 3. That is a real improvement, but it needs the server to inject
state into the page, which is Stage 4's mechanism, not this one. **Fold it into
Stage 4 if that stage happens; do the client fix here regardless**, because it
is also the correct fallback for any reader the cookie cannot identify.

#### Implementation notes

- Keep both genuine navigations: zero boards → `/boards`, and a refused board →
  `/boards?gone=1`. Those change page, so they must stay real.
- The hoisted board list should be a `let` **inside** `main()`, not module
  scope. The version measured above put it at module scope, which works only
  because `main()` runs once.
- **Add a test for landing on `/`.** Nothing covers it today — every browser
  test opens `/?board=…`, `/admin`, `/boards` or `/welcome`. Both suites passed
  with the change applied (1579 + 26), which is reassuring and *not* evidence:
  the path has no coverage to fail. That gap is the main risk in this stage and
  the cheapest thing to close.
- Tempting and not recommended: having `login.js` and the two "Gallery"
  back-links read `localStorage.lastBoard` and link straight to `/?board=…`,
  skipping the boards fetch. It saves a round trip on the common path and costs
  a wrong-footed `?gone=1` page ("the address changed") on a stale id, which is
  the wrong sentence for "you just signed in".

### Stage 4 — stop making data wait for code

**Deep-dived 2026-09-16. Recommendation: DROP IT.** Not deferred — dropped. The
premise was true when this plan was written and Stage 1 dissolved it. Nothing
here was implemented; what follows is why it should not be.

#### The question the plan asked, answered

"Measure `/api/items?board=…&limit=200` on the largest board before choosing."
Done, against the real dev database — the biggest board is `ui` at **4,666
items**:

```
listItems limit=200  (the boot page)      18.5 ms    317 kB raw -> 23 kB brotli
listItems limit=500  (a drain page)       27.1 ms    790 kB raw
listItems no limit   (the whole board)   108.4 ms   7178 kB raw
listBoards                                 2.0 ms     55 kB raw
```

18.5 ms — "tens of milliseconds", so by this plan's own stated criterion the
shim wins and SSR is not worth the weight. But the criterion turns out to be
the wrong question, because it assumes the data is on the critical path.

#### It isn't. The code is.

The grid cannot render before the bundle is parsed, so
`time-to-grid ≥ time-to-bundle` no matter what the data does. Measured how far
apart they actually are, from the bundle's `responseEnd` to the first `/api`
request starting:

```
warm cache, fast net          gap   2 ms
warm, 100 ms RTT / 1.5 Mbps   gap   2 ms
warm, 4× CPU throttle         gap  14 ms
```

After Stage 1 there is essentially nothing left between "the code arrived" and
"the data was asked for". A shim exists to reclaim that gap. The gap is 2 ms.

#### Proved it by building the strongest version and measuring

The best available mechanism is not the shim and not SSR — it is
`<link rel="preload" as="fetch">` emitted into the HTML by the server, which
starts the API calls at the *first* round trip, in parallel with the bundle,
with no payload embedded and no DB query blocking the document. Injected the
hints for all six boot endpoints and measured on a throttled link
(100 ms RTT, 1.5 Mbps):

| | bundle ready | items done | **grid** |
| --- | --- | --- | --- |
| cold, no hints | 975 ms | 1146 ms | **1269 ms** |
| cold, with hints | 1070 ms | **283 ms** | **1229 ms** |
| warm, no hints | 124 ms (cached) | 258 ms | **389 ms** |
| warm, with hints | 126 ms (cached) | 292 ms | **405 ms** |

The data lands **863 ms earlier** on a cold load and the grid improves by
**40 ms**, because the grid is waiting for the bundle — and the hints actually
push the bundle *later* (975 → 1070 ms) by competing for the same constrained
bandwidth. On a warm load the hints do nothing at all; the 16 ms is noise.

SSR is worse than this on both counts: it embeds ~23 kB of compressed JSON into
a document that is `no-cache`, so it re-sends that on **every** load forever,
delaying the bundle by more than the hints do, to move data that is already not
the critical path.

**If the goal is a faster grid, the lever is fewer boot bytes, not earlier
data — and that is Stage 2**, which takes the boot payload from 69 kB to 37 kB.

#### Two measurement traps, recorded because both nearly produced a wrong answer

- **`page.route()` disables the HTTP cache for the whole context.** The first
  run of the table above used route interception to inject the hints and showed
  warm-with-hints at 1129 ms against 401 ms without — an apparent 3× regression
  that was entirely the instrument. The bundle's `transferSize` gave it away:
  83,248 bytes on a run that should have been a cache hit. Re-run by writing
  the hints into the served file instead.
- **Playwright reports cache-served requests as `request` events**, so counting
  those says the cache was missed when it was not. `transferSize === 0` is the
  honest signal. (Same trap as Stage 3.)

#### Keep this, if hints are ever revisited

`<link rel="preload" as="fetch">` **must carry `crossorigin`**, and the failure
mode is silent. Measured against a bare server:

```
no preload, plain fetch            /data fetched 1x
preload, plain fetch               /data fetched 2x   ← preload wasted
preload + fetch cache:"no-store"   /data fetched 2x   ← preload wasted
preload crossorigin + no-store     /data fetched 1x   ← reused
```

Every boot call in `app.js` passes `{ cache: "no-store" }`, so without
`crossorigin` the hints would not merely fail to help — they would **double
every boot request**. Verified on the real app with a real session that the
`crossorigin` form reuses the response, sends credentials (no 401s) and renders
normally.

#### Caveat, stated because it does not change the conclusion

The throttled runs used a board with no items, so the items response was tiny
and the hints' benefit is understated there. It does not rescue the stage: for
data to become the critical path the items response would have to take longer
than the whole bundle, and on the largest real board it is 23 kB brotli against
the bundle's 83 kB. The ordering is not close.

The existing pagination — `limit=200` for the first page at
[app.js:125](../public/app.js#L125), then `limit=500` pages via `drainItems`
([data.js:467](../public/data.js#L467)) — is already the right shape and needed
no change either way.

### Stage 5 — the third-party font chain

[index.html:9](../public/index.html#L9) loads the Inter stylesheet from
`fonts.googleapis.com`, render-blocking, which then requests a `woff2` from
`fonts.gstatic.com` — a 2-deep chain across two origins nobody here controls,
each with its own DNS + TLS. The `preconnect` hints at lines 7-8 soften the
handshake and cannot remove the chain. Self-host the four Inter weights as
`woff2` under `public/`, drop the two `preconnect`s and the third-party
stylesheet, and the CSP loses its `fonts.googleapis.com` / `fonts.gstatic.com`
allowances — [server.js:295-305](../server/server.js#L295-L305) gets shorter, which is
its own small win.

## Out of scope, noted

`admin.js` calls `renderMembers`, `renderBoards`, `renderUsage`,
`renderPluginSurfaces`, `renderBackups` and `renderLogs` at boot — six tab
renders, each with its own API call, for tabs the user cannot see.
`renderStorage` is already correctly deferred to tab selection, with a comment
explaining why. This is the same "work on arrival for UI nobody asked for"
shape as the modals and probably wants the same treatment, but it is the admin
page, not the board page, and it is not what this arc was opened for.
