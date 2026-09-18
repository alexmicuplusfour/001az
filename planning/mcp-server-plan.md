# An MCP server for boards (2026-09-18)

> **Status: PLANNED, nothing built.** Parts 1–3 are the research: Mobbin's live
> MCP probed tool-by-tool, the field's prior art and stated consensus. Part 4 is
> a **measured** structural audit of this app — two things I expected to block
> the build measured as non-problems, and one thing I expected to build turned
> out to already run in production. Part 5 is the build spec. Part 6 is the
> staging.
>
> The `ui` board (4,673 screens, fully tagged, fully embedded) is the worked
> example throughout.

## The one-sentence answer

Mobbin's MCP is a **retrieval service that refuses to describe its own data** —
it hands the model pixels and lets the model's vision do the comprehension; this
app should do the opposite where it is strong (hand over the board's
hand-authored facet vocabulary, which Mobbin structurally cannot), copy it
exactly where it is right (two image tiers, sampled sequences, context cost as a
stated parameter), and can ship the whole thing as **five tools on one
hand-rolled HTTP route inside the existing process** — no SDK, no sidecar, no
new extension, no new index, and in stage 1 no migration.

---

## Part 1 — What Mobbin's MCP actually does

Observed by calling it. Endpoint `https://api.mobbin.com/mcp`, Streamable HTTP,
OAuth against a Mobbin account (browser sign-in on first connect, no API key to
paste). Pro/Team/Enterprise only, 60 requests per 60 seconds per user, read-only.

### Three tools, split by shape of answer — not by entity type

| tool | what it finds | result shape |
|---|---|---|
| `search_screens` | one screen in one state | flat list |
| `search_flows` | an ordered multi-step journey | list of ordered screen sets |
| `search_sections` | a marketing-site section (hero, pricing, footer) | flat list |

Not one tool with a `type` parameter, because each returns a genuinely different
**shape**. A flow carries order and length; a screen does not. Collapsing them
would force one schema to carry a `position` that is null two thirds of the time.

### The payload is deliberately starved

A whole screen result:

```json
{
  "id": "9811faad-c1a7-414a-a9c6-e3f7eee75c07",
  "image_url": "https://mobbin.com/api/mcp/short/VwW8Wsuy",
  "mobbin_url": "https://mobbin.com/screens/9811faad-...",
  "app_name": "Sweatpals",
  "platform": "web"
}
```

That is the entire metadata surface. No tags, no component list, no colours, no
description — **and Mobbin has all of that on their website.** They are a
taxonomy company and they ship none of the taxonomy through MCP:

> *"Examine the returned images to understand each screen's actual content — do
> not describe screens based solely on metadata."*

**The image is the payload.** The server does retrieval; the caller's vision does
comprehension. Two consequences: they never compress a screenshot into text
(lossy for exactly what designers search for), and their taxonomy never has to
match the caller's question — "empty states with a friendly illustration and one
primary CTA" works even though none of those are Mobbin facets.

### Two image tiers, split by who consumes them

Inline blocks are low-res previews (~768px, `curated by Mobbin` banner burned in).
`image_url` is a separate high-res link:

> *"Inline images are low-res previews for you to read, not for the user. …
> Whenever the user wants to save, export, embed, or paste a result (files,
> Figma, Notion, docs, slides), download it from `image_url`."*

High-res links are short opaque tokens (`/api/mcp/short/VwW8Wsuy`) expiring after
30 days, with an explicit instruction to download rather than hotlink.

### Flows sample the sequence instead of dumping it

A 20-screen Liven onboarding flow returned **five** inline images —
"evenly-spaced preview images" — alongside the full 20-entry `screens` array of
`{screen_id, image_url, position}`. The model sees the arc (open / early /
middle / late / land) for five images and can pull any frame at full resolution
after. Dumping all 20 would be ~15k tokens for one result out of ten.

### `task_intent` — a sanitised session key carried across calls

> *"One short sentence summarizing the user's overall task. … MUST be the same
> across all calls for the same task. Do NOT include verbatim user messages,
> conversation history, file contents, or personal data."*

Three jobs at once: a relevance bias the query cannot carry, a stable session
grain for analytics, and — via the prohibition — a contract about what the client
may send.

### `mode: deep | standard` — a paid reranker on the default path

> *"`deep` uses an AI-powered pipeline that interprets intent and scores each
> candidate for relevance, keeping the strong matches."*

**`deep` is the default**, so Mobbin pays for an LLM pass on every call they
aren't asked not to. (`fast` is a deprecated alias for `standard`, with the
deprecation written into the enum description — the schema is the only doc a
model reads, so that is where a rename has to be announced.)

### Query discipline is taught inside the schema

> *"Describe one screen in plain language … Good: 'login screen with biometric
> authentication'. Avoid: combining multiple screens/intents (search
> separately), negations ('without ads'), vague style words ('modern', 'clean'),
> disconnected keyword lists. Name a specific app to filter results to it. Do not
> include platform — use the dedicated parameter."*

App filtering is **in-band** (in the query prose) while platform is a
**parameter**, and they have to say so, because a model left alone writes
`"ios login screen"` and burns the parameter. The negation warning is an honest
admission that retrieval is embedding-based: "without ads" embeds almost
identically to "with ads".

### Context cost is a first-class parameter concern

`limit` caps at 30 (screens) / 10 (flows) with *"Lower limits are recommended to
manage context size"* in the schema. `exclude_screen_ids` takes up to 100 UUIDs,
so a second pass paginates by **subtraction** — "more like this, but not these" —
rather than an offset cursor an agent cannot reason about.

### The citation rule is a business requirement wearing a tool description

> *"When you present results to the user, ALWAYS cite each screen you mention as
> a markdown link to its `mobbin_url`."*

Plus the watermark burned into every preview. The MCP is a funnel back to the
product and the enforcement mechanism is instruction-following. That is the only
enforcement available to anyone shipping an MCP.

### One thing Mobbin gets wrong

Their response is **N image blocks, then one JSON blob**, so binding image #2 to
result #2 is positional. Interleaving removes the ambiguity for free (§5.5).

---

## Part 2 — The wider field

### Prior art: the category exists and is mostly worse

- **[A1 Gallery MCP](https://www.a1.gallery/mcp)** — **17 tools**
  (`search_websites`, `browse_websites`, `get_website`, `search_sections`,
  `search_pages`, `analyze_design_tokens`, `get_similar_websites`,
  `browse_fonts`, `find_font_pairings`, `browse_creators`, `get_design_filters`…).
  Returns screenshots plus extracted text, structured data (pricing tiers, FAQ
  Q&A) and *measured* design tokens (type scale, spacing, radius, container
  width). Free tier 50 req/day. The 17-tool surface is the mistake; the
  measured-token idea is genuinely good and nobody else does it.
- **[Landing Gallery MCP](https://www.landing.gallery/mcp)** — 500+ curated sites,
  **no account required**, up to four newest-first matches with top-cropped
  previews. The ease-of-setup end of the spectrum.
- **[Design Inspiration MCP](https://lobehub.com/mcp/notsointresting-design-inspiration-mcp)**
  and clones — thin wrappers over Google (Serper with `site:` filters scoped to
  Dribbble/Behance/Awwwards/Mobbin/Pinterest). No corpus of their own. This is
  the floor of the category, and it exists because the category is obviously
  valuable.

**What nobody has built:** your *own* gallery, with *your own* taxonomy,
queryable and writable by an agent. A1 and Landing Gallery are somebody else's
curation. That is the gap this fills.

### The consensus on tool design

From [philschmid](https://www.philschmid.de/mcp-best-practices),
[Block](https://engineering.block.xyz/blog/blocks-playbook-for-designing-mcp-servers),
[AWS](https://aws.amazon.com/blogs/machine-learning/mcp-tool-design-practical-approaches-and-tradeoffs/),
[Nordic APIs](https://nordicapis.com/8-tips-and-best-practices-for-mcp-server-development/):

| rule | consequence here |
|---|---|
| **5–15 tools.** LLMs measurably degrade choosing from large sets. | Five tools, not A1's seventeen. |
| **Outcome-first, not REST 1:1.** | `search_board` composes facets + meaning + anchor in one call rather than three tools mirroring three routes. |
| **Return curated data, not raw API responses.** | Don't ship `listItems`'s full shape. Project it (§5.5). |
| **Prefer Markdown/XML over JSON** — models struggle with strict JSON grammar. | Compact lines, not nested objects. |
| **Errors are instructional observations.** | An unknown board id answers with the list of board ids that exist. |
| **Pagination metadata** for anything over ~50. | Every search states matched vs returned. |
| **Check size before returning; resize or reject** (Block rejects >400KB). | The 600px/14KB thumb is already under any sane threshold. |

### The image-token trap

[claude-code#31208](https://github.com/anthropics/claude-code/issues/31208)
reports MCP `ImageContent` treated as base64 *text* rather than a native image
block — **~15,000–25,000 tokens instead of ~1,600**, a 10–20× waste. **Closed as
"not planned."**

Empirically, in the session this doc was written in, Mobbin's images came back as
genuine rendered image blocks, so the path works in that client today. The report
is still a portability warning: **verify image rendering per target client**, and
keep previews small enough that a client which gets it wrong degrades rather than
explodes. At 14KB a mishandled preview costs ~5k tokens instead of ~280 — bad,
not fatal. At a 190KB original the same mistake is catastrophic. This is the
strongest argument for the thumb tier being the default and the original never
being inlined.

### MCP Apps — real, official, and not yet

[MCP Apps](https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/)
shipped 2026-01-26 as the first official MCP extension (SEP-1865, Nov 2025;
folded into the extensions framework in the 2026-07-28 spec). A tool declares
`_meta.ui.resourceUri` pointing at a `ui://` resource containing bundled HTML/JS;
the host renders it in a sandboxed iframe with bidirectional JSON-RPC over
`postMessage`. Supported in Claude web/desktop, Goose, VS Code Insiders,
ChatGPT. Mobbin ships one. This app has an entire board grid in `public/` that
could become that resource — stage 4, explicitly not stage 1.

---

## Part 3 — What this app already has

### The `ui` board is a Mobbin at 1/20th the corpus

4,673 items, **all `tagged`, all embedded** (`Xenova/bge-small-en-v1.5`, 384d,
1536 bytes/row, local and free). Eleven hand-authored facets, each carrying
disambiguation prose in its `description`:

| facet | values | note |
|---|---|---|
| `use_case` | 13 | single; dashboard-overview 1178, record-detail-view 1138, form-data-entry 465 |
| `form_factor` | 3 | desktop-web / mobile-app / tablet |
| `shell` | 7 | sidebar-nav, three-column, split-pane, canvas-fullscreen … |
| `screen_state` | 6 | populated-normal, empty-state, error-alert-state … |
| `aesthetic` | 6 | developer-centric, consumerized-b2b, fintech-clean … |
| `theme` | 3 | light / dark / mixed, with an explicit rule about dark sidebars |
| `density` | 3 | compact / comfortable / roomy |
| `core_components` | 19 | multi; data-table, command-palette, kanban-board … |
| `ai_presence` | 4 | chat-copilot-pane, inline-assist-ghost, prompt-input-hero, none |
| `viz` | 8 | multi; kpi-cards, time-series, node-graph … |
| `craft_details` | 6 | multi; glass-blur, monospace-accents, soft-elevation-shadows … |

Every item also carries `tag_reasoning`: a sentence per facet, a `fit` sentence,
and a freeform `description` —

> *"A Slack App Directory management page showing approved and restricted apps
> with filters and grouped app lists. The interface is clean, enterprise-
> oriented, and mostly white with subtle dividers and small status labels."*

**This is what Mobbin does not have and cannot have.** Their taxonomy serves
100k+ screens across every vertical; ours was written for one board.

### The retrieval algebra is already shipped

| route | what it does | cost |
|---|---|---|
| `GET /api/search` ([server.js:3081](../server/server.js#L3081)) | embed query, cosine over board vectors, collapse per entity, relative cutoff at best − 0.15, cap 60 | one paid embed, metered |
| `GET /api/search/similar` ([server.js:3119](../server/server.js#L3119)) | rank against one item's own vectors | **free** |
| `GET /api/boards/:id/meaning-clusters` ([server.js:3175](../server/server.js#L3175)) | k-means over stored embeddings, cached on a corpus fingerprint | free |
| `GET /api/boards/:id/facet-stats` ([server.js:1396](../server/server.js#L1396)) | the facet rollup | free |

[conversational-search-plan.md](conversational-search-plan.md) already argued the
doctrine for the in-app case: *"The AI should not get a parallel search engine;
it should speak the app's existing search algebra."* **An MCP server is that
doctrine pointed outward.**

### Both image tiers already exist

- **Preview**: `/thumbnails/<name>.webp`, 600px wide
  ([image-thumb.js:12](../server/faces/image-thumb.js#L12)), **~14KB average
  across 5,237 files, 82MB total**. ~280 tokens each at Claude's tokenisation.
- **High-res**: `aiImageFor` in [ai-image.js](../server/ai-image.js), presets
  `standard` 1024 / `high` 1568 / `max` 4096, byte-capped, provider-clamped,
  quality→size step-down, card face as its floor. *"Deliberately dependency-light
  (sharp + fs + the shared decode gate — no db, no worker)"* — an MCP handler
  calls it directly.

Originals: 2.0G / 5,237 files. Never inline one.

---

## Part 4 — Structural audit, measured

The repo's standing rule — *don't build machinery you can't verify* — also
forbids **removing** machinery on a hunch. Everything below was measured against
the live `ui` board.

| candidate | verdict |
|---|---|
| Move the facet algebra server-side | **Already done. Zero work.** (§4.1) |
| Add pgvector | **No**, but the first reason was wrong — 232ms round trip, cache not index (§4.2) |
| Add a GIN index on `tags` | **No** — 2.53ms measured (§4.3) |
| Bearer-token auth | **Yes — the one genuinely new mechanism** (§5.3) |
| A route module rather than more `server.js` | **Yes, scoped** (§5.1) |
| `boardEmbeddings` takes `entity_ids[1]` | **Fix** (stage 3) |
| Namespace `usage_meter.provider` | **Not in this arc** — MCP adds no provider ([mcp-stage-2.md §1.2](mcp-stage-2.md)) |

### 4.1 — The facet algebra is already shared, and already runs on the server

I started believing the filter algebra lived only in the browser
(`public/filters.js`, `state.selected` as `Map<facetKey, Set<value>>`) and that
an MCP would force a server-side reimplementation with the attendant drift risk.

Wrong. [`public/facet-match.js`](../public/facet-match.js) already extracted the
rule, for exactly this reason, and says so:

> *"the cluster-core move: rules two sides must agree on have exactly one home,
> and this file is where a selection's meaning, serialization, and equality are
> all decided."*

The server **already imports it in production**:

- [`alerts.js:49`](../server/alerts.js#L49) — `matchesCondition(tagSet, condition)`,
  the full include/exclude algebra over `facetPass`, run on every tag landing.
- [`server.js:162`](../server/server.js#L162) — `halvesOf` / `wireEntry` codecs.
- [`server.js:668`](../server/server.js#L668) — `cleanSelection(raw)`, the API
  boundary sanitiser shared by filter configs *and* alert conditions.

So `search_board`'s facet leg is **`cleanSelection` → `matchesCondition` → a
projection**. The matcher exists, is tested, is the same one the grid uses, and
the input sanitiser exists too. MCP becomes its third consumer, not a second
implementation. This is the single biggest scope reduction in the arc.

### 4.2 — pgvector is not warranted — but not for the reason I first gave

> **Corrected 2026-09-18 after measuring the round trip.** The first version of
> this section rejected pgvector on an `EXPLAIN ANALYZE` reading of **4.95ms**.
> That measures *server-side execution only*. See
> [mcp-stage-1.md §2](mcp-stage-1.md) for the full breakdown.

`/api/search`'s comment says *"the corpus is small enough to scan per request."*
Measured end to end, from Node:

| | |
|---|---|
| the same rows **without** the `embedding` column | **7.7ms** |
| the same rows **with** it (what `/api/search` does) | **232.2ms** |
| the leanest possible projection (`entity_id + embedding`) | **224.1ms** |
| the JS cosine scan over all 4,673 vectors | **3.0ms** |

Postgres executes in ~5ms. **The other ~225ms is node-postgres moving 7 MB of
`bytea` and building 4,673 row objects.** No index can help that; only
transferring fewer bytes can.

So the honest argument *for* pgvector is not "faster scanning" — the scan is 3ms
in JS — but "**an ANN index returns top-k, so the corpus never crosses the wire
at all**." That is a real argument, and the first draft of this doc dismissed it
on the wrong evidence.

**It still loses, and now for a better reason.** An in-process cache of the
decoded corpus, keyed on a fingerprint costing **2.3ms** to check, turns 232ms
into ~2ms on every call after the first — the same benefit, zero infrastructure,
and **the pattern already exists in the same file**: `meaningCorpusCache` at
[server.js:3169](../server/server.js#L3169), keyed on
`` `${model}|${count}|${max(updated_at)}` `` and bounded by `capCache(map, 16)`.

`pgvector` is also **not installed** — `postgres:17-alpine` has no `vector`
extension available, so adopting it means a new base image
(`pgvector/pgvector:pg17`), a migration, a column type, an index, and a rebuild
path for dimension changes. **Revisit when boards × corpus exceeds what RAM
should hold**, not before.

### 4.3 — No index is needed for facet filtering either

The composed algebra on `jsonb` with no index at all:

```sql
where board_id = '…'
  and tags @> '["theme/dark"]'
  and tags @> '["aesthetic/developer-centric"]'
  and (tags @> '["core_components/data-table"]' or tags @> '["core_components/code-editor"]')
```

```
Seq Scan  (actual time=0.047..2.447 rows=73 loops=1)
Execution Time: 2.526 ms
```

**2.5ms**, 73 hits out of 4,673 (304 dark developer-centric screens; 73 of those
with a data table or code editor). Server-side facet filtering was never a
performance problem — **nobody had written the query**, because the client had
the whole board in memory anyway.

Which settles a design choice: **filter in Node over the assembled item shape,
reusing `matchesCondition` — not in SQL.** SQL would be a second implementation
with exclusions, system facets (`~clusters`, `~objects`, `~uploaders`) and
entity-vs-instance union semantics to re-derive, and would buy nothing at 5ms.
One home for the rule stays one home.

---

## Part 5 — The build

### 5.1 — Files

| file | ~lines | contents |
|---|---|---|
| `server/mcp.js` | 150 | transport: JSON-RPC envelope, `initialize` / `tools/list` / `tools/call`, Origin + version + auth gates. Knows nothing about boards. |
| `server/mcp-tools.js` | 350 | the five tools: schemas as pure data, one handler each. Knows nothing about HTTP. |
| `test/mcp-transport.test.js` | — | protocol conformance |
| `test/mcp-tools.test.js` | — | tool behaviour against the fixture db |

Mounted `mountMcp(app, { db, dirs })` from `server.js`, the shape
[`mountBackups`](../server/backup-routes.js#L51) and `mountIngest` already use.
**`server.js` gains one import and one call line.** It is 3,858 lines; an MCP
protocol handler must not go inline, and this is not a licence to rewrite it.

The transport/tools split is the point: the protocol half is testable with no
database, the tools half with no HTTP.

### 5.2 — Transport: hand-rolled Streamable HTTP, no SDK

The spec's minimum is genuinely small. From
[the transport spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports):

- The server **MUST** provide **one endpoint path supporting POST and GET**.
- A POST carrying a JSON-RPC **request** may answer `Content-Type:
  application/json` with a single JSON object. **SSE is optional.**
- A POST carrying a **notification or response** → **202 Accepted, no body**.
- GET → may answer **405 Method Not Allowed** (we offer no server-initiated
  stream). Legal and correct for a search server.
- DELETE → may answer 405. `Mcp-Session-Id` is **MAY**, so a stateless server
  omits sessions entirely.
- The server **MUST validate the `Origin` header** (DNS-rebinding defence).
- An invalid/unsupported `MCP-Protocol-Version` **MUST** be 400. Absent header →
  assume `2025-03-26`.

`initialize` answers `{protocolVersion, capabilities: {tools: {}}, serverInfo:
{name, version}, instructions}`. Version negotiation: echo the client's version
if supported, else answer our latest. `instructions` is a real lever — a short
paragraph telling the caller to run `describe_board` before `search_board`.

**No `@modelcontextprotocol/sdk`.** The whole surface above is ~150 lines; the
SDK exists mainly for stateful SSE sessions this server does not have, and the
repo already calls OpenAI/Gemini with plain `fetch` rather than SDKs. Adding a
dependency to avoid 150 lines of JSON-RPC switch would be against the house
grain. (If MCP Apps lands in stage 4 and wants `@modelcontextprotocol/ext-apps`,
reconsider *then*.)

### 5.3 — Auth: ease of setup first, with the Origin check doing the real work

Authorization is **OPTIONAL** per spec, and stdio transports **SHOULD NOT** use
OAuth — they take credentials from the environment. The ecosystem's practice for
self-hosted servers is one bearer token from an env var
([discussion #1247](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1247),
[mcp-auth](https://mcp-auth.dev/docs/configure-server/bearer-auth),
[graphiti#1365](https://github.com/getzep/graphiti/issues/1365),
[freecad-ai#59](https://github.com/ghbalf/freecad-ai/issues/59)).

1. **`MCP_TOKEN` unset + request from loopback → no auth.** One person, one
   Docker host, one machine. A token there is ceremony.
2. **`MCP_TOKEN` set → `Authorization: Bearer` required**, compared with
   `crypto.timingSafeEqual` on equal-length buffers. One env var. No table, no
   admin UI, no migration.
3. **Non-loopback bind + no token → refuse to mount, log the reason.** The one
   place a default says no, because the failure mode is publishing a private
   gallery unauthenticated and the operator never finds out. Overridable with
   `MCP_ALLOW_ANONYMOUS=1` — *defaults, not laws*.
4. **`MCP_DISABLE=1` turns the whole thing off.** An open-source app should not
   grow a listening surface its operator did not ask for.

**The `Origin` check is not optional and is what makes rule 1 safe.** A page in
the operator's browser can POST to `http://localhost:8001/mcp`; the CSP does not
constrain *other* origins, and cookie auth is irrelevant because MCP does not use
cookies. Reject any request carrying an `Origin` header that is not same-origin
or explicitly allow-listed via `MCP_ALLOWED_ORIGINS`. A real MCP client sends no
`Origin` at all, so the check costs legitimate callers nothing. `express.json()`
already forces a CORS preflight that the app never answers, but that is an
accident of Content-Type — the spec mandates the explicit check and it is four
lines.

A resolved token maps to a user, so `canAccessBoard` / `board_members` ride
unchanged and per-board scoping is free. (An `api_tokens` table with per-board
scopes and `last_used_at` is the natural follow-on if multi-user ever matters.
Not stage 1.)

**Stage-1 identity:** the token resolves to the admin user (`ADMIN_EMAIL`).
Multi-user tokens are a later table, not a blocker.

### 5.4 — Integration points in `server.js`

Four, all small, all verified:

1. **Mount after `attachUser`** so `req.user` exists (it will be `null` for MCP —
   the handler resolves its own user from the token and does not consult
   cookies).
2. **`restoreGate` needs `/mcp`.** Today it returns JSON 503 only for `/api/` and
   `/auth/`, and `text/plain` otherwise
   ([backup-routes.js:47](../server/backup-routes.js#L47)). An MCP client
   receiving `Restore in progress — back in a moment.` as a JSON-RPC body is a
   parse error, not a retry. Add `/mcp` to the JSON branch.
3. **`Cache-Control: no-store`** is scoped to `/api`
   ([server.js:325](../server/server.js#L325)). `/mcp` sets its own.
4. **Rate limit.** Reuse [`rateLimit`](../server/ratelimit.js) — 60/60s keyed by
   token-or-IP, landing on Mobbin's number by coincidence and on the existing
   `/api/search` limiter's shape by design.

### 5.5 — The five tools

Not seventeen (A1), one more than three (Mobbin) because `describe_board` is the
differentiator. Deliberately **not** `search_ui_screens` — the architecture is
board-agnostic everywhere else and the board id is a parameter, as in every route.

---

**1. `list_boards`** — the discovery entry point.

```
in:  {}
out: one line per board — id, name, type, card count, facet count,
     "semantic search: yes/no" (does a current-model embedder resolve)
```

No images. Rides `accessibleBoards` ([server.js:945](../server/server.js#L945))
and `boardEntityCounts`.

---

**2. `describe_board(board)`** — **the load-bearing tool, and the one Mobbin
structurally cannot have.**

```
in:  { board: string }
out: for each facet — key, label, single|multi, the tagger's own `description`
     prose, and every value with its live count
     + the board's `context` line and total card count
```

The caller's next query is then written *in the board's vocabulary* instead of
guessing at it. It also answers counting questions with zero images: "how many
dark developer-centric dashboards" is a `GROUP BY`.

Counts come from one query — measured at 2.5ms:

```sql
SELECT tag, count(*) FROM (
  SELECT jsonb_array_elements_text(tags) AS tag FROM items WHERE board_id=$1
) t GROUP BY 1
```

Deliberately **not** `facetRollup` ([facet-diagnosis.js:140](../server/facet-diagnosis.js#L140)):
that answers *"is this facet's diagnosis stale"*, which is an operator question,
not a vocabulary one. Wrong tool, and it would drag diagnosis state into a
read-only surface.

The `instructions` string in `initialize` tells callers to run this first.

---

**3. `search_board(board, facets?, query?, similar_to?, limit?, exclude_ids?, include_images?, task_intent?)`**
— the whole algebra in one call, which is beyond what Mobbin's shape allows.

```
facets          {key: {any: [...], not: [...]}} — the EXACT wire form
                cleanSelection/halvesOf already parse and filter configs
                already store. A saved filter config in the UI and an
                agent's query are the same object.
query           free text → the existing embed + cosine path. One paid call.
similar_to      an entity id anchor → the free path.
limit           default 12, max 30.
exclude_ids     entity ids to omit — second-pass refinement.
include_images  default true; false for counting/survey queries.
task_intent     one sanitised sentence, carried for metering attribution.
```

**Composition order, and why:**

1. `cleanSelection(facets)` → the same sanitiser filter configs use.
2. Load the board once via `listItems(db, null, boardId)` — **not** a bespoke
   lean query. It already does face selection, the instance→entity tag union and
   `aggregateStatus`; a second assembly path is the duplication the repo's own
   rules forbid. **Measured: 94.7ms**, against **190.8ms** for a bespoke lean
   alternative — the no-duplication choice is also the fast one, because a
   correlated per-entity subquery loses to `listItems`'s two-query + JS-join
   shape. Question closed.
3. `matchesCondition(new Set(item.tags), condition)` per item — the alerts
   matcher, unchanged.
4. Rank the survivors: `query` → embed once, cosine **against the survivors
   only**; `similar_to` → the anchor's own vectors, free. Neither → newest first,
   the board's default order.
5. Drop `exclude_ids`, slice to `limit`.

**One deliberate behaviour change from `/api/search`:** the relative cutoff
(best − 0.15) is computed over the **filtered** set, not the whole board. For a
composed query that is the correct reading of "the best match among these", and
scoring only survivors is also strictly less work. Worth a comment at the call
site so nobody later "fixes" it back.

**Degradation, not refusal:** a board with no embedder must still answer facet
queries. `query` on such a board returns the facet-filtered results plus a text
line saying semantic ranking is unavailable and why — the "errors are
instructional observations" rule. `/api/search` 404s today; the MCP must not.

---

**4. `get_items(board, ids[], preset?)`** — plural deliberately; an agent that
liked four results should not make four calls.

```
in:  { board, ids: [entity ids], preset?: standard|high|max }
out: per item — every facet tag, the full per-facet reasoning, the `fit`
     sentence, the description, dimensions, a legible rendition via
     aiImageFor, and a TEMPORARY SIGNED DOWNLOAD LINK for the original
```

> **Corrected in stage 2** ([mcp-stage-2.md §1.1](mcp-stage-2.md)). This used to
> promise the original's *absolute local path* — "the honest answer for a
> self-hosted app: the agent and the gallery share a filesystem". They do not.
> The gallery is a **named Docker volume with no host-visible path at all**, so
> that field would have named a file the agent cannot open. The export is a
> signed URL, which is what Mobbin does — arrived at here for a different reason
> than theirs.

Cap `ids` at 6 (measured: a `standard` rendition is ~805 tokens, `high` ~1,880). Reasoning comes from one targeted
read over the requested entities only:

```sql
SELECT entity_ids, tag_reasoning FROM items WHERE entity_ids && $1::bigint[]
```

`listItems` deliberately does not carry reasoning — it is lazy-loaded at
[server.js:3263](../server/server.js#L3263) for the lightbox — and adding it there
would bloat every board load in the browser to serve a tool.

---

**5. `save_to_crate(board, crate, ids[])`** — stage 3, and the actual reason to
build this rather than subscribe to Mobbin.

`crates` + `crate_items` and their routes already exist
([server.js:614-660](../server/server.js#L614)); `toggleCrateItem(db, userId,
crateId, entityId)` is the write. Create-if-absent by name so an agent does not
need a crate id it has no way to know. "Search the board and save the good ones
to a crate I can open in the UI" closes the loop between the agent and the app.
Mobbin's MCP is read-only because it is someone else's library; this is the
operator's own gallery.

Gate it on `MCP_READONLY=1` being **absent** — writes are opt-out, not opt-in,
but the switch exists.

### 5.6 — Response shape: interleaved, not blob-then-images

Mobbin returns N images then one JSON blob, forcing positional binding. Emit one
`text` block per result immediately followed by its `image` block:

```
### 3 of 12 · id 8842 · score 0.81
use_case/dashboard-overview · shell/three-column · theme/dark · density/compact
core_components: data-table, command-palette · viz: kpi-cards, time-series
A dark analytics console with a slim icon rail, a dense metrics table and a
command palette open over it.
[image: 600px webp]
```

Compact lines rather than nested JSON, per Block's token-efficiency point. The
header carries the stable handle for `get_items` and `exclude_ids`. Tail the
whole response with one line:

```
matched 304 · returned 12 · refine with exclude_ids, or narrow the facets
```

That is the `has_more` / `total_count` the consensus asks for, in the form a
model will actually act on.

### 5.7 — Token budget

| per result | tokens |
|---|---|
| 600px webp preview | ~280 |
| 13 facet tags | ~55 |
| description sentence | ~40 |
| header line | ~20 |
| **total** | **~395** |

12 results ≈ **4.7k tokens**; 30 ≈ 11.9k. Hence default 12, not Mobbin's 20.
`include_images: false` drops it to ~115/result, so a 30-result facet census
costs 3.5k — which is what makes "survey the board" a reasonable thing for an
agent to do, and is the direct payoff of shipping the metadata Mobbin withholds.

### 5.8 — Metering

A `search_board` carrying `query` is one embedding call and must meter exactly
like `/api/search` does today —
`meterAiCall(db, boardId, { capability: "embed", provider, model }, usage)`
([metering.js:99](../server/metering.js#L99)). Facet-only and `similar_to`
searches are free and meter nothing, which is already true of their in-app
equivalents.

`task_intent` becomes the **attribution** dimension: "which agent session ran up
this bill" is a question the Usage tab cannot answer today. Keep Mobbin's privacy
clause verbatim in the parameter description — it is the part that stops a client
pasting a transcript into a telemetry field.

This is the right moment for the **`usage_meter.provider` namespacing migration**
that has been open since the metering arc. MCP is the third caller family; an
un-namespaced provider column was always going to collide, and stamping a false
$0 is the failure it produces.

### 5.9 — What to copy exactly, and what not to

**Copy:** two image tiers with the split stated in the description · context-cost
language with a hard ceiling · `exclude_ids` over offset pagination ·
query-writing guidance in the `query` description, interpolated with *the board's
own facets* · `task_intent` with its privacy clause · errors as instructions.

**Don't copy:**

1. **Don't starve the payload.** Mobbin withholds metadata because theirs is
   generic and it is their moat. Ours is the differentiator — ship the tags and
   the description beside the image so the model gets pixels *and* a vocabulary
   it can filter on next turn.
2. **Don't default to an LLM reranker.** `deep` earns its keep at 100k+ screens
   with a generic taxonomy. At 4,673 items with board-specific facets and a free
   local embedder, facet-narrow + cosine is already precise, and a rerank would
   put a paid call on every search in an app whose entire metering arc exists to
   keep paid calls visible. If ever wanted: a mode, off by default.
3. **Don't build one tool per content type.** The board id is the parameter.
4. **Don't ship read-only by reflex.** See `save_to_crate`.
5. **Don't build 17 tools.**

---

## Part 6 — Staging

### Stage 1 — the proof

**Full spec: [mcp-stage-1.md](mcp-stage-1.md).** In brief: `server/mcp.js` +
`server/mcp-tools.js`, `mountMcp` in `server.js`, the `restoreGate` clause,
Origin validation, the rate limiter, and **an MCP tab** in admin. Tools:
`list_boards`, `describe_board`, `search_board` (facets + query + similar,
images inline, `exclude_ids`).

**Config lives in `settings`, not the environment** — `mcp_enabled` (default
off), `mcp_token` (one per instance, plaintext like the `crypto_key_*` rows
already there), `mcp_origins`. The first draft of this arc put all of it in env
vars, which broke the app's own pattern and left the feature undiscoverable with
no way to hand the operator a working command. The tab's copy button is the
reason it is a tab.

*New mechanism:* transport + auth + one admin pane. *No migration (the `settings`
table exists), no dependency, no index.*

**Tests.** `mcp-transport.test.js`: `initialize` version echo and the
unsupported-version path; GET→405; notification→202; bad Origin→403; missing
token when required→401; malformed JSON-RPC→ `-32700`/`-32600`. `mcp-tools.test.js`
against the existing fixture db: facet composition matches `matchesCondition`
directly (the anti-drift pin — the same selection must give the same set through
both doors), `limit`/`exclude_ids` honoured, an un-embedded board degrades rather
than 404s, an unknown board id answers with the board list.

**Done when** `claude mcp add --transport http boards http://localhost:8001/mcp`
followed by *"find me dark developer-centric dashboards with a data table"*
returns twelve correct screens with images.

**Measured 2026-09-18**: `listItems` 94.7ms, `boardEmbeddings` 232.2ms, cosine
scan 3.0ms, `describe_board` GROUP BY 15.1ms. §5.5 step 2 stands. Full table in
[mcp-stage-1.md §1](mcp-stage-1.md).

### Stage 2 — depth

**Full spec: [mcp-stage-2.md](mcp-stage-2.md).** `get_items` (the full record
plus a legible rendition) and a **signed asset route**, because there is no
shared filesystem to hand a path across · `last used` on the tab ·
`task_intent` into the server log line · a board scope checklist.

*New mechanism:* the asset route. **Not** the `usage_meter.provider` migration —
see below.

### Stage 3 — the write

**Full spec: [mcp-stage-3.md](mcp-stage-3.md).** `save_to_crate`, additive and
create-if-absent · the `boardEmbeddings` `entity_ids[1]` projection fix
([db.js:3689](../server/db.js#L3689)) — harmless on `ui` (one entity per item)
but wrong under classify mode, and an MCP that returns entity ids as its stable
handle must not sit on a lossy projection · tool annotations on all five tools,
which is a stage 1/2 gap this is the right moment to close.

Two things this entry promised are **corrected** in that spec. `MCP_READONLY` is
an env var, and stage 1 already established that this feature's config lives in
`settings` and on the tab — it becomes a switch there, default on. And the
projection fix drags its two naming columns with it: `ident`/`fname` are the
*instance's* identity, which the fan-out makes the wrong grain (and which is
already wrong on every derived board).

*New mechanism:* none. No migration, no dependency, no index.

### Stage 4 — MCP Apps

**Full spec: [mcp-stage-4.md](mcp-stage-4.md). SHIPPED 2026-09-18 — built
despite that spec's own recommendation not to, which stands as written.** MCP Apps went Final on 2026-01-26 and fits a gallery unusually well, but
**Claude Code cannot render a `ui://` resource** (anthropics/claude-code#95149,
open) — and Claude Code is the client this feature's own copy-command sets up.
The workaround that issue recommends, an image content block beside the text, is
what stage 1 has shipped since day one.

Two lines of this entry are **wrong** and are corrected there. "Reusing
`public/`" does not survive measurement: `grid.js` pulls 22 modules and 253 KB
of source containing 20 `fetch()` calls, and a UI resource runs under
`connect-src 'none'`. And the SDK question, reconsidered with three stages of
evidence, answers the same way: still no.

The gate stays "used in anger", and the thing blocking that is not stage 4 — it
was that stages 1–3 sat uncommitted, so no deployed instance had an MCP
endpoint for any client to use. All four stages are on main as of 7eca785; a
droplet deploy is what now stands between the arc and its first real use.

---

## Part 7 — Risks and open questions

- **Client image handling varies.** [claude-code#31208](https://github.com/anthropics/claude-code/issues/31208)
  is closed-not-planned. Verify per client before trusting §5.7. The 600px/14KB
  default is the mitigation: a client that gets it wrong costs ~5k tokens per
  preview rather than ~25k.
- **`listItems` allocates 7.36 MB per call.** Measured at 94.7ms, which is fine
  for one call; worth watching under an agent firing ten in a row. The corpus
  cache does not help here — only a leaner projection would, and that costs the
  duplication §5.5 refuses to pay.
- **`instructions` is untested leverage.** Whether callers actually run
  `describe_board` first is an empirical question the first week answers.
- **Board-agnostic tools on a `ui`-shaped corpus.** The taxonomy makes this
  useful for `ui`; a `wardrobe` board gets the same tools and a different
  vocabulary, which is the design working. But the *value* is facet quality, and
  facet quality is per board.
- **No flow equivalent.** Mobbin's `search_flows` has no analogue here because
  boards hold no ordered sequences. If ordered sets ever matter, crates are the
  existing vehicle, and the "sample, never dump" rule is the design to copy.

## Honest assessment

The retrieval, the tagging, the embeddings, both image tiers, the rate limiter,
the meter, the membership model, **the facet matcher and its input sanitiser**
are all already here and already tested. Stage 1 is ~500 lines of new code, of
which 150 is a JSON-RPC switch statement. No new dependency, no new extension, no
new index, no sidecar, no migration.

The real question was never feasibility. It is whether 4,673 screens are worth an
agent's time versus Mobbin's 100k+, and the answer is yes for exactly one reason:
**the facets**. This board can be asked things Mobbin cannot answer, about
screens Mobbin does not have, and written back to.

If the facets ever stop being better than Mobbin's, so does the case.
