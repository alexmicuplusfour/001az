# MCP stage 2 — detail and export (2026-09-18)

> Companion to [mcp-server-plan.md](mcp-server-plan.md) (the arc) and
> [mcp-stage-1.md](mcp-stage-1.md) (transport, auth, the three read tools, the
> Agents tab — shipped).
>
> **Status: SHIPPED 2026-09-18 in 7eca785.** Suite 1663 (browser included)
> green, exercised against the live `ui` board. §11 records what was built and
> the one defect the live run turned up; §12 the review pass after it.
>
> Two things stage 1's plan promised for this stage are **wrong** and are
> corrected in §1. Everything else was measured against the running container.

## The one-sentence answer

Stage 1 lets an agent *find* things; stage 2 lets it *use* them — one
`get_items` tool for the full record and a legible rendition, plus the one
mechanism stage 1 assumed it would not need: **a way to hand over a file**,
because under Docker the agent and the gallery share no filesystem at all.

---

## 1 — Two corrections to stage 1's plan

### 1.1 — There is no local file path to hand over

Stage 1's plan said `get_items` would return "**the ABSOLUTE LOCAL PATH of the
original** — the easiest possible export path for a coding agent on the same
machine, and something Mobbin cannot offer at any price."

Measured: the gallery is a **named Docker volume**, not a bind mount.

```
$ docker volume inspect 001az_appdata --format '{{.Mountpoint}}'
/var/lib/docker/volumes/001az_appdata/_data
$ ls /var/lib/docker/volumes/001az_appdata/_data
ls: cannot access ...: No such file or directory      # not on the host at all
$ docker exec 001az-app-1 sh -c 'echo $GALLERY_DIR'
/data/gallery                                          # container-only
```

`/data/gallery/x.png` exists inside the container and nowhere else. An agent
handed that path gets something it cannot open. The "self-hosted advantage" was
reasoning about *self-hosted* when the deployment is *containerised* — the same
mistake as stage 1's loopback assumption, found the same way.

**So the export has to be a URL**, which is what Mobbin does — and stage 1's
plan dismissed a signed link on the grounds that "the agent and the gallery
share a filesystem." They do not. Mobbin arrived at the short-link for a
different reason (multi-tenant SaaS) and it turns out to be the only answer
here too.

### 1.2 — The `usage_meter.provider` migration does not belong in this arc

Stage 1's plan bundled it in, reasoning that "MCP is the third caller family,
which is precisely the collision this was always going to hit."

**MCP introduces no provider.** Its only metered call is the query embedding,
which goes through the existing `embed` capability with whatever provider
already serves it. Checked against the live meter:

| capability | providers present |
|---|---|
| `tag` | `anthropic`, `openai`, `gemini`, `` (238 pre-meter rows) |
| `extract` | `openai`, `gemini` |
| `embed` | `local` |
| `transcribe` | `openai`, `whisper` |
| `detect` | `localDetector` |
| `api` | `coingecko`, `financialmodelingprep` |

MCP adds a row under `embed`/`local` — a pair that already exists. The
collision (an AI provider and a connector provider sharing a name, so
`model_prices`' `(provider, model, unit, source, effective_from)` key crosses
families and stamps the wrong rate) is exactly as likely as it was before this
arc.

**It stays a known-open, on its own.** Bundling an unrelated risky migration
into a feature arc is how both get stuck.

---

## 2 — What an agent cannot do after stage 1

Working through an actual session against the `ui` board:

| want | stage 1 | |
|---|---|---|
| "find dark developer dashboards with a table" | ✅ | `search_board` |
| "more like #3" | ✅ | `similar_to`, free |
| "same but light-themed" | ✅ | facets |
| "how many of those are compact" | ✅ | `describe_board` |
| **"show me #3 properly, I can't read the labels"** | ❌ | 600px preview only |
| **"what did the tagger say about #3"** | ❌ | only the one-line description |
| **"put that screenshot in my PR description"** | ❌ | no way to get the file |
| "save these five to a crate" | ❌ | stage 3 |

The first three are one tool. The gap is detail and export, and they belong
together: an agent that wants a bigger image usually wants the file next.

---

## 3 — `get_items`

```jsonc
{
  "name": "get_items",
  "title": "Get items in full",
  "description": "Fetch the complete record for specific items from a search — every facet value, the tagger's per-facet reasoning, and a larger, legible rendering. Also returns a temporary download link for the original file. Ask for several ids in ONE call rather than one call each.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "board": { "type": "string" },
      "ids": { "type": "array", "items": { "type": "integer" }, "minItems": 1, "maxItems": 6,
               "description": "Item ids from a search_board result." },
      "preset": { "type": "string", "enum": ["standard", "high"], "default": "standard",
                  "description": "standard is ~1024px and legible for layout. Use high (~1568px) only when you need to READ small text in the screenshot — it roughly doubles the tokens." }
    },
    "required": ["board", "ids"],
    "additionalProperties": false
  }
}
```

Per item: one text block (every facet value, the per-facet reasoning sentences,
the `fit` sentence, the description, original dimensions and filename, and the
download link), then one image block at the chosen preset.

### 3.1 — The preset default, measured

`aiImageFor` run against three real `ui` originals inside the container, with
an MCP-side clamp of `{ maxEdge: 1568, maxBytes: 400_000 }`:

| original | `thumb` | `standard` (1024) | `high` (1568) | `max` |
|---|---|---|---|---|
| 511 KB | 58 KB / face / 3ms | **22 KB / 78ms** | 46 KB / 70ms | 50 KB (clamped to 1568) |
| 108 KB | 4 KB / face / 2ms | **9 KB / 49ms** | 16 KB / 46ms | 17 KB |
| 64 KB | 8 KB / face / 1ms | **19 KB / 40ms** | 36 KB / 85ms | 39 KB |

Bytes are not the constraint — **tokens are**. At Claude's tokenisation a
1024×590 render is ~805 tokens and a 1568×900 is ~1,880.

- default **`standard`**: 6 items ≈ 4.8k tokens
- `high` when asked: 6 items ≈ 11.3k tokens

So `standard` is the default and `high` is described as "when you need to read
small text", which is the honest distinction — `high` is the *tagger's* default
precisely because it has to read body text, and a "look closer" usually does
not. `max` is not offered: the clamp makes it identical to `high`, and an enum
with two names for one thing teaches a model nothing.

`ids` caps at **6**. `aiImageFor` renders serially through the shared decode
gate (`sharpGate`), so six is ~0.3–0.5s of render.

### 3.2 — One query for the whole page

Stage 1's `search_board` reads descriptions with a targeted query over the
returned ids. `get_items` needs more of the same row — the reasoning bag **and**
`payload.files`, because `aiImageFor` wants the real file entry (its
`meta.width/height` saves a sharp header read per item):

```sql
SELECT entity_ids, tag_reasoning, payload
  FROM items WHERE entity_ids && $1::bigint[]
```

Measured at 1.3ms for 12 entities in stage 1; six is less.

---

## 4 — The asset route: the one new mechanism

```
GET /mcp/asset/:name/:exp/:sig     →  the original file
```

`sig = HMAC-SHA256(secret, "<name>.<exp>")`, base64url, truncated. No table:
the signature *is* the grant. `crypto.createHmac` is already the repo's idiom —
[alerts.js:200](../server/alerts.js#L200) signs webhook bodies the same way.

**It signs the stored FILE NAME, not the entity id** (changed while building;
the plan first said id). `get_items` already knows exactly which file it
rendered, so having this route re-resolve an entity's face would be a second
implementation of that choice — free to disagree with the first on any item
with several instances. Signing the name also makes the route a pure function
of its URL: no database read but the secret, and nothing to get out of step.

A correctly-signed name is still rejected unless it equals its own
`path.basename` — the signature makes forgery impossible, but a path that never
reaches the join is one that cannot escape it, and a future change to the
signing scheme should not be able to quietly reopen that.

| decision | why |
|---|---|
| **A signed URL, not the bearer token** | The agent already holds the token, but echoing it into *tool output* spreads it into transcripts and logs far beyond the client's config. A signature grants one file and nothing else. |
| **`settings.mcp_asset_secret`, minted on first use, separate from `mcp_token`** | Rotating the token is about disconnecting clients; it should not also kill a download an agent is mid-way through. Clearing this secret is the separate act that invalidates every outstanding link. |
| **1 hour expiry** | Long enough for the turn that asked, short enough that a link in a pasted transcript is already dead. Re-asking `get_items` re-issues. |
| **Gated on `mcp_enabled`, not on Origin** | A signature is the authorisation; the Origin check exists for JSON-RPC rebinding and has no meaning on a GET of an image. Switching the feature off must kill outstanding links, so the enabled check stays. |
| **Serves the ORIGINAL, not a rendition** | "Export" means the real file. The rendition is what the *model* reads; this is what the *user* gets — stage 1's two-tier split, extended to the second tier. |
| **Rate-limited** | Same 60/60s limiter. Not a security boundary; the signature is. |

Mounted next to `/mcp` in `mcp.js`, ahead of the `requireAuth` static mounts.
It must also join `restoreGate`'s JSON branch — or rather, it must **not**: a
restore returning `text/plain` to a browser fetching an image is correct.
`/mcp` is the JSON-RPC path; `/mcp/asset/...` is not, and the gate's
`req.path === "/mcp"` check (stage 1) already distinguishes them. Worth a test
so nobody "helpfully" widens it to `startsWith("/mcp")`.

**Content-Type** from the stored file's extension. The `media/` module already
owns kind detection; a small extension→type map is the honest scope here, with
`application/octet-stream` as the floor.

---

## 5 — What the tab gains: one honest signal

**`last used`, and nothing else.**

The stage-1 plan sketched a "recent activity" panel — tool, board, query, spend.
Building it needs a per-event store, and the two candidates both fail:

- **`usage_meter`** is a daily *rollup* keyed `(day, board, capability, provider, model, unit)`. Most MCP calls are **free** (facet-only search, `describe_board`, `similar_to`), so a money table cannot be the activity record. Adding `task_intent` to that PK would explode a rollup's cardinality by design.
- **`job_log`** is a per-event table and nearly fits — except every kind in it is *work the board did* (`tag`, `extract`, `face`, `ingest`, `transcribe`, `cancel`), and its rows drive the board's Jobs page. Filing reads there would bury a board's actual work under agent traffic.

A third table is the honest answer for real analytics, and nobody has asked for
analytics. So stage 2 ships the question an operator actually has after setting
this up — *is it working, is anything connected?* — as a single
`settings.mcp_last_used` stamp, written at most once a minute (a module-level
throttle; a settings UPSERT on every read would be a write per query).

The tab shows "last used 4 minutes ago" or "never used yet". If someone later
wants to know *what* agents ask for, that is a table and its own arc.

---

## 6 — `task_intent`: make it earn its place

Stage 1 accepted `task_intent` and recorded it nowhere, on the reasoning that
changing a tool schema later churns clients. That is true, but a parameter the
model spends tokens writing and the server discards is a lie in the schema.

**It goes in the server log line**, which already exists:

```
mcp search_board 179ms · ui · "studying empty-state patterns"
```

Zero new storage, and it makes the Logs tab answer *why* calls are happening,
not just that they are. The description then says what is true — that it is
recorded in the server log — and Mobbin's privacy clause stays verbatim,
because a log is exactly the place a pasted transcript would be worst.

---

## 7 — Board scope

Stage 1's tab says *"A connected client sees all 14 boards, as alex@…"* — a
sentence apologising for a missing control. Stage 2 makes it one.

`settings.mcp_boards`: comma-separated board ids, **empty means all** (so
nothing changes for anyone who does not touch it). Applied in one place —
`visibleBoards` in `mcp-tools.js` — so `list_boards`, `describe_board` and
`search_board` all narrow together, and `resolveBoard`'s refusal keeps naming
only boards the caller may actually search.

The tab renders a checkbox per board. Unchecking every box means *all*, not
*none*: "no selection" is absence, not a claim, and a control whose empty state
silently disables the feature is a trap.

---

## 8 — What is NOT in stage 2

| omitted | why |
|---|---|
| `save_to_crate` | stage 3 — the first write path gets its own review |
| an activity/analytics table | §5 — nobody has asked, and the two tables that exist both misfit |
| the `usage_meter.provider` migration | §1.2 — orthogonal to MCP |
| `resource_link` content blocks | the download link rides in the text block instead. `resource_link` invites a client to `resources/read` the URI, and we declare no `resources` capability; a plain URL is as actionable for an agent and promises nothing we do not serve |
| the corpus cache | still an optimisation; still measure the annoyance first |
| `max` preset | clamps to `high`; two names for one thing |
| browser-pasteable permanent asset URLs | the 1-hour signature covers the agent case; a shareable link is a different feature with different consent |

---

## 9 — Tests

Extending the three stage-1 files plus the browser one.

**`mcp-tools.test.js`**
- `get_items` returns one text block and one image block per id, in the order asked
- every facet value and every per-facet reasoning sentence appears, not just the description
- `preset: "high"` produces a larger image than `standard` for the same item
- an id from a *different* board is refused (the board argument is the authority, not the id)
- an id that does not exist is skipped with a line saying so, and the rest still return
- an item whose original is missing still returns its text block and its link (the link 404s later — that is the asset route's business, not this tool's)
- `ids` beyond the cap is a tool error naming the cap, not a silent truncation

**`mcp-asset.test.js`** (new)
- a link from `get_items` fetches the original bytes with a sane Content-Type
- a tampered `id`, `exp` or `sig` → **403**
- an expired `exp` → **403**, with a message saying to re-run `get_items`
- rotating `mcp_token` does **not** break an outstanding link; clearing `mcp_asset_secret` does
- `mcp_enabled = 0` → **404**, same as `/mcp`
- **`restoreGate` still answers `/mcp` in JSON and `/mcp/asset/...` in text** — the pin against someone widening that check to `startsWith`

**`mcp-admin.test.js`**
- `mcp_boards` round-trips; an empty value means all
- `last_used` appears in the pane payload and advances after a call

**`mcp-tools.test.js`** (scope)
- a board excluded by `mcp_boards` vanishes from `list_boards` **and** is refused by id from `search_board`, `describe_board` and `get_items` — the same "not just a listing filter" pin stage 1 made for membership

**`browser/mcp-tab.test.js`**
- the board checklist renders, unchecking one persists, unchecking all reads as "all boards"
- "last used" renders both states without errors

---

## 10 — Risks

- **The signature outlives the transcript it is in.** One hour is short, but a
  link pasted into a shared log is live for that hour. That is the cost of not
  putting the bearer token in output, and it is the better trade — but it
  should be said in the tab, next to the asset secret.
- **`get_items` at `high` × 6 is ~11k tokens.** The schema says so; whether
  models respect a token warning in a parameter description is the same open
  question stage 1 has about `describe_board`-before-`search_board`.
- **`mcp_boards` is a second place board access is decided**, beside
  `board_members`. It narrows and never widens — a board the acting user cannot
  reach stays unreachable whatever the list says — but two gates on one question
  is a thing to keep honest, and the test above is what keeps it.
- **The asset route is the first unauthenticated-by-cookie path in the app.**
  It is authenticated by signature, gated on `mcp_enabled`, rate-limited and
  serves only files already in the gallery — but it is a new kind of surface
  and deserves the security-review pass on the way out.

---

## 11 — Built and verified

### 11.1 — What shipped

| file | what |
|---|---|
| `server/mcp.js` | the signed asset route, `assetLink`, `mcp_asset_secret`, `mcp_boards` + `mcp_last_used` in the pane payload, `task_intent` into the log line |
| `server/mcp-tools.js` | `get_items`, `recordsFor`, `detailText`, board scope in `visibleBoards` **and** `resolveBoard` |
| `public/admin-mcp.js` | board checklist, "last used" |
| `test/mcp-asset.test.js` | 8 new tests |
| `test/mcp-{tools,admin}.test.js`, `test/browser/mcp-tab.test.js` | 13 more |

### 11.2 — Two things the build changed

**`touchLastUsed` moved into `gate()` and throttles on the STORED stamp.** It
started life on `tools/call` with a module-level clock — which meant a
`tools/list` (a client saying hello, which is exactly what "is anything
connected" asks about) did not count, and the in-process clock went stale across
a restart. Reading the stamp `gate()` had already fetched costs nothing and is
correct in both directions.

**A dead guard in `get_items`, found by a test.** `if (!blocks.length) return
fail(...)` could never fire, because the missing-ids notice always put a block
in. So a call naming only ids from *another board* came back as a cheerful
non-error. Now `!found.length` is the failure, with the likeliest cause named.

### 11.3 — The defect the live run turned up

The first real `get_items` against the `ui` board returned a link that served
`application/octet-stream`. express resolves types through `send` → **`mime@1.6`,
which predates AVIF** — and the gallery holds **46 `.avif` files** among
2,751 png / 1,258 jpg / 979 webp / 146 gif / 18 pdf / 7 mp3.

A download nobody can preview is half a download, so the route now names the
types itself (`send` only guesses when the header is absent) and an
extensionless file honestly keeps `octet-stream`. Pinned by a test.

**Note, out of scope but real:** `/gallery`'s static mount has the same gap for
the lightbox. Browsers sniff inside `<img>` so it mostly does not show, which is
presumably why it was never noticed.

### 11.4 — Measured on the live `ui` board

| | |
|---|---|
| `get_items`, 2 ids, `standard` | **489ms**, 6 blocks (4 text, 2 images), 60 KB response |
| one `standard` rendition of a 2048×1273 AVIF | 53.3 KB base64 |
| the signed link, fetched unauthenticated | **200**, `image/avif`, **117,002 bytes — byte-identical to disk** |
| the same link with one character changed | **403** |

The record block carries what search could not: per-facet reasoning beside each
value ("*use_case: analytics-reporting — The screen centers on sessions/traces
analytics with summary metrics, a histogram, and a sortable list*"), the
original filename, `2048×1273`, and `114KB`.

The log line reads:

```
mcp search_board 85ms · 64443caf-… · "studying empty-state patterns"
```

which is `task_intent` doing the one job stage 2 gives it.

---

## 12 — Review pass (same day)

Three defects, none of which any test was failing on, and one performance fix.

### 12.1 — Two reads of the same rows, disagreeing

Stage 2 left `descriptionsFor` (stage 1's) beside its new `recordsFor`. They
picked **different instances of the same entity**, in two ways:

- `descriptionsFor` required a stored description and took the first row that
  had one; `recordsFor` took the first row full stop. So `search_board` could
  print a description `get_items` then omitted.
- `descriptionsFor` had **no `ORDER BY` at all**, so among rows that qualified,
  "first" was whatever Postgres felt like. Two identical searches could print
  different descriptions for the same card.

Both are invisible on a board where every entity has one instance — which is
every board here — and would have surfaced the first time derived identity put
two images on one card.

Now one read, and one rule stated once: **an entity's record is its FACE
instance's** — the row whose file is the image the caller is looking at.
Anything else describes one picture while showing another. `listItems` already
made that choice; matching its `name` here means the two cannot drift.

The download link falls out of the same fix: it is now the face's file, so a
link beside a picture is that picture.

**The test that pins it is the second one written.** The first passed against a
deliberately broken implementation, because on a default board the face IS the
first row and every candidate answer coincides. The real test builds a board
with `mapping.face = {pick: "latest"}`, where the face is the *second* instance
— and it fails against the old behaviour, which is the only evidence that a
test is load-bearing.

### 12.2 — A scope list goes stale and blinds the agent

Deleting a board touches nothing in `settings` — `deleteBoard` even purges
`usage_meter` by hand because no FK reaches it. So a `mcp_boards` list naming
deleted boards survived them.

Delete every scoped board and the agent saw **no boards at all**, while the tab
showed every box unticked — which the tab itself says means *all of them*. A
feature answering "nothing" with nothing on screen to explain why.

`liveScope(allBoards, ids)` now intersects the stored list with boards that
still exist, and an empty intersection reads as no scope. Exported, so the
checklist and the tools apply the same rule rather than two copies of it.

### 12.3 — `get_items` read the whole board to fetch six rows

It called `listItems(db, null, board.id)` — 4,673 entities, 95ms, 7.4MB of
assembled JSON — and then looked up two ids in the result.

`listItems` now takes an `ids` option. Four lines in `db.js`, in the function
that already owns face selection, the instance→entity tag union and
`aggregateStatus` — rather than a second assembly path, which is the drift this
arc keeps catching in other forms.

Measured on the live board: `get_items` for two ids **403ms → 287ms**, and the
7.4MB is simply not allocated.

### 12.4 — Considered and deliberately not changed

- **`assetSecret` is read once per link, so six times per `get_items`.** Caching
  it in the closure would break revocation: clearing the secret must stop
  *minting* links with the old one, not just verifying them. Six sub-millisecond
  settings reads is the right price.
- **Renditions are serial across items.** `sharpGate` serialises decodes
  anyway, so a `Promise.all` over the loop would queue the same work at the same
  gate for the same total time.

### 12.5 — And one the suite itself found

Three full runs after the fixes above failed — each on a DIFFERENT test, none of
them MCP's: `welcome.test.js` twice, `ingest-sweep.test.js` twice. Every one
passed in isolation.

Bisecting by exclusion rather than guessing at it:

| run | result |
|---|---|
| everything except the five new MCP files | **1604 pass, 0 fail** |
| everything except the new BROWSER file | **1660 pass, 0 fail** |

So the four API files were innocent and the browser file was the tipping point.
Not connections — 8 of a possible 100 during a heavy run — but Chromium: the
file was written as seven tests and the harness opens a fresh page per test,
so it added **nine page loads and a fifth browser** to a `--test-concurrency=8`
run, and the tests that fell over were the timing-sensitive ones elsewhere.

The harness says this in its own header — *"These are SLOW next to the ~1ms unit
tests. Spend them on paths that are only real in a browser"* — and seven tests
was not spending them, it was scattering them. Rewritten as **three tests
driving one page each through a whole arc**: same assertions, four page loads.

Three consecutive full runs green afterwards.

The lesson is not about this file. A new test file that makes OTHER files fail
is a regression like any other, and "passes in isolation" is the symptom, not
the defence.

**Suite 1663, green, three runs running.**
