# Ingest source visibility: show the real path, survive a missing one

**Status: SHIPPED 2026-08-23** (all six slices, same day as planned).
**Presentation partly superseded** by `ingest-source-chooser-plan.md` (tile +
chooser drawer replace the path row / Pull from / stacked browse modal; every
policy here — probes, relink, atomic commit — carries over).
Provenance: a live incident — a board's local folder was renamed on the host
(`ingest-root/New folder` → `ingest-root/wardrobe`) and every surface handled
it worse than the engine did — plus a survey of how watch-folder tools
(Syncthing, Plex, Lightroom, Resilio, Dropbox, rclone, Jellyfin, Immich) treat
a vanished source. Six slices, all UI/visibility; the engine's semantics are
deliberately untouched.

What landed, against the slices below:

| Slice | Landed as |
|---|---|
| 1 · resolved path | `rootPath` on GET `/ingest`; `.im-affix.mono` label in `renderFolderBlock` (`INGEST_ROOT_LABEL` skipped — verbatim path first) |
| 2 · tagged errors | `unreadableError()` in `sources/folder.js` (+ path-free `fetch` messages); FTP tags 550 **or** an ENOENT-shaped message — ftp-srv answers 451, real servers 550 |
| 3 · browse fallback | route maps `err.notFound` → 404; modal ascends per-404 to the root floor, `.im-status.error.flush` notice, "Use this folder" gated on a rendered level |
| 4 · health probe | `body.limit` (1–1000) through `browse()`; auto probe for folder (open/debounced edit/pick), Test button for FTP/S3 |
| 5 · failing chip | `ingest_error` boolean on `ingestStatus`; toolbar chip + boards-index chip tint red — family-level variants (`.mapping-chip.error`, `.bc-chip.error`) |

Post-ship simplification pass (4-angle review, same day): the save seam now
clears `last_error` alongside `drain_left` (`clearIngestSuperseded`) — before
that, "error is moot after save" existed only in the PATCH echo while storage
kept the flag, so the gallery and boards page could disagree until the next
run. The derivable `root` boolean left the modal GET (`rootPath != null` is
the same fact); `browse()` is the single owner of the limit default+clamp;
the modal's probe policy runs on one axis (`eager = !needsConnection`) so a
future connectionless source can't fall between the folder/remote branches;
a browse pick hands its level's emptiness to the health line instead of
re-probing; the Test button disables in flight (clicks against a dead host
would stack 30s-timeout requests); and ftp's missing-path detection is a
named, unit-tested predicate (`isPathMissing` — the 550 branch ftp-srv can
never exercise now has a direct witness).

Follow-up (2026-08-24, user-directed): the source is now an **add/remove
interaction, and adding IS choosing**. An unconfigured board's modal shows
nothing chosen — no root prefix, no probe, no "blank = the whole source"
implication — just "+ folder" (the filters' own add/× vocabulary). Clicking
it opens the browse modal directly (revealing a pre-blessed blank row was the
same presumption one level down); the path row materializes only on an
explicit "Use this folder" — including for the root, which is now a
deliberate top-level pick, never a default. Cancel leaves nothing added. The
browse modal's location line spells the real place (`/data/ingest/wardrobe`,
or the connection's label for FTP/S3) instead of a bare "/". The root prefix
beside the input is plain muted text, not a pill (boxed, it read as a
clickable control) — and remote sources get the same prefix, wearing the
connection's name ("mplex/"), without which a bare "pixel/camera" doesn't
even read as a path. The standalone connection picker is GONE from the
Source section: switching it while a path was showing silently re-aimed a
path picked on one server at another (and its default-repair of a dangling
id was itself an implied choice). The connection is now chosen inside the
browse modal — path and server are one choice, committed together by "Use
this folder" — and changing servers is a re-browse. The health line stays SILENT while everything is fine —
auto-checks surface only server verdicts that the path is bad; Test answers
by toast (a reply to a click, not ambient state), so the inline line has
exactly one job. FTP's schema label dropped "Base" ("+ base folder" read
oddly on the add button). × removes the
path; **removed + Save clears the board's ingestion config** (`ingest: null`)
— the modal's first way to un-configure a board. Preview and Save refuse to
act with no source added. A saved config always opens as added — a legacy
root-watch saved as bare `{type}` is normalized to an explicit blank so the
modal shows what the sweep actually does. Server semantics unchanged (blank
path = whole source stays legal at the API); the modal just never *implies*
it.

Also 2026-08-24, user-directed: an unconfigured board's modal now
opens with the trigger **Off** instead of Continuous-but-Paused. The old
default read as saved state — the incident's owner saw "on (continuous) and
paused" on every unconfigured board and reasonably assumed something had
written configs. Off says the truth in one word; the pause-by-default guard
became unnecessary with it, because any schedule present at Save was chosen
by hand (Off's enabled-normalization clears the pause before the user can
reach a schedule), so Save arming a hand-picked schedule is consent, not the
silent arming the old guard existed to prevent.

CSS landed as extensions of existing vocabulary, not one-offs: `.im-status`
grew its full range (`error` / `warn` / `ok` tones from the app's existing
color families + `tight` / `flush` spacing) and now serves the run-status
line, the source-health line, and the browse modal's relink notice; the one
genuinely new component is `.im-affix` (read-only input-row context label,
`.mono` variant), written side- and content-agnostic for future bucket/host
prefixes or unit suffixes. Chip failure tints are family variants
(`.mapping-chip.error`, `.bc-chip.error`), not per-chip specials.
| 6 · honest hint | both continuous strings name the 5-minute error backoff |

Verified by `test/ingest-folder.test.js` (friendly + tagged + path-free walk
and fetch errors), `test/ingest-routes.test.js` (rootPath; 404 vs 400; probe
limit; `ingest_error` derivation end-to-end), `test/ingest-sources.test.js`
(FTP missing-path 404). Three pre-existing pins of the old "unreadable"
wording updated (`ingest-sweep`, `job-log` ×2). The browse modal's ascend
loop is not DOM-tested — the route contract carries it (browser-stub couldn't
import the modal module without stubbing `createModal`'s overlay plumbing;
revisit if the modal grows more logic).

## The incident

With the board pointed at `New folder` after the rename:

- The modal's Folder field says `New folder` — nothing says it means
  `/data/ingest/New folder` (`INGEST_ROOT` + subpath). The only place the real
  path ever appears is the raw error: `ingestion folder unreadable: ENOENT: no
  such file or directory, scandir '/data/ingest/New folder'` — the resolved
  path surfaces *only* in error states, via a leak.
- Browse… opens the tree modal at the saved path, the level fails to load, and
  the modal is orphaned: no path line, no ↑ Up, no entries — because
  `renderPath(parent)` runs only on a successful load
  (`public/source-browse-modal.js:60`). Meanwhile "Use this folder" stays
  enabled and would re-save the dead path (`current` was initialized to the
  start path at line 23 and never corrected).
- Outside the modal, the toolbar chip kept counting down as "scheduled" — a
  watch that fails every run is indistinguishable from a healthy one without
  opening the modal.

## What already works — and must not change

The engine already follows the industry's cardinal rule (stop and surface,
never act):

- **Additive law.** Sources are read-only; a vanished source can never delete
  or modify ingested items (`server/ingestion/sources/folder.js:1-5`).
- **Error state + self-heal.** A failed run records `last_error`, backs off
  5 minutes, and retries forever (`server/worker.js:1865-1895`) — so a
  remounted drive or returned share resumes with no user action. This matches
  Resilio/Syncthing exactly; do not add give-up logic.
- **Log hygiene.** Repeated identical failures fold into one job-log row
  (`foldJobRepeat`, `server/worker.js:1738`), so a dead source is one row, not
  3k.
- **Relink is naturally lossless for local folders.** Ledger keys are relative
  to the *configured* folder (`folder.js:91`, `recordIngest` is
  board-scoped) — repointing the board at the renamed folder keeps every key
  identical: no re-ingest, no duplicates. The relink UX in slice 3 leans on
  this; nothing needs migrating.
- **The jobs dot is an event signal, by design.** `latestJobFailureAt` reads
  `started_at` of the newest failed row (`server/db.js:2442-2448`), and a fold
  updates `endedAt` but never `started_at` — so the dot fires once at failure
  onset and stays quiet after acknowledgment *even while the failure
  continues*. That is correct for an event ledger; the missing piece is a
  *state* signal, which is slice 5's job — not a change to the dot.

## The conventions (research digest)

Full survey in the conversation that produced this plan; the rules that bind
here:

1. **Stop and surface, never act.** Sync tools (Syncthing, Resilio, Dropbox,
   OneDrive) pause the folder into a visible per-folder error state, config
   retained. Tools that acted instead are their communities' top grievances
   (Jellyfin scan-removal, jellyfin#1714; Immich's v1.131 offline-delete
   regression, immich#17419; rclone's empty-source destination wipe).
2. **Temporary vs permanent is never inferred.** Marker files (Syncthing's
   `.stfolder`), volume tracking (Lightroom's offline-volume state), or a
   two-step trash (Plex's Empty Trash — famously advised off for NAS). Nobody
   uses a timeout, and nobody auto-removes config.
3. **Relink preserves state, and the user drives it.** Lightroom's "Find
   Missing Folder" (point the flagged node at the new location) is the
   canonical flow; slice 3 is that flow in our browse modal.
4. **The full resolved path is the source of truth in settings**, optionally
   with a friendly label on top (Syncthing label + path; Plex/Resilio raw
   absolute paths; Lightroom path on hover + volume status LED).

## Slice 1 — show the resolved path where the folder is configured

The modal GET ships `root: !!process.env.INGEST_ROOT` — a boolean
(`server/server.js:1205`) — so the client *cannot* render the resolved path.
The route is already manager-gated precisely because "the config carries
server folder paths"; sending the root string to managers is consistent with
that posture.

- `GET /api/boards/:id/ingest` gains `rootPath: process.env.INGEST_ROOT ||
  null` beside the existing `root` boolean (which `renderDetail`'s
  no-root warning keeps using).
- `renderFolderBlock` (`public/ingest-modal.js:262`) renders a non-editable
  prefix before the input — `/data/ingest/` + `[New folder]` — monospace,
  ellipsized from the left (`direction: rtl` on overflow), full value in
  `title`. Blank input keeps meaning "the root itself"; placeholder text
  unchanged.
- Remote sources: the "Pull from" row already names the connection, and the
  connection list is deliberately `{id, label}` only (`files.js:285`) — no
  bucket/host here. Widening that is out of scope; the FTP/S3 folder block
  gets no prefix chip.
- Optional, decide at build time: an `INGEST_ROOT_LABEL` env for operators
  whose container path (`/data/ingest`) reads worse than the host bind
  (`./ingest-root`). Display-only alias; `rootPath` stays the truth the
  errors and jail use. Cheap, but it is a second spelling of the same fact —
  skip unless the verbatim path proves confusing in practice.

## Slice 2 — readable, non-leaking source errors, tagged for machines

`folder.js` throws raw fs messages (`ingestion folder unreadable: ENOENT: …
scandir '/data/ingest/New folder'`, line 68). Those strings become
`last_error` (modal status line), job-log rows — which are **member-visible
by design** (`server/server.js:952-955`) — and browse-route responses. So the
absolute server path currently leaks past the manager gate. Sanitizing here
fixes surfaces everywhere downstream.

- In `folder.js` `list()` (root-level catch, line 67-69) and `fetch()`, map
  codes to messages built from the *configured subpath*, never the absolute:
  - `ENOENT`/`ENOTDIR` → `` folder "New folder" doesn't exist under the
    ingest root — renamed or removed? `` and set `err.notFound = true`.
  - `EACCES`/`EPERM` → `` folder "New folder" can't be read (permission
    denied) ``.
  - anything else → `` folder "New folder" can't be read (<code>) ``.
  - `fetch()` per-file `ENOENT` → `` file vanished before it could be
    copied `` (these land in per-item errors, `worker.js:1804`).
- In `ftp.js` `list()` (line 73), tag `err.notFound = true` when the base-dir
  listing fails with FTP code 550 (basic-ftp exposes `err.code`); message
  stays `FTP list failed: …` (remote paths are user-configured, not leaks).
- `s3.js` is untouched: a missing prefix is *by design* indistinguishable
  from an empty one, and empty is healthy (see non-goals). Real S3 errors
  (NoSuchBucket, auth) already read fine.
- `err.notFound` is the seam slices 3 and 4 stand on.

Tests: extend `test/ingest-folder.test.js` — root-level ENOENT produces the
friendly message, no absolute path in it, `notFound` set; per-file fetch
ENOENT message; EACCES path (skip on platforms where it can't be arranged).
FTP 550 tagging wherever `test/ingest-sources.test.js` stubs the client.

## Slice 3 — the browse modal never orphans; missing start = relink flow

This is the bug fix, and it doubles as the Lightroom-style relink: when the
saved folder is gone, land the user somewhere real so one click into
`wardrobe` + "Use this folder" completes the repair (lossless per the
key-stability fact above).

- **Route** (`server/server.js:1213-1223`): map `err.notFound` → HTTP 404
  (body still `{ error }`); everything else stays 400. A dead FTP server is a
  connect error, not a 550 — it stays 400, which is what stops the client
  fallback from chaining 30 s timeouts up a dead tree.
- **Client** (`public/source-browse-modal.js`):
  - On a 404 for a non-blank path, auto-ascend one segment (client-side
    `parentOf` — strip the last `/`-segment; the failed response has no
    `parent` to lean on) and reload, keeping a persistent notice line:
    `Couldn't open "New folder" — it may have been renamed or removed.
    Showing "<landed>".` Each still-missing ancestor 404s and ascends again;
    `""` (the root) is the floor. A 404 at the root itself, or any non-404
    failure, shows the plain error and stops — no retry loop.
  - Track `loadedOk` per level: "Use this folder" is disabled until the
    current level has actually rendered (fixes the modal happily re-saving
    the dead start path), and `current` only ever advances on success (it
    already does — line 59 — the gap was the button, not the tracking).
  - `renderPath` runs on the fallback's successful landing, so the path line
    and ↑ Up return with it.

Tests: route status mapping (404 vs 400) in `test/ingest-routes.test.js`; the
ascend/notice/`loadedOk` behavior via the `test/browser-stub.js` harness
(precedent: `test/switch-row.test.js`) if the modal module imports cleanly;
otherwise the route tests carry the contract and the client behavior is
manual-verify.

## Slice 4 — folder health where you configure it

Today the modal renders a saved config with no idea whether the folder
exists; the status line only reports the *last run*, which for a paused board
may be days stale, and for a never-run board says nothing.

- **Probe = the browse route with a bound.** The route accepts optional
  `body.limit` (clamped 1–1000, default 1000), threaded through
  `adapter.browse` → `be.list({ limit })` (`files.js:304-320` already passes
  a limit; make it a parameter). `{ probe: limit: 1 }` answers "does this
  level open" for pennies; slice 2's 404 distinguishes *missing* from
  *unreadable* from *fine*. An empty-but-present folder is `ok, 0 entries` —
  healthy, exactly as it must be for inbox-style boards.
- **Local folder: automatic.** Probe on modal build, on path edits (400 ms
  debounce, seq-guarded like the preview count at `ingest-modal.js:566`),
  and after a Browse pick. Render a one-line status under the folder row:
  - found → subtle `✓ folder found` (`im-hint`);
  - 404 → red (`im-status error` styling): `folder not found — renamed or
    removed? Browse to point the board at it`;
  - other error → its sanitized message.
- **Remote (FTP/S3): on demand.** A `Test` button beside Browse… runs the
  same probe on click. No auto-probe: a dead FTP server holds a 30 s connect
  timeout (`ftp.js:39`) and a keystroke-driven prober would stack handshakes
  against it. The health line shows `Checking…` → same three outcomes, and a
  path change (typed or picked) hides the last verdict rather than letting a
  stale ✓ vouch for a path it never checked. (For S3 this honestly answers
  "can I list" — it cannot detect a renamed prefix, and with a limit-1 probe
  the copy can only say something/nothing: `reachable` /
  `reachable — nothing under this prefix`.)
- No probe at all when `!info.root` for folder source (the existing warning
  at `ingest-modal.js:239-244` already owns that state).

Tests: route honors + clamps `body.limit` (`test/ingest-routes.test.js`);
`browse()` threads it (`test/ingest-folder.test.js`).

## Slice 5 — the chip admits the watch is failing

`ingestMode` is manual/paused/scheduled (`server/ingestion/index.js:80-84`);
a continuously failing board reads "scheduled" on the toolbar and on the
boards index. The jobs dot fires once at onset (see above) — there is no
ongoing-state signal anywhere outside the modal. Syncthing's red folder is
the convention.

- `ingestStatus` (`server/ingestion/index.js:99-104`) gains
  `ingest_error: !!board.ingest_state?.last_error` — a boolean, carrying no
  paths, safe on the member-visible payloads that already spread
  `ingestStatus` (`server/server.js:844, 939`). (The error *string* is
  already member-visible in the jobs log by design, and slice 2 makes it
  leak-free — but the boolean keeps this payload's exposure unchanged.)
  Note `ingestStatus` is called with the full board row at both sites, so
  `ingest_state` is in hand; no query changes.
- `stampBoardIngest` (`public/data.js:286-289`) carries it into state; the
  toolbar chip (`public/toolbar.js:37-89`) gets an `.error` variant — red
  tint on the existing chip, countdown still shown (the retry *is*
  scheduled), title `Automatic ingestion is failing — open to see the
  error.` Mode precedence: error tint composes with, not replaces, the
  countdown/paused rendering.
- Boards index (`public/boards.js:273-280`): the mode suffix map gains the
  failing case — `— failing` beside the existing `— off` / `— paused`.
- Freshness caveat, accepted: the boolean rides payloads the client already
  polls/refreshes (`refreshBoardIngest` on countdown expiry, the boards
  index tick). At worst the tint lags one refresh cycle behind the first
  failure — same staleness contract as the countdown itself, no new polling.

Tests: `ingestStatus` derivation (null state / clean state / error state) in
`test/ingest-engine.test.js` or wherever `ingestStatus` is pinned today.

## Slice 6 — the continuous hint stops lying

`ingest-modal.js:498-500`: after an error the cadence is a 5-minute backoff,
not 30 s. New strings:

- local: `Continuous re-checks the folder about every 30s (after an error,
  every 5 minutes until it recovers).`
- remote: `Continuous re-checks the source about every 30s — fine for your
  own server, but a busy poll on a remote source; after an error it retries
  every 5 minutes. Interval is gentler.`

## Order and dependencies

2 → 3 → 4 (the `notFound` tag and 404 mapping are the seam the browse
fallback and the health probe both read). 1, 5, 6 are independent and can
land in any gap. Suggested: 3's route half rides with 2 in one change; the
modal halves of 1, 3, 4 land together (they all touch `renderFolderBlock`
and the browse modal); then 5; 6 with whichever touches the modal last.

## Non-goals

- **No S3 "source went quiet" heuristic.** Rejected in review: the ingestion
  feature is legitimately used as a consume-style inbox — ingest, then clear
  the source (possibly automated later) — so *empty is a healthy resting
  state*, and "previously N files, now 0" would cry wolf after every drain.
  The marker-object trick (console-created folders leave a zero-byte key,
  which a console rename moves away — `s3.js:70` already skips it) only
  works for console-created prefixes and silently doesn't otherwise;
  inconsistent detection is worse than none. S3 truth stays manual: Test and
  Browse.
- **No auto-repair of any kind.** No auto-repointing to a similarly-named
  folder, no auto-clearing config, no permanent auto-pause. The infinite
  gentle retry is what lets an unplugged drive heal itself; every surveyed
  tool treats config mutation as the user's move alone. Slice 3 *offers* the
  relink; nothing performs it.
- **Auto-remove-after-ingest is its own future plan**, and it flips the
  additive law, so it must not ride along here. Three questions it will have
  to answer, recorded so they aren't rediscovered: (a) removal should
  probably forget the ledger key too — keys are relative paths, camera-style
  name reuse (`IMG_0001.jpg`) would otherwise be silently skipped forever;
  but with no content-hash dedup in `admitFile`, re-dropping the *same* file
  then duplicates — choose consciously. (b) Delete only after the admit
  transaction commits; never on retryable errors. (c) Decide the
  "unsupported type" skip policy — today a skipped file is ledgered and sits
  in the folder forever, which inbox mode turns into invisible junk.
