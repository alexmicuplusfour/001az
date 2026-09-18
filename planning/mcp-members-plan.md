# MCP per member — the token names a person (2026-09-18)

> Companion to [mcp-server-plan.md](mcp-server-plan.md) (the arc),
> [mcp-stage-1.md](mcp-stage-1.md) · [2](mcp-stage-2.md) · [3](mcp-stage-3.md) ·
> [4](mcp-stage-4.md) (the four shipped stages) and
> [mcp-review.md](mcp-review.md) (the review pass; §1–3 fixed in 7fd9b48).
>
> **Status: ALL THREE STAGES BUILT, uncommitted.** Suite 1730 green (browser
> included). §0 is the structural finding that decides the size of this —
> measured by reading the tool layer back, not assumed. §1 is a shipping bug
> this arc dissolves rather than patches, reproduced against the test harness.
> §10.8, §10.16 and §10.23 record what each build changed about its own spec.
>
> Stage 1 of the arc wrote: *"Per-connection identity is the `api_tokens` table,
> which is a later problem if one token ever stops being enough."* This is that
> problem, arriving for a better reason than expected: not because one token ran
> out, but because one token was never honest about who was asking.

## The one-sentence answer

The tools already take a user and already enforce that user's board access on
every call — **the only thing that makes MCP admin-shaped is one line resolving
the acting user from an environment variable** — so this arc is a token table, a
different line, and the two pages that let a person hold their own token.

---

## 0 — What the code already does

Read the tool layer back looking for admin assumptions. There are none.

| what | where | already per-user |
|---|---|---|
| which boards a caller may see | `visibleBoards(db, user)` | `canAccessBoard` per board, per call — no cache, so a membership change lands immediately |
| a board named by id | `resolveBoard` | resolves out of that same visible list, so a board is unreachable BY ID, not merely unlisted |
| crates a caller may search | `resolveCrate` → `listCrates(db, user.id, …)` | yours plus anyone's public ones |
| crates a caller may write | `save_to_crate` → `createCrate(db, user.id, …)` | and `addCrateItems` gates on `user_id` |
| "does this board show any crates" | `hasCrates(db, userId, boardId)` | |

Every one of those takes `ctx.user`. The whole feature is parameterised on a
person already; it has simply never been handed anyone but the admin:

```js
const actingUser = () => getUserByEmail(db, adminEmail);   // mcp.js
```

**That is the arc.** Not an authorisation model — one that works is already
running in production — but a way for the request to say whose it is.

### 0.1 — Proved, not read

The tool layer takes a context bag and tests with no server, so the claim above
is checkable today: build the ctx `mcp.js` builds, swap the user, call the
handlers. Two non-admin members, one board each, nothing else changed.

```
alice sees                 Alice board
bob sees                   Bob board
admin sees                 Alice board, Bob board

alice describe_board(bob's)          isError=true   No board "…" is available to you.
alice search_board(bob's)            isError=true   No board "…" is available to you.
alice get_items(bob's card)          isError=true   No board "…" is available to you.
alice save_to_crate(bob's)           isError=true   No board "…" is available to you.
alice get_items(bob's id, HER board) isError=true   No item on "Alice board" has id …
alice search_board(hers)             isError=false  ### 1 of 1 · id 500001
alice save_to_crate(hers)            isError=false  Saved 1 card to "Alice picks"…

crates on b1 visible to alice: [["Alice picks", owned]]
crates on b1 visible to bob:   []
```

And the ceiling composes with membership the way §2 claims — `mcp_boards` set to
Bob's board alone:

```
alice list_boards   "You have access to no boards on this instance."
admin list_boards   Bob board
```

So every refusal is already the right refusal, by id as well as by omission, and
a crate written by a member is that member's. Nothing in this arc has to teach
the tools anything.

### 0.2 — Board role does not matter, and should not

`canAccessBoard` asks whether there is a `board_members` row; `canManageBoard`
asks whether its role is `admin`, and the MCP never calls it. Promoting a member
to board-admin changes nothing about what the tools give them:

```
bob as board-admin of b1   Alice board, Bob board
bob as plain member of b1  Alice board, Bob board
```

That is right and worth stating so nobody "fixes" it later: everything MCP does
is reading, plus adding to a crate that belongs to the caller. None of it is
board management, so none of it is the board-admin's to gate.

### 0.3 — Two dead bindings, while we are in here

`getBoard` is imported in `mcp-tools.js` and used nowhere — `resolveBoard` stopped
calling it when it started taking the row out of `visibleBoards`, and only the
comment explaining that still names it. `rank()` destructures `user` from its
ctx and never reads it. Neither is a bug; both are stage 1 cleanup, and both are
invisible to `npm run lint` today.

Two consequences worth stating before the design, because they remove work
people would otherwise plan for:

- **`mcp_boards` needs no new meaning.** `visibleBoards` runs the scope gate and
  the membership gate in that order and its comment already says why: *"it can
  never widen access, because the membership check runs regardless."* It was
  written for the case where the caller is not the admin.
- **A new table travels in backups with no edit.** `server/backup.js` discovers
  tables from `pg_class` and topologically sorts them by their real FK
  constraints; nothing names tables by hand.

---

## 1 — The bug this dissolves

`adminEmail` is `process.env.ADMIN_EMAIL`. server.js says what that variable is
worth today, in its own words:

> *"…that account IS the admin — no env preconfiguration (ADMIN_EMAIL stays as
> optional automation)."*

A fresh install makes its admin through the login page's first-run setup.
Nothing writes `ADMIN_EMAIL`. `seedAdmin("")` returns early on the falsy email,
`getUserByEmail(db, "")` matches no row, and every tool call answers:

```
list_boards isError=true
  "This instance has no admin account configured, so no board is reachable."
```

Reproduced against the harness by pointing `ADMIN_EMAIL` at a user who is not
there — the same `getUserByEmail → null` branch an empty string takes.

What makes it nasty is how well everything else works: `initialize` answers,
`tools/list` lists five tools, the MCP tab renders a valid `claude mcp add`
command and says *"Acts as the admin account"*. Only the tools fail, and they
fail with a sentence about configuration that names no variable.

**This arc removes the variable from the path rather than fixing the lookup.**
A token knows its owner because a column says so.

---

## 2 — Where each setting lives

| setting | today | after | why |
|---|---|---|---|
| `mcp_enabled` | instance | **admin** | the feature switch for the instance |
| `mcp_origins` | instance | **admin** | a security setting about browsers, not a preference |
| `mcp_write` | instance | **admin** | one switch — see §8.2 |
| `mcp_boards` | instance | **admin** | becomes a CEILING: which boards agents may reach at all, intersected with each member's own access |
| `mcp_asset_secret` | instance | **instance** | unchanged; one secret, revoking it kills every outstanding link |
| `mcp_token` | instance | **per member** | the table below |
| `mcp_last_used` | instance | **per token** | "is anything connected" is a question about a client, and now there are several |

---

## 3 — The table

```sql
CREATE TABLE IF NOT EXISTS mcp_tokens (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token        TEXT   NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  last_used_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id);
```

`mcp_tokens`, not stage 1's guessed `api_tokens`: this grants exactly the MCP
surface as one person, and a REST token would carry different scopes. Naming it
for what it does keeps the day someone wants the other thing from being a
migration of meaning.

**`user_id` is indexed, not unique.** One token per person is what the UI mints
(§8.3), and that is a property of the page, not of the schema — so "one per
device" later is a UI change rather than a migration. Costs nothing to allow and
cannot be added cheaply afterwards.

**Stored as written, like `mcp_token` is today.** Sessions and invites store a
SHA-256 digest ([migration 0003](../server/migrations/0003_hash_bearer_tokens.js))
and hashing would cost nothing on lookup — you hash what arrives and look that
up. It costs the one thing the tab exists for: a working command, complete,
after the day it was minted. Two things make plaintext the better trade here:

1. Per-member tokens **reduce** blast radius rather than raising it. Today one
   leaked token is admin-level and reaches every board. After this, one leaked
   token reaches one person's boards.
2. The reader it would defend against is someone holding the database, and they
   already hold every board and every other secret in `settings`.

What changes is who sees it on a SCREEN: a member's own page shows their own
token; the admin's connections list never does (§7). That is a statement about
the UI, not about the database, and the plan should not pretend otherwise.

**Carrying the existing token.** A migration moves `settings.mcp_token` into a
row for the first `is_admin` user by `created_at` — not `ADMIN_EMAIL`, for §1's
reason — then deletes the setting along with `mcp_last_used`. Without it, every
client connected today breaks on deploy.

---

## 4 — Identity, and the path that goes away

The gate becomes: enabled → origin → **token names a person** → dispatch.

```js
const caller = await userForToken(db, bearer);   // one indexed query, joins users
if (!caller) return 401;
```

That single query replaces both `getSettings(… mcp_token …)` and
`getUserByEmail`, so the hot path gets shorter, not longer.

It also replaces the `crypto.timingSafeEqual` compare with a b-tree lookup. That
is the same shape `getSessionUser` already uses for every signed-in request in
the app, and against a 192-bit random token a timing signal on an index probe is
not a way in. Consistency with the session path is worth more here than a
compare that guards a value nobody can approach by guessing.

**The tokenless loopback path is deleted.** It existed so `npm run server` on
your own machine needed no paste, and it is the path that produced
[mcp-review.md](mcp-review.md) §2 — a header the caller writes standing in for
an identity. Once tokens name people, "no token" names nobody, and the honest
answer to "who is this?" would have to be "the admin, by convention". The admin
has a token of their own now; pasting it is the same gesture the shortcut saved.

So `isLoopback`, the `LOOPBACK` set and the review's `x-forwarded-for` guard all
go. `test/mcp-transport.test.js`'s "no token means local clients only" becomes
"no token is 401, whatever the request claims to be" — the spoof assertions
added in 7fd9b48 stop being a special case and become the whole rule.

---

## 5 — Rate limiting: two windows, two questions

Stage 1's known-gaps note called this the day it arrives:

> *"Rate limiting is per IP, and under Docker every client arrives from the
> bridge gateway — so all clients share one 60/min bucket. Harmless with one
> instance-wide token (they are all the same caller anyway); it becomes wrong
> the day `api_tokens` lands and callers are distinguishable."*

Under Docker every member NATs to the same bridge address, so left alone this
ships five members sharing one 60/min window, where one person's agent starves
everybody's. Two windows, in this order:

1. **By IP, before the token is read.** The DoS guard, and what keeps an
   unauthenticated flood from costing a database query each.
2. **By user, after it is.** The fair-share window, 60/min each.

Two limiters answering two different questions, which is the same split
[mcp-review.md](mcp-review.md) §3 just made between JSON-RPC and the asset route
— and the same reason: one budget covering two things silently makes one of them
the other's victim.

---

## 6 — The Account page

`public/profile.html` becomes `public/account.html`, and `profile.js` becomes
`account.js`. Renamed, not retitled: the page grows a second tab about something
that is not a profile, and a file called `profile` serving an Account page is
the sort of small lie that is free to write and permanent to read.

Measured scope — smaller than it looks:

- **In the two files:** `<title>`, `<h1>`, the `#profile-ui` id, the `<script
  src>`, the `next=%2Fprofile.html` on the password-change link, the
  `location.replace` bounce. The tab currently labelled **"Account"** becomes
  **"Profile"**, since the page now carries that name.
- **One real caller:** `public/user-menu.js` — its label and href.
- **Comments naming the old file:** `panel.css` (×2), `utils.js` (×2),
  `boards.css`, `scripts/build-frontend.mjs`, `test/browser/boot.test.js`.
- **No build edit.** `build-frontend.mjs` enumerates pages by reading the
  directory, so `account.html` is bundled with no list to update.
- **No test or screenshot churn.** Nothing navigates to the page; every mention
  in `test/` is a comment, and `docs/screens/back/` has no shot of it.

**No redirect from the old path.** Every link to that page is one the app itself
generates and they all change in the same commit. The casualty is a bookmark, on
an instance with a handful of accounts, and a compatibility shim for that is
ceremony with no expiry date.

### The tab switcher

`admin.js` has one — active-class toggling, hash deep-linking, `TAB_NAMES`.
`account.js` has none. It gets extracted to a shared module rather than copied:
the second copy is the one that goes stale, and this repo's standing rule is
reuse over generalise over create.

### What the member's MCP tab says

- The endpoint and **their** command, with copy / show / rotate / clear.
- **Their** reachable boards, read-only — rendered from the same `visibleBoards`
  the tools call, exported rather than restated, so the page cannot claim access
  the tool then refuses.
- Last used, and the tool list (nothing secret in it).
- Whether saving is on, as a sentence rather than a control: it is not theirs to
  move.
- The honest empty states: the admin has MCP switched off; or you are a member
  of no boards, so a token would connect to nothing.

---

## 7 — What the admin keeps, and gains

**Keeps:** the enable switch, allowed origins, the board ceiling, the saving
switch, the tool list.

**Loses:** the token controls, and with them the `actingAs` line and the
"crates appear in the gallery under the admin's account" caveat — crates now
land with the person who asked for them, which is what a crate was always for.

**Gains a connections list:** one row per token — member, created, last used,
revoke. That is the oversight question an admin actually has ("who has an agent
pointed at this instance, and when did it last run?"), and it replaces a
`mcp_last_used` that could only ever answer it for the instance as a whole.

Revoking is deleting the row. The member's own page shows it gone and offers to
mint another; nothing else needs to know.

---

## 8 — Decisions, with their reasons

### 8.1 — The no-token shortcut goes

Decided: delete it. See §4. It saved one paste on a development machine and cost
a security hole; the admin now holds a token like everyone else.

### 8.2 — One saving switch, for the instance

Decided: keep it instance-wide. A crate belongs to whoever made it and
`save_to_crate` only ever adds — `ON CONFLICT DO NOTHING`, never a removal — so
the worst a member's agent can do is clutter that member's own shelf. A
per-member version of this control would be one nobody ever has a reason to
move, and the tools already hide the tool from `tools/list` when it is off.

### 8.3 — One token per person

Decided: the page mints one. A single command with a single rotate button is the
thing the tab exists to hand over, and a list of one row is a worse version of
it. The table allows more (§3) so the day someone wants the laptop and the
office cut off separately, that is a page, not a migration.

### 8.4 — Metering stays out

Decided: out of scope. `usage_meter`'s primary key is `(day, board_id,
capability, provider, model, unit)` — there is nowhere for a person, so a member's
plain-language search bills the board with nothing recording who asked.

Worth doing next rather than never, and worth doing in one pass with the arc's
other open item: `usage_meter.provider` is un-namespaced across the AI and
connector families, which already needs a migration of its own. Two reasons to
rewrite that key, one migration.

---

## 9 — What is NOT in this arc

- **Per-member board ceilings.** The admin ceiling plus membership is two gates
  already; a third would be a rule nobody could predict the result of.
- **Named or multiple tokens per person** (§8.3).
- **Spend per person** (§8.4).
- **Hashed tokens** (§3) — a separate decision, one line of migration if it is
  ever taken.
- **[mcp-review.md](mcp-review.md) §4 and §5**, which are open and unrelated:
  the empty-crate hint, and the crate-name collision between save and search.
  §5 gets *more* likely with several members writing crates on shared boards, so
  it should be fixed before this ships, not as part of it.

---

## 10 — Staging

### Stage 1 — identity

The table (§3), the migration carrying today's token, `userForToken`, the
tokenless path deleted, the two rate windows, and §0.3's two dead bindings. The
admin tab keeps working with its token controls pointed at the admin's own row —
a small edit, not the new page.

**Done when** two members with different board access hold different tokens and
`list_boards` answers each of them with their own boards, and when an instance
with no `ADMIN_EMAIL` serves both of them.

#### 10.1 — The migration is `0051`, and it runs early enough

`initDb(db)` — which is `runMigrations` plus the schedule reconcile — is called
at `server.js:256`. `seedAdmin` follows at 265 and `mountMcp` at 3795, so the
table exists long before anything can ask for a token. `0050_ingest_content_identity`
is the current head, so this is `0051`.

**The carry-over names the first `is_admin` user by `created_at`, not
`ADMIN_EMAIL`** — §1 is the whole reason: the variable is optional automation and
is empty on any instance whose admin came from first-run setup. That choice
belongs in the migration's own comment rather than only here, because this
instance has **two** admin accounts (measured) and the other one is entitled to
wonder where the instance's token went.

It also skips cleanly when there is nothing to do: no `settings.mcp_token` (MCP
was never switched on) or no admin at all (a schema migrated before first-run
setup) and it carries nothing. `mcp_last_used` is deleted alongside the token —
it is a per-token fact now, and a stale instance-wide row that nothing reads is
the kind of thing a later reader mistakes for state.

Restore needs no special handling; see §12, which measured it rather than
guessing.

#### 10.2 — `userForToken`, and what the gate sheds

```sql
SELECT u.*, t.id AS token_id, t.last_used_at
  FROM mcp_tokens t JOIN users u ON u.id = t.user_id
 WHERE t.token = $1
```

`canAccessBoard` reads `is_admin` and `id`, so the whole user row is what the
tools want anyway — this is the same shape `getSessionUser` hands every
cookie-bearing request.

`CONFIG_KEYS` drops `mcp_token` and `mcp_last_used`, going from six settings to
four. **No query regression:** today's gate is `getSettings` + `getUserByEmail`,
two round trips; after, it is `getSettings` + `userForToken`, still two — and the
second one now answers "who is this" and "is the token real" together, where
before it only answered the first.

`touchLastUsed` moves to the token row and keeps its trick: throttled against
the stamp the lookup ALREADY returned, so it costs nothing to check and survives
a restart.

#### 10.3 — The chain, and where the second window goes

`gate()` becomes middleware rather than a function the handler calls, because
the per-user window cannot be keyed until the token has named someone:

```js
app.post("/mcp", limiter, wrap(identify), userLimiter, wrap(handle));
```

`identify` keeps today's order — **404 when disabled first**, then origin, then
the token — and attaches `req.mcpUser`. `userLimiter` is the existing
`rateLimit` with nothing new added to it: it already accepts `key: (req) => …`,
so `key: (req) => "u" + req.mcpUser.id` is the entire change. IP stays FIRST so
an unauthenticated flood still costs no database query.

#### 10.4 — What "enable" and "clear" mean once tokens belong to people

**Enabling still mints — for the admin who enabled it.** Today's code states the
promise: *"switching the feature on mints a token precisely so the normal
install never meets this rule"*, and one click to a working command is the
reason this is a tab and not three environment variables. Strictly, enabling is
an instance act and minting is a personal one; in practice the person switching
it on is the person who wants to connect. So it mints, and it mints something
that belongs to them by name rather than to the instance by convention.

**Clearing stops producing a command.** With the tokenless path gone there is no
"local-only shape" to fall back to — a command with no `Authorization` header
connects to nothing. So clearing returns the pane to its `create token` state,
which is what it now means. `test/browser/mcp-tab.test.js`'s
`assert.doesNotMatch(cmd, /Authorization/, "no token, no header — the local-only
shape")` is a MEANING change, not a wording one, and is the one browser
assertion this stage rewrites.

#### 10.5 — The admin tab, in the interim

Its token controls point at the admin's own row: `paneState` reads it,
rotate replaces it, clear deletes it. That is wiring, not logic — the mint /
rotate / revoke functions written here are the ones stage 2's account routes
call, so nothing about this is thrown away except which route reaches them.

`actingAs` stays for one stage: with the admin the only person holding a token,
it is still true. It goes in stage 2, when it stops being.

#### 10.6 — The harness change is the bulk of the work

Every tool test connects with no bearer today, riding the path this stage
deletes. Counted call sites that would start answering 401:

| file | calls |
|---|---|
| `mcp-transport.test.js` | 30 |
| `mcp-tools.test.js` | 18 |
| `mcp-write.test.js` | 15 |
| `mcp-app.test.js` | 9 |
| `mcp-admin.test.js` | 4 |
| `mcp-asset.test.js` | 2 |

Seventy-eight edits is the wrong answer. `startServer()` mints a token for the
seeded admin and `mcp()` sends it by default: **one change in `helpers.js`,
none at the call sites.**

Two details that decide whether that works:

- `mcp-transport.test.js` tests the gate itself and must send NO header on
  purpose, so the default keys off `token === undefined` — `token: null` goes on
  meaning "send nothing", which is what it means today.
- The default is looked up by `base`, which is unique per server, so files
  running concurrently cannot read each other's token. A module-level variable
  would be the bug this avoids.

Assertions that change rather than move: "no token means local clients only"
becomes "no token is 401, whatever the request claims to be" — the spoofed
`X-Forwarded-For` cases added in 7fd9b48 stop being a special case and become
the whole rule — and `mcp-admin.test.js`'s "clearing the token is the local-only
mode" becomes "clearing the token disconnects".

#### 10.7 — Cleanup carried by this stage

§0.3's two dead bindings: the unused `getBoard` import, and `rank()`'s
destructured `user`. Both sit in the file this stage is already opening, and
neither is visible to `npm run lint`.

#### 10.8 — Built, and the two things the build changed

**The IP window had to grow.** The spec above said "by IP, before the token is
read" and left both windows at 60/min. Writing the fairness test is what caught
it: every authenticated request is counted by IP TOO, and under Docker every
member arrives from the same bridge address — so an IP window of 60 caps the
whole instance at 60/min however many people hold tokens, which is precisely
the problem the per-user window exists to solve. The IP window is the FLOOD
guard and has to be an order of magnitude larger than the fairness one, so it
is 600/min: room for ten members at full tilt, while an unauthenticated flood
still costs only one indexed lookup before it bites.

**The pane needed copy, not just wiring.** §10.4 called clearing a meaning
change; it is also three sentences. With no tokenless path, a command carrying
no `Authorization` header is an instruction that cannot work — so `command()`
returns a line asking for a token instead of a broken one, the acts-as line
reads *"Yours, acting as …"*, and the clear confirmation stops describing
loopback and says what it now does: your clients stop, nobody else's.

**A harness detail worth keeping.** A test that clears or rotates the admin's
token is disturbing what every other call in its file defaults to, so it puts
the fixture back — `mcpToken(base)` is exported for exactly that. Three tests
needed it (two in `mcp-admin.test.js`, one in `browser/mcp-tab.test.js`) and
each first showed up as a confusing 401 in a test several cases later.

### Stage 2 — the Account page

The rename, the extracted tab switcher, Profile + MCP tabs, and the member
routes (`GET /api/account/mcp`, `POST` to mint or rotate, `DELETE` to clear).

**Done when** a non-admin member can sign in, open Account → MCP, copy a
command, connect a client and search exactly the boards they are a member of —
with no admin involvement beyond the feature being switched on.

#### 10.9 — The rename, re-measured

Eleven references, and smaller than that sounds: **five are comments**
(`panel.css` ×2, `utils.js` ×2, `scripts/build-frontend.mjs`), three are inside
the two files being renamed, one is `panel.css`'s header line. **One real
caller: `public/user-menu.js`.**

`public/profile.html` → `account.html`, `public/profile.js` → `account.js`.
Inside them: `<title>`, `<h1>`, the `#profile-ui` id, the `<script src>`, the
`next=%2Fprofile.html` on the password-change link, the `location.replace`
bounce — and the tab currently labelled **"Account"** becomes **"Profile"**,
since the page now carries that name.

No build edit (`build-frontend.mjs` enumerates pages by reading the directory),
no test navigates there, and `docs/screens/` has no shot of it. No redirect from
the old path: every link to it is one the app generates, and they all change in
the same commit.

#### 10.10 — Two panes, two shared blocks

| block | admin tab | member tab |
|---|---|---|
| Connection — command, copy, show, rotate, clear | own token | own token — **identical** |
| Tools list | served | served — **identical** |
| Enable switch | writes | not theirs |
| Boards | editable ceiling chip | read-only list of theirs |
| Saving switch | writes | a sentence |
| Allowed origins | yes | no |

So this is not "build a member pane", it is **two panes sharing two
components** — which is the reuse rule this repo already states: never a second
copy of a component's CSS or JS.

`admin-mcp.js` cannot be reused as it stands. It does
`const content = document.getElementById("mcp-content")` at module scope and
looks up six more ids in `wire()`, so it is welded to the admin page's DOM. The
shared part takes a container element and its callbacks; it looks nothing up.

The CSS splits along the same line. The `.mcp-*` rules live inline in
`admin.html`:

- **shared** — `.mcp-cmd`, `.mcp-cmd-actions`, `.mcp-tools`, `.mcp-group`,
  `.mcp-t`, `.section .mcp-after-list`
- **admin-only** — `.mcp-access`, `.mcp-row`, `.mcp-adv`, `.panel .section + #mcp-body`

The shared half moves to a stylesheet both pages load; promoting a
component-scoped style when a second surface adopts it is the standing rule.

#### 10.11 — The tab switcher, extracted with its hooks

`admin.js` has one and `account.js` needs one, so it moves — but three things in
it are the admin page's, not tabs-in-general: `setLogsActive(name === "logs")`,
render-on-select for Storage, and "the default tab drops its hash" (`members`
normalises to the bare path). The extraction is therefore
`mountTabs({ names, defaultTab, onSelect })`, with admin passing those in.
Lifting the function verbatim would carry a logs stream into a page that has no
logs.

#### 10.12 — The routes, including one that is overdue

`PATCH /api/admin/mcp` currently accepts `token: null`, and
`POST /api/admin/mcp/rotate` mints — both **personal acts behind
`requireAdmin`**. That was right in stage 1, when the admin tab was the only
surface; it is the thing stage 2 exists to correct.

| route | who | what |
|---|---|---|
| `GET /api/account/mcp` | `requireAuth` | endpoint, my token, my last used, my boards, the tool list, whether the feature and saving are on |
| `POST /api/account/mcp/token` | `requireAuth` | mint, or rotate over the top |
| `DELETE /api/account/mcp/token` | `requireAuth` | clear |
| `GET`/`PATCH /api/admin/mcp` | `requireAdmin` | the instance: enabled, origins, board ceiling, saving, tools — and **no token fields at all** |

`req.user.id` is the only id any of the account routes will touch; minting for
someone else is not a thing the shape allows.

The member's board list comes from `visibleBoards` — which means **exporting it**
from `mcp-tools.js`. A second query written for the page could claim access the
tool then refuses, and the page's whole promise is that it cannot.

#### 10.13 — What the member's tab says

The command, their boards read-only, last used, the tool list, and whether
saving is on **as a sentence** — it is not theirs to move. Plus the two honest
empty states: the admin has MCP switched off, or you are a member of no boards
so a token would connect to nothing.

**Rotating fires a blue info toast**, not a longer confirm: *your connected
clients stop working until each is given the new token*. The consequence is
worth stating and the confirm is already carrying its own sentence; a `toast.info`
is what this codebase has for "notable, not an error", and loading it into the
dialog would make the dialog the thing nobody reads.

#### 10.14 — The admin tab after this, and the stage 1 call it reverses

The admin tab keeps the instance and loses the connection block entirely. Their
own token lives where everyone else's does, and a second copy on the admin tab
would be the same thing in two places with two rotate buttons.

**Which un-does §10.4.** Stage 1 decided enabling mints a token for the admin
who enabled it, to keep one click between switching on and a working command
while the tab was the only surface. Once the Account page exists, that mint
hands the admin a token they did not ask for, on a page that no longer shows it
— so it goes, and the Account page's "create token" becomes the only mint. The
one-click promise moves with the command rather than being deleted.

Recorded rather than quietly changed: a decision that was right for one stage
and wrong for the next is the normal case, and the reason to write down why is
so the next reader can tell that from a mistake.

#### 10.15 — Tests

- **A non-admin does the whole thing** — the browser test, and
  `harness.signIn()` already makes exactly that person (member, one board, a
  password). Open `/account.html`, MCP tab, create a token, and the command that
  appears carries it.
- **The Profile tab still works** after the rename — the name form is the page's
  older half and must survive it.
- **Account routes are `requireAuth`, not `requireAdmin`** — a member reaches
  them, and reaches nothing of the admin's.
- **A member's payload names only their boards**, and matches what
  `list_boards` answers on the same token.
- **The admin routes no longer mint or clear** — `token: null` through the PATCH
  does nothing, and the rotate route is gone.
- **Enabling no longer mints** (§10.14), which is the stage 1 test inverted.

#### 10.16 — Built, and what the build changed

**The admin tab's Connection section did not vanish, it became a pointer.**
§10.14 said the block goes; deleting it outright would have left an admin who
just switched the feature on with nowhere obvious to go. It is now one sentence
linking `/account.html#mcp` — the heading stays so the shape of the pane is
unchanged, and the person most likely to want a token next is told where it is.

**`mcp.css` carries one rule that is not shared.** The read-only `.mcp-boards`
list is the account page's alone, but the account page has no inline component
styles at all and adding a `<style>` block for one rule would be the start of
the split this file exists to avoid. It lives with its neighbours.

**The browser file swapped a test rather than adding one.** Its own header
warns that page loads are what made this suite flake in parallel, so the member
journey took the place of the admin-token test it made obsolete — same count,
and the thing being proved moved with the feature.

**Three test fixtures were coupled to what the old pane rendered**, and said so
only when it moved: `turnOn` waited on `#mcp-cmd` (now `#mcp-write`, which is
genuinely this tab's), the scope test hardcoded "1 of 2 boards" and broke the
moment another test seeded a board (it counts off the chip now), and two
assertions in `welcome.test.js` named the **Profile** row in the user menu. The
last one is the rename's only real reach outside the two files.

### Stage 3 — oversight

The connections list on the admin tab, revocation, and the admin pane shedding
what moved.

**Done when** an admin can see every connected client, revoke one, and watch
that member's next call answer 401.

#### 10.17 — Half of this shipped in stage 2

"The admin pane shedding what moved" is done. §10.16's pointer IS the shed:
`admin-mcp.js` carries no command, no rotate and no `actingAs`, and
`mcp-admin.test.js` already pins all three as `undefined` on that payload.

So this stage is a LIST and a DELETE — smaller than the sentence above implies,
and worth saying before anyone plans for the rest of it.

#### 10.18 — The list rides in `adminState`, not a route of its own

`mcp.js` states the rule this pane lives by: ONE payload for all three routes,
because the pane re-renders from whatever a write ANSWERS. A separate
`/connections` route means every `save()` repaint either drops the table or pays
a second fetch, and revoke would need a refresh path of its own. Folded in,
revoke answers `adminState()` exactly as PATCH does and the pane redraws by the
road it already travels. Cost: a third query in a `Promise.all` running two.

```sql
SELECT t.id, t.created_at, t.last_used_at, u.email, u.name, u.is_admin
  FROM mcp_tokens t JOIN users u ON u.id = t.user_id
 ORDER BY t.last_used_at DESC NULLS LAST, t.created_at DESC
```

**Activity order, not roster order.** `listUsers` sorts `is_admin DESC,
created_at ASC` because it is a roster; this answers "what is actually running",
so the most recently used leads and the never-used sinks.

**No token, not even masked.** §3 promised the admin's list never shows one, and
a masked prefix would be a correlation handle with nothing to correlate against
— no log line carries a token. That is an ASSERTION rather than a comment: the
serialised payload must not contain the token string.

**No board column.** It would be `visibleBoards`' N+1 (§12) multiplied by every
member, to re-answer a question the Members tab already answers.

#### 10.19 — Revoke names a row, not a person

`setMcpToken(db, userId, null)` is the account page's act — *my* token is now
nothing. The admin's act is *this row goes*, which is a second function:

```js
export async function deleteMcpToken(db, id) { /* … WHERE id=$1 */ }
```

§3 left `user_id` non-unique on purpose, so a per-user delete would take out a
second device nobody named; and the list is keyed by token id, so reaching for
the owner's id from a row the reader picked is an indirection that is only
accidentally correct today.

`DELETE /api/admin/mcp/connections/:id`, `requireAdmin`, answering `adminState()`.

**An id already gone is 200 with fresh state, not 404.** Two admins with the tab
open is the normal case and the second one got what they asked for; a red toast
would be the pane arguing with a reader who is right. `deleteUser` takes the
same shape and checks no rowcount either.

**One guard the house idiom is missing.** `server.js` does
`deleteUser(db, Number(req.params.id))` with no NaN check, and measured against
the live database that is a 500 rather than a 404:

```
NaN param -> invalid input syntax for type bigint: "NaN"
```

One line here (`Number.isFinite`); the neighbour is worth the same the day
somebody is in that file.

#### 10.20 — The pane, with no new CSS

Every cell already has a name in `panel.css` — `table`, `.name-cell`, `.email`,
`.badge`, `.muted`, `.row-actions`, `button.danger` — and `admin-members.js`
builds an identical row shape. Nothing goes in `mcp.css`: the account page does
not render this, so it is not a shared component, and the standing rule promotes
a style when a SECOND surface adopts it, not in anticipation of one.

Columns: member (name, email, the `admin` badge), created, last used, revoke.
Created is a date, like Members' last-login cell; last used is `relTime`,
because the question here is "is anything running" and "3m ago" answers it where
a date does not.

**The Connection pointer becomes this section's `.sub`.** §10.16 left a heading
carrying one sentence; this gives that heading its body. Two adjacent sections
saying neighbouring things would be worse than what stage 2 left.

**The list sits inside `#mcp-body`**, so it is hidden while MCP is off — honest
rather than incidental: `identify` answers 404 before it ever reads a token, so
every row in that table is inert while the switch is off.

#### 10.21 — The log line names nobody

`mcp search_board 42ms · board · crate · "intent"` was complete while every call
was the same caller. It is not any more: the connections list says *Bob's agent
ran 3m ago* and the line one layer down cannot say which of them was Bob.

`const user = req.mcpUser` is already in scope where that line is written, so
this is `· ${user.email}` and the Logs tab is admin-only. The same oversight
question the list answers, one layer down, for one token.

#### 10.22 — Tests

Node, in `mcp-admin.test.js` — the instance's half:

- one row per token, carrying member / created / last used, and **no token
  string anywhere in the payload**
- **revoke, and that member's next call is 401 while a second member's still
  answers** — the "done when" above, verbatim
- the revoke route is 403 for a member
- an id already gone is a no-op answering fresh state; a junk id is not a 500
- deleting a member takes their connection with it (the FK cascade), so the list
  cannot show a ghost

Browser: folded into the existing admin-tab test, **with no extra page load** —
that file's header is loud about why. It revokes a BURNER member's row rather
than the admin's: §10.8 recorded three tests that broke by disturbing the
harness default, and revoking somebody else is the truer admin act anyway.

#### 10.23 — Built, and what the build changed

**The confirm is worded about the CONNECTION, not its owner.** The obvious
sentence — *"Revoke Bob's token? Their clients stop working"* — is false on the
one row the admin is most likely to click first, which is their own. Naming the
token by its owner's email and then saying *any client using it* is true of every
row, and it means the pane never has to know which row belongs to the reader.
That saves a `/api/me` lookup threaded down into `paint()` for one pronoun.

**The no-token promise is pinned in TWO positions, not one.** §10.22 asked for it
on the payload; the browser test asserts it on the rendered page as well. Same
argument `mcp-admin.test.js` already makes about the tool list — one of them
agreeing proves only that one of them was filtered, and a masked-token
"improvement" would sail past a payload-only check.

**Found and left alone:** `test/browser/mcp-tab.test.js`'s header says *"THREE
tests, not one per behaviour"* and there are five. Stale before this arc — the
committed file has five too — so it is not this stage's to rewrite, but the
paragraph it heads is real advice about why that file bundles journeys, and it
is worth a word the next time somebody is in there.

#### 10.24 — The pass after, and the copy it found

**Three `esc` copies, now one.** One predated this arc in `admin-mcp.js`; stages
1-2 added a second to `mcp-pane.js` and a third to `account-mcp.js` — the same
four lines written three times in one afternoon, which is how a shared half ends
up with three private wholes. It lives in `utils.js` beside `relTime`, which had
the identical history.

**The person cell was copied, and the original did not escape.** The connections
row was written against `admin-members.js`'s name cell, which interpolates
`${u.name}` straight into `innerHTML`. A member sets their own name from Account
-> Profile and `PATCH /api/account` stores it verbatim (`trim().slice(0, 80)`),
so that string is member-controlled text meeting an admin page. Measured, not
inferred: a member named `<img src=x onerror=…>` put **one injected element** in
the admin's Members table, with the literal text absent.

The handler did not fire, because `script-src 'self'` carries no
`'unsafe-inline'` — so CSP, and only CSP, stands between that and script
execution. A response header is the wrong last line of defence for an
interpolation that should never have been raw.

Fixed at the depth the bug lives at rather than in the new copy: `memberCell()`
in `utils.js`, escaped, rendered by BOTH tabs. The browser test pins it on the
shared function — the connections list seeds a member named with markup and
asserts the cell shows it rather than parses it — so pinning it twice at two
call sites would be pinning one function twice.

**`save()` and `revoke()` collapse into `apply()`.** Both were the same five
lines: paint what the write answered, and on failure toast and re-read so
nothing on screen claims a write that did not land. Two comments saying that is
one rule stated twice.

**The token assertion moved to `outerHTML`.** A `textContent` check passes a
token parked in a `data-` attribute or a `title`, which is exactly how a
well-meaning "let the admin correlate this against the logs" change would ship.

**Found, NOT fixed — the same shape one privilege up.** `admin-boards.js` renders
a board's name raw into the instance admin's Boards tab, and
`PATCH /api/boards/:id` is `requireBoardManager` — so a BOARD-admin who is not an
instance admin can set that string. Same defect, different table, and fixing it
honestly means auditing that whole tab. Out of this arc, worth its own pass.

---

## 11 — Tests

- **Two members, two tokens, different boards** — the arc's load-bearing test.
  Member A's `list_boards`, `describe_board`, `search_board` and `get_items` all
  refuse a board only member B can see, BY ID, not merely by omission.
- **A revoked token is 401 on the next call**, and the member's other state is
  untouched.
- **A membership change lands without a reconnect** — add a board to a member
  between two calls on one connection and the second call sees it.
- **`save_to_crate` writes to the CALLER's crates**, and a second member with a
  same-named crate on the same board is unaffected (which is also the test that
  will fail loudly if review §5 is still open).
- **No token is 401 whatever the request claims** — the rewritten local-only
  test, spoofed `X-Forwarded-For` included.
- **The migration carries the existing token** — an instance with
  `settings.mcp_token` set keeps answering the same bearer afterwards.
- **No `ADMIN_EMAIL`, working tools** — the §1 regression, pinned.
- **Per-user rate windows are separate** — member A exhausting their window
  leaves member B answering, which is the Docker-shared-bridge case.
- **Browser:** a non-admin reaching Account → MCP sees their own token and no
  admin control; the admin's connections list shows a row and revokes it.

---

## 12 — Risks and open questions

- ~~**Restoring a pre-arc backup** leaves the carry-over unapplied.~~
  **Measured, and a non-problem.** Restore drops the schema, rebuilds it at the
  ARCHIVE's migration id, loads the data, and its `finish` phase calls
  `initDb(db)` — "remaining migrations + live-schedule reconcile". So a pre-arc
  archive rebuilds at ≤0050 without `mcp_tokens`, loads `settings.mcp_token`,
  and then the carry-over migration runs in-process and moves it. A post-arc
  archive rebuilds at a schema that already has the table and already records
  the migration, so it does not re-run. Both directions are clean, and neither
  can conflict — the migration that reads the setting is the one that creates
  the table.
- **A member who is a member of nothing** gets a working token that lists no
  boards. Correct, and `list_boards` says so in words, but the Account tab
  should say it before they paste anything.
- **Signed asset links carry no identity, and no session either.** `/gallery` is
  `requireAuth` behind 64-bit random filenames that only surface through the
  board-ACL'd `/api/items`; a signed `/mcp/asset/…` link needs no cookie at all,
  which is the whole point — an agent has none. So a member's link pasted
  onward hands that one file to a stranger for an hour. Already true of the
  admin's links today and not made worse by this arc, but it stops being a
  single person's decision once several members can mint them.
- **Two admins exist on this instance** (measured: 2 of 4 accounts). Nothing in
  the design assumes one, but the carry-over migration picks the earliest by
  `created_at` and should say so out loud in its own comment, because the other
  admin will wonder where the instance's old token went.
- **`visibleBoards` is N+1** — `listBoards` then a `canAccessBoard` query per
  board. Fine at 14 boards and one caller; worth folding into one query while
  this arc is in the file, since it is about to run for every member on every
  call.
- **Revoking is silent to the member.** Their client starts answering 401 and
  their account page shows `create token`; the 401 body already says where to go.
  Not worth a notification channel, but the reader should not meet it as a
  surprise.
- **Last used is up to 60 s stale** — `touchLastUsed`'s throttle, which exists so
  a busy agent does not write a row per call. It does not affect "did the revoke
  land" (the row is gone), and somebody will still report it.
- **No client identity.** Nothing records a User-Agent, so the connections list
  cannot tell Claude Code from Cursor. Harmless while it is one token per person;
  it is the column that arrives with named tokens (§8.3).
- **Two admins see each other's rows** (measured: 4 accounts, 2 admins). That is
  what oversight means, but it is the first surface on which one admin acts on
  another admin's thing.
