# MCP stage 1 — the proof (2026-09-18)

> Companion to [mcp-server-plan.md](mcp-server-plan.md), which holds the research
> and the arc. Transport, auth, three read tools, and the admin tab.
>
> **Status: SHIPPED 2026-09-18 in 7eca785.** Suite 1641 green at the time. Exercised
> against the live `ui` board (4,673 cards) through a rebuilt container — the
> numbers are in §12, and one finding there (§12.2) changed the auth copy.
>
> Everything below was measured or read out of the spec, not assumed. One
> measurement in the parent doc was **wrong** and is corrected in §2. The
> configuration surface was **absent** from the first draft and is §6.

## Done when

The Agents tab is switched on, its **copy** button hands over a working command,
pasting it connects a client, *"find me dark developer-centric dashboards with a
data table"* returns twelve correct screens with readable images, and `npm test`
is green.

**Ships:** `server/mcp.js`, `server/mcp-tools.js`, `public/admin-mcp.js`, a tab
button + panel in `admin.html`, three lines in `admin.js`, one import + one call
in `server.js`, one clause in `restoreGate`, three `settings` rows, three test
files. **No migration** (the `settings` table already exists). **No new
dependency. No new index.**

---

## 1 — The measurements

All medians of 5 runs against the live `ui` board, warm.

| operation | median | note |
|---|---|---|
| `listItems(db, null, board)` | **94.7ms** | 4,673 entities, 7.36 MB JSON |
| `boardEmbeddings(db, board, model)` | **232.2ms** | 4,673 vectors, 7 MB |
| …the same rows **without** the `embedding` column | **7.7ms** | |
| …**only** `entity_id + embedding` (leanest possible) | **224.1ms** | |
| cosine scan over all 4,673 vectors (JS) | **3.0ms** | |
| fingerprint aggregate (`COUNT`+`MAX(updated_at)`) | **2.3ms** | |
| `describe_board` tag `GROUP BY` | **15.1ms** | |
| reasoning read for 12 entities | **1.3ms** | |
| a bespoke "lean tags index" alternative to `listItems` | **190.8ms** | *slower than `listItems`* |

### Budget per call

| call | local cost |
|---|---|
| `list_boards` | few ms |
| `describe_board` | ~17ms |
| `search_board`, facets only | ~96ms |
| `search_board`, with `query` or `similar_to` | ~330ms + the embed API round trip |
| `search_board`, with the corpus cache warm (§4.3.x) | ~100ms + the embed round trip |

---

## 2 — Correction to the parent doc's §4.2

The parent doc rejected pgvector on the strength of an `EXPLAIN ANALYZE` reading
**4.95ms**. That measured *server-side execution only*. The real round trip is
**232ms**:

- same rows **without** the embedding column: **7.7ms**
- same rows **with** it: **232.2ms**
- leanest possible projection: **224.1ms**

**~225ms is node-postgres moving 7 MB of `bytea` and building 4,673 row
objects.** Postgres does its part in 5ms. **No index can help this** — only
transferring fewer bytes can.

So the honest argument *for* pgvector is not "faster scanning" (3ms in JS) but
"**an ANN index returns top-k, so the corpus never crosses the wire at all**."
That is a real argument the first draft dismissed on the wrong evidence.

**It still loses, and now for a better reason.** An in-process cache of the
decoded corpus, keyed on a fingerprint that costs 2.3ms to check, turns 232ms
into ~2ms after the first call — same benefit, zero infrastructure, and **the
pattern already exists in the same file**: `meaningCorpusCache` at
[server.js:3169](../server/server.js#L3169), keyed on
`` `${model}|${count}|${max(updated_at)}` ``, bounded by `capCache(map, 16)`.
See §4.3.x. Revisit pgvector when boards × corpus exceeds what RAM should hold.

### And it settles `listItems`

Measured: `listItems` is **94.7ms**; the bespoke lean alternative is **190.8ms** —
twice as slow, because a correlated per-entity subquery loses to `listItems`'s
two-query + JS-join shape. **The no-duplication choice is also the fast one.
Question closed.** Pass `userId = null`: the crate-membership and favorites joins
are guarded by `if (userId)` and search results do not need them.

---

## 3 — `server/mcp.js`: the transport

Knows nothing about boards. ~150 lines.

### What the spec actually demands

From [transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and [lifecycle](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle):

| requirement | our answer |
|---|---|
| ONE endpoint path supporting POST **and** GET | `/mcp` |
| POST of a JSON-RPC **request** may answer `application/json` with one object — **SSE is optional** | plain JSON always |
| POST of a **notification or response** → **202, no body** | yes |
| GET → `text/event-stream` **or 405** | **405** (no server-initiated stream) |
| DELETE → may answer 405 | 405 |
| `Mcp-Session-Id` is **MAY** | omitted; stateless |
| **MUST validate `Origin`** (DNS rebinding) | §5 |
| invalid/unsupported `MCP-Protocol-Version` → **400** | yes |
| absent version header → assume `2025-03-26` | yes |

No SDK: `@modelcontextprotocol/sdk` exists mostly for the stateful SSE sessions
this server does not have, and the repo already calls every AI provider with
plain `fetch`. 150 lines of JSON-RPC switch is not worth a dependency.

### Methods handled

| method | behaviour |
|---|---|
| `initialize` | echo the client's `protocolVersion` if supported, else answer ours. `capabilities: { tools: {} }` — **no `listChanged`**, the list is static. `serverInfo: {name: "001az-boards", version}`. `instructions`: §3.2. |
| `notifications/initialized` | 202, no body |
| `tools/list` | all tools. No `nextCursor` — pagination is defined but pointless at three. |
| `tools/call` | dispatch to `mcp-tools.js` |
| `ping` | `{}` |
| anything else | `-32601 Method not found` |

### Error codes, and the distinction that matters

**Protocol errors** (JSON-RPC `error`): `-32700` unparseable body, `-32600`
malformed envelope, `-32601` unknown method **or unknown tool name**, `-32602`
bad arguments.

**Tool execution errors** go in the *result* as
`{content: [{type:"text", text}], isError: true}` — **not** as JSON-RPC errors.
This is the spec's explicit split and getting it backwards is the common bug: a
model can read and recover from an `isError` result, while a JSON-RPC error is a
transport failure it can only report.

*"board `xyz` not found — available boards: ui, wardrobe, cars"* is an `isError`
result. *"no tool named `serch_board`"* is `-32601`.

### 3.2 — `instructions`

The one free lever for steering callers:

> These tools search private, self-hosted galleries ("boards"). Each board has
> its own hand-authored facet vocabulary — **call `describe_board` before your
> first `search_board` on a board** and phrase facet filters in the exact keys
> and values it returns. `search_board` composes facet filters, meaning search
> and similar-to in one call; prefer one composed call over several. Images
> returned inline are low-resolution previews for you to read.

Whether callers obey is empirical; the first week answers it.

---

## 4 — `server/mcp-tools.js`: the three tools

Knows nothing about HTTP. Schemas are pure data; one handler each. The split
means the protocol half tests with no database and the tools half with no HTTP.

**The schema table is also the tab's copy** (§6): `GET /api/admin/mcp` serves the
tool list so the Agents tab renders the vocabulary it is handed and invents none
— the standing rule the metering readers earned the hard way.

### 4.1 — `list_boards`

```jsonc
{
  "name": "list_boards",
  "title": "List boards",
  "description": "List the galleries (boards) available to you. Start here, then call describe_board on whichever one fits before searching it. Cheap — no images.",
  "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false }
}
```

One line per board: `id · name · N cards · M facets · semantic search: yes/no`.
Rides `accessibleBoards` ([server.js:945](../server/server.js#L945)) and
`boardEntityCounts`. "semantic search" is whether `resolveEmbedder(db)` resolves
— the caller needs to know before it writes a `query`.

### 4.2 — `describe_board`

The load-bearing tool, and the one Mobbin structurally cannot have.

```jsonc
{
  "name": "describe_board",
  "title": "Describe a board's vocabulary",
  "description": "Return one board's facet vocabulary: every facet key, its allowed values with live counts, and the prose that defines each one. Call this before search_board so your facet filters use the board's exact keys and values. No images — also the cheapest way to answer counting questions ('how many dark dashboards are there').",
  "inputSchema": {
    "type": "object",
    "properties": { "board": { "type": "string", "description": "Board id from list_boards." } },
    "required": ["board"], "additionalProperties": false
  }
}
```

Output per facet: `key`, `label`, `single|multi`, the facet's own `description`
prose, every value with its count. Plus the board's `context` line and total card
count. Counts from one query (**15.1ms**):

```sql
SELECT tag, count(*) FROM (
  SELECT jsonb_array_elements_text(tags) AS tag FROM items WHERE board_id = $1
) t GROUP BY 1
```

**Deliberately not `facetRollup`** ([facet-diagnosis.js:140](../server/facet-diagnosis.js#L140)):
that answers *"is this facet's diagnosis stale"*, an operator question, and would
drag diagnosis state into a read-only surface. Wrong tool, right-looking name.

A value declared on the board with **zero** tagged items is still listed, marked
`0` — hiding it would let a caller conclude the vocabulary is smaller than it is.

### 4.3 — `search_board`

```jsonc
{
  "name": "search_board",
  "title": "Search a board",
  "description": "Search one board. Combine any of: facet filters (exact vocabulary from describe_board), a meaning query in plain language, and a similar-to anchor. Prefer ONE composed call over several narrow ones. Returns compact metadata plus a low-resolution preview image per result for you to read.\n\nWriting `query`: describe what you'd SEE, in plain language — 'analytics console with a dense metrics table and a command palette open'. Avoid negations ('without a sidebar' ranks almost identically to 'with a sidebar' — exclude it with facets.not instead), vague style words ('modern', 'clean'), and disconnected keyword lists. Put structural constraints in `facets`, not in `query`.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "board":   { "type": "string" },
      "facets":  {
        "type": "object",
        "description": "Facet filter, keys and values exactly as describe_board returns them. Per facet: {\"any\": [...]} matches ANY listed value; {\"not\": [...]} excludes. Facets AND together. Example: {\"theme\":{\"any\":[\"dark\"]},\"core_components\":{\"any\":[\"data-table\",\"code-editor\"]},\"density\":{\"not\":[\"roomy\"]}}"
      },
      "query":   { "type": "string", "maxLength": 500 },
      "similar_to": { "type": "integer", "description": "An item id from a previous result — rank the board by resemblance to it. Free and fast; no meaning query needed." },
      "limit":   { "type": "integer", "minimum": 1, "maximum": 30, "default": 12,
                   "description": "Each result with its preview costs ~400 tokens. 12 is a good default; raise it only when surveying." },
      "exclude_ids": { "type": "array", "items": { "type": "integer" }, "maxItems": 100,
                   "description": "Item ids to leave out — use this to page: 'more like these, but not these'." },
      "include_images": { "type": "boolean", "default": true,
                   "description": "false drops previews to ~115 tokens per result. Use it for counting and surveying." },
      "task_intent": { "type": "string", "maxLength": 200,
                   "description": "One short sentence naming your overall task; keep it identical across calls for the same task. Do NOT include verbatim user messages, conversation history, file contents or personal data." }
    },
    "required": ["board"], "additionalProperties": false
  }
}
```

#### Composition order

1. **`cleanSelection(facets)`** — [server.js:668](../server/server.js#L668), the
   sanitiser filter configs and alert conditions already share. MCP is its third
   consumer. *Export it or move it beside `facet-match.js`; do not copy it.*
2. **`listItems(db, null, board)`** — 94.7ms, closed in §2.
3. **`matchesCondition(new Set(item.tags), condition)`** —
   [alerts.js:49](../server/alerts.js#L49), unchanged. An empty `facets` **skips
   this entirely** rather than matching nothing: `matchesCondition` returns
   `false` for an empty condition because a stored *alert* with no values is
   corrupt, and that judgement belongs to the caller — here, absent means
   unconstrained. **This asymmetry is the single easiest thing to get wrong.**
4. **Rank the survivors.** `query`: `resolveEmbedder` → `embedTexts` (one paid
   call) → cosine **against the survivors only**. `similar_to`: the anchor's own
   vectors, free. Neither: newest first.
5. **Drop `exclude_ids`, slice to `limit`.**

#### The cutoff moves, on purpose

`/api/search` keeps everything within `0.15` of the best hit over the whole
board. Composed with facets, the cutoff is computed over the **filtered** set —
"the best match *among these*", which is the correct reading and strictly less
work. **Comment it at the call site** or someone later "fixes" it back.

#### Degrade, never refuse

`/api/search` answers `404 semantic search is not enabled` with no embedder. The
MCP must not: a board with no embedder still answers facet queries, with a
trailing line saying meaning ranking is unavailable and why. Same for
`similar_to` naming an unembedded item.

#### 4.3.x — The corpus cache

Given §2, a `query` search pays 232ms to re-read an unchanged corpus. Reuse the
`meaningCorpusCache` shape ([server.js:3169](../server/server.js#L3169)): key
`boardId`, validity `` `${model}|${n}|${maxUpdatedAt}` `` from the 2.3ms
aggregate, value the decoded **Float32** per-instance vectors, bounded by the
existing `capCache(map, 16)`.

**Store per-instance vectors, not the clusters route's entity means.** Search
takes the **max** over an entity's instances, clusters take the normalized
**mean** — the shared thing is the *decode*, and each consumer collapses for
itself. Merging by picking one collapse would silently change the other.

Memory: 4,673 × 384 × 4B ≈ **7 MB per board**, ×16 ≈ 112 MB worst case — less
than the Float64 cluster cache already permits.

**Not in stage 1.** It is an optimisation; §1 makes adding it later a decision
rather than a guess.

### 4.4 — Response shape

Mobbin returns N images then one JSON blob, so binding image #2 to result #2 is
positional. **Interleave**: one `text` block per result immediately followed by
its `image` block.

```
### 3 of 12 · id 8842 · score 0.81
use_case/dashboard-overview · shell/three-column · theme/dark · density/compact
core_components: data-table, command-palette · viz: kpi-cards, time-series
A dark analytics console with a slim icon rail, a dense metrics table and a
command palette open over it.
```
followed by
```jsonc
{ "type": "image", "data": "<base64 webp>", "mimeType": "image/webp",
  "annotations": { "audience": ["assistant"], "priority": 0.3 } }
```

**`annotations.audience` is the improvement over Mobbin.** They express "these
previews are for you to read, not for the user" in *prose* inside the tool
description. The protocol has a field for it. Marking previews
`audience: ["assistant"]` says it structurally, so a host that honours
annotations will not paste 12 low-res thumbnails into the user's transcript.

Images read straight off `path.join(THUMBS_DIR, item.name + ".webp")` — the
600px/~14KB faces, already generated, already immutable. Base64 inflates 14KB to
~19KB, so 12 results ≈ 224KB of response body. **Never inline an original.**

Trailing block:

```
matched 304 · returned 12 · refine with exclude_ids, or narrow the facets
```

`structuredContent`/`outputSchema` are skipped deliberately: the payload is prose
plus images, not a record, and an output schema would demand a JSON duplicate of
every result.

### 4.5 — Descriptions

`listItems` does not carry `tag_reasoning` — it is lazy-loaded for the lightbox
at [server.js:3263](../server/server.js#L3263), and adding it there would bloat
every board load in the browser to serve a tool. One targeted read for the
returned page only (**1.3ms**):

```sql
SELECT entity_ids, tag_reasoning->>'description' AS d
  FROM items WHERE entity_ids && $1::bigint[]
```

---

## 5 — Auth: settings, not environment

> **Corrected.** The first draft of this doc put everything in env vars
> (`MCP_TOKEN`, `MCP_DISABLE`, `MCP_ALLOW_ANONYMOUS`, `MCP_ALLOWED_ORIGINS`).
> **That breaks a pattern this app already has:** `settings` holds
> `crypto_key_coingecko` and `stocks_key_financialmodelingprep` — real API keys,
> in the database, managed from admin. Secrets live in the DB here. An env-only
> feature is also invisible: nobody discovers it, and there is no way to hand the
> operator a working command to paste.

**One token for the instance**, stored in `settings` alongside the other keys.

| setting | default | meaning |
|---|---|---|
| `mcp_enabled` | `0` | the route answers **404** when off |
| `mcp_token` | minted on first enable | plaintext, like `crypto_key_*` |
| `mcp_origins` | unset | extra allowed origins, comma-separated |

**Default off.** An open-source app should not grow a listening surface its
operator did not ask for, and the tab's first job is to turn it on.

### Plaintext, and why that is the right call here

Members stores only invite-token *hashes*, so "copy link" has to **re-mint**
([admin-members.js:44](../public/admin-members.js#L44)). With one shared
instance-wide token that behaviour is unusable: copying the command would rotate
the secret and disconnect the client you set up yesterday. A single shared token
therefore has to be readable, which makes it plaintext — the same posture
`crypto_key_coingecko` already has. Stating it plainly: **anyone who can read the
`settings` table or a backup can read this token.** Given the stated preference
for ease of setup over security on a self-hosted app, that is the accepted
trade — and it is now *visible* in the UI rather than buried in an env file,
which is strictly better than where the first draft left it.

### The rules, evaluated per request

Config is mutable at runtime now, so the gate is per-request rather than
per-mount:

1. `mcp_enabled = 0` → **404**. Not 503 — a feature that is off should not look
   like an outage.
2. `mcp_token` set → `Authorization: Bearer` required, compared with
   `crypto.timingSafeEqual` on equal-length buffers (length-check first;
   `timingSafeEqual` throws on a mismatch).
3. `mcp_token` **cleared** → loopback only, no auth. The ease-of-setup escape
   hatch, and the tab says so in words: *"Clear the token to let clients on this
   machine connect without one."* A non-loopback request with no token is
   refused. This is the same rule the first draft had, now visible instead of
   hidden.
4. The token resolves to the admin user (`ADMIN_EMAIL`), so `canAccessBoard` /
   `board_members` ride unchanged. **No board scope list in stage 1** — the tab
   states which boards the connection sees; a checklist is stage 2 if anyone
   wants to withhold one.
5. `MCP_DISABLE=1` survives as the **only** env var: a hard kill for an operator
   who wants the code path gone regardless of what a DB row says. Defensible for
   open source; everything else moved.

### The Origin check is what makes rule 3 safe

The parent doc's first pass justified loopback-anonymous with *"anything reaching
localhost can read the cookie jar."* **Wrong for the case that matters.** A page
in the operator's browser can POST to `http://localhost:8001/mcp`; the app's CSP
constrains *its own* pages, not other origins, and cookie auth is irrelevant
because MCP does not use cookies.

The spec's mandatory Origin validation is the actual defence: **reject any
request carrying an `Origin` header that is not same-origin or listed in
`mcp_origins`.** A real MCP client sends no `Origin` at all, so this costs
legitimate callers nothing. `express.json()` happens to force a CORS preflight the
app never answers, but that is an accident of Content-Type, not a control.

**Rate limit:** reuse [`rateLimit`](../server/ratelimit.js) at 60/60s keyed by
IP. Mobbin's number by coincidence, the existing `/api/search` limiter's shape by
design.

---

## 6 — The Agents tab

A ninth tab in `admin.html`, after Logs. The eight existing tabs are all plain
nouns; **"Agents"** says what it is for, with the MCP term prominent inside for
anyone searching for it.

### Why a tab and not somewhere existing

- **Capabilities** is the near miss. Its whole vocabulary is
  provider / keyId / model / binding / floor / probe
  ([capabilities.js:68](../server/capabilities.js#L68)) and MCP has **none** of
  them. Capabilities is work the app *consumes*; this is the app being consumed.
  Forcing it in would bend a registry every field of which is meaningless here.
- **Plugins** installs third-party code *into* the app. Opposite direction.
- **Members** has the closest machinery (mint / copy / scope / last-used) but it
  is a list of rows, and with one instance-wide token there is no list — there is
  a connection string, a switch, and eventually activity. Those want a pane.

### The pane

```
┌─ MCP endpoint ──────────────────────────── ◉ On ─┐
│                                                   │
│  Connect a client                                 │
│  ┌─────────────────────────────────────────────┐  │
│  │ claude mcp add --transport http boards \    │  │
│  │   http://localhost:8001/mcp \               │  │
│  │   --header "Authorization: Bearer a1b2…"    │  │
│  └─────────────────────────────────────────────┘  │
│                                         [ copy ]  │
│                                                   │
│  Token   a1b2c3…                 [show] [rotate]  │
│  Required from anywhere but this machine. Clear   │
│  it to let local clients connect without one.     │
│  Rotating disconnects every connected client.     │
│                                                   │
│  Sees all 14 boards, as alex@… (admin)            │
└───────────────────────────────────────────────────┘

┌─ What a connected agent can do ───────────────────┐
│  list_boards      list the galleries              │
│  describe_board   hand over a board's vocabulary   │
│  search_board     facets + meaning + similar-to    │
└───────────────────────────────────────────────────┘

┌─ Advanced ─────────────────────────────  collapsed ┐
│  Allowed origins    (same-origin only)             │
└────────────────────────────────────────────────────┘
```

**The copy button is the reason the tab exists.** Everything else could have been
env vars; a working command with the real host and the real token filled in could
not. `copy()` already exists in [api.js:47](../public/api.js#L47) and flashes the
triggering button.

**The tool list is served, not hardcoded.** `GET /api/admin/mcp` returns the same
tool metadata `tools/list` returns, so the tab renders the vocabulary it is handed
and a fourth tool appears there with no client edit — the standing rule the
metering readers earned the hard way, and the same stance
[admin-capabilities.js](../public/admin-capabilities.js) takes ("*this module
holds no capability knowledge*").

**The endpoint URL** is `` `${BASE_URL}/mcp` `` — exactly parallel to
`inviteLink` at [server.js:359](../server/server.js#L359), which is already how
this app answers "what is my public address." No new env var, no request-host
guessing.

### Routes

| route | does |
|---|---|
| `GET /api/admin/mcp` | everything the tab draws: `enabled`, `token`, `endpoint`, `origins`, the tool list, board count, the acting user's email |
| `PATCH /api/admin/mcp` | `{enabled?, token?, origins?}` — `token: null` clears it |
| `POST /api/admin/mcp/rotate` | mint a new token, return it |

All `requireAdmin`, all in `mcp.js` beside the protocol handler — one module owns
the feature, its config and its route.

### Frontend delta

`public/admin-mcp.js` (new), plus in `admin.html` one `<button class="tab"
data-tab="mcp" data-icon="plug">Agents</button>` and one
`<section class="panel" id="panel-mcp" hidden>`, plus in `admin.js` an import, a
line in the tab switch and a line in the initial render batch — the shape the
other eight tabs already use.

---

## 7 — Integration in `server.js`

Four edits, all verified against the current file.

1. **`import { mountMcp } from "./mcp.js";`** and
   **`mountMcp(app, { db, dirs: { galleryDir: GALLERY_DIR, thumbsDir: THUMBS_DIR }, baseUrl: BASE_URL });`**
   beside `mountIngest` / `mountBackups` at
   [server.js:3726](../server/server.js#L3726). That is the whole `server.js`
   delta — it is 3,858 lines and this is not a licence to rewrite it.
2. **Mount after `attachUser`** ([server.js:338](../server/server.js#L338)).
   `req.user` is `null` for `/mcp` (the handler resolves its own user from the
   token) and populated for `/api/admin/mcp` (cookie session, `requireAdmin`).
3. **`restoreGate` needs `/mcp`.**
   [backup-routes.js:47](../server/backup-routes.js#L47) returns a JSON 503 only
   for `/api/` and `/auth/` and `text/plain` otherwise. An MCP client handed
   `Restore in progress — back in a moment.` as a JSON-RPC body gets a parse
   error, not a retry. One `||` clause.
4. **`Cache-Control: no-store`** is scoped to `/api`
   ([server.js:325](../server/server.js#L325)). `/mcp` sets its own; the admin
   route inherits it.

---

## 8 — What is deliberately NOT in stage 1

| omitted | why |
|---|---|
| `get_items` (high-res + local file path) | stage 2 |
| `save_to_crate` and the read-only switch | stage 3 — the first write path deserves its own review, and a switch for a thing that cannot happen yet is furniture |
| board scope checklist | the connection acts as the admin and the tab *says so*; withholding a board is stage 2, when someone wants it |
| recent-activity panel | needs the `task_intent` meter dimension (stage 2). The tab has honest content without it |
| named per-client connections | one instance-wide token; the `api_tokens` table is the stage-2 answer if rotating-disconnects-everything becomes annoying |
| the corpus cache | §4.3.x — measure the annoyance first |
| pgvector | §2 |
| MCP Apps `ui://` | stage 4 |
| `outputSchema` / `structuredContent` | the payload is prose + images, not a record |
| SSE, sessions, `listChanged` | all optional; none needed |
| inlining originals | 190KB vs 14KB, and a client that mishandles `ImageContent` turns that into ~25k tokens ([claude-code#31208](https://github.com/anthropics/claude-code/issues/31208)) |

---

## 9 — Tests

The harness is `startServer()` from [test/helpers.js](../test/helpers.js): a
throwaway Postgres cloned from the pre-migrated template, the app imported
against it, an ephemeral port. `seedItem`, `seedInstance`, `adminSession`, `req`
already exist. 117 test files precede these.

`req()` sends a cookie, not a bearer — **add an `mcp()` helper** that POSTs a
JSON-RPC envelope with the right `Accept`, `MCP-Protocol-Version` and optional
`Authorization`, and returns the parsed result.

### `test/mcp-transport.test.js` — no board data needed

- `initialize` echoes a supported `protocolVersion`; an unsupported one gets ours
  back, not an error
- `MCP-Protocol-Version: nonsense` → **400**; absent → treated as `2025-03-26`
- `GET /mcp` → **405**; `DELETE /mcp` → **405**
- `notifications/initialized` → **202, empty body**
- unparseable body → `-32700`; envelope without `method` → `-32600`
- `tools/call` naming an unknown tool → `-32601` (**protocol** error)
- `tools/list` returns exactly the stage-1 tools, each with a valid
  `inputSchema` whose `required` names only declared properties
- `Origin: https://evil.example` → **403**; no `Origin` → allowed; same-origin →
  allowed; an origin listed in `mcp_origins` → allowed
- **`mcp_enabled = 0` → 404** for every method, including `initialize`
- token set: no header → **401**; wrong token → **401**; right token → **200**
- token cleared: loopback → **200**; a forwarded non-loopback ip → **401**
- rate limiter returns **429** with `Retry-After`

### `test/mcp-tools.test.js` — against seeded boards

- **The anti-drift pin.** For a set of selections, the ids from `search_board`
  equal the ids from calling `matchesCondition` directly over the same items.
  Same selection, two doors, one answer — the test that keeps the MCP from
  growing a second algebra. Cover include-only, exclude-only, both, and
  multi-value OR-within-facet.
- **Empty `facets` is unconstrained, not unmatchable** (§4.3 step 3) — the
  asymmetry with `matchesCondition`'s empty-condition rule, pinned explicitly.
- `limit` honoured; `exclude_ids` removes exactly those ids; `include_images:
  false` returns zero image blocks and every text block.
- Unknown board id → `isError: true` **result** (not a JSON-RPC error) naming the
  available boards.
- A board with no embedder: `query` still returns facet-filtered results plus the
  explanatory line; **never a 404**.
- `describe_board` lists a declared-but-unused value with count `0`, and its
  counts equal a direct `GROUP BY` over the same seed.
- A board the acting user cannot access is absent from `list_boards` **and**
  answers `isError` from `search_board` — the access check is not just a listing
  filter. Seed a second user via `seedUser` to prove it.
- Image blocks carry `mimeType: "image/webp"` and
  `annotations.audience: ["assistant"]`.
- An item whose thumbnail is **missing** yields its text block with no image
  block and the response still succeeds — 5,237 faces for 5,237 originals today,
  but a tool that 500s on one missing file breaks on a half-restored backup.

### `test/mcp-admin.test.js` — the tab's routes

- `GET /api/admin/mcp` requires admin; a plain member gets **403**
- it returns the **same tool names** `tools/list` returns (the drift pin between
  the pane and the protocol — the tab must not be able to advertise a tool that
  does not exist, or miss one that does)
- `PATCH` with `enabled: true` mints a token if none exists
- `PATCH` with `token: null` clears it, and `/mcp` then refuses a non-loopback
  request
- `POST /rotate` returns a new token and the old one stops working
- the `endpoint` field equals `` `${BASE_URL}/mcp` ``

---

## 10 — Decisions, with their reasons

| decision | reason |
|---|---|
| Hand-rolled transport, no SDK | ~150 lines; the SDK is for stateful SSE we don't have; the repo calls every provider with plain `fetch` |
| `listItems`, not a lean index | measured 94.7ms vs 190.8ms — the no-duplication choice is also the fast one |
| Filter in Node, not SQL | SQL would re-derive exclusions, system facets and entity-union semantics — a second algebra, for nothing at 5ms |
| No corpus cache in stage 1 | an optimisation; §1 makes adding it later a decision, not a guess |
| No pgvector | §2 — a cache gets the same win with no infrastructure |
| Cutoff over the filtered set | "best among these" is the correct reading of a composed query |
| Degrade instead of 404 | a board without an embedder still has facets |
| `audience: ["assistant"]` on previews | the protocol has a field for what Mobbin says in prose |
| Interleaved text+image | positional binding is a bug waiting for an off-by-one |
| `task_intent` in stage 1, metering in stage 2 | changing a tool schema later churns every connected client; adding a meter dimension churns nothing |
| Config in `settings`, not env | `crypto_key_*` is already there; env-only is undiscoverable and cannot hand over a command |
| Plaintext token | a single shared token must be readable or "copy" would rotate it; same posture as the keys already in `settings`, and now *visible* |
| Default off | an open-source app should not grow a listening surface nobody asked for |
| A ninth tab, not Capabilities | Capabilities' every field (provider/keyId/model/binding/floor) is meaningless for an inbound surface |
| Tool list served, not hardcoded | the tab renders what it is handed; a fourth tool needs no client edit |
| Origin check mandatory | it is what makes the cleared-token loopback path safe, and the spec requires it |

## 11 — Risks

- **Client image handling varies.** [claude-code#31208](https://github.com/anthropics/claude-code/issues/31208)
  (MCP `ImageContent` read as base64 text — 10–20× token waste) is closed as
  *not planned*. Mobbin's images render natively in the client this was written
  in. Verify per target client before trusting §1's budget; the 600px/14KB
  default is the mitigation.
- **The plaintext token is in every backup.** Accepted (§5), but it should be
  said out loud in the tab, not only here.
- **`instructions` is untested leverage.** Whether callers run `describe_board`
  first is empirical.
- **The empty-`facets` asymmetry** (§4.3 step 3) is the one place the shared
  matcher's semantics do not match what this caller wants. It has a test; it
  needs a comment too.
- **`listItems` allocates 7.36 MB per call** and hands almost all of it to the
  collector. Fine at one call; worth watching under an agent firing ten in a row.
  The corpus cache does not help — only a leaner projection would, and that costs
  the duplication this stage refuses to pay.
- **One token means one revocation.** Rotating disconnects every client. That is
  the accepted cost of skipping `api_tokens`; if it bites, stage 2 has the table.

---

## 12 — Built and verified

### 12.1 — What shipped

| file | what |
|---|---|
| `server/mcp.js` | transport + the three admin routes, ~250 lines |
| `server/mcp-tools.js` | `list_boards`, `describe_board`, `search_board` |
| `public/admin-mcp.js` | the Agents tab |
| `public/facet-match.js` | gained `cleanSelection`, moved out of `server.js` — MCP is its third consumer, not a copy |
| `public/admin.html` / `admin.js` | one tab button, one panel, three lines |
| `server/server.js` | one import, one `mountMcp` call |
| `server/backup-routes.js` | `/mcp` added to `restoreGate`'s JSON branch |
| `test/helpers.js` | `mcp()`, `callTool()`, `toolText()`, `toolImages()` |
| `test/mcp-{transport,tools,admin}.test.js` | 37 tests |

Suite **1641 green**, no migration, no new dependency, no new index.

### 12.2 — The Docker finding, which changed the design

The tokenless-on-loopback path **does not work under Docker, and must not**.
A published port (`8001:3001`) is NATed, so a request from the operator's own
terminal reaches the app from the bridge gateway — measured, not guessed: the
first live call answered `401` before a token existed.

That is the correct behaviour. The port is published on `0.0.0.0`, so a packet
from the bridge is indistinguishable from one sent by anyone else on the LAN;
trusting it would hand the gallery to the network rather than to the operator.
So the rule stayed and the **copy** was fixed instead — the tab now says the
tokenless mode serves `npm run server` on the host and nothing else, and
`mcp.js` carries the reasoning where the next person will look for it. Enabling
mints a token, so the normal install never meets this rule at all.

### 12.3 — Measured on the live `ui` board

| call | wall time | payload |
|---|---|---|
| `initialize` | few ms | — |
| `list_boards` (14 boards) | ~30ms | text only |
| `describe_board` (11 facets, live counts) | **69ms** | 7,397 chars ≈ 1,850 tokens |
| `search_board`, 3 composed facets, 12 results + previews | **179ms** | 261 KB, 12 images at ~18.2 KB base64 |
| `search_board`, meaning query, local embedder, 5 results | **850ms** | text only |

The 3-facet search matched **54 of 4,673** and returned 12. A returned preview
decodes as a real 14,008-byte WebP and is legible — the top hit for
`theme/dark + aesthetic/developer-centric + core_components/data-table` was a
dark observability workspace whose stored description ("*left navigation,
central metrics and table, right-side conversation/detail inspector … dense,
technical, and polished*") matches the pixels.

18.2 KB of base64 per preview against the ~14 KB predicted in §4.4 — the ×1.33
inflation, exactly as budgeted.

The meaning query metered one `embed` request to the board, as `/api/search`
does. `task_intent` was accepted and deliberately not recorded: attribution is
stage 2, behind the provider-namespacing migration (§4.3).

---

## 13 — Review pass (same day)

Four things the first build got wrong, all found by reading it back rather than
by a failing test — which is itself the finding: 37 green route tests did not
notice that the tab was broken.

### 13.1 — The pane crashed on its first click

`GET /api/admin/mcp` answered the full payload; `PATCH` and `POST /rotate`
answered the bare `{enabled, token, origins}`. The pane re-renders from whatever
a write returns, so the first click on the switch painted `undefined` for the
endpoint and threw on `d.tools.map`. **Blank tab, every route test green.**

Fixed with one `paneState()` used by all three routes. The rule worth keeping:
**a reader that re-renders from a write's answer must be handed the same shape
the read gave it.**

### 13.2 — Twelve blocking file reads per search

`previewBlock` used `fs.readFileSync` inside the request handler — every other
module in the repo uses `fs.promises`. Twelve 14KB reads per search, each one
stopping the event loop for the whole server. Now `fs.promises.readFile`,
gathered with the description query in one `Promise.all`.

### 13.3 — The Origin gate trusted the Host header

It compared `Origin` against `` `${req.protocol}://${req.get("host")}` `` —
both of which the caller writes. A page on `evil.example` sending a matching
`Host` and `Origin` passed as same-origin. Now compared against `baseUrl`, the
one address this instance claims (the same value invite links mint from), with
trailing slashes normalised. Pinned by a test that sends the spoofed pair.

It was never the only gate — the token still had to be right — but a
defence-in-depth check that can be talked out of its own identity is not one.

### 13.4 — `test/browser/mcp-tab.test.js`

Added, and it is what 13.1 was missing. The harness's `page.errors` watcher
catches uncaught exceptions with no assertion written for them, which is exactly
the shape of that bug. Five cases: renders off, switching on paints a complete
command with a minted token, show/rotate, clearing drops the auth header, and
switching off hides the body — each asserting `page.errors` is empty.

Also dropped: a `version` field threaded into every tool context and read by
none of them.

**Suite 1646 node + 34 browser, green.** Re-verified on the rebuilt container:
the same 3-facet search still matches 54 of 4,673 and returns 12 previews, and
the origin gate now answers 200 for `http://localhost:8001` and 403 for
`https://evil.example`.

### Known gaps, deliberately left

- **No Agents screenshot in the README.** Every other admin tab has one
  (`docs/screens/back/01..06`). The README is a WIP placeholder with no prose
  about any feature, so adding a section for this one would be out of character —
  but the screenshot row is a real omission whenever that file gets its pass.
- **Rate limiting is per IP**, and under Docker every client arrives from the
  bridge gateway — so all clients share one 60/min bucket. Harmless with one
  instance-wide token (they are all the same caller anyway); it becomes wrong
  the day `api_tokens` lands and callers are distinguishable.
