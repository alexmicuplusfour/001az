# Ingestion status chip — the modal says what the schedule is doing (2026-09-09)

**Status: COMPLETE — all three stages shipped 2026-09-09 (local,
uncommitted). Suite green (1474), eslint clean; the five modal states
screenshot-verified through a headless-Edge harness driving the real
modules.**
Self-contained for a fresh session. Written after a dive through the ingestion
state model, all four surfaces that already read it, the app's status
vocabulary, and outside research on status-indicator conventions (Spectrum
StatusLight, Vercel Geist StatusDot, Polaris, Carbon, Zapier's zap states).

## The gap

Every ingestion surface EXCEPT the modal reads state at a glance:

- the gallery toolbar chip ([toolbar.js:38](../public/toolbar.js#L38)) — live
  countdown, `paused` text, red `.error` tint while failing;
- the boards-page card chip ([boards.js:473](../public/boards.js#L473)) —
  "next run in 2h / due / off / paused", failing tint + reworded title;
- the failing alert ([ingest-missing-source-plan.md](ingest-missing-source-plan.md))
  — whose whole message is "open the board to see the error".

The modal — the surface that CONFIGURES the feature, and where the alert sends
you — says almost nothing. What it has: a trigger dropdown and a Paused switch
(controls showing the *draft*, not the state), and one static line at the
bottom, under Preview ([ingest-modal.js:810](../public/ingest-modal.js#L810)):
"Last run 21s ago — added 0", computed once at open. On a watch board that
line is wrong within a minute, and it's history anyway — nothing in the modal
says "this board is watching, next check in 8s" or "failing — retrying in 3m".
The error message itself renders in that bottom line, the least prominent spot
in the modal the alert pointed you at.

And a third problem hiding under the second: the precedence rules — "a pending
run outranks the mode", "failing tints, it doesn't replace (the countdown IS
the retry)" — already live in TWO copies (toolbar chip render, boards-page
chip). A modal status would be the third. The rules need one home before they
get a third dialect.

## What exists (the dive)

State model — all server-side, already shipped:

- `board.ingest` — the config: source, filters, sort, limit/total,
  `trigger {mode: manual|continuous|interval|daily, every?, at?}`, `enabled`.
- `ingestMode()` ([ingestion/index.js:80](../server/ingestion/index.js#L80)):
  `null` (no config) | `"manual"` (UI word: Off) | `"paused"`
  (`enabled === false`) | `"scheduled"`.
- `ingestStatus()` ([ingestion/index.js:107](../server/ingestion/index.js#L107))
  ships the trio on EVERY board payload: `ingest_mode`, `ingest_next_run_at`
  (also the retry stamp while failing; `<= now` means due/claimed),
  `ingest_error` (boolean only — the message can name server paths, so words
  stay behind the manager-gated modal GET).
- Sweep-owned `ingest_state` `{last_run_at, last_added, last_error,
  drain_left}` ([db.js:1960](../server/db.js#L1960)); a config save clears
  only the two fields that judged the OLD config (`clearIngestSuperseded`).
- The modal GET ([server.js:1386](../server/server.js#L1386)) returns
  `available/descriptor/sources/config/state/rootPath` — no next-run stamp,
  and it doesn't need one: the client already holds the live trio in
  `state.boardIngestMode/NextRun/Error`, kept fresh by the toolbar tick +
  `refreshBoardIngest` backoff. The modal can read what's already there.

Status vocabulary already in the app (the reuse > generalize > create audit):

- `.im-status` ([modal.css:640](../public/modal.css#L640)) — modal status
  LINE: neutral gray + `.error`/`.warn`/`.ok` tones, spacing `.tight`/`.flush`.
  Explicitly "shared vocabulary, not ingest-only". A sentence, no mark.
- `.mapping-chip`/`.bc-chip` `.error`/`.paused`
  ([styles.css:1546](../public/styles.css#L1546),
  [boards.css:351](../public/boards.css#L351)) — toolbar/card icon chips,
  family-wide state classes. Different altitude (page chrome), keep.
- `.btn-dot` ([styles.css:704](../public/styles.css#L704)) — 8px attention
  dot; text-red is #b4232a but the dot wears #e5484d — the mark's ink
  brightens for 8px duty. Precedent we reuse below.
- `.jobs-chip.busy` icon pulse + "the pulse stops (nothing is moving)" +
  `prefers-reduced-motion` ([styles.css:1604](../public/styles.css#L1604)).
- `capability-present.js` — the pure-presenter pattern (data in, verdict out,
  node-testable, thin DOM shells mount it). `presentChip` already speaks
  `ok/warn/dim`.

Nothing is a dot + label semantic status indicator. Creating one is justified;
creating it GENERIC, with the full tone set, is the assignment.

## Research, distilled to what we adopt

- **Dot + mandatory text label** is the inline archetype (Spectrum
  StatusLight, Vercel Geist StatusDot). Color never stands alone (WCAG
  1.4.1); the dot is `aria-hidden` because the text names the state.
- **Pulse means activity happening NOW**, never merely "enabled" (Geist
  animates only QUEUED/BUILDING; status-page green pulses because monitoring
  is live; our own jobs chip already follows this). Continuous watch counts —
  the 30s loop is live activity. An armed daily timer doesn't.
- **Neutral is a real state**: off/not-configured is gray. Absence isn't
  failure.
- **Current state and last outcome are two facts** (Zapier, n8n, Actions all
  split them). The chip says what it's doing; the last-run line stays its own
  sentence. Never merged.
- **State word first, detail after an em dash** ("Watching — next check in
  8s"), terse everywhere else, detail at the owning surface (this modal).
- **Reduced motion**: the dot stays, the animation stops. **No `aria-live`**
  on a ticking countdown — a 1s live region is announcement spam; the chip is
  plain readable text, transitions go unannounced.

## The component — `.status-chip` (modal.css, sibling of `.im-status`)

One generic inline element with its own surface: dot + label on a ground
TINTED BY THE TONE, so it reads as an object AND as a signal at a distance —
the state registers before the words do, even peripherally or clipped. Lives
in modal.css next to `.im-status` — same family (the LINE judges, the CHIP
states), same tone names, loaded by every page that has modals.

The surfaces are not invented: the app already speaks a tinted-statement
family — `.good-box / .warn-box / .mute-box`
([styles.css:2348](../public/styles.css#L2348)) — plus a red family the jobs
modal wears (`.jobs-danger`, ground #fdeaea,
[styles.css:1626](../public/styles.css#L1626)). The chip is that family at
pill scale: same ground/ink pairs, 6px radius (the modal dialect), literal
values (the family lives in styles.css, which admin.html doesn't load), no
border — the boxes' 1px is statement-scale chrome; at 22px the tint alone is
the edge. The only minted ink in the whole component stays the warn DOT.
Discovered along the way: modal.css carries its OWN `.warn-box` dialect
([modal.css:980](../public/modal.css#L980): border #ffe1a3, text #92650a vs
styles.css's #f2e2b8/#7a5b12) — pre-existing drift, worth folding when either
file is next open; the chip sides with styles.css's triplet.

```html
<span class="status-chip ok live">
  <span class="status-dot" aria-hidden="true"></span>
  <span class="status-label">Watching — next check in 8s</span>
</span>
```

```css
/* Inline status: a dot + the state in words, on the tone's own ground —
   the statement boxes (.good/.warn/.mute-box) at pill scale, plus the
   red family .jobs-danger already wears. Every triplet is lifted from
   those families (literals: they live in styles.css, absent on
   admin.html); the one minted ink is the warn dot. The dot's ink
   brightens at 8px the way .btn-dot's red does. .live = something is
   happening RIGHT NOW (a watch's poll loop, a run in flight) — never
   merely "enabled"; the ripple dies under reduced motion, the dot
   stays. .dim = deliberate quiet (paused, off) — the
   .mapping-chip.paused treatment. The label span exists so a cramped
   host can ellipsize the words while the dot and tint hold. */
.status-chip { display: inline-flex; align-items: center; gap: 6px;
               min-width: 0; font-size: 12px;
               color: #6b6b72; background: #f6f6f9;      /* .mute-box */
               border-radius: 6px; padding: 3px 10px 3px 8px; }
.status-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-dot  { flex: none; width: 8px; height: 8px; border-radius: 50%;
               color: #9aa0aa; background: currentColor; }
.status-chip.ok    { color: #14532d; background: #f0fdf4; }  /* .good-box */
.status-chip.ok    .status-dot { color: #16a34a; }
.status-chip.warn  { color: #7a5b12; background: #fff7e6; }  /* .warn-box */
.status-chip.warn  .status-dot { color: #e09f3e; }  /* the one minted ink: 8px-duty amber */
.status-chip.error { color: #b4232a; background: #fdeaea; }  /* .jobs-danger's family */
.status-chip.error .status-dot { color: #e5484d; }  /* .btn-dot's red, same reason it exists */
.status-chip.dim   { opacity: .6; }
.status-chip.live  .status-dot { animation: status-ripple 1.8s ease-out infinite; }
@keyframes status-ripple {
  0%        { box-shadow: 0 0 0 0   color-mix(in srgb, currentColor 45%, transparent); }
  70%, 100% { box-shadow: 0 0 0 5px color-mix(in srgb, currentColor 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  .status-chip.live .status-dot { animation: none; }
}
```

The full set, built at birth: tones `neutral(base) / ok / warn / error` ×
modifiers `live / dim`. `warn` has no ingestion state today — it exists
because the set does (quota, degraded-capability, and any future "attention
without failure" surface). No size axis: one size until a second surface asks.

## The presenter — `public/ingest-present.js`

The one home for the precedence + wording rules, on the
capability-present.js model: pure data in, verdict out, node-testable, no DOM.

```
presentIngest({ mode, nextRunAt, error, triggerMode, now }) →
  { state, tone, live, dim, due, left, label, title }
```

`triggerMode` (the SAVED trigger.mode) is optional — only the modal holds it;
trio-only surfaces get "Scheduled" wording instead of "Watching". `state` is
the discriminant for surfaces that branch; `due`/`left` carry the countdown
itself so no surface re-derives the ladder's top rung from raw state — the
toolbar renders its bare eta as `p.due ? "now" : fmtDuration(p.left)` and
composes its hover title from `p.title` plus the click affordance only it
has.

The ladder (top wins), compounds included:

| state | tone | live | label |
|---|---|---|---|
| stamp due (`nextRunAt <= now`), not failing | ok | yes | Running now |
| stamp due, failing | error | yes | Retrying now |
| failing, retry ahead | error | — | Failing — retry in 3m |
| failing, paused (no stamp) | error | dim | Paused — last run failed |
| paused | neutral | dim | Paused |
| scheduled · continuous | ok | yes | Watching — next check in 8s |
| scheduled · interval/daily | ok | — | Scheduled — next run in 2h |
| manual / no config | neutral | dim | Off |

(Durations are `fmtDuration`'s one coarse unit — "8s", "3m", "2h" — the same
format the toolbar countdown already speaks.)

"Pending run outranks the mode" and "failing tints, the countdown is the
retry" come straight from the toolbar chip's comments — this table is those
rules written once. `title` carries the toolbar's longer explanatory
sentences for hover surfaces.

## Modal integration

- **The header slot, carved once for every modal**: `createModal` grows a
  `.modal-status` span between the title and the × — ALWAYS in the DOM,
  returned as `statusEl` beside `titleEl`, `:empty` costs nothing. Any modal
  drops any content in (a `.status-chip` here; text, a future badge
  elsewhere) with no per-modal header surgery. modal.css carves the space
  robustly: the header gains `gap: 12px`; `.modal-title` gets
  `flex-shrink: 0` (the name never crumples); `.modal-status` gets
  `margin-left: auto; min-width: 0` so it hugs the × and yields FIRST when
  width runs out — the chip's `.status-label` ellipsizes, the dot and tone
  survive. On a phone-width dialog the verdict degrades to dot + clipped
  words, never a wrapped header.
- **The ingest modal fills the slot**: verdict right, title left — the first
  thing the alert-follower sees. Reads `state.boardIngest*` +
  `info.state.last_error` on a 1s tick with the toolbar's `isConnected`
  self-clear; countdown text re-renders, class only changes on transition.
  The slot persists across the settings ⇄ results view swap — it's the
  feature's state, not the view's.
- **The chip is the record, the controls are the draft.** It shows SERVER
  truth only — flip Paused and the chip holds until Save lands (the save
  response already re-stamps the board via `stampBoard`, so the chip follows
  on the next tick). No predictive state.
- **Last-run line stays** (history, not state) but goes live: `relTime` on
  the same tick. It keeps sole custody of the error MESSAGE (manager-gated
  words; the chip only ever says "Failing").
- Error arriving while open: the polling trio flips `boardIngestError` → the
  chip flips; the message line refreshes on the next modal open (a refetch on
  flip is optional polish, not stage 1).

## Stages

**Stage 1 — the component, the slot, the presenter, the modal wearing all
three.** `.status-chip` CSS (full set) in modal.css; the `.modal-status`
header slot in createModal + modal.css (every modal gets it, only this one
fills it yet); `ingest-present.js` + node tests (every ladder row, the
compounds, countdown formatting via `fmtDuration`); ingest-modal header chip
on the 1s tick. Visible value: the modal states its state.

**Stage 2 — liveness + the failing story.** Last-run line re-renders
`relTime` on the chip's tick ("21s ago" is a claim about now; a watch board
falsifies it within the minute). SHIPPED. Correction found while building:
the failing ALERT this plan inherited from ingest-missing-source-plan.md is
still unshipped — today the story's entry is the toolbar chip's red tint
("Click to see the error") → modal → red chip + message line, which now
holds end-to-end.

**Stage 3 — one home for the rules.** SHIPPED. Toolbar `ingestChip()` and
boards-page `chipsFor()` now read `presentIngest`; both private copies of
the precedence rules are gone. What stayed local, deliberately: the
toolbar's compact FORM (bare countdown off `p.due`/`p.left`, the word
"paused") and the click affordance only it has ("Click to configure / see
the error"), composed around `p.title`. The boards-page card title speaks
the presenter's words ("Automatic ingestion: Scheduled — next run in 2h",
". Open the board for the error." while failing) — one dialect everywhere.
This is the stage that paid the don't-inherit-past-decisions debt.

## Simplify pass (2026-09-09, four parallel reviewers)

Applied:
- **One due-stamp nudge per tab** — the strongest finding, flagged by all
  four angles: the modal's private refetch throttle (flat 10s, no backoff)
  was a second uncoordinated clock beside the toolbar's 5s→60s backoff on
  the same endpoint, defeating it during exactly the stall it was written
  for. The toolbar's module-level pair moved to data.js as
  `nudgeBoardIngest()` — beside `refreshBoardIngest`, where the rest of
  stamp-following (`pollDelay`, `stampBoard`) already lives; both ticks now
  offer it every second and one clock+backoff decides.
- **`due`/`left` on the verdict** — the toolbar's leftover raw reads of
  `state.boardIngestNextRun` were the ladder's top rung re-derived; the
  presenter now hands the countdown over.
- **Toolbar titles composed, not mapped** — the state-keyed `TITLES` table
  restated presenter wording and degraded silently on a missed key; now
  `"Automatic ingestion: " + p.title + " Click to …"`. The failing title
  gained "the countdown is its retry" so nothing was lost.
- **Compositor-only ripple** — box-shadow animated per-frame paint for the
  life of a watch modal; now a `::after` ring on transform/opacity (also
  drops the color-mix dependency).
- **`verdict()` flags** — twin positional booleans (`false, false`) became
  named `{ live, dim, due, left }` overrides; the modal's tick was renamed
  and re-gated on the modal (`overlay.isConnected`) with both riders named.

Skipped, with reasons: deleting the unadopted `warn` tone (the full set was
an explicit design decision; the altitude reviewer independently endorsed
keeping it); promoting the 4-line tick skeleton to a shared helper (two
instances across a surface boundary — a third adopter can prompt it);
wrapping the 4-line presenter-input spelling (marginal, differing extras).

Future adopters, named not built: capability chips already speak
`ok/warn/dim` and could wear the dot when that page is next touched; sidecar
presence rows (`engineAbsent`) are a natural `dim`/`error` dot; a jobs-modal
"running" row is `ok live`; connector quota is `warn`. The SET ships now; the
adopters come when their surfaces are next open.

## Calls made (and the alternative considered)

- **Armed = green** (not neutral): the app's own convention — cap-chip
  "active" is `ok` green; a healthy watch is the thing working as configured.
- **Paused = neutral + dim** (not amber): a deliberate user hold is quiet, not
  a warning — matches `.mapping-chip.paused`'s opacity treatment and the
  flexibility-over-guardrails house rule. Amber would nag about a choice.
- **No blue "info" tone**: the app has no blue family; running-now folds into
  ok + live (research: info is optional exactly this way). Minting a family
  for one transient state is how palettes rot.
- **Chip in the header**, not inside the Trigger section: state is a verdict
  about the whole feature (source + schedule + last run), and the header is
  the one line every state of the modal shows — including a future one that
  opens straight to results.
- **Tinted ground per tone**: the ground carries the verdict, so the state
  reads at a distance and survives a clipped label — and no families are
  minted for it, because the statement boxes + the jobs-danger reds already
  ARE the app's tinted vocabulary; the chip is that vocabulary at pill
  scale. (First draft kept a neutral `--pill-bg` ground on
  `.mapping-chip.error`'s red-ink-neutral-ground rule; superseded — that
  rule stays true where it lives, on INTERACTIVE toolbar chips, which keep
  their neutral pills and only re-read words from the presenter.)
  Non-interactive by design — no hover, no cursor.
