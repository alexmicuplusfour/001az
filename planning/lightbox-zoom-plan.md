# Lightbox zoom — the wheel steers, the click still closes (2026-09-19)

**Status: COMPLETE — all three stages SHIPPED 2026-09-19.**
[zoom-geometry.js](../public/zoom-geometry.js) (17 unit tests), the controller
and the readout in [lightbox.js](../public/lightbox.js), and
[test/browser/lightbox-zoom.test.js](../test/browser/lightbox-zoom.test.js)
(7 cases in real Chromium), and a simplification pass over the finished diff
(section near the bottom). Suite 1792 green, browser suite 45 green. Desktop
only, image renderer only, no server change, no payload change. Uncommitted at
time of writing.

The ask, verbatim: *"thinking of adding zoom (scroll) and pan to cursor
location… we'd scroll only if the image is larger than it's being shown"* —
clarified to mean **zoom anchored at the cursor**: the point under the pointer
stays put while the image grows around it. Not drag-to-pan. That clarification
is the whole reason this plan is small, and the reason it earns its place at
all: the lightbox already loads the **original** file
([kinds.js:9](../public/kinds.js#L9) `gallery/<name>`, not the thumbnail), so a
4000px photo on a 1400px stage has ~3× of real pixels nobody can currently see.
The detail is already on the wire. This is the first thing that looks at it.

## What it sits on, and what it must not break

- **Click means close, everywhere.**
  [lightbox.js:793](../public/lightbox.js#L793) binds `closeLightbox` to the
  whole surface and [styles.css:1784](../public/styles.css#L1784) advertises it
  with `cursor: zoom-out`. Every other interactive thing in the lightbox — the
  panel, the nav arrows, the action pills, the audio wrap — exists as a
  `stopPropagation` against that one handler. It is the lightbox's only
  dismissal gesture that doesn't need the keyboard.
- **Fit scale is never above 1.**
  [styles.css:1801](../public/styles.css#L1801) sizes the image by
  `max-width/height: 100%` with `object-fit: contain` and no `width`, so the
  browser shrinks to fit and never upscales. That single fact is what makes the
  "only if it's larger than shown" rule exactly computable rather than a guess.
- **The detection overlay measures the live rect.**
  [lightbox.js:155](../public/lightbox.js#L155) `positionDetOverlay` reads
  `img.getBoundingClientRect()` and runs it through
  [det-geometry.js](../public/det-geometry.js) `contentRect`. A rect is
  *post-transform*, and the natural aspect never changes, so the boxes follow a
  scale/translate with **zero new math** — they only need to be told to
  re-place.
- **The stage clips nothing.**
  [styles.css:1816](../public/styles.css#L1816) has no `overflow`, because until
  now nothing could exceed it.
- **The panel changes the frame.**
  `.panel-open` adds `padding-right: 432px`
  ([styles.css:2231](../public/styles.css#L2231)) and
  [lightbox.js:671](../public/lightbox.js#L671) already chases the resulting
  relayout with a `requestAnimationFrame(positionDetOverlay)`.
- **The stage is a renderer registry.** Image-bearing renderers expose
  `imgEl` ([detail-view.js:228](../public/detail-view.js#L228)); docs, audio and
  charts don't. The chart renderer **already owns wheel zoom-pan** of its own
  ([detail-chart.js:260](../public/detail-chart.js#L260), lightweight-charts'
  defaults) — two wheel-zoom systems in one stage is the failure mode to design
  away, not to discover.
- **Wheel is unclaimed.** `lockScroll` ([modal.js:28](../public/modal.js#L28))
  puts `overflow: hidden` on the body while the lightbox is open, so the wheel
  currently does nothing over the stage. It is *not* free over the whole
  lightbox: `.lbp-body` and the instances list scroll for real.

## Decisions made up front

**Plain wheel and ctrl+wheel do the same thing.** PhotoSwipe's default is the
opposite — wheel pans, ctrl+wheel zooms — because it assumes an already-zoomed
image with somewhere to pan. A fit-to-screen photo has nowhere, so the plain
wheel would do nothing. Browsers set `ctrlKey: true` on a trackpad *pinch* but
give no way to tell a two-finger scroll from a mouse wheel, so any policy that
splits the two has to guess. Collapsing them dissolves the guess: pinch zooms,
two-finger scroll zooms, mouse wheel zooms, and no gesture is ever the wrong
one. ctrl+wheel must be `preventDefault`ed regardless or it zooms the *browser
page* inside the lightbox.

**Click keeps meaning close.** This is the decision the whole plan hangs on.
Drag-to-pan would need a movement threshold between `pointerdown` and `click`,
`draggable = false` on the image to kill the native HTML5 drag ghost, a
grab/grabbing cursor pair, and a rule for what a click on a zoomed image means
— and every one of those is a renegotiation of the contract above. Cursor
anchoring makes it unnecessary: you steer with the pointer and scroll, and
because each wheel event re-anchors at the current cursor, **moving the mouse
mid-gesture pans for free**. Wheel zooms, click closes; neither gesture is
overloaded.

**Zoomable is a fact about the file, not a mode.** `maxScale = naturalWidth /
displayedWidth`, which is ≥ 1 by the fit rule above. `maxScale <= 1.01` → the
feature does not exist for that image: no listener effect, cursor unchanged, no
pill. A small image behaves *exactly* as it does today, which is the promise
the user's own framing made.

**Cap at CSS 100%, and know what that means.** On a 2× display, CSS-pixel 1:1 is
still being upscaled 2× in device pixels — true source-pixel-per-device-pixel
is `natural / (displayed × dpr)`, a *lower* cap. Capping at `natural/displayed`
is what every desktop app calls 100%, never hides data, and is one number
instead of a DPR lecture. The crispness payoff is front-loaded on retina; that
is a fact to accept, not a bug to fix.

**Reset to fit, don't preserve.** Panel toggle, window resize, `navLightbox`,
`showInstance`, `showMedia`, `closeLightbox` — all reset. Carrying a zoom across
a navigation is a feature someone can ask for later; defaulting to it means
every one of those six paths has to be right about a state the reader has
forgotten setting.

**No touch.** The page ships `width=device-width, initial-scale=1` with no
`user-scalable=no`, so mobile browsers already pinch-zoom the fixed lightbox via
the visual viewport — and re-raster crisply while doing it. Implementing our own
means `touch-action: none` and reimplementing, worse, something the browser does
well. Mobile is not a gap here; it is already covered by someone else.

**No pan at a fixed zoom level, in v1.** See *Open* at the bottom.

## The shape

Two files, mirroring the split
[det-geometry.js](../public/det-geometry.js) +
[det-geometry.test.js](../test/det-geometry.test.js) already established: the
pure math lives where node can test it without a DOM (lightbox.js touches
`document` at import time and can't be imported in a unit test), the wiring
stays in lightbox.js.

### Stage 1 — `public/zoom-geometry.js` + its test

Pure, no DOM.

**One coordinate space: client pixels.** This is the decision that makes the
rest of the module boring. The wheel event's `clientX/Y` is used raw, the stage
is a `DOMRect`, the fit box is a client-space rect, and `tx/ty` are a *pixel
offset applied to the fit box's own position*. With `transform-origin: 0 0` the
element's local origin **is** its fit-box top-left, so the visible box is
always, exactly:

```
{ fit.x + tx, fit.y + ty, fit.w * s, fit.h * s }
```

No conversions anywhere, and `view = { s: 1, tx: 0, ty: 0 }` is rest.

```
fitInfo(stage, naturalW, naturalH)      -> { x, y, w, h, maxScale, zoomable }
clampView(view, fit, stage)             -> { s, tx, ty }
zoomAt(view, cursor, factor, fit, stage) -> { s, tx, ty }
wheelFactor(deltaY, deltaMode)          -> number
```

**`fitInfo` computes the fit box — it never measures one.**
`getBoundingClientRect()` on a transformed element returns the *transformed*
rect, so a measured fit box is only correct at rest, and "only correct at rest"
is a rule someone eventually breaks. The box is derivable instead: it is the
contain-fit of `natural` inside the stage, capped at 1 because `max-width:100%`
shrinks a large image but does not grow a small one —

```
k  = min(stage.w / naturalW, stage.h / naturalH, 1)
w  = naturalW * k,  h = naturalH * k
x  = stage.x + (stage.w - w) / 2      // flex centering, in closed form
maxScale = naturalW / w   (= 1/k)     // ≥ 1 by construction
zoomable = maxScale > 1.01
```

This is deliberately **not**
[det-geometry.js](../public/det-geometry.js) `contentRect`, which describes
`object-fit: contain` inside a *fixed* element box and therefore scales up as
happily as down. Same arithmetic, different rule, one `, 1` apart — the comment
has to say so or the two will get "unified" into a bug where every small image
claims to be zoomable. `naturalW === 0` (not yet loaded) returns
`zoomable: false`.

**The anchoring identity**, per axis, with `p` the cursor:

```
s' = clamp(s * factor, 1, maxScale)
t' = p - (p - t) * (s'/s)
```

**`clampView` has two branches per axis**, and needs the fit width, not just the
stage width — which is why `frame` alone can't express it. A portrait photo at
1.5× covers vertically while still needing to stay centered horizontally:

```
scaled ≤ stage  ->  t = fit.w * (1 - s) / 2          // stay centered
scaled > stage  ->  t ∈ [ stage.w - fit.w*s - dx, -dx ],  dx = fit.x - stage.x
```

The branches **meet exactly** at `s = stage.w / fit.w`: centered gives
`fit.w·(1−s)/2`, covering collapses to the same number. That continuity is what
keeps the image from jumping as an axis crosses from letterboxed to covering,
and it is a free test.

`clampView` also **snaps `s` to exactly 1** within epsilon and zeroes the
offsets there. Without it, float drift parks the view at `s = 1.0000001` after
zooming out, `s > 1` stays true forever, and the Stage 3 pill sits on screen
announcing "100%".

Near an edge the clamp wins and the anchored point drifts off the cursor. That
is correct — it is what every viewer does, and it is what makes zooming back out
settle into fit instead of sliding.

**`wheelFactor`** normalizes `deltaMode` (Firefox reports LINE — ×8; PAGE —
×24), caps a single event's contribution (Chrome/Safari can emit hundreds of
pixels at once), and uses the reciprocal form so in and out are exactly
symmetric — `f(d) * f(-d) === 1` is an identity, not an approximation:

```
f = dy <= 0 ? 1 - (2*dy)/100 : 1 / (1 + (2*dy)/100)
```

Tests:

- **Anchor:** the image-local point under the cursor is unchanged across a zoom
  — computed both sides, compared to 1e-9.
- **Round trip, interior only:** zoom in then out by the reciprocal factor
  returns the original view *away from the clamps*. Stated without that
  qualifier the test is simply false near an edge, and the obvious way to make
  it pass is to weaken the clamp.
- **Continuity:** at `s = stage.w / fit.w` both clamp branches agree.
- **Letterboxed axis:** a portrait image at 1.5× stays horizontally centered
  while the vertical axis is covering.
- **Hard stops:** repeated zoom-in never passes `maxScale`; repeated zoom-out
  lands on exactly `{ 1, 0, 0 }`.
- **`fitInfo` never upscales:** a small image gets `w === naturalW`,
  `maxScale === 1`, `zoomable === false`; so does `naturalW === 0`.
- **`wheelFactor`:** the symmetry identity; a LINE-mode delta and a PIXEL-mode
  delta of equivalent intent land within a tolerance of each other; an absurd
  delta is capped.

**What the build corrected.** Three, all small:

- **`zoomAt` takes five arguments, not six.** `maxScale` was already riding on
  `fit` — passing it separately invites the two disagreeing.
- **The centering branch is `(stage - scaled)/2 - gap`, not `fit.w·(1−s)/2`.**
  The two are equal *for a centered fit box*, which is the only kind `fitInfo`
  makes — but the general form doesn't have to assume that, and reads as what it
  does. The identity is pinned by a test so the equivalence stays visible.
- **`SPEEDUP` is 1, not the 2 the source recipe uses.** At 2 a single capped
  event is ~48%, which puts a typical 3× image barely two mouse-wheel notches
  end to end. At 1 it's ~24% and about five. Untested against a real hand — it
  is one constant, commented as the module's only tuning knob.

Every test was checked by mutation: dropping the no-upscale cap, neutering the
centering branch, breaking the anchor ratio, removing the snap, removing the
delta cap, and swapping the reciprocal form for the symmetric one each fail at
least one test. A green suite here means something.

### Stage 2 — the controller in lightbox.js

**A prerequisite that wasn't one.** This section originally opened with a bug:
`imageDetail` fires `onImageLayout()` from `img.onload`
([detail-view.js:215](../public/detail-view.js#L215)), while the branch below it
that catches an image already in cache
(`img.complete && img.naturalWidth > 0`,
[detail-view.js:221](../public/detail-view.js#L221)) clears `loading`, sets
opacity, and says nothing. Since `preloadFull` warms ±2 neighbours on every open
and navigation ([lightbox.js:684](../public/lightbox.js#L684)), that looked like
the ordinary path going unannounced — zoom dead on exactly the images you reach
by arrowing.

**It rests on a false premise, and a browser says so.** A cached image is
`complete` the instant `src` is assigned *and* still fires `load`, because the
event is queued rather than skipped. The `complete` branch is a spinner-flash
shortcut, not a substitute announcement. Measured directly in Chromium before
believing either way; the "fix" was reverted, and the branch now carries a
comment saying why it stays quiet. The load hook alone covers cold and cached
alike — verified by deleting both cached-path mechanisms and watching the
browser tests stay green.

Worth keeping as a lesson about this codebase's shape: the det overlay would
never have exposed it either way, because `renderPanel` → `drawDetOverlay`
positions it by a second route. A single-consumer callback whose only consumer
has a backup path is a contract nobody has ever actually tested.

**State: `view` and `fit`, and three hooks — not six.** The earlier draft listed
six reset paths; four of them are the same path. `navLightbox` and
`showInstance` both run through `showMedia`, and `closeLightbox` unmounts.
`showMedia` clears (`view = REST`, `fit = null`) — it cannot do more, because
the image has no `naturalWidth` yet. The fit is computed where the size first
exists:

- **`onImageLayout`** — already the "my media just laid out" callback, already
  wired from lightbox.js as `positionDetOverlay`. It becomes *refit, then
  position*. This is the hook; the others are corrections to it.
- **`resize`** ([lightbox.js:791](../public/lightbox.js#L791)) — existing
  listener, same treatment.
- **`setPanel`** ([lightbox.js:671](../public/lightbox.js#L671)) — the padding
  shift changes the stage box. It already chases the relayout with
  `requestAnimationFrame(positionDetOverlay)`; the refit rides in that same
  frame or it reads the old width.

**The wheel rule, precisely — vagueness here breaks the chart.** "preventDefault
once engaged" isn't a rule. Three cases, on `elLightboxStage`,
`{ passive: false }`:

- **No `currentHandle.imgEl`** → return before touching the event. A chart's
  wheel bubbles through this stage and lightweight-charts is entitled to it;
  the same `imgEl` gate `positionDetOverlay` uses is what hands it over
  untouched. (Nothing else competes: `.lb-det-overlay` is `pointer-events:none`,
  and the panel body and instances list are outside the stage, so they keep
  scrolling.)
- **`imgEl`, not zoomable** → `preventDefault()` only when `ctrlKey`, then
  return. There's nothing to zoom, but letting a pinch page-zoom the browser
  *underneath* a `position: fixed` overlay is its own mess.
- **`imgEl`, zoomable** → `preventDefault()` always (page zoom, macOS
  option+wheel history), then `zoomAt`.

A cursor in the letterbox gap still zooms, and should: `zoomAt` handles a cursor
outside the fit box (`P` goes negative), and `clampView` catches the result.

**Writing it.** `transform` and `transformOrigin: "0 0"` inline on `imgEl`, in a
`requestAnimationFrame` (wheel outruns frames), with `positionDetOverlay` in the
same frame. Reset *removes* the inline properties rather than writing an
identity transform or `none` — a transformed element is a containing block and a
stacking context, and at rest it should be neither, so an image that was never
zoomed ends with the style attribute it started with. No transition on
`transform`; a wheel that rubber-bands feels broken. A `.zoomed` class on
`elLightbox` carries the CSS half.

`showMedia` resets on media swap too, so a zoom can't outlive the image it was
aimed at while the next one loads. That is a reset, not a fit — a cold image has
no `naturalWidth` yet. Its own window (arrow away while zoomed, then wheel
before the new image paints) is too narrow for the suite to reach; the promise
around it is tested, the line itself is belt-and-braces and labelled as such.

That the lightbox now *writes* to a node the renderer owns is a contract change,
small but real: `imgEl` is exposed "so the object-detection overlay can measure
the displayed content rect"
([detail-view.js:14](../public/detail-view.js#L14)). It becomes measure **and
transform**.

**`will-change: transform` while a gesture burst is live, dropped on a ~150ms
idle.** Not a micro-optimization: `will-change` tells the browser to reuse the
existing rasterization, which is exactly why scaled content goes blurry.
Dropping it is what makes the zoomed image sharp — and it means the image
visibly sharpens a moment after the wheel stops. That's the trade, chosen over
re-rastering a 4000px source every frame. Trackpad momentum keeps events dense
enough that the timeout fires at the end of the whole fling, not mid-gesture.

**Clipping: `overflow: clip` on the stage, and the overlay clipped by
`clip-path`.** Two corrections to the earlier draft:

- **`clip`, not `hidden`.** `overflow: hidden` makes the stage a scroll
  container — programmatically scrollable, and something eventually scrolls it.
  `overflow: clip` clips without one. Baseline since Safari 16.
- **The det overlay must NOT move into the stage.** The draft said to move it
  there for the clip. `mountDetail` opens with `stage.replaceChildren()`
  ([detail-view.js:244](../public/detail-view.js#L244)) — the overlay would be
  destroyed on the next navigation, and `initLightbox` only ever creates it
  once. Instead it stays a child of `elLightbox` and gets clipped to the stage
  rect in `positionDetOverlay`, which already computes both boxes in client
  coordinates:

  ```
  clip-path: inset(max(0, stage.top - r.y) ... )   // four sides, from r and stage
  ```

  Four lines, no contract change, no coordinate rebase, and the stage stays "the
  one slot detail renderers mount into" exactly as its comment claims.

**`.lightbox img` scales its own decoration.** `box-shadow: 0 8px 40px` and
`border-radius: 4px` ([styles.css:1801](../public/styles.css#L1801)) both ride
the transform — a 3× image wears a 24px/120px shadow and a 12px radius. Mostly
invisible (once an axis covers, the shadow is outside the clip), but it shows on
a letterboxed axis mid-zoom. `.zoomed` drops both.

**Accepted cost: one forced reflow per zoom frame.** Writing the transform and
then reading `getBoundingClientRect()` in `positionDetOverlay` forces a
synchronous layout. The view is known analytically and the read could be
skipped — but `positionDetOverlay` is shared with three non-zoom callers that
are correct as they stand, and it early-returns on an empty overlay, so the cost
only exists while detection boxes are actually on screen. Left alone.

**The browser test, and why this stage needs one.** Everything in Stage 1 rests
on one assumption a unit test cannot reach: that the image's real layout box
equals `fitInfo`'s prediction — that `max-width/max-height: 100%` on a flex item
with `min-width: auto` really does contain-fit it to the stage. That is a claim
about Chromium, and [test/browser](../test/browser/README.md) exists for exactly
this class of claim. One case: open the lightbox on a known-size image, read the
stage rect and the image rect, assert `fitInfo` matches within a pixel. If that
holds, the module is load-bearing; if it doesn't, everything above is wrong in a
way no amount of green unit tests would show.

**It holds.** `fitInfo` predicts Chromium's layout box to within a pixel on x,
y, w and h. Five cases shipped in
[lightbox-zoom.test.js](../test/browser/lightbox-zoom.test.js): that prediction;
the wheel zooming about the cursor without closing the lightbox; a navigation
landing fitted; an already-fitting image left untouched; and a reopen starting
at the fit and still zooming from cache.

**What the build corrected.**

- **The "cached image" prerequisite was wrong** — see the top of this stage.
  Measured, reverted, and the measurement kept as a comment so the next reader
  doesn't rediscover it.
- **The first anchor test asserted anchoring where the clamp owns the
  position.** One notch off a fitted 2400×1600 leaves it 1220px wide in a
  1216px stage: the pan range is 4px, the clamp wins, and the point under the
  cursor is *supposed* to slide. The test climbs away from the fit first and
  says why. This is the exact trap flagged in the Stage 1 review, walked into
  three hours later from the other side.
- **`naturalWidth > 0` is not "ready to zoom".** It can be true a frame or two
  before the layout the fit reads, so a wheel sent immediately can land on
  nothing. The test wheels until it takes or runs out of road — a broken zoom
  still fails, it just never zooms.

### Stage 3 — the readout and the keys

**The reason given for the readout was wrong.** The draft justified it with
"nothing on screen says you are zoomed or that you can zoom here." It says
neither. That you are zoomed is obvious — the picture is bigger and cropped —
and the readout can't advertise zoomability because it isn't there until after
you have zoomed. What it actually gives you is a **number with a meaningful
ceiling**, and that is the case for it:

**It reads percent of native, not percent of fit.** Unspecified in the draft,
and the two answers differ by the whole zoom range. `s` runs 1 → `maxScale`,
where `maxScale` is "one image pixel per CSS pixel" — so the number to show is
`s / maxScale`, which makes **100% mean 1:1** the way it does in every desktop
viewer, and makes the cap legible instead of mysterious: the pill stops at 100%
and the reader can see there are no more pixels to ask for. Percent-of-fit would
print "100%" on a fitted image that is showing 41% of its pixels.

**It rides in the count pill, it does not get its own.** `.lightbox-count`
([styles.css:2201](../public/styles.css#L2201)) is absolutely positioned,
center-anchored by a `translateX(-50%)`, and re-centered when the panel opens by
a second rule ([styles.css:2316](../public/styles.css#L2316)). A sibling pill
"next to" it would have to duplicate all of that and then negotiate its own
horizontal offset against a centered neighbour whose width changes with the
item count. Instead the readout is a **tail on the pill that is already there** —
`3 / 461 · 72%` — which is the `modeChip` tail idiom (`· meaning`) the toolbar
already uses, and which inherits the panel shift for free. One
`renderLightboxCount()` composes both parts and joins the present ones with
` · `, because either can be absent.

**Which surfaces a small existing bug.** The count is set to `""` on a
single-item board ([lightbox.js:849](../public/lightbox.js#L849)) and nothing
hides the element, so an empty 24px pill is painted at the bottom of the screen
today. Cosmetic now; once the element can hold either part, or neither, a
`.lightbox-count:empty { display: none }` is load-bearing.

**The keys: `+`, `=`, `-`, and `0`.** `e.key === "+"` alone is a bug on most
layouts — the unshifted key is `=`, which is why every application binds both.
`0` resets to fit, and it is worth more than its three lines: it **answers the
Escape question** the decision table left open. Zoom does not need a layer in
`panel → zoom → close`, because it has a key of its own.

No collision to worry about: `gridShortcutsBlocked()`
([shortcuts.js:10](../public/shortcuts.js#L10)) already refuses every grid
shortcut while the lightbox is open — checked, not assumed.

**The readout must not be `aria-live`.** A polite region that re-announces on
every wheel event during a gesture is worse than silence.

**What the keyboard still cannot do, and it matters more here.** `+`/`-` zoom
about the stage center, and the clamp keeps a centered zoom centered — so a
keyboard user can reach any *scale* but only ever the *middle* of the picture.
A corner is unreachable. This is the lateral gap from *Open* below, except that
a mouse user works around it by aiming the cursor and a keyboard user has no
cursor to aim. It is the strongest argument for arrow-pan-while-zoomed, stronger
than anything in the mouse case, and it should be decided here rather than
inherited.

**Tests.** The percentage is one line and belongs to the pure module
(`nativePercent(view, fit)`). The keys are a browser case, cheap: `+` zooms, `0`
returns to the fit, the pill reads what the geometry says, and the pill is
absent at rest.

**What shipped.** `nativePercent` in the pure module (2 unit tests),
`renderLightboxCount()` composing both halves of the pill, `zoomByKey()`, the
four keys, and `.lightbox-count:empty { display: none }`. One browser case
covers the lot. All four pieces were mutation-checked — percent-of-fit instead
of percent-of-native, the missing `:empty` rule, no `+`, no `0` — and each one
fails a test.

**A press is a notch, by construction.** `zoomByKey(wheelFactor(-100))` rather
than a `KEY_STEP` constant: any delta past the cap *is* one notch, so the key
and the wheel cannot drift apart later. The reach of a key press is therefore
whatever `SPEEDUP` is, and tuning one tunes both.

**The teeth in the readout test** are not in comparing it to the geometry — a
readout stuck at "100%" would pass that, since the geometry would be at the
ceiling too. They're in the second assertion: three presses of `+` cannot reach
the ceiling on a 2400×1600 image at this viewport, so a pinned number fails.

**Untested, and honestly so:** the `ctrlKey || metaKey` guard that leaves
Cmd+0 / Ctrl+− to the browser's own page zoom. Playwright can press the chord,
but nothing observable in the page distinguishes "we ignored it" from "we never
saw it".

## Checked, and deliberately left alone

- **The image arrives at `opacity: 0`.** `imageDetail` fades in on load
  ([detail-view.js:213](../public/detail-view.js#L213)); the reset-on-`showMedia`
  hook fires before that, so a new image is always at fit before it is visible.
- **`contentRect`'s letterbox math mostly no-ops** for the lightbox image (the
  element box *is* the fitted box), and stays correct under transform either
  way. No change to det-geometry.js.
- **Very large textures.** A 6000px source at 3× is a big GPU surface; Chrome
  caps raster area and may fall back to blur or evict. The CSS-100% cap bounds
  this at "the pixels that actually exist," which is the natural place for the
  ceiling to be anyway.
- **`cursor: zoom-out` stays on the lightbox.** It remains *true* at every zoom
  level — clicking closes — and a `zoom-in` cursor would now be the lie.

## The simplification pass (2026-09-19, after all three stages)

Four review angles over the finished diff. Suite 1792 green, browser suite 45.

**Taken:**

- **A fit carries its own frame.** `zoomFit` and `zoomStage` were two variables
  holding one invariant by convention, and every consumer had to pass both.
  `fitInfo` now returns `frame`, so `clampView(view, fit)` and
  `zoomAt(view, cursor, factor, fit)` lost a parameter and the module state lost
  a variable. The rule became structural instead of documented.
- **The `will-change` gesture-hold is gone.** It cost a module-level timer, a
  clear in the reset path, a `removeProperty` branch, an `isConnected` re-check
  and a per-event style write during a fling — for a raster hint that was never
  measured to help. Its absence is the default every image on the web already
  has. (The suggested alternative — a `will-change` rule on `.zoomed` — was
  **rejected**: that pins the hint on for as long as you stay zoomed, which is
  exactly the blur the release existed to avoid.)
- **One `applyZoom(cursor, factor)`.** The wheel and the keys were the same four
  steps written twice, differing only in where they aim and how far. The keys
  now go through the same rAF coalescer, so holding `+` paints once per frame
  instead of ~30 times a second.
- **`resetZoom()` split from `refitZoom()`.** Three callers needed "go home"
  without needing a new measurement (media swap, close, the `0` key); the `0`
  key had been inlining the reset 700 lines from the code that owns it.
- **`readyImage()` is shared with `positionDetOverlay`.** "The stage is showing
  an image we can measure" had been written twice in one file — and
  `detail-view.js`'s contract names `imgEl` as the single hook for both.
- **`clipInset()` moved into the pure module** with three tests. It was the
  trickiest arithmetic in the diff — four `Math.max`, two of them sign-flipped —
  and the only part with no unit test, sitting in a function that otherwise just
  assigns style properties.
- **`nativePercent(s, maxScale)`** takes the two numbers it reads. The browser
  test had been fabricating a half-view (`{ s }` with no `tx`/`ty`) to call it,
  which is a signature asking for too much.
- **`transform-origin` moved to the `.zoomed` rule** — it is a constant, and it
  was being re-parsed on every painted frame.
- **`ResizeObserver` on the stage replaces the window `resize` listener and
  `setPanel`'s rAF.** The house idiom (grid.js, header-scroll.js). It observes
  the box instead of enumerating what moves it — picking up browser page zoom
  and stylesheet changes, which `resize` misses — and it fires after layout,
  which is what the panel toggle previously needed a rAF and a load-bearing
  ordering comment to arrange.
- **The count pill memoizes its text.** It is written once per painted frame and
  the element blurs the backdrop behind it, so an unchanged string was
  re-rasterizing a blur 60 times a second. Its second writer in `showLightbox`
  is gone too — one composer, as designed.
- **Reads before writes in `positionDetOverlay`**, killing a forced synchronous
  layout per zoom frame.
- **Test cleanups:** a `BIG` fixture constant and an `openBig` helper for four
  identical setups, `wheelUntilZoomed` defaulting to three notches at the stage
  centre, an unused `openCard` parameter, and the cache test no longer
  re-asserting the whole of the navigation test's claim.

**Skipped, with reasons:**

- **Giving the stage a media slot so the det overlay can live inside it.** The
  deepest suggestion, and the one that would delete `clipInset` outright. It
  changes `mountDetail`'s contract ("stage" quietly becomes "your slot") and
  needs `position: relative` plus a full-size flex child that the doc and chart
  renderers still size correctly against — for one feature's benefit. Worth
  revisiting the next time something else needs to ride the zoomed frame; not
  worth it for the first.
- **Deriving the overlay's rect from `zoomFit`/`zoomView` instead of measuring
  it.** Would remove the last per-frame rect reads, but couples
  `positionDetOverlay`'s correctness to zoom state being in sync, for three
  callers that have nothing to do with zoom.
- **Deleting `fitInfo`'s "not loaded" branch** as unreachable in production. It
  is a pure exported function guarding its own precondition; three lines.
- **Deleting `SPEEDUP`** because it currently multiplies by one. It is the
  documented tuning knob and it has not met a real hand yet — the moment it
  does, it stops being an identity.

**A coverage gap the pass exposed.** Removing the `ResizeObserver` entirely
broke no test — the frame-change path had never had one, before or after. Now
it does: opening the details panel narrows the stage by 400px, and the test
asserts the image re-fits to it and that the readout is measured against the new
frame rather than the old.

## Not in scope

Drag-to-pan. Touch pinch. Zoom for documents (the iframe has its own), audio, or
charts. Zoom persisted across navigation. Rotation. Tile-based deep zoom. A
zoom-% readout with +/− buttons in the chrome (the pill and the keys cover it
without growing the control cluster).

## Open

**The lateral gap.** Cursor anchoring is a *steering* mechanism: you aim and
scroll in, and mid-gesture cursor movement re-anchors for free. What it can't do
is move sideways at a fixed zoom — at 3× on the left edge, reaching the right
edge means scrolling out a notch and back in. Three fills, cheapest first, and
v1 ships the first:

1. **Leave it.** Zoom out, re-aim, zoom in. Zero code, and probably fine for
   "let me check that detail."
2. **`←`/`→` pan while zoomed, nav only at fit.** Free pan, but it makes the
   arrows modal — and arrows-as-nav is the lightbox's most-used key.
3. **Drag-to-pan**, if it turns out to be missed — which re-opens the click
   contract in full, so only if it earns it.

Decide from use, not from the plan. Shipped as (1).

**It is sharper for the keyboard, and stayed open anyway.** `+`/`-` zoom about
the stage center and the clamp keeps a centered zoom centered, so a keyboard
user reaches any scale but only ever the middle of the picture — a corner is
unreachable, with no cursor to work around it the way a mouse user does. Raised
at Stage 3 and left as it is: the fix is (2), and making the lightbox's
most-used key modal is a real cost to weigh against a gap nobody has hit yet.
Worth revisiting the first time someone says the keys feel stuck in the middle.

**Escape is settled.** It was left open in the decision table ("reset to fit →
close?"). `0` resolved it: the zoom has its own undo, so Escape keeps its two
meanings (close the panel, else close the lightbox) and never grows a third.

**`SPEEDUP` still has not met a real hand on a real wheel.** One capped event is
~24%, chosen by arithmetic over a typical range; a browser cannot tell you
whether that feels right, and now it sets the reach of the keys too.
