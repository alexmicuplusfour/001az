# Welcome — the first screen of a fresh instance (2026-09-13)

**Status: ALL STAGES SHIPPED 2026-09-13. Stage 3a and the walked-in half of 3.0
were REVERSED the same day — see the banner on Stage 3.** Suite green at
1523 (was 1495), eslint clean. Stage 4 arrived as a bug fix rather than the
one-line cleanup it was written as — four of the chooser's five keyed providers
could not complete first-run at all — and retiring the default then changed
tagging's fresh-instance STATE, which two surfaces had hardcoded around (4.8).
Its empty-state half was deleted rather than built: Stage 3b had already
shipped that sentence. Suite green at 1519 (was 1495), eslint clean. New files:
`test/welcome.test.js` (7), `test/welcome-gate.test.js` (2),
`test/browser/welcome.test.js` (9), `public/welcome.{html,css,js}`,
`public/user-menu.js`.

The Stage 1/2 boundary is **closed**: `/welcome` exists, and the redirect a
fresh admin gets now lands on a page. A browser test opens `/boards` as a fresh
admin and follows the redirect to a rendered chooser, which is the assertion
the dead-end period had no way to make — `location.replace` is a no-op in a
stub, so the page it names could have been absent and three dom-stub tests
would still have been green.
Self-contained for a fresh session. Written after a deep dive across the
capability registry and its status feed, the plugin catalog and its defaults,
the AI provider descriptors, the first-run setup path, the client boot gates,
and the boards page's empty state — plus a live look at a genuinely fresh
instance on :8002.

Revised three times since the first draft, every time because the code said
otherwise:

- **2026-09-13, Finding 3 inverted.** The draft claimed there was no keyless
  path to tagging and proposed writing an Ollama descriptor. One already ships
  ([examples/plugins/ollama](../examples/plugins/ollama)). The real gap is
  discovery, which turned the optional Stage 5 into the core **Stage 2b**.
- **2026-09-13, Stage 1 deep-dived.** `/api/me` turned out to be fetched eight
  times per admin page with `no-store`, and `app.js` turned out to need no edit
  at all. Both are in **Stage 1**; the first closed the re-gating open
  question as a side effect.
- **2026-09-13, Stages 2 and 2b deep-dived against a running server** — the
  bundled Ollama installed for real and driven through the whole connect
  sequence. Seven corrections, all in place below and listed with their
  measurements in **2.8**. The load-bearing two: a bundled def must not join
  `pluginDefs()`, and a manifest cannot carry the fields the connect card
  needs, which moves the install from the Connect button to the tile.
- **2026-09-13, Stages 2b and 2 built.** Four more things the tree decided,
  all in **2.9** and **2b's** closing notes: the listing hints a manifest had
  to grow before the ordering rule could exist, where the bundled rows are
  actually composed, the `[hidden]` attribute doing nothing on a page made of
  flex and grid, and the provider LABEL vs its internal name.
- **2026-09-13, Stage 3 deep-dived, and it grew.** Three findings turned
  "three lines in a menu" into real work: `/welcome` is a first-run screen and
  3a makes it a recurring destination; the strip's predicate misses the reader
  Stage 2 creates; and its feed costs 58 queries for the one row it reads. All
  measured, all in **Stage 3** below.
- **2026-09-13, Stage 3a REVERSED, and 3.0 with it.** Shipped, used, and wrong:
  a standing "Setup" row reads as an unfinished task on an instance with
  nothing left to set up, and the page it led to answered a returning reader
  with a blank API-key box for the provider already answering — which added
  the SAME connection a second time and orphaned the first (reproduced:
  `["1:OpenAI"] → ["1:OpenAI","2:OpenAI"]`). The row is gone, `/welcome`
  bounces a configured instance to the boards page, and the way back is the
  3b strip alone, which is the one door that says what is wrong. Kept: the
  user-menu extraction 3a forced, which is why removing the row was one edit
  instead of three.
- **2026-09-13, Stage 4 built.** The fix landed first and the flip second, as
  4.2 requires. Then the flip moved a state nobody had budgeted for:
  `blocked` → `unavailable` on a fresh instance, which two readers had written
  out as a hardcoded pair — one of them the strip Stage 3b had just shipped,
  which would have gone silent with every test green. **4.8.**
- **2026-09-13, Stage 4 deep-dived, and it inverted.** Running Stage 2's own
  connect sequence against a built-in provider found that **four of the five
  keyed providers in the chooser do not work today** — the pick is never
  recorded as an install, and every resolution rung is install-gated. Stage 4's
  headline edit would have moved the fifth into that set. The stage is now led
  by the fix, the flip is conditioned on the operator's own env, it grew a
  migration, and its second bullet is **deleted** — Stage 3b already ships that
  sentence, 20px higher on the same page.
- **2026-09-13, the CTA handoff moved (post-ship).** "Make your first board"
  opened the board modal on the welcome screen itself — the app's densest
  dialog as the closing shot of a guided first run, and exactly the stall the
  out-of-scope list predicted. The button is now a navigation to `/boards`,
  where an admin's empty grid renders a card-shaped placeholder — the real
  card's classes, the empty face's dashed rectangle, a plus — that opens the
  same modal (`createBoard`: one call, two doors, the toolbar button being
  the other). board-modal.js no longer loads on /welcome at all. The modal is
  still the creation surface; an abstracted create flow is its own future
  arc.

Stage 2 is specified against a working prototype (eight revisions), and records
what the design stopped being as well as what it is.

## Why now

A fresh instance was started on :8002 and signed into. The first screen is the
boards page with one sentence on it:

> No boards yet — use + New board to make the first one.

That sentence is true, and it is the whole welcome. It does not mention that
the capability the product is built around — tagging — is not running, cannot
run, and will not run until someone picks an AI provider and pastes a key. An
admin who follows that sentence makes a board, points it at a folder, watches
items ingest, and gets a gallery of untagged files. The app's own Capabilities
tab knows all of this and says it clearly; nothing routes anyone there.

This plan is the "candidate follow-up" that
[capabilities-plan.md:1244](capabilities-plan.md#L1244) named and deferred:

> **Non-goals, decided:** … No gallery/first-run integration in this slice —
> the gallery already has the jobs surface; a "tagging is blocked" banner
> linking here is a candidate follow-up, not part of 4a.

## The five findings

### 1. The status layer exists and is better than any surface showing it

`GET /api/admin/capabilities`
([capability-status.js](../server/capability-status.js)) already answers, per
capability: the state (`active` / `degraded` / `blocked` / `off` /
`unavailable`), what is actually running, **why** it fell if it fell, who else
could serve it with their install/key/health state, how many items are waiting
on it, and whether it has a Test probe.

[capability-present.js](../public/capability-present.js) turns that into
copy — pure, DOM-free, import-free, node-testable, and explicitly written to
name no capability. It already has **three** shells mounted on it:

- [admin-capabilities.js](../public/admin-capabilities.js) — the cards
- [plugin-modal.js](../public/plugin-modal.js) — `planSection`
- [board-modal.js](../public/board-modal.js) — `planBoardPicker`

A welcome screen is a **fourth shell**. It computes nothing, stores nothing,
and names no capability. That is the whole reason this plan is small.

### 2. Anthropic is pre-installed, keyless, and nobody chose it

[plugins.js:44](../server/plugins.js#L44):

```js
defaultInstalled: p.name === "anthropic",
```

…with the comment *"Anthropic is the one connection pre-added, since tagging
(the product's core value) must work out of the box."* It does not work out of
the box — it cannot, because the row has no key. So a fresh instance shows a
Plugins card for a vendor the admin never picked, wearing an amber **no key
yet**, and a Capabilities card reading **Tagging · needs a key**. Both are
honest reports of a state the admin did not create.

This is the shape two standing rules already forbid:

- *No implied choices in UI* — unset is absence; a selection is an explicit act
  in the chooser.
- *General-purpose app, not a personal tool* — never bake a particular vendor
  into shipped defaults.

The reason it survived is that **there was no chooser** — pre-installing one
provider was the closest thing to an opinion the app could express. This plan
builds the chooser, which is what makes the default retirable (Stage 4).

### 3. The keyless path exists and is invisible

**Correction to an earlier draft of this document,** which claimed there was no
zero-key route to tagging and proposed writing an Ollama descriptor. There is
one, it is finished, and it ships in the repo:
[examples/plugins/ollama](../examples/plugins/ollama) — `keyless: true`,
`needsBase: true`, tagging **and** embeddings over the compat wire, live model
discovery per connection via `/v1/models`, name-pattern filters that split the
tagger picker from the embedder picker, a declared image ceiling and rate
limit. Its sibling [deepseek](../examples/plugins/deepseek) is the keyed
counterpart.

It is **baked into the Docker image** and installs with no network at all —
[plugin-fetch.js:62](../server/plugin-fetch.js#L62) resolves a bare path, so

```
POST /api/admin/plugins/install { "url": "examples/plugins/ollama" }
```

is the whole install. The README says exactly this.

So the problem is not that the capability is missing. **The problem is that
nothing lists it.** `supportedBy` is built from `pluginCatalog`, which composes
the built-in registries plus `listExternalPlugins` — rows for plugins that are
*already installed*. A bundled example that nobody has installed appears in no
catalog, no roster and no picker. The only way to discover it is to read a
README in the source tree, which a fresh admin on a running instance has no
reason to open.

That makes the gap a **discovery** gap, one small piece wide: enumerate what is
baked in at `examples/plugins/*/manifest.json` and offer it as available. That
piece serves the welcome chooser, the Add-plugin modal and the deepseek example
identically — which is why it belongs in the core stages rather than in an
optional one at the end (see Stage 2b).

### 4. The first screen is the boards page, and it doesn't know AI exists

[boards.js:180](../public/boards.js#L180) — the admin branch of the empty
state. Its own comment already identifies the surface correctly (*"This is
also the first screen of a fresh instance, since a boardless landing now
arrives here"*) and [boards-empty.test.js](../test/boards-empty.test.js) pins
that it reads the signed-in user rather than just the count. What it does not
know is anything about capabilities — the page never fetches that feed, and
for a member it must not (the feed is `requireAdmin`).

### 5. First-run setup exists, and ends by dropping you at the front door

`GET`/`POST /api/setup` ([server.js:554](../server/server.js#L554)) let the
first visitor to a passwordless instance claim the admin account, right on the
login page, with the door re-checked per call and closed for good once any
password exists ([setup.test.js](../test/setup.test.js) pins this). On success
[login.js:100](../public/login.js#L100) does:

```js
location.replace("/");
```

That redirect is **the one moment the app knows for certain it is looking at a
brand-new instance**, and it spends it on the gallery. It is the natural hook.

## The decision

**A soft gate: `/welcome`, admin-only, skippable, and derived rather than
stored.**

Three rules, in tension, all of which hold:

1. **The AI provider is the backbone, and the first screen must say so.** The
   product's value is tagging. A first screen that talks about boards while
   tagging is blocked is the "empty charts with no data source connected"
   failure — the one case where the UX literature agrees upfront setup beats a
   blank slate (see *Prior art* below).
2. **Never hard-gate.** The app really is usable without AI — upload, browse,
   facet filtering, the keyless connectors. A mandatory wizard is the thing
   people script around, and it would trap the reader who can least act on it.
3. **Non-admins never see any of it.** They cannot add a key. `requireAdmin`
   guards the whole feed. Showing a member a setup screen is showing them
   someone else's homework.

### `setup_pending` is derived, with exactly one stored bit

```
setup_pending = is_admin
             && welcome_skipped is unset
             && this instance has no boards
             && tagging does not resolve
```

One setting (`welcome_skipped`, a plain `settings` row — no migration);
everything else derived. The middle rung is what separates **new** from
**broken** — a long-running instance whose key was revoked is not a first-run
problem and must not be sent to an onboarding page; it gets Stage 3b's strip.
It also happens to make the predicate cheap, since it short-circuits the only
expensive rung. Both arguments are in Stage 1.2.

Deliberately **not** a stored "onboarding completed" flag:
that would be a second truth about whether the app works, and the app already
has a first-class answer to that question. Completion is not something the
admin clicks — it is tagging resolving. Revoke the key a year later and the
strip comes back, because it was never a fact about a ceremony.

This is the Home Assistant *Repairs* model: issues are derived, persist across
restarts, and **vanish by themselves when fixed** — no dismissal state to go
stale.

### Skip stops the redirect, not the truth

`welcome_skipped` suppresses the boot redirect and nothing else. The user-menu
row and the derived strip (Stage 3) stay, because the capability is still
blocked and the app should not pretend otherwise. That is the difference
between a wizard you escape and a checklist you postpone.

### Consequences accepted

- **A fresh instance costs an admin one extra screen.** Skip is one click and
  is offered in full sentences, not buried.
- **`/welcome` is admin-only.** A member on a keyless instance sees exactly
  what they see today. Their remedy is a person, not a page.
- **`setup_pending` adds two trivial queries to `/api/me` in the steady
  state** — a PK lookup and an `EXISTS`. `/api/me` is fetched eight times per
  admin page load and is `no-store`, so the ordering is load-bearing rather
  than tidy; the six-query path only ever runs on an instance with zero
  boards. Numbers in Stage 1.2.
- **The welcome screen can be wrong for a few seconds** after a bind, the same
  way the Capabilities tab can. It re-reads rather than caching.

## Prior art (web research, 2026-09-12)

- **AnythingLLM** puts provider choice first and alone:
  `OnboardingFlow/Steps/LLMPreference` is its own step ahead of everything
  else, over 40 providers, and the same settings surface stays reachable
  afterward ([DeepWiki](https://deepwiki.com/Mintplex-Labs/anything-llm/3.2-provider-configuration)).
  Validates: one decision per screen, and the onboarding UI is a *view* of the
  settings UI, not a parallel one.
- **Discourse** launches its wizard immediately after admin-account creation,
  offers **"Maybe Later"**, and lets an admin re-run it at any time
  ([meta](https://meta.discourse.org/t/rerun-the-setup-wizard/101179),
  [design thread](https://meta.discourse.org/t/designing-the-first-time-setup-wizard/49512)).
  Validates: the hook point (Finding 5), the skip, and the re-entry.
- **Metabase** shows the cost of a mandatory one — people ask how to bypass it
  programmatically
  ([discussion](https://discourse.metabase.com/t/skip-setup-wizard-programmatically-setup-initial-admin-data/19573)).
  Validates: soft gate.
- **Home Assistant Repairs** — derived issues, `is_persistent` across
  restarts, auto-removed when fixed
  ([dev docs](https://developers.home-assistant.io/docs/core/platform/repairs/),
  [integration](https://www.home-assistant.io/integrations/repairs/)).
  Validates: the derived-not-stored decision, and Stage 3's strip.
- **Onboarding literature, 2026**: checklists beat wizards because they are
  non-mandatory and resumable; tours fail when "mandatory, long, or not
  resumable"; **but** upfront setup is correct "when the product genuinely
  requires configuration to be useful"
  ([SaaSUI](https://www.saasui.design/blog/saas-onboarding-flows-that-actually-convert-2026),
  [Arcade](https://www.arcade.software/post/saas-onboarding-complete-playbook),
  [Userpilot](https://userpilot.com/blog/best-user-onboarding-experience/)).
- **Empty states are the only UI surface 100% of new users meet**
  ([Setproduct](https://www.setproduct.com/blog/empty-state-ui-design),
  [UserOnboard](https://www.useronboard.com/onboarding-ux-patterns/empty-states/),
  [Vercel Geist](https://vercel.com/geist/empty-state)). Stage 4 is that.
- **Counter-example, deliberately not followed:** Open WebUI and LibreChat
  keep provider config in `.env` / `librechat.yaml`
  ([guide](https://joshuaopolko.com/librechat-self-hosted-guide/),
  [comparison](https://tokenmix.ai/blog/openwebui-vs-librechat-self-hosted-comparison-2026)).
  001az has a real in-app key store with per-connection rows, board pins and
  live model lists; regressing the first decision to an env var would be a
  step backwards.

## Stages

### Stage 1 — `setup_pending`, the boot branch, and skip

Deep-dived 2026-09-13. Four things came out of reading the actual boot paths,
and two of them change the design.

#### 1.1 `/api/me` is hot, uncached, and fetched eight times per admin page

Twelve client modules fetch it; **every admin tab renderer fetches its own
copy** (`admin-members`, `-boards`, `-usage`, `-storage`, `-capabilities`,
`-plugins` ×2, `-backups`, `-logs`). And [server.js:320](../server/server.js#L320)
sets `Cache-Control: no-store` across all of `/api`, deliberately — so those
are eight real round trips, not seven cache hits.

Whatever `setup_pending` costs, **multiply it by eight** on the page an admin
opens most. That rules out calling `capabilityStatus()` (three settings walks
per AI entry plus a sidecar probe round) and makes even `resolveCapability`
worth ordering carefully.

*(The 8× fetch is a pre-existing smell — `renderPluginSurfaces` already exists
to collapse two of them. Not this stage's job, but worth its own cleanup.)*

#### 1.2 Order the predicate cheap-first, and the re-gating question answers itself

The plan's open question — *"does `/welcome` re-gate after a working instance
breaks?"* — and the cost question have the **same answer**. Three rungs, each a
short-circuit for the next:

```js
// capability-resolve.js, beside resolveCapability
export const setupPending = async (db) =>
  !(await getSetting(db, "welcome_skipped"))   // 1 PK lookup on settings(key)
  && !(await anyBoard(db))                     // 1 EXISTS on a tiny table
  && !(await resolveCapability(db, "tag"));    // the expensive one, last
```

Costs, counted by reading the resolver:

| instance | queries | why |
| --- | --- | --- |
| skipped | **1** | short-circuits on the setting |
| has boards (the steady state, forever) | **2** | short-circuits on the board check |
| fresh, nothing configured | **3** | `default_key_id` is null → no key row and no `disqualified` call; the env rung returns on a `process.env` test; `floor.kind === "blocked"` returns null |
| fresh, tagging configured | **6** | `default_key_id` → `getAiKey` → `pluginInstalled` → `model` |

`settings.key` is the PRIMARY KEY ([0001_baseline.sql:276](../server/migrations/0001_baseline.sql#L276)),
so rung 1 is a PK lookup. **Steady state is two trivial queries**, and the
six-query path only ever runs on an instance with zero boards.

That ordering is also the answer to re-gating: **a ten-board instance whose key
was revoked in month six is never redirected** — it short-circuits at rung 2
and gets Stage 3b's strip instead, which is the right treatment for *broken* as
opposed to *new*. The one-stored-bit rule survives intact.

`anyBoard` is new and one line — `SELECT EXISTS(SELECT 1 FROM boards)`. There
is no existing count helper worth reusing: `listBoards` selects `BOARD_COLS`
for every row ([db.js:1612](../server/db.js#L1612)).

#### 1.3 There is only ONE client gate, and it is not the one the plan named

The plan said to branch in both boot gates. Reading them, **app.js needs no
edit at all.**

[app.js:88–112](../public/app.js#L88-L112) already runs a boardless landing
*before* its main `Promise.all`: fetch `/api/boards`, redirect to the last
board if any exist, `location.replace("/boards")` when the array is empty. A
fresh admin opening `/` is **already** delivered to the boards page — which is
the page that gates.

This matters beyond tidiness. The branch the plan proposed sits at
[app.js:180](../public/app.js#L180), which is *after* a six-request
`Promise.all` — board, items, me, crates, boards, filter-configs. Branching
there would make a redirected admin pay for an entire board payload first. The
early block is the right place, but it has no `me` yet, and fetching one there
would add a round trip to every gallery boot for everyone.

So: **one branch, in [boards.js:51](../public/boards.js#L51)**, inside the
existing ladder:

```js
} else if (me.is_admin && me.setup_pending) {
  location.replace("/welcome");
}
```

It covers both entries — `/` with zero boards lands here, and `/boards` is
reached directly from the logo. Combined with 1.2's board rung, the only admin
it ever fires for is one with no boards and no model, which is the definition
of fresh.

Position in the ladder is load-bearing: **after** `needs_password` (a fresh
invite sets a password before anything else), and before `#gate` is unhidden so
nothing paints and then jumps.

#### 1.4 The server edits

- **`/api/me` ([server.js:403](../server/server.js#L403))** becomes
  `wrap(async …)`. It is currently a **plain synchronous handler** — going
  async without `wrap` turns a rejection into an unhandled rejection instead of
  a 500 (`wrap` is defined at [server.js:358](../server/server.js#L358)). One
  field, admin-only, so the question cannot leak to a member:

  ```js
  ...(req.user.is_admin ? { setup_pending: await setupPending(db) } : {}),
  ```

  It already sits behind `restoreGate` ([server.js:330](../server/server.js#L330)),
  so a mid-restore request never reaches the new query.

- **`POST /api/admin/welcome/skip`** — `requireAdmin`,
  `setSetting(db, "welcome_skipped", "1")`. A plain `settings` row:
  **no migration.**

- `/welcome.html` is served by the existing static mount's
  `extensions: ["html"]` ([server.js:3496](../server/server.js#L3496)), the
  same way `/boards` resolves — **no route**. Its own boot must gate too (not
  admin → `/boards`), or it is both a hole and a redirect-loop risk.

#### 1.5 Test fallout, including one that is load-bearing

[dom-stub.js:89](../test/dom-stub.js#L89) makes `location.replace` **throw**:

```js
replace(u) { throw new Error("unexpected redirect to " + u); },
```

…with the comment *"A redirect here means the auth gate misfired."* That is
free coverage: any stub-DOM test whose `me` fixture trips the new branch fails
loudly instead of quietly rendering the wrong screen.

It also exposes a real problem with
[boards-empty.test.js](../test/boards-empty.test.js). Its fixture is
`{ is_admin: true }` with zero boards — which passes today only because
`setup_pending` is `undefined` and therefore falsy. But that fixture *is* the
fresh-instance state, and on a real fresh instance that admin is at `/welcome`
and never sees this screen. The fixture must say `setup_pending: false`
**explicitly**, and the file's header comment should say why.

Which lands back on Stage 4: **the blocked variant of the boards empty state is
the post-skip screen, not the fresh-instance screen.** A fresh admin never
reads it. Worth knowing before spending copy on it.

Server-side, [password.test.js](../test/password.test.js) asserts `/api/me`
field by field, including that `password_hash` never appears. The addition is
additive so it passes, but that is the assertion to re-run deliberately.

#### 1.6 The truth table (`test/welcome.test.js`)

| skipped | boards | tag resolves | `setup_pending` |
| --- | --- | --- | --- |
| no | none | no | **true** — the only true row |
| no | none | yes | false |
| no | some | no | false — *broken, not new*; the strip covers it |
| yes | none | no | false |
| — | — | — | field absent entirely for a member |

Plus: the skip route is `requireAdmin`, and a second call is idempotent.

#### 1.7 What Stage 1 is, in full — SHIPPED 2026-09-13

| file | change |
| --- | --- |
| `server/db.js` | `anyBoard(db)` — `SELECT 1 FROM boards LIMIT 1`, beside `boardExists` |
| `server/capability-resolve.js` | `setupPending(db)` — the three-rung predicate, after `resolveCapability` |
| `server/server.js` | `/api/me` → `wrap(async)` + one admin-only field; `POST /api/admin/welcome/skip` |
| `public/boards.js` | one `else if` in the existing ladder |
| `test/welcome.test.js` | new — 7 tests, the truth table above |
| `test/welcome-gate.test.js` | new — 2 tests, **not in the original plan** (see below) |
| `test/boards-empty.test.js` | fixture gains `setup_pending: false` + a why |

`public/app.js`: **untouched**, as 1.3 predicted.

Two corrections the tree forced on the plan as written:

- **Export style.** The plan sketched `export const setupPending = async (db) =>`.
  capability-resolve.js has no exported arrow-consts at all — its six exports
  are `export async function` and its arrow-consts are deliberately
  module-private. Same in db.js's boards section. Both new helpers follow the
  file, not the sketch.
- **`anyBoard`'s body.** The plan said `SELECT EXISTS(SELECT 1 FROM boards)`.
  That returns one row always and would need `rows[0].exists` — the only such
  shape in that section. `boardExists` and `boardHasItems` next door both do
  `SELECT 1 … ` + `rows.length > 0`, so `anyBoard` does too.

#### 1.8 `test/welcome-gate.test.js` — the file the plan forgot

The plan's Tests section listed the server truth table and the fixture fix, and
assumed dom-stub's throwing `location.replace` would cover the client rung by
itself. It does not, and the gap is worth recording because the reasoning was
wrong in an instructive way.

**The throw only fires if a redirect is attempted.** With `setup_pending`
absent the field is `undefined`, the rung never runs, and the ladder falls
through to the render branch — three green tests describing a screen a fresh
admin can no longer reach. Confirmed by deleting the field and re-running:
3 pass, 0 fail, nothing thrown. So `setup_pending: false` in that fixture is
**documentation, not a guard**, and the header comment in the file says so now.
(An earlier draft of that comment claimed the opposite; the adversarial review
caught it.)

The positive case therefore needs a file of its own — a third boot, because
boards.js reads `me` once at module scope. It swaps dom-stub's throwing
`replace` for a recorder, which is the second reason it cannot live inside
boards-empty.test.js: the two files want opposite things from the same global.

It asserts more than the destination. `location.replace` is a no-op in a stub,
so every statement after it still runs — a rung that redirected and then fell
through into `render()` would pass a destination-only check. The proof is
`byId`, which dom-stub fills lazily (`getElementById: (id) => (byId[id] ||= el())`):
an id still absent was never asked for. `#gate`, `#boards-grid` and `#toolbar`
are all still undefined, so the page genuinely never opened.

The three boot files now read as a set: `boards-page` (a member with boards →
the grid), `boards-empty` (an admin who **skipped** → the empty state),
`welcome-gate` (an admin who hasn't → nothing at all).

#### 1.9 Review findings, and what measurement said

51-agent adversarial pass over the diff — six lenses, three skeptics per
finding, majority-refute to kill. 15 raw findings, 13 killed. Of the
survivors:

- **`/welcome` 404s** (high). Real, reproduced on a live server, and exactly
  the Stage 1/2 boundary the Sequencing section already declares. Recorded at
  the top of this document rather than fixed, because fixing it *is* Stage 2.
- **The false comment in boards-empty.test.js** (low). Fixed — see 1.8.

Worth keeping from the killed pile, because two of them were killed by
*measurement* rather than argument:

- **Cost.** An agent instrumented `db.query` against a real server: steady
  state (a board exists) is **4 queries for an admin, 2 for a member — a delta
  of exactly 2**, which is what 1.2 predicted.
- **`?gone=1` is swallowed** when a bounced admin also has zero boards and no
  model. Real but narrow, and arguably right: an instance in that state has
  nothing to explain a missing board *with*. Left alone deliberately.
- **`/api/me` can now 500 and boards.js would read the error body as a user.**
  Pre-existing: `attachUser` has been async and throwable since long before
  this, and `boards.js` has never checked `r.ok`. Out of Stage 1's scope, but
  it is a real latent bug in the boot gate and worth its own fix.

### Stage 2 — the page

Designed against a working prototype over eight revisions; what follows is
where it landed and, where it matters, what it stopped being.

**`public/welcome.html` + `public/welcome.js`.** Wears the boards page's chrome
(tinted body, floating header, `styles.css` + `modal.css` + `toast.css`) so it
reads as the same product. Its own boot gate: not signed in → login; not admin
→ `/boards`.

**Two fetches**: `GET /api/admin/capabilities` (the tagging entry's
`supportedBy` roster) and `GET /api/admin/plugins` (labels, `ai.needsBase`,
`ai.keyless`, and — after Stage 2b — the bundled-but-uninstalled rows).

#### 2.1 Three tiers of copy, each with one job

```
Connect an AI model                                    ← the task, and only the task
Needed for tagging, descriptions and board fields.     ← what it's for
[ tiles ]
You can change this later.                             ← footnote, under the models
```

Every word above was argued down from something worse, and the failure modes
are worth recording because they recur:

- **The title names the action and nothing else.** "Connect a model **to start
  tagging**" promises a thing that will not happen for a while — the admin has
  no board and no taxonomy yet. "…**for tagging**" understates it: the model
  also writes descriptions and fills fields.
- **The description says what it is needed for, not what it does.** "It tags
  what you add, fills in your fields and writes descriptions" is a narrative of
  who-does-what; "001az uses it to…" is the app talking about itself. A list of
  purposes is shorter and is what the reader is actually asking.
- **No sentence defends the screen's existence.** Early drafts ("Tagging
  doesn't run without one") read as argument. The reader is on a setup screen;
  that setup is required is *implied by being there*, and the UX literature is
  explicit that implied information should not be stated.
- **The footnote is a footnote** — 12px, `--text-dim`, directly under the tiles,
  where the hesitation it answers actually occurs ("am I stuck with this one?").
  It is not a subtitle and must never be sized like one.

#### 2.2 The chooser: one name per row, and you only ever see one

Tiles are **monogram + label**. No description, no chip, no status.

The first version carried a `needs a key` chip on every row. Five identical
chips carry zero information — the entropy is in the *exception*, so only the
keyless row gets a line (`on your machine`). The monogram derives from
`label[0]`: no vendor assets, no id→glyph table, nothing to keep in step
(provider-agnosticism).

**Ordering:** the bundled keyless provider first. It is the only row someone
can finish without deciding to spend money (Stage 2b).

**Which means Stage 2 depends on 2b, not only the other way round.** The
tag-capable providers on a fresh instance are anthropic, openai, gemini, glm
and openrouter — measured, and *not one of them is keyless*. Without 2b the
ordering rule above has nothing to order and the `on your machine` exception
has nothing to except; the chooser is five identical keyed rows, which is the
screen §2.2 exists to avoid.

**Picking one collapses the rest.** The grid is replaced by a single card for
the chosen provider — you never look at four vendors you already rejected.

#### 2.3 The connect card

Three bands, not one row. (It *was* one row —
`← O Ollama [input] [Connect]` — and it was unreadable: the input's purpose was
guessable only from its placeholder.)

```
┌───────────────────────────────────────────┐
│  ←   O   Ollama                           │   identity + a way back
│          on your machine                  │
│                                           │
│  Server URL                               │   a LABELLED field, full width
│  [ http://host.docker.internal:11434/v1 ] │   label is "API key" for keyed rows
│                                           │
│  [ Connect ]        · · · ·               │   action + progress
└───────────────────────────────────────────┘
```

Four calls, **all of which already exist**. Only the first branches, and it
fires **on the tile, not on Connect** — see below for why it has to:

| | when | built-in provider | bundled plugin (Stage 2b) |
| --- | --- | --- | --- |
| 1 | tile click | `PATCH /api/admin/plugins/ai:<name> { installed: true }` | `POST /api/admin/plugins/install { url }` |
| 2 | Connect | `POST /api/admin/ai-keys { name, provider, key, base_url? }` ([server.js:2298](../server/server.js#L2298)) | same |
| 3 | Connect | `POST /api/admin/capabilities/tag/bind { keyId }` ([server.js:2758](../server/server.js#L2758)) | same |
| 4 | Connect | `POST /api/admin/capabilities/tag/probe` ([capability-probe.js](../server/capability-probe.js)) | same |

Step 3 sends **no model**, and that is correct rather than lazy: tagging has no
provider setting, so `chooseBinding` short-circuits on `!keys.provider` and
`modelFor` falls to the descriptor's declared default. Verified — a bare
`{ keyId }` for Ollama resolves to `llama3.1:8b`.

**Why the install moved to the tile.** A bundled plugin's manifest carries
`{ id, apiVersion, kind, label, main }` and nothing else; `keyless`,
`needsBase`, `base` and `defaultModel` all live in the factory, which only runs
at `loadDir`. So before the install this card cannot know whether its field is
an API key or a server URL — which is the card. Installing on the tile answers
it: `POST /api/admin/plugins/install` returns the full catalog entry, and a
local dep-free plugin takes **21 ms** with no network and no npm. The cost is
residue — backing out of a tile leaves the plugin installed — and that is
acceptable: it is a removable card on the Plugins page, and an install with
no connection serves nothing and claims nothing.

The alternative, exporting `buildModule` so `bundledDefs()` could run factories
at boot without registering them, is refused. It buys full-fidelity rows
(`description` included) at the price of a new rule — *bundled code executes at
every boot* — for a payoff two rows wide.

Progress is **three dots** — one per call Connect actually makes, since step 1
is already done by the time this button exists. (It was four while the install
sat here; a dot that is always lit the instant it appears is not progress.) The
install's own wait is the tile's, and at 21 ms it needs nothing.

Failure surfaces **inline**, never as a toast — the rule from
[plugin-add-modal.js](../public/plugin-add-modal.js)'s install zone: a
long-running action's error must not outlive the surface that caused it. The
button wears `busy()` ([modal.js:175](../public/modal.js#L175)).

No new server surface, and deliberately no composite route: four calls means
four honest failure points, each reporting the message its own route already
writes. That is also why step 1 keeps its own error home — a bundled install
that fails has to say so on the tile, not inside a card that could not be
drawn.

**The caveat this card must not paper over:** step 4 proves the *connection*,
not that the work will succeed. For the bundled Ollama, `keyTest: "list"` hits
`/v1/models` — a box with nothing pulled tests green, and tagging then fails at
the wire for want of a tool-calling model. Green-then-failing is a reachable
state; the success copy must not promise more than the probe checked.

**And the other direction, which is worse: the redirect stops at step 3.**
`setup_pending` reads "does tagging resolve", and a stored binding resolves
whether or not anything answers at the far end — so `/api/me` flips to
`setup_pending: false` between bind and probe. Measured on a live server: bind
200, `setup_pending` false, then probe 400
(`Ollama: ECONNREFUSED — http://127.0.0.1:11434/v1/models`).

The order is **forced**, not a choice: `PROBES.tag` resolves the capability
before calling it, so the binding has to exist before the probe can run. A
failed connect therefore leaves an instance that is bound, broken, and no
longer redirected — reload and you land on the boards page's empty state, not
back here.

Two consequences. The card must not send a failed admin away: a 400 on step 4
keeps them on this screen with the provider's own message and the field still
holding what they typed (which the inline-error rule above already demands).
And **Stage 3 is the recovery path**, which makes it more load-bearing than
"useful even if 2 slips" — without the Setup row, a mistyped URL is a one-way
door out of the setup screen.

#### 2.4 What comes after, and only after

The **"Make your first board"** button does not exist until the connection
lands. Progressive disclosure with teeth: the step is absent, not disabled.
`openBoardModal(null, { canEditAI: true, onSaved: … })` — the same call
[boards.js:115](../public/boards.js#L115) already makes.

On success the title flips to **"Model connected"** and the footnote to
**"Change it any time from Setup"** — which is also where the re-entry question
(Stage 3a) gets answered, at the moment the reader would wonder about it.

> **2026-09-13, since shipping:** the button NAVIGATES to `/boards` now — the
> modal-in-place was a jump cut, and the boards page's empty grid carries a
> placeholder card that opens it instead (see the ledger entry). And with
> Stage 3a reversed there is no Setup to point at: the footnote reads "Change
> it any time from Admin → Capabilities."

#### 2.5 The rest of the capabilities: named, marked, and collapsed

A disclosure below a rule — **"What else this server can do"** — carrying the
three marks on its right while shut, so what is inside is legible without
opening it. Open, the marks move into their rows and the header's go away: one
home at a time.

| mark | name | state on a slim deploy | `presentChip` |
| --- | --- | --- | --- |
| `embed` *(new — see below)* | Embeddings | `off` | `off` |
| `srcWave` | Audio transcription | `unavailable` | `unavailable` |
| `srcFrame` | Object detection | `unavailable` | `unavailable` |

Called by their real names. Glosses ("— not just keywords") were cut: the name
plus the mark carries it, and this section is not where the product gets
explained.

**The right-hand column is not this page's to write.** An earlier draft of this
table said "not installed here" for the sidecars — invented copy, and a fourth
spelling of a state that already has one. Measured on a fresh instance, the
feed answers `off` / `unavailable` / `unavailable`, and
[presentChip](../public/capability-present.js#L14) turns those into exactly the
words above. Use it verbatim. The sidecar rows also carry a `reason` the server
already authored — *"the built-in engine is not running on this server"* —
which is better than either and is what the Capabilities tab shows; if a row
wants a sentence, that is the sentence, not a new one.

Embeddings is the interesting row of the three, and the reason the disclosure
is worth having at all: `off` is the only one of the three states a reader can
do something about.

**This replaced a live capability readout**, which was the first design's
centrepiece — every AI capability rendered through `presentChip`/`presentLines`,
flipping to `active` as the connection landed. It was cut for two reasons, both
worth keeping written down:

1. **Only two capabilities hang off the provider** — tagging, and extraction
   which delegates to it. Embeddings run on the in-app embedder, transcription
   and detection on sidecars. So three of five rows never moved, which made the
   "watch it come alive" argument mostly false.
2. **It competed with the action.** The screen's job is one decision; a live
   five-row status panel is a status page wearing a setup screen's clothes. The
   Capabilities tab already is that page and is better at it.

**`embed` needs a mark and does not have one.** [capabilities.js](../server/capabilities.js)
declares `icon: "search"` for it — a borrowed magnifier that means *search*,
not *embeddings*, and the only entry in `CAPABILITY_DEFS` whose glyph is
on loan. The prototype proposes five scattered dots (points in a space), drawn
on the set's own 24×24 / 2px-round grid. If it holds up beside `srcWave` and
`srcFrame`, it is one `ICONS` entry plus one word in the registry.

Both halves land together, and the blast radius is one line: today the only
reader of `cap.icon` is the board modal's capability strip
([board-modal.js:860](../public/board-modal.js#L860)), and it goes through
`glyphEl`, which falls back to `ICONS.srcDot` for a name it doesn't know. So a
registry word shipped without its glyph degrades to a dot rather than throwing
— which is a reason to be careful, not a reason to relax: a silent dot is
exactly the kind of miss nothing fails on.

#### 2.6 The skip row

```
Skip for now   Uploads, boards and filtering work without it.
```

`POST /api/admin/welcome/skip` → `/boards`. The consequence sits **here** and
nowhere else on the page: this is the one spot where "what happens without a
model" is information the reader needs, because it is the choice being made.

#### 2.7 What the page is not

No carousel. No step numbers — the three things are not a sequence, and
numbering would claim they are. No progress percentage, no tour, no confetti,
no illustration of the product's value. An earlier revision had a
before/after sample item (filename → description + tags); it was cut for
being both an attention-grabber and a **misdescription** — it implied the model
invents tags, when the whole point is that it selects from a taxonomy the user
writes.

#### 2.8 What the running server said (2026-09-13)

Everything above that is stated as fact was measured, not read. The bundled
Ollama was installed from its repo path against a real server and driven
through all four calls.

- **The chooser is five keyed rows without 2b.** `ai:local`, `ai:whisper` and
  `ai:localDetector` are `tag: false` and drop out; what remains is anthropic
  (installed), openai, gemini, glm, openrouter — `keyless: false` on every one.
- **`POST /api/admin/plugins/install { url: "examples/plugins/ollama" }` →
  200 in 21 ms**, returning the full catalog entry: `keyless: true`,
  `needsBase: true`, `base: "http://host.docker.internal:11434/v1"`,
  `provides: { tag, embed }`. No network, no npm — the plugin declares no
  dependencies, and [plugin-fetch.js](../server/plugin-fetch.js#L79) resolves
  the bare path against cwd.
- **The provider's name is `community.ollama`, not `ollama`** — `catalogIdFor`
  is `ai:${manifest.id}` and `registerProvider(m.id, …)`. So the chooser posts
  `provider: "community.ollama"` to `/api/admin/ai-keys`, and the label
  ("Ollama") is the only string a reader ever sees. Nothing here should build a
  name from the directory.
- **The four calls all answered as specified**: key 200, bind 200, probe 400
  with the provider's own sentence.
- **`GET /api/admin/capabilities` costs 67 queries / 55 ms** on a fresh
  instance. Affordable once on a setup page, and it should be issued in
  parallel with `/api/admin/plugins` rather than after it — but it is the whole
  page's budget, spent on three collapsed rows, which is worth remembering if
  the disclosure ever grows.
- **`--ghost` does not exist.** The tree's tokens are `--text`, `--text-dim`,
  `--pill-bg`, `--pill-bg-hover`, `--pill-active`, `--gap`, `--sans`,
  `--serif`, `--neg-ink`, `--neg-border`, `--spk`. The footnote is
  `--text-dim`.
- **`/welcome` still 404s** (reconfirmed), and will resolve through
  `express.static(…, { extensions: ["html"] })` when the file exists. That
  mount is unauthenticated, exactly as `/boards` is: the gate is the page's own
  boot ladder and the `requireAdmin` on every route it calls, so nothing
  sensitive may be baked into the HTML.

#### 2.9 What building it decided — SHIPPED 2026-09-13

| file | what |
| --- | --- |
| `public/welcome.html` | the shell: gallery chrome, three copy tiers, chooser, disclosure, skip row |
| `public/welcome.css` | `w-*`, the way boards.css is `bc-*` |
| `public/welcome.js` | the boot gate, two feeds, the chooser, the three calls |
| `public/utils.js` | `ICONS.embed` |
| `server/capabilities.js` | embed's `icon: "search"` → `"embed"` |
| `public/modal.css` | the action row's button reaches a third wearer |
| `test/browser/welcome.test.js` | 7, the whole chain in Chromium |

Four things the code decided that the plan had not:

- **`[hidden]` does nothing on this page without help.** The attribute's UA rule
  is `[hidden] { display: none }` — specificity (0,1,0), the same as a class
  selector, and the author sheet wins ties. Every element here that toggles with
  `hidden` also declares a `display`, so every one needs its own `[hidden]`
  override, which is the rule styles.css already writes for `#bulk-bar`,
  `.lightbox` and the rest. Three browser tests failed on exactly this before
  the rule existed: the tiles were still on screen behind the card.
- **The provider's LABEL, never `running.provider`.** An installed plugin's
  provider name is its namespaced manifest id — `community.ollama` — and it
  reached the success line as "community.ollama · llama3.1:8b is answering."
  Worse, the obvious fix (`labelIn`) is wrong on the path that matters: the feed
  is fetched BEFORE the install, so its roster has never heard of the provider
  now answering, and labelIn falls through to the name. The label that is
  correct is the one the card already printed, so Connect passes it along;
  `labelIn` covers the other arrival, where there is no card and the roster is
  current.
- **The skip row has to go when the model lands.** "Skip for now — uploads,
  boards and filtering work without it" under a connected model reads as the
  page not having noticed what just happened. The consequence sentence was
  always true; it stops being anyone's problem.
- **Three dots, and the action row leaves with the action.** The install moved
  to the tile (2.3), so Connect makes three calls; and once it has, a progress
  trace is decoration on a card that has stopped being something you operate.

**The simplification pass** took out four things that had grown by accident,
and each one was a duplicate wearing a different hat:

- **The tile and the card built the same identity block twice** — name, plus
  the "on your machine" line — and had already drifted: the tile asked
  `isKeyless(p)`, the card asked `p.ai?.keyless`, which is the same answer only
  after the install. One `identity(p)`, one predicate.
- **Three functions passed the picked provider to each other.** It is page
  state, like `tagCap` — every step of the connect sequence is about the same
  one provider, and threading it was three chances to hand along a different
  one. A module-level `picked` collapsed `settled(running, card, label)` to
  `settled(running)` and dropped a parameter from the connect call too.
- **`.w-next` restated flex and gap** to be an action row, which is a cascade
  collision with `.w-actions` over `gap` rather than a second opinion. It wears
  the class in the markup instead — which is also how its button reaches
  modal.css without a fourth selector.
- **`readManifest` + `validateManifest` was copied at all three entry points**
  — loadDir, installFromUrl, and now the bundled scan. One `manifestIn(dir)`;
  the three differ only in what they do with the throw.

Plus two comments that said the same thing twice: admin-plugins.js already
stated the manifest-only-row rule at `tagFor`, so `keyNote` points at it rather
than restating it in six lines.

**What `welcome.js` does NOT do**, and the line worth holding: it never maps a
state to a word. The disclosure's right-hand column is `presentChip` verbatim,
and the day this file grows a `state === "..."` is the day the screen has
started keeping its own opinion about capabilities. `capability-present.js` is
untouched, which is the plan's own test of whether the design was right.

### Stage 2b — the bundled catalog (what Finding 3 actually needs)

One reader, so the chooser can offer what the image already carries.

**`server/plugins.js`** grows `bundledDefs()`: scan
`examples/plugins/*/manifest.json` at boot, and for each one whose id is
**not** in `listExternalPlugins`, emit a catalog entry with
`state.installed: false` and its install path.

**It does not join `pluginDefs()`, and this is the correction that matters.**
An earlier draft said "beside the four existing `*Defs()` builders", which
reads as a fifth spread in

```js
DEFS = [...aiDefs(), ...connectorDefs(), ...mediaDefs(), ...sourceDefs()];
```

— and that array is what [getPluginDef](../server/plugins.js#L161) searches,
which is how [PATCH /api/admin/plugins/:id](../server/server.js#L2485) and
`POST /api/admin/plugins/:id/test` find their target. A bundled row in there
makes `PATCH ai:community.ollama { installed: true }` answer **200** and write
`installed: true` for a plugin whose code has never been loaded. Nothing
crashes — `disqualified` reports `"community.ollama" is not installed` because
`PROVIDERS` has no such entry — but the Plugins page then shows an installed
card for a provider that cannot serve, and `aiRoster` counts a phantom as
supply. The install verb is not a toggle, so it must not be reachable through
the toggle's route.

So the rows are appended by **`pluginCatalog(db)`**, which is the read-side
projection, and `pluginDefs()` stays the list of things the routes may address.
Same shape as every other catalog row, so the readers below learn no new case:

- the **Add plugin** modal lists them beside the built-in connections instead
  of only offering a URL box (today a bundled example is strictly harder to
  install than a random GitHub repo, which is backwards). Listing is free —
  [admin-plugins.js:128](../public/admin-plugins.js#L128) is
  `plugins.filter((p) => !p.core)` and a non-core uninstalled row lands there
  with no edit — but **adding is not**: that modal's Add button is
  `PATCH …/:id { installed: true }`
  ([plugin-add-modal.js:69](../public/plugin-add-modal.js#L69)), the built-in
  verb, which per the rule above will not resolve a bundled id. It needs the
  same branch the chooser takes. And no "code from the internet" confirm on
  that path — that warning is about untrusted sources, and this source is the
  image;
- the welcome chooser's roster is "registered AI providers + bundled AI
  providers not yet installed";
- **deepseek** gets the same treatment for free, which is the test that this
  is a catalog feature and not an Ollama special case.

**The chooser's connect sequence** branches on one field. A built-in flips
`installed`; a bundled plugin installs from its path:

```
built-in  →  PATCH /api/admin/plugins/ai:<name>   { installed: true }
bundled   →  POST  /api/admin/plugins/install     { url: "examples/plugins/ollama" }
```

Both then take the same three steps (`ai-keys` → `capabilities/tag/bind` →
`probe`). The install route already exists and already handles local paths; no
new server surface, again. Per §2.3 that branch fires **on the tile**: a
bundled row knows its label and its path and nothing else, so the card has to
install before it can tell which field to draw.

**What a bundled row may and may not carry.** Label and path come from the
manifest. `description`, `keyless`, `needsBase`, `base` and the `provides`
catalogs do not exist until the factory runs, so the row ships without them and
every reader must survive their absence. Two already do —
[tagFor](../public/admin-plugins.js) answers `"AI"` with no serving role, and
`aiRoster` filters on `p.capabilities?.[declaredBy]` with optional chaining —
but `keyNote` in the same file dereferences `p.ai.onDevice` unguarded. It is
safe today because it runs on the *card* path and a bundled row is never a
card; it is one refactor away from a throw, and a `?.` there is cheaper than
remembering why.

**The ordering rule needed something a manifest could say.** "Keyless first" is
a fact from the descriptor, and the whole point of a bundled row is that its
descriptor has not run — so on a fresh instance the rule had nothing to sort
by and Ollama came last, which is the arrangement it exists to prevent. The
manifest therefore declares two **listing hints**, `keyless` and `needsBase`,
validated as booleans and used for exactly two things: the order, and whether
the note reads "on your machine".

They are a second copy of something the factory already says, so they get the
treatment a second copy needs: `plugin-install.test.js` installs every bundled
example for real and asserts hint === descriptor. They also ride the `bundled`
block and never a half-built `ai` one — `ai.keyless === false` means "the
descriptor says bring a key", and "nothing has loaded yet" is not that.

**Where the rows are composed.** `bundledPlugins(db)` lives in `plugins.js` next
to `erroredExternalEntry`, which turned out to be the same shape for the same
reason — a catalog row built from a manifest with no live descriptor — so both
now come off one `manifestEntry()`. The rows are appended in the
`GET /api/admin/plugins` route rather than inside `pluginCatalog(db)`: readers
that ask "what could serve this" (the capabilities feed's `supportedBy`) should
not be answered with something that cannot, and keeping the composition at the
route is the strongest form of the rule above — the rows never enter
`plugins.js`'s def list at all.

It cost one deliberate module cycle: `plugins.js` now imports `catalogIdFor`,
`validateManifest` and `readManifest` from `plugin-loader.js`, which already
imports `resetDefs()` from `plugins.js`. Both directions are calls to hoisted
function declarations, never module-eval reads, and the alternative was a second
copy of the manifest → catalog-id rule, which is the one thing `catalogIdFor`
exists to prevent.

**Ordering in the chooser matters and is a real decision.** Ollama first means
the first thing an admin sees costs nothing and leaves their data on their own
box. Ollama last means the recommended path leads. Prefer **first** — it is
the only entry that can be completed by someone who has not yet decided to
spend money, and it is the difference between "this needs a credit card" and
"this runs on my machine".

**The one honest caveat, which the chooser should carry:** tagging over the
compat wire hard-fails without a tool call, so the box needs a tool-calling
model pulled (llama3.1+, qwen2.5/3, mistral-nemo). The descriptor's
`modelFilter` and its `defaultModel` comment already say so. The connect
probe's error is the right place for it to land — `keyTest: "list"` proves the
box is up, not that a usable model is pulled, so a green test followed by a
failing tag is a reachable state and the copy should not promise otherwise.

### Stage 3 — the persistent place

> **REVERSED IN PART, 2026-09-13, after using it.** Everything below shipped as
> written. Then **3a's menu row was removed and 3.0's walked-in path deleted**,
> because the premise underneath both — that `/welcome` should be somewhere an
> admin returns to — is wrong. It is a first-run guide. A returning reader had
> no question it could answer, and the one it asked anyway ("paste an API key")
> produced a DUPLICATE connection to the provider already serving.
>
> What stands: **3b (the boards strip)**, which is now the whole answer to "how
> do they get back" — it appears only when tagging is broken and says how; and
> **3c (the one-capability feed route)**, which the strip rides. What went:
> the menu row, and `settled()`'s second arrival. `/welcome` now sends a
> configured instance to the boards page, so the walked-in state cannot occur.
>
> The sections below are left as written: the reasoning is why the row looked
> right, and the reversal only makes sense next to it.

Two rungs, both derived from the same feed — plus a third thing the first rung
turns out to require, and a cost fix the second one needs before it ships.

#### 3.0 The thing 3a breaks, which is `/welcome` itself

A Setup row makes `/welcome` a **recurring destination**, and it was built as a
first-run screen. Here is what an admin with two boards and a working model
lands on today, read off a real browser:

```
title : Model connected
why   : Anthropic · claude-haiku-4-5 is answering.
fine  : Change it any time from Setup.        ← told to someone who arrived via Setup
next  : [ Make your first board ]             ← they have two
tiles : hidden                                ← switching provider is unreachable
```

Three things are wrong and the third is the real one: the chooser collapses on
a connected instance, so the page the Setup row leads to is the one page that
cannot change your setup. The footnote is a loop and the button is a claim
about how new you are.

The fix costs nothing to find: `settled()` already knows which arrival this is
— `picked` is null when nobody clicked a tile. So the walked-in path keeps the
chooser, drops the board button and says something that isn't circular, while
the just-connected path is untouched. It is a **Stage 2 edit that Stage 3
forces**, which is the honest way to record it: 3a is not three lines.

#### 3a. One user menu, then a Setup row in it

The plan used to say "both copies". There are **three** — Stage 2 added one:

| | `me` from | after sign-out |
| --- | --- | --- |
| [boards.js](../public/boards.js) | `me` | `replace("/login.html?next=%2Fboards")` |
| [toolbar.js:207](../public/toolbar.js#L207) | `state.me` | `location.reload()` |
| [welcome.js](../public/welcome.js) | `me` (admin-only page, so no guard) | `replace(…next=%2Fwelcome)` |

Otherwise identical, down to the separator. The button above each is duplicated
too — `tool-btn user-menu-btn`, a name span, a caret; eight lines, three times.

So the row lands in **one** place, after extracting one: a `user-menu.js` with
the button and the menu, taking the two things that genuinely differ as
arguments. Adding a row to three copies is the exact move the no-duplication
rule exists to stop, and the third copy is mine.

`ddRow({ label: "Setup", href: "/welcome" })`, above Admin: admin-only, always
present, no state and no badge. A row that appears only when it is needed is a
row nobody can find when they need it.

#### 3b. A strip on the boards page — and its predicate has three cases, not two

The plan said `blocked` or `degraded`. Measured on a live server, that misses
the reader Stage 2 creates. Bind a provider, let the probe fail:

```
probe: 400 {"error":"Ollama: bad port — http://127.0.0.1:9/v1/models"}
tag.state = active | reason = null | demand = null
supportedBy[ollama].health = { failCount: 1, lastError: { message: "Ollama: bad port …" } }
```

**`active`.** A stored binding resolves whether or not anything answers at the
far end — the same fact that turns the redirect off at bind (2.3). So an admin
whose connect just failed gets no redirect *and* no strip.

The evidence is already in the payload and **nothing renders it**:
`capability-present.js` never mentions `health`, and the only reader in
`public/` is [plugin-modal.js:142](../public/plugin-modal.js#L142) — a banner
inside the modal of the plugin you already suspected. A bound-and-failing
tagger is invisible on every surface in the app. Closing that is 3b's real job,
and the third case is what closes it:

  1. `blocked` — nothing resolves (the skipped admin)
  2. `degraded` — the stored choice is not what's serving
  3. **resolving, but failing at the wire** — `health.failCount` on the roster
     entry for whatever `running.provider` names

The sentence renders VERBATIM, which the first draft did not:

> **Tagging** — needs a key · 14 items waiting · **Finish setup →**

`c.label` + `presentChip(c).text` + `demand.waiting`. "Tagging is waiting on a
key" was authored copy dressed as payload — `presentChip` returns a two-word
chip, not a sentence — and a fourth spelling of a state is exactly what §2.5
already had to take back out. Case 3 has no chip of its own (the chip says
`active`, correctly), so it borrows the provider's own last error, which is the
only sentence about it anyone wrote.

It renders above the grid, admin-only, and **disappears by itself** when the
capability resolves. No dismiss button, because there is nothing to dismiss —
it is a reading of the current state, not a notification.

**Gate the fetch on `me.is_admin`** — a member's boards page never issues it,
and the route's own `requireAdmin` is the backstop. That gate is testable for
free: the browser tests assert `page.failures` is empty, so a member's page
issuing this would 403 and fail. The alternative (a second `/api/me` field) is
refused for the reason Stage 1.1 gives.

Note the audience. By Stage 1.2 an admin with **zero** boards was redirected
and is not here; an admin who **skipped** is, and so — since Stage 2 — is
anyone whose connect went wrong. The copy states the consequence rather than
greeting anyone.

#### 3d. What shipped — 2026-09-13

| file | what |
| --- | --- |
| `public/user-menu.js` | **new** — the button and the menu, once; `{ me, afterSignOut }` |
| `public/boards.js` `toolbar.js` `welcome.js` | each lost ~25 lines to it, and gained the Setup row for free |
| `server/capability-status.js` | `capabilityStatus(db, { only })` — a builder list and one filter |
| `server/server.js` | `GET /api/admin/capabilities/:id` |
| `public/capability-present.js` | `presentTrouble(c)` — the three cases |
| `public/boards.{js,html,css}` | `#setup-strip`, wearing styles.css's `.warn-box` |
| `public/welcome.js` | `settled()` splits on `picked`: walked-in keeps the chooser |

Three things worth keeping:

- **The strip's box is not new CSS.** styles.css already has `.warn-box` — "one
  rounded shell in three tones, amber is *this wants your attention*" — which
  is exactly the sentence. All boards.css adds is the row inside it and where it
  sits. (And its own `[hidden]` rule, for the reason 2.9 records.)

  The simplification pass moved that class into boards.html, with the rest of
  the page's structure, and the cost is worth recording: the dom-stub knows the
  elements a page ASKS FOR, not the markup they came from, so `.warn-box` is no
  longer assertable from a node test. The test says what it can honestly see —
  that the page chose to show the strip, and what it says — and the class
  choice is pinned by the comment beside it. Which is the normal state of
  affairs for a class name; it was only ever checkable because a line of JS was
  restating a constant.
- **`append()` will not take a bare string in the dom-stub**, and the throw
  landed outside the strip's one `try`, so the strip vanished with three green
  tests to show for it. The app builds text nodes explicitly everywhere else;
  this now does too. The lesson is the placement of the `try`, not the stub: a
  function whose only handled error is a fetch failure must not do DOM work that
  can throw.
- **The strip is asserted in `boards-empty.test.js`**, not a file of its own —
  the skipped admin is already that file's subject and is also the strip's
  reader. Which means the fixture had to grow the capability route: leave it out
  and the page's own `try/catch` swallows the miss.

#### 3c. The feed has to be askable for one capability first

| | queries | ms |
| --- | --- | --- |
| `GET /api/admin/capabilities` (9 entries) | **58** | 73 |
| `pluginCatalog(db)` — the part every entry shares | 7 | 5 |
| one capability's ingredients, catalog included | **12** | 9 |
| `GET /api/boards/overview` | 6 | 23 |
| `GET /api/me` | 4 | 24 |

Every admin boards-page load would pay ~6× the rest of the page combined to
decide whether to show a strip that is usually absent. And the bulk is not the
catalog — it is building eight entries nobody reads: object detection,
ingestion sources, two connector domains.

`capabilityStatus(db, { only })`. The id is a **parameter, not a branch**, so
this does not break "nothing is authored per capability"; it is the same walk
with a filter, and it is 4.7× cheaper. Do it before the fetch ships rather
than after.

The strip is also issued **after** the grid renders, not beside it: the cards
are the page and the strip is a footnote about the server. A beat late is
invisible; blocking the grid on it would not be.

### Stage 4 — record the choice, then retire the default

**Deep-dived 2026-09-13 against a running server, and it came back inverted.**
The stage was one bullet ("`defaultInstalled` → `false`") plus a copy rewrite.
The bullet turned out to sit on top of a live bug, and the copy rewrite turned
out to have shipped already, in Stage 3b. What follows replaces both.

#### 4.1 The finding: the chooser does not record the choice

Stage 2's `connect()` makes three calls — create the key, bind it, probe. Run
verbatim against a fresh instance, with a built-in provider instead of the
bundled Ollama every browser test uses:

```
openai      ai-keys -> 200    bind -> 200    resolve -> NULL
            feed: degraded — "OpenAI is removed on the Plugins page"
anthropic   ai-keys -> 200    bind -> 200    resolve -> anthropic/claude-haiku-4-5
```

The chooser's keyed population is `anthropic, openai, gemini, glm, openrouter`.
**One of the five completes**, and only because of the `defaultInstalled` line
this stage exists to delete.

The cause is not in the welcome screen. Every rung of resolution is gated on
the provider's plugin being installed
([capability-resolve.js:61](../server/capability-resolve.js#L61), inside
`disqualified`, which the stored rung, the board rung and the env rung all
walk) — and **registering a key does not install anything**.
[POST /api/admin/ai-keys](../server/server.js#L2298) calls `createAiKey` and
nothing else. The two are separate acts, deliberately:
[plugins.test.js:400](../test/plugins.test.js#L400) pins it in so many words —

> openai is available by default — a default key on a not-installed provider
> resolves to nothing until it's added.

That is a defensible rule for the Plugins page, where installing is a visible
toggle. The welcome screen has no such toggle, and never asks the question.

What the reader gets is worse than a failure. `connect()`'s third call returns:

> **No default API key configured**

— two green dots in, on the step after they pasted a key. It is wrong, and it
blames them for the thing they just did.

**Why no test caught it.** [browser/welcome.test.js](../test/browser/welcome.test.js)
drives Ollama, and a *bundled* plugin is installed at tile-click (2.3), for an
unrelated reason — the card cannot learn whether its field is a key or a URL
until the descriptor loads. Bundled providers work by side effect of a decision
made about something else. Built-ins had no such accident.

#### 4.2 Which makes the original bullet an inversion

Flipping `defaultInstalled` → `false` with 4.1 unfixed moves Anthropic into the
broken set: **one built-in works** becomes **none do**, and the only providers
that can complete first-run are the bundled ones. The order is forced — the
recording lands first, and the flip becomes safe rather than fatal.

#### 4.3 The fix is the rule this stage is already invoking

*No implied choices in UI* asks that a selection be an explicit act in the
chooser. Picking a provider and pressing Connect **is** that act. It simply is
not written down. So:

```js
await api("PATCH", `/api/admin/plugins/${picked.id}`, { installed: true });
```

in `connect()`, before the bind. Unconditional — no branch on `p.bundled`:

- `picked` is always the real def by then. A built-in arrives as itself; a
  bundled one arrives as the **install reply** (`showCard(plugin)` in `pick()`),
  so its id is the namespaced `ai:community.ollama`, not the catalog id the
  tile wore.
- the route is idempotent for the already-installed case (measured: second
  `PATCH` → 200), so the bundled path pays one no-op call rather than a
  condition someone has to keep true.

It is one call, and it is not a workaround for the gate — it is the gate
getting the answer it was always asking for.

#### 4.4 Then the default goes, conditioned on the operator's own config

```js
defaultInstalled: p.name === "anthropic" && !!process.env.ANTHROPIC_API_KEY,
```

Not a flat `false`, because the env rung is install-gated like every other
([capabilities.js:123](../server/capabilities.js#L123) says so in its own
comment) and `ANTHROPIC_API_KEY` is a shipped, documented path —
[.env.example:14](../.env.example#L14). A flat `false` means an operator who
puts a key in their compose file gets an instance where it does nothing, with
the Capabilities tab explaining that they removed a plugin they never saw.

The conditioned form is not the app picking a vendor. It is the app noticing
that **the operator already picked one**, in the one place a self-hosted app
should always look. A fresh instance with no env var gets the clean slate this
stage is for; the comment says exactly that, replacing the current claim that
tagging "must work out of the box" — which it never did, since the row has no
key.

#### 4.5 …and a migration, for the instances the env doesn't cover

An admin who added an Anthropic key **through the UI** never had reason to
touch the install toggle: the card was pre-added. Their row is absent or
`installed IS NULL`, which falls to the default. Flip it and tagging stops on
an instance that was working — silently, on upgrade.

`server/migrations/0047_anthropic_explicit_install.sql`: write an explicit
`installed = true` for `ai:anthropic` **only where an `ai_keys` row for
anthropic exists**. Narrow on purpose — that is precisely the set where the
default is load-bearing. A fresh instance has no such row and keeps its clean
slate; an instance that has the card and never used it loses a pre-added vendor
it never chose, which is the point of the stage.

#### 4.6 The empty state — **deleted, not deferred**

This stage used to rewrite the admin sentence at
[boards.js](../public/boards.js) when tagging is blocked:

> No boards yet. Nothing gets tagged until you **connect a model**.

It named its reader precisely: the **post-skip** admin, since a fresh admin
with zero boards is redirected away (1.5) and never sees the screen.

**Stage 3b now serves that reader, on that screen.** The setup strip is a
sibling element immediately above `<main id="boards-grid">`, and for this exact
person both conditions are true at once and always — `presentTrouble` returns a
clause (tagging is blocked) and `boards.length === 0`. So the page would say
the same fact twice, ~20px apart, once in amber with a door and once in grey
without one. The grey one would be the weaker copy of the two.

The note stays exactly as it is. The bullet was written before 3b existed; 3b
is the better answer to the same finding (§4 of *The five findings*), because
it also reaches the admin whose key died on an instance with fifty boards —
whom an empty-state sentence reaches never.

#### 4.7 Tests

- **the built-in connect path**, which nothing covers today: create a key for a
  keyed built-in, bind, and assert tagging **resolves**. This is the regression
  test for 4.1 and it fails on today's tree.
- [plugins.test.js:44](../test/plugins.test.js#L44) pins `["ai:anthropic"]` as
  the one `defaultInstalled` id; it becomes env-conditioned with 4.4 and must
  set/clear the var rather than assert a constant.
- [plugins.test.js:400](../test/plugins.test.js#L400) keeps its rule (a key
  alone still installs nothing) — 4.3 changes the **chooser**, not the
  resolver. Its `finally` restores `ai:anthropic` to installed and will need to
  match the new default.
- the migration: an instance with an anthropic key keeps tagging across it; one
  without gets no row written.
- no new boards-empty test. The third boot this section used to promise is
  4.6's deletion.

#### 4.8 What building it decided — SHIPPED 2026-09-13

Suite 1519 → **1523**, eslint clean. Live-verified on a fresh instance: no AI
provider installed at all (`installed AI providers: []`), the strip reading
`Tagging — unavailable · 1 item waiting`, and the connect sequence landing
`state=active running=openai/gpt-5-mini` with the strip going silent.

The regression pin works: with the one line of 4.3 commented out, the new
browser test fails with the exact sentence the deep dive diagnosed —
`tagging has to actually resolve — got degraded: OpenAI is removed on the
Plugins page`.

**Retiring the default changed a STATE, and two places had the old list
hardcoded.** This is the finding, and it was not in the plan.

With nothing installed that advertises tagging, a fresh instance no longer
reads `blocked` — it reads **`unavailable`**. The state machine was right all
along ([capability-status.js](../server/capability-status.js): *"nothing
installed advertises it"*); it simply had no way to say so for `tag` before,
because one vendor was always pre-added. `blocked` means *there is installed
supply waiting on a credential*, and that had stopped being true.

Two readers had `blocked || degraded` written out as a pair:

- **`presentTrouble`** — so the boards strip returned `null` and **said
  nothing**, for precisely the reader Stage 3b exists for. Shipping 4.4 without
  this would have silently deleted the surface built one stage earlier.
- **`demand`** ([capability-status.js](../server/capability-status.js)) — so
  the `N items waiting` count disappeared at the one moment it is most worth
  showing: a fresh instance whose queue is filling with nothing installed to
  drain it.

Both are now the same three states, and both say why in a comment that names
the other. The asymmetry with `off` is deliberate and stated: a capability
someone turned off is a decision, not an outage.

**Only one of the two was caught by a test**, and the difference is worth
keeping. `demand` crashed loudly (`Cannot read properties of null (reading
'waiting')`) because a real payload flowed through a real assertion.
`presentTrouble` had **no test at all** — the strip is pinned in
[boards-empty.test.js](../test/boards-empty.test.js) against a hand-written
`TAG` fixture that says `state: "blocked"`, so it would have stayed green
forever while the real surface went blank. A fixture can only ever assert the
world its author already believed in. Fixed twice over: the fixture now carries
the state its own scenario actually produces (`unavailable`), and
`presentTrouble` gained direct tests in
[capability-present.test.js](../test/capability-present.test.js) covering all
five states, the item-count clause, and the health-streak case.

**The copy moved with the state.** The strip on a fresh instance now reads
*"Tagging — unavailable"* rather than *"needs a key"*. That is better, not just
different: you do not need a key, you need to pick a provider first, and the
key comes after. The word is `presentChip`'s either way — no sentence was
authored to accommodate this.

**Three tests were relying on the default without saying so.** Each now states
what it needs:

- [welcome.test.js](../test/welcome.test.js)'s *"stops the moment tagging
  resolves"* created an anthropic key and expected `setup_pending` to go false.
  It now installs the provider too — the line that was invisible while the gate
  happened to be open for one vendor, and exactly the pair the chooser performs.
- [providers.test.js](../test/providers.test.js) pinned the fresh install list
  as `["anthropic", "local", "localDetector", "whisper"]`. It is now the three
  on-device engines and nothing else, which is the whole change in one
  assertion.
- [plugins.test.js](../test/plugins.test.js)'s tier table had a third tier that
  existed only for anthropic. Two tiers now: core, and available.

**The memo is the one sharp edge**, and it is test-only. `defaultInstalled`
reads `process.env` inside `aiDefs()`, which `pluginDefs()` memoizes — correct
in production, where the environment is fixed long before anything reads it,
and stale in the four tests that MOVE `ANTHROPIC_API_KEY` mid-run. Those call
`resetDefs()`, which is exported and already exists for the plugin loader. The
alternative — making `defaultInstalled` a function — would have put a
non-serializable value on a def that ships to the client, to fix a problem no
running server has.

### Stage 5 — *(retired)*

This stage used to be "write an Ollama descriptor". Finding 3 above records why
it is gone: the descriptor exists, so the work it named is really the bundled
catalog in **Stage 2b**, which is core rather than optional. Ollama is in the
chooser on day one.

## Tests

- **`test/welcome.test.js`** (server) — the `setupPending` truth table, the
  member-omits-the-field rule and the skip route's guard. Spelled out in
  **Stage 1.6**; not repeated here.
- **`test/browser/welcome.test.js`** — **written instead of the dom-stub
  `welcome-page.test.js` this plan first listed, and that swap is the finding.**
  The page's middle step changes what the next step renders: the card's field is
  "Server URL" or "API key" depending on a descriptor that does not exist until
  a click has already happened. A stub test of the render function has to be
  handed the very answer the step produces, so it can only assert that the
  renderer works — never that the step ran. Seven cases, ~6 s: the redirect in,
  the ordering rule, install-then-field, a failed connect, a successful one, the
  disclosure, and skip + the member bounce.
- **`test/capability-present.test.js`** — unchanged. If this plan needs an
  edit there, the welcome screen has grown capability knowledge and the design
  is wrong.
- **`test/boards-empty.test.js`** — done, and it is the only file 3b touches.
  The third boot this section used to promise for Stage 4 is gone with the
  empty-state rewrite (4.6): 3b's strip already tells that reader, so there is
  no second sentence left to pin.
- **`test/setup.test.js`** — untouched; the account door and the welcome gate
  are separate questions and should stay separately pinned.
- **`test/plugins.test.js`** — three changes, from opposite stages. The bundled
  catalog must list `examples/plugins/*` as available-and-not-installed, and
  **`getPluginDef` must NOT resolve a bundled id** — that one is the guard for
  2b's central rule and the only thing standing between a bundled row and a
  `PATCH { installed: true }` that half-installs it. Both 2b, both written. Then
  `defaultInstalled` for anthropic becomes env-conditioned rather than gone
  (4.4), which makes its two assertions — the pin at :44 and the `finally` at
  :400 — set the var rather than assert a constant.
- **`test/plugin-install.test.js`** (2b, written) — the listed path installs,
  the row leaves the bundled list and comes back on uninstall, and every listing
  hint matches the descriptor it stands in for.
- **`test/provides.test.js`** (2b, one word) — its "no legacy triple" loop
  dereferenced `p.ai` on every AI row and met the first row that has none. The
  first reader to meet the absence, and it will not be the last: this is the
  cost of the manifest-only row, paid where it is cheap.
- **A boot test** ([test/browser/boot.test.js](../test/browser/boot.test.js)) —
  an admin with `setup_pending` lands on `/welcome`, a member does not, and
  `/welcome` itself does not bounce an admin (the redirect-loop guard).
- **A browser test for the connect sequence itself**
  ([test/browser/](../test/browser/), the
  [upload.test.js](../test/browser/upload.test.js) pattern). The dom-stub file
  above is the right home for "what does the page say"; it is the wrong home
  for tile → install → field → Connect → four calls → the board button
  appearing, because a stub cannot fail the way that chain fails. That file's
  own header is the argument: the picker bug it was written for lived entirely
  in a chain the unit tests never ran, and failed silently when it broke.
  Stage 2 is a longer chain with a step whose whole job is to change what the
  next step renders.

## Sequencing

Two stages touch the server — **1** (the predicate, the field, the skip route)
and **2b** (the bundled catalog reader). The rest is client.

**2b can land first and alone** — and **2 should not land without it.** The
Add-plugin modal is a wearer on its own, and today a bundled example is
strictly harder to install than a random GitHub repo, worth fixing whether or
not a welcome screen ever exists. The reverse is the new part: with no bundled
catalog the chooser is five keyed vendors (§2.2, measured), so the screen's
ordering rule and its one non-keyed exception both point at nothing. Ship 2b
first, then 2.

**3 is useful even if 2 slips**: a "Setup" menu row pointing at `#capabilities`
beats no way back at all.

**4 depends on 2, and is now ordered internally.** Do not retire the pre-added
anthropic default before the chooser exists, or a fresh instance gets a Plugins
page with no AI providers on it at all. It also depends on 2b for the same
reason from the other side: with the bundled catalog in place, "no providers
pre-added" still leaves Ollama visible and installable.

What the deep dive added is an order *within* 4: **4.3 lands before 4.4.**
Until the chooser records its pick as an install, `defaultInstalled` is the
only thing keeping any built-in provider working, and retiring it first takes
first-run from "one of five works" to "none do". 4.3 was also worth shipping on
its own — it fixed four broken providers and depended on nothing else in the
stage.

Shipped in that order, and the order held: 4.3 alone turns the suite green on
the new browser test, and 4.4 is what surfaced the state change in 4.8.

**1 and 2 ship together or not at all** — a redirect to a page that does not
exist, or a page nothing routes to, are each worse than today.

## Non-goals / open questions

- **No member-facing capability view.** Still deferred, as in
  [capabilities-plan.md](capabilities-plan.md). A member's answer to "why
  aren't my items tagged" is an admin.
- **Plugins, connectors, media handlers, sources, members stay out of the
  welcome screen.** None of them blocks anything — adding CoinGecko is
  something you do when you want crypto, not on day one. One read-only line
  pointing at Admin → Plugins, and stop. The welcome screen's job is **one
  decision**; the browse catalog already exists and is good.
- **No import/export of a setup.** Out of scope.
- **Not this plan, but adjacent and real: `/api/me` is fetched eight times per
  admin page load** (Stage 1.1), each a `no-store` round trip.
  `renderPluginSurfaces` already exists to collapse two of them. Its own
  cleanup.
- **Not this plan: the handoff after "Make your first board".** The welcome
  screen ends by opening the existing board modal, and that is where a first
  admin actually has to write a taxonomy — the product's main feature, on a
  large surface whose headline is not "write your tags". If first-run stalls
  anywhere after this ships, it stalls there. **2026-09-13: half-taken** —
  the button lands on the boards page and its placeholder card opens the
  modal, so the seam for an abstracted create flow exists (`createBoard`),
  but the modal is still what opens.
- **Closed: re-gating.** The zero-boards rung (Stage 1.2) settles it — new
  gets the redirect, broken gets the strip, and no second stored bit is
  needed. It also happens to be the thing that keeps `/api/me` cheap.
- **Closed: the menu row does not clear `welcome_skipped`.** With the
  zero-boards rung in place the question mostly dissolves — an admin who
  skipped and then made a board would never be redirected again regardless. So
  clearing it would buy one narrow case (skipped, still boardless, visited
  Setup, walked away) at the cost of a flag that un-sets itself by navigation.
  Skip stays skipped; the strip and the menu row are the recurring surfaces.
- **Open: does the bundled catalog auto-install anything?** No. Listing is the
  fix; installing without being asked is the `defaultInstalled` mistake in a
  new costume. A bundled plugin appears as available and installs when picked.
- **Out of scope, deliberately: no strip in the gallery.** An admin who works
  inside one board all day never opens the boards page, so 3b never reaches
  them — [toolbar.js](../public/toolbar.js) is the other candidate surface.
  Left out because the gallery's header is already the densest row in the app
  and because the Setup menu row IS in the gallery (3a puts it in all three
  menus at once), so the door is there even where the sign isn't. Named here
  rather than left to be discovered as an accident.
