# MCP stage 3 — the write, and one projection that has been lying (2026-09-18)

> Companion to [mcp-server-plan.md](mcp-server-plan.md) (the arc),
> [mcp-stage-1.md](mcp-stage-1.md) (transport, auth, three read tools, the
> Agents tab) and [mcp-stage-2.md](mcp-stage-2.md) (`get_items`, the signed
> asset route, board scope).
>
> **Status: SHIPPED 2026-09-18 in 7eca785.** Suite 1679 (browser included)
> green across three consecutive full runs, exercised against the live `ui`
> board. §10 records what was built and the two things the build changed.
>
> Every number below was measured against the running container, not reasoned
> about.
>
> The arc doc promised this stage as "`save_to_crate` with create-if-absent and
> `MCP_READONLY` · the `boardEmbeddings` `entity_ids[1]` projection fix". Both
> halves survive the deep dive. **`MCP_READONLY` does not** — see §3.

## The one-sentence answer

Stage 1 lets an agent find things and stage 2 lets it use them; stage 3 lets it
**give something back** — one additive `save_to_crate` — and repairs the one
place the retrieval layer quietly answers a different question than the one it
was asked.

---

## 0 — What the live instance actually says

Everything in this stage was sized against the running compose instance first.
Four of these numbers changed the plan.

| Question | Answer | What it changed |
|---|---|---|
| Items with `cardinality(entity_ids) > 1` | **0**, across all 8 populated boards | The `entity_ids[1]` bug is real but **latent**. No live data reproduces it; the proof has to be a constructed fixture. |
| Boards configured for classify mode | **1** (`emma`, "Which of these people appear in this photo?") | The bug has a live *configuration* even without live *data*. One two-Emma photo is all it takes. |
| Crates on the instance | **0** | §2.1. The write tool targets a feature no human here has used once. |
| Favorites / saved filter configs | **0** / **0** | Same. None of the three per-user save vehicles has ever been used. |
| Users | **4** | "Whose crate?" is a real question, not a single-operator formality (§2.3). |
| Orphan instances (`entity_ids = {}`) | **0** | The `?? row.id` fallback in three consumers is dead code in practice (§1.2). |

```
 board_id (populated)                  | cardinality | count
 --------------------------------------+-------------+-------
 64443caf… (ui)                        |           1 |  4673
 637bb1f8… (wardrobe)                  |           1 |   461
 40489422… (stocks test)               |           1 |    32
 c40a4671… (cars)                      |           1 |    27
 cebd157f… (resumes test)              |           1 |    18
 7148a768… (emma)                      |           1 |    15
 4abb0064… (boats)                     |           1 |     4
 d61e8dbf… (transcriber test)          |           1 |     2
```

---

## 1 — The projection that has been lying

[db.js:3689](../server/db.js#L3689), `boardEmbeddings` — the one read behind
semantic search, find-similar, the meaning-clusters rail **and** the MCP's own
`similar_to` ranking:

```sql
SELECT id, entity_ids[1] AS entity_id, embedding,
       payload->>'identity' AS ident,
       payload->'files'->0->>'original_name' AS fname
FROM items WHERE board_id=$1 AND embedding IS NOT NULL AND embedding_model=$2
```

Vectors are stored **per instance**. Results speak in **entity** ids, which is
correct — an entity is what a card is. `entity_ids[1]` is the translation, and
it is only right when an instance belongs to exactly one entity.

Classify mode is the supported configuration where it does not. `setItemEntities`
says so in as many words ([db.js:2870](../server/db.js#L2870)): *"Length 1 is the
extract-mode norm; length N is classify."* A photo of two Emmas is one instance
with `entity_ids = {watson, stone}`, and this query silently throws Stone away.

### 1.1 — What breaks, exactly

Four consumers, all reading `row.entity_id ?? row.id`:

| Consumer | Symptom for the dropped entity |
|---|---|
| `/api/search` ([server.js:3079](../server/server.js#L3079)) | Never surfaces, for any query the shared instance would have matched. |
| `/api/search/similar` ([server.js:3109](../server/server.js#L3109)) | **404 `item not embedded yet`** — the anchor filter finds no vectors for it, although its instance has one. The sharpest symptom, and the one a user would report as a bug. |
| `/api/boards/:id/meaning-clusters` ([server.js:3177](../server/server.js#L3177)) | Absent from the carving entirely. Since the clusters rail is a *filter*, the card is unreachable by every cluster selection. |
| `rank()` ([mcp-tools.js:578](../server/mcp-tools.js#L578)) | `similar_to: <that id>` answers *"has no stored vector yet, so similar-to ranking was skipped"* — the agent is told the data is missing when it is present. |

The pathological case is not exotic: an entity that only ever co-occurs, and
always second, has **zero** vectors anywhere in the system. On the `emma` board
that is "Emma Stone, who is only ever photographed next to Emma Watson".

**This is why it belongs to the MCP arc.** An agent's `similar_to` and
`exclude_ids` both take entity ids as stable handles. A handle that sometimes
names nothing is worse than no handle at all, because the failure reads as
"no data" rather than "wrong lookup".

### 1.2 — The fix, and what it costs

Return the array; fan out in JS. Not `unnest` in SQL — that would duplicate the
bytea per entity, and the bytea is the whole cost of this read.

```sql
SELECT id, entity_ids, embedding
FROM items WHERE board_id=$1 AND embedding IS NOT NULL AND embedding_model=$2
```

`entity_ids` already arrives as an array of **Numbers**: the OID 1016 parser at
[db.js:25](../server/db.js#L25) was registered for exactly this column. No
coercion, no new parsing.

Each consumer's `const eid = row.entity_id ?? row.id` becomes a loop over
`row.entity_ids`. The `?? row.id` fallback **goes away** rather than becoming
`|| [row.id]`: an instance with no entity is an orphan that `cleanupOrphans`
removes, there are zero of them live, and answering with an item id in a payload
that promises entity ids produces an id no card will ever match. Silently
dropping the row is the honest degradation.

> **This paragraph is wrong and the build did not do it — see §10.2.** The
> fallback stays, in one place, because 23 test fixtures make entity-less items
> that production cannot, and narrowing rows this fix is not about is not part
> of this fix.

**Measured** (5 runs each after a warm-up, inside the app container, `ui` board,
4,673 embedded rows):

```
today:  median 209.1ms   min 198.8   max 217.1
fixed:  median 203.6ms   min 196.4   max 228.7
```

Payload composition, same rows:

```
 rows | vectors | name_strings | entity_id_arrays
------+---------+--------------+------------------
 4673 | 7010 kB |       260 kB |           132 kB
```

**The correct projection is free.** It drops 260 kB of name strings (§1.3) and
adds 132 kB of arrays in place of ~37 kB of scalars — net slightly smaller,
which is why the medians sit within noise of each other. This matches stage 1's
finding that the ~230ms is node-postgres moving 7 MB of bytea and nothing else:
no projection change moves that number, and none of these is big enough to try.

### 1.3 — The naming columns the fan-out makes wrong

`ident` and `fname` exist for one caller: the meaning-clusters medoid title and
handle hash. They are the **instance's** identity, and the fan-out makes that
grain wrong — entity Stone would be titled by a file that is mostly about
Watson, and two clusters could carry the same title.

It is already wrong today, on every derived board. Measured on `emma`:

```
  id  | entity_ids |      item_ident      |    entity
 -----+------------+----------------------+-------------
 5243 | {33215}    | 55b62fa2dddea3bd.jpg | emma watson
 5246 | {33215}    | e37064110c1404db.jpg | emma watson
```

The cluster title renders `most typical: 55b62fa2dddea3bd.jpg` where the board
knows the answer is `emma watson`.

So both columns come out of `boardEmbeddings`, and the clusters route names its
entities from the entities table after the collapse — one
`SELECT id, identity, display_name FROM entities WHERE id = ANY($1)` over the
entity ids it already has. Fewer rows than items by construction, a column that
is actually about the thing being named, and the read above gets 260 kB lighter.

The gibberish `handleFor` hash is unaffected in kind — it hashes whatever key it
is given, and a stable entity identity is a better stable input than a stable
filename.

### 1.4 — The other `[1]` I looked at and left

[db.js:4518](../server/db.js#L4518), `firingMatches`:
`COALESCE(e.id, i.entity_ids[1]) AS live_entity_id`.

Left alone. That `[1]` is the **fallback branch** — the recorded entity has
already been merged away and deleted, and the query is guessing which card a
dead alert link should now open. One link needs one target; picking the first
current parent is as defensible as any other rule, and the comment above it
already says it is best-effort. A lossy projection in a lookup is a bug; a lossy
projection in a documented guess is the guess.

The `entity_ids?.[0]` uses in `worker.js` are the same shape — naming one item
in a log line — and stay.

### 1.5 — How it gets proved

A board with an instance deliberately given `entity_ids = [A, B]`, then:

*(Built as its own file, [test/mcp-entity-fanout.test.js](../test/mcp-entity-fanout.test.js),
rather than inside `embed-sweep.test.js` as planned: that file's fixtures make
entity-less items on purpose, and a fan-out fixture sitting among them would
read as more of the same instead of as the one case that is different.)*

- `/api/search` returns **both** A and B for a query the shared text matches
- `/api/search/similar?item=B` returns results (**today: 404**)
- `meaning-clusters` places both A and B
- MCP `search_board` with `similar_to: B` ranks instead of noting a skip

Written against the current code first. If it passes before the fix, the fixture
is wrong — that is the lesson from stage 2 §12.1, where the first multi-instance
test passed against deliberately broken code because on a default board every
candidate answer coincides. **B must be second in the array**, or the test proves
nothing.

---

## 2 — The write

### 2.1 — The crate is the right vehicle, and nobody has ever used one

Zero crates. Zero favorites. Zero filter configs. Every per-user save vehicle in
this app is unexercised — and `toolbar.js:619` means the crates button **does not
render at all** until a board has one, so on this instance the control is
invisible.

That is not an argument against. It is the most interesting thing in the stage.

A human curating by hand does not need a named set; they scroll. An agent that
has just composed a three-facet query, reranked it by meaning, read twelve
descriptions and picked nine has produced something that **exists only in the
transcript** unless it can hand it back. The crate is the app's existing answer
to "a named set of cards on one board", it cascades correctly on board delete
(unlike `settings`, which stage 2 §12.2 had to work around), and it already
appears in the toolbar, the filter state and the delta-poll stamp.

The agent is plausibly the crate's first real user. Shipping the write is how we
find out, and the answer is cheap either way.

**Considered and rejected: writing a `filter_configs` row instead.** A saved
facet selection is *live* — it keeps matching as the board grows, where a crate
freezes twelve ids. Tempting, and genuinely better for queries the facets fully
express. But that is exactly the case where the agent added nothing: the human
could have clicked those chips themselves. The agent's value is the part the
facets **cannot** say — the semantic rerank, the twelve descriptions read, the
nine kept. That judgment is a set of ids, not a selection. Crate.

Both is worse than either. Two write tools for two unused features, to find out
which one people want, is the speculative-complexity rule failing out loud.

### 2.2 — `toggleCrateItem` is the wrong primitive for an agent

[db.js:1412](../server/db.js#L1412) is a **toggle** — it exists for a checkbox.
Called twice with the same id, it removes what it added.

MCP clients retry. A model unsure whether its call landed calls again; so does a
transport-level retry after a slow response. A `save_to_crate` built on the
toggle would let the second attempt **silently un-save the work** and answer
"done" both times. Nothing in the protocol prevents this and nothing in the app
would record it.

So: a new `addCrateItems(db, userId, crateId, entityIds)` — ownership check,
board check, bulk `INSERT … ON CONFLICT DO NOTHING`, touch each entity, return
`{ added, skipped, count }`.

And per *don't inherit past decisions*: `toggleCrateItem`'s add branch becomes a
call to it with a single id. Same insert, same board check, same `touchEntity` —
one implementation of "put this card in this crate" instead of two free to drift.
The route at [server.js:650](../server/server.js#L650) keeps its toggle
semantics; the checkbox still toggles, because that is what a checkbox means.

`ON CONFLICT DO NOTHING` is what earns `idempotentHint: true` in §4. It is not a
label; it is the reason the label is true.

### 2.3 — Whose crate?

`crates.user_id` is NOT NULL with `UNIQUE(user_id, board_id, name)`. There is no
such thing as an instance-level crate, and inventing one is a schema change to
serve one caller.

The MCP already acts as somebody: `actingUser()` resolves `ADMIN_EMAIL`
([mcp.js:177](../server/mcp.js#L177)), which is how every read is scoped. The
write uses the same identity — anything else would mean an agent that reads as
one user and writes as another.

The tab **already says so**: *"Connections act as alex@…"*. That line was written
for the reads; the write is what makes it load-bearing. With four users on this
instance it is a real statement, not a formality.

Consequence worth naming: a crate created by an agent is **private to the admin**
by default (`public` defaults false, and public means "visible to other members
of this instance", not "on the web"). Fine, and unsurprising.

Edge, accepted: if another user has a *public* crate of the same name,
`createCrate`'s uniqueness is per user, so the agent gets its own and the gallery
dropdown shows two rows with the same name — one suffixed with its owner. That is
already what happens between two humans. Not a new problem; not fixed here.

### 2.4 — Additive only

No remove. No reorder. No rename. No delete.

The cost is real: an agent that saves twelve and then realises three were wrong
cannot take them out, and will make a second crate. I am taking that cost
deliberately, because additive-only is what makes `destructiveHint: false` a true
statement rather than a hopeful one, and because the human already has a one-click
remove in the gallery for exactly this.

A `save_to_crate` that can also unsave is a tool whose worst case is "the agent
quietly emptied the set I curated". There is no version of this feature worth
that.

### 2.5 — `save_to_crate`

```jsonc
{
  "name": "save_to_crate",
  "title": "Save cards to a crate",
  "description":
    "Save cards to a named set (a \"crate\") on one board, so the person can open them in the gallery. Creates the crate if it does not exist yet. Adding a card that is already in the crate does nothing, so this is safe to retry.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "board": { "type": "string", "description": "The board the ids came from." },
      "crate": { "type": "string", "maxLength": 64,
                 "description": "The crate's name — created if it does not exist. Call describe_board to see the names already in use." },
      "ids":   { "type": "array", "items": { "type": "integer" }, "minItems": 1, "maxItems": 100,
                 "description": "Item ids from a search_board result." },
      "task_intent": { "type": "string", "maxLength": 200, "description": "…as elsewhere." }
    },
    "required": ["board", "crate", "ids"],
    "additionalProperties": false
  },
  "annotations": { "readOnlyHint": false, "destructiveHint": false,
                   "idempotentHint": true, "openWorldHint": false }
}
```

`maxItems: 100` matches `exclude_ids`, and a bulk insert of 100 rows is nothing.
The `MAX_ITEMS: 6` ceiling on `get_items` exists because renditions cost tokens;
nothing here costs tokens.

Name handling: `createCrate` already trims and slices to 64. The answer must
**name what it actually called it**, because a silently truncated name is one the
agent will fail to find again.

The answer, in full:

```
Saved 9 cards to "Dark dashboards" on ui. 3 were already in it; the crate now holds 12.

2 ids are not cards on this board and were skipped: 88231, 88999.

Open it from the crates button in the gallery toolbar. That button only appears
once a board has at least one crate, so this may be its first time on screen.
```

No images. The caller has already seen these cards; re-rendering them is pure
cost. That last paragraph is the one thing only this server knows, and leaving it
out would ship a write whose result the person cannot find.

A call where **no** id resolves is `isError` — the same rule as `get_items`
(stage 2 §12 removed a dead guard for exactly this shape): the likeliest cause is
ids from another board's search, and the message says so.

### 2.6 — Closing the loop without a new tool

A write the agent cannot read back is a write into a hole. Two small additions,
no fourth read tool:

**`describe_board` gains one closing line.** It already answers "what do I need to
know before searching this board". Its crates are part of that:

```
Saved sets (crates) on this board: "Dark dashboards" (12), "Onboarding" (4).
Pass crate: "<name>" to search_board to search inside one.
```

One query, run where the caller already looks.

**`search_board` gains `crate`.** Resolved by name against the visible crates
(own + public — that is `listCrates`' existing rule, **reused, not a second
visibility query**), then applied as a membership filter in the same position as
the facet filter: before ranking, before `exclude_ids`. An unknown name is
`isError` listing the names that do exist, matching how `resolveBoard` answers a
wrong board id.

Implementation note: **do not** pass `userId` into `listItems` to get `crateIds`.
That would add the crate and favorites lookups to the measured 95ms search path
on every call, to serve the rare one. A direct
`SELECT item_id FROM crate_items WHERE crate_id=$1` into a Set, only when
`args.crate` is present, costs nothing when it is absent — and the comment at
[mcp-tools.js:398](../server/mcp-tools.js#L398) explaining why `userId` is null
stays true.

---

## 3 — `MCP_READONLY` was wrong before it was written

The arc doc named an env var. Stage 1 already made this mistake once and
corrected it: config lives in `settings` and shows up on the tab, because an env
var makes the feature undiscoverable and un-tellable — there is no way to hand
the operator a working command from a page that cannot see the setting.

So: **one switch on the Agents tab**, stored as `mcp_write`.

### 3.1 — Default on

Stored `"0"` means off; absent or `"1"` means on. The *negative* is the stored
value so that absence reads as enabled — the same stance `liveScope` takes on
this very pane, where an empty board list means all of them. Absence is not a
claim.

Why on:

- The user's stated preference for this feature is **ease of setup over
  security**, and a read-only default is one step away from that.
- The client already has the human in the loop. That is what the MCP spec's
  confirmation model and §4's annotations are *for*: a client can auto-approve
  the four read tools and prompt on the write. A server-side default-off would be
  this app second-guessing a decision the client makes better, with the
  operator's actual context in front of them.
- The blast radius is "there is a crate I did not ask for" — removable in one
  click, with nothing destroyed.
- *Flexibility over guardrails*: defaults, not laws. The switch exists so the
  operator who wants a hard no has one. It does not exist to make everyone else
  opt in to the feature they already switched on.

### 3.2 — Hidden from the list, readable when called anyway

Off means the tool is **absent from `tools/list`**. A vocabulary that offers what
the server will refuse is a lie — and it is the tab's tool table too, which
renders from `toolSpecs()`, so flipping the switch visibly adds and removes the
row. Flip it, watch the list change: the control explains itself.

But a client that listed before the flip will still call it, and
`METHOD_NOT_FOUND` tells that client nothing it can act on. So `tools/call`
answers with an `isError` **result**, not a protocol error:

> Saving is switched off for agents on this instance. The operator can turn it
> back on under Agents in the admin settings.

That is the same split stage 1 committed to and the spec asks for: protocol
errors are transport failures a model can only report; tool errors are things it
can read and route around — here, by telling the person what to click.

### 3.3 — A comment that stops being true

[mcp.js](../server/mcp.js) currently says, in `initialize`:

> *No listChanged: the tool list is a module constant and cannot change while the
> process runs, so promising notifications would be a capability we would never
> exercise.*

After this stage the first clause is **false**. The conclusion does not change,
and the new reason is better: we still do not declare `listChanged` because we
have no channel to announce on — GET is 405 by design, there is no SSE stream,
and a client re-lists when it reconnects. The spec is explicit that `listChanged`
describes whether the server *will emit notifications*, not whether the list may
change. Rewrite the comment to say that.

Mechanically: `gate()` already returns `cfg`. `dispatch(msg)` becomes
`dispatch(msg, cfg)`, and `toolSpecs()` / `findTool()` take the flag. No new read.

---

## 4 — The four read tools currently advertise as destructive

Not a stage 3 idea — a stage 1/2 gap that stage 3 is the right moment to close.

Content-block annotations are used (`audience: ["assistant"]`, `priority`). **Tool
annotations are not.** Per the spec, an unannotated tool is assumed
`readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: false`,
`openWorldHint: true` — the pessimistic posture. Every client seeing this server
today is being told that `list_boards` may destroy something and may call out to
the open internet.

That is merely noisy while everything is a read. The moment one tool genuinely
writes, it is actively harmful: the client cannot distinguish the write from the
reads, so either everything prompts or nothing does. Confirmation fatigue is the
documented failure mode — users trained to approve on autopilot.

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `list_boards` | `true` | — | `true` | `false` |
| `describe_board` | `true` | — | `true` | `false` |
| `search_board` | `true` | — | `true` | `false` |
| `get_items` | `true` | — | `true` | `false` |
| `save_to_crate` | `false` | `false` | `true` | `false` |

`openWorldHint: false` on all five is the true statement: every one of them
operates inside one Postgres database and one gallery directory. The single call
that reaches a third party is the embedding request inside `search_board`, which
is this instance's own configured provider doing this instance's own work — not
an open world of entities the tool discovers.

`destructiveHint` is omitted on the reads because the spec only gives it meaning
when `readOnlyHint` is false. Writing `destructiveHint: false` next to
`readOnlyHint: true` is noise that implies the two are independent.

Clients MUST treat annotations from untrusted servers as untrusted — that is
their problem to solve, and it is not a reason to omit true ones. A test pins
every tool as annotated, so a sixth tool cannot ship silently pessimistic.

---

## 5 — What the tab gains

One block, placed **between** the board checklist and the tool table:

```
Saving
[x] Let agents save cards to crates
    Saved sets appear in the crates menu in the gallery, under <admin email>'s
    account. Agents can add to a crate and create new ones; they cannot remove
    cards, rename or delete.
```

Between, not after, because the tool table below it is the switch's own readout —
untick the box and the `save_to_crate` row disappears from "What a connected
agent can do". Nothing left to explain.

The "Connections act as …" line stays exactly where it is. It already says the
true thing; the write is what makes anyone read it.

No new `confirm()`. Rotate and clear ask because they break working clients
irreversibly; a switch that changes what the *next* call may do is not in that
category, and *flexibility over guardrails* says stop adding ceremony to
reversible acts.

---

## 6 — What is NOT in stage 3

- **`list_crates` as a fifth tool.** §2.6 gets the same reach from one line of
  `describe_board` output and one argument on `search_board`.
- **Remove / rename / delete from a crate.** §2.4.
- **Favorites (hearts) as a second write surface.** A heart is a personal signal;
  an agent producing them means nothing. The crate is the one with a name.
- **Ingesting new material.** A genuinely different tool with a genuinely
  different blast radius, touching the connector and worker pipelines. Not
  smuggled in behind "the write stage".
- **`usage_meter.provider` namespacing.** Still open, still not this arc — the
  MCP adds no provider and stage 3 spends no tokens.
- **A README screenshot of the Agents tab.** Still owed (every other admin tab has
  `docs/screens/back/01..06`); still blocked on the README being a prose-free WIP
  placeholder.

---

## 7 — Tests

**`test/embed-sweep.test.js`** (extend — it already owns all three HTTP consumers):

1. one instance, two entities, B second → `/api/search` returns both
2. → `/api/search/similar?item=B` answers (**today: 404**)
3. → `meaning-clusters` places both
4. cluster titles name the **entity**, not the instance filename, on a derived
   board

**`test/mcp-write.test.js`** (new):

5. creates the crate when absent, with exactly that name, owned by the acting user
6. adds to the existing crate rather than making a second
7. **called twice with the same ids, adds nothing and says so** — the anti-toggle
   pin, and the one test that would have caught §2.2
8. ids from another board are skipped and **named**; all-bad is `isError`
9. a board outside `mcp_boards` refuses the write, not only the read
10. a >64-char name is trimmed and the answer reports the trimmed name
11. writes off → absent from `tools/list`
12. writes off → `tools/call` is an `isError` **result**, not `METHOD_NOT_FOUND`
13. `search_board` with `crate` filters to members; an unknown name is `isError`
    naming the real ones
14. `describe_board` names the board's crates

**`test/mcp-tools.test.js`** (extend):

15. every tool carries annotations; every read is `readOnlyHint: true`; the write
    is `readOnlyHint: false, destructiveHint: false, idempotentHint: true`.
    Asserted over the registry, so a sixth tool cannot ship unannotated.

**`test/crate-pop.test.js`** (extend): the toggle still toggles after its add
branch is rerouted through `addCrateItems`.

**No new browser test.** The switch is one checkbox on a pane whose arc is already
driven end-to-end by
[test/browser/mcp-tab.test.js](../test/browser/mcp-tab.test.js), and stage 2 §12.5
is explicit about what adding page loads to that file did to *other* files'
timing. The assertion — untick the box, the tool row disappears — folds into the
first existing test, which already loads that pane and reads that table. Zero new
page loads.

---

## 8 — Risks and open questions

- **The projection fix has no live reproduction.** Zero multi-entity rows exist,
  so the fixture is the only proof, and a fixture that does not put B second
  proves nothing (stage 2 §12.1). Write the test against unfixed code first and
  watch it fail.
- **Touching three shipped routes for a latent bug.** `/api/search`,
  `/api/search/similar` and the clusters rail are all in daily use. The fan-out is
  behaviour-preserving for `cardinality = 1`, which is 100% of live rows — but
  "preserving on all current data" is exactly the kind of claim that wants the
  full suite, not reasoning.
- **Nobody has ever made a crate.** The write may land in a feature that stays
  unused, in which case stage 3 is a correctness fix plus an experiment. That is
  an acceptable outcome and a cheap one; it is not an acceptable *surprise*, so it
  is written down here.
- **Default-on writes.** If an operator is annoyed that an agent made a crate, the
  default was wrong and the switch flips. Reversible in both directions, which is
  the whole reason the default is allowed to be the convenient one.
- **Annotations are advisory.** Clients may ignore them entirely. Setting them
  correctly is still free and still right.

---

## 9 — Build order

1. **The projection fix**, alone, with its tests. Independent of everything else,
   touches shipped routes, and wants a clean full-suite run of its own before
   anything is stacked on it.
2. **`addCrateItems` + rerouting `toggleCrateItem`**, with the existing crate tests
   green. Pure db layer, no MCP.
3. **`save_to_crate` + the switch + the `findTool`/`toolSpecs` threading.**
4. **`describe_board`'s crate line + `search_board`'s `crate` argument.**
5. **Annotations on all five tools**, and the comment rewrite in §3.3.
6. **The tab block.**

1 and 2 are each independently shippable and independently valuable. If the stage
stalls anywhere, it should stall after one of them, not in the middle of three.

---

## 10 — Built and verified

Built in the §9 order. **Suite 1679** (1663 before), green three times running
with the browser file in.

### 10.1 — What shipped

| | |
|---|---|
| `server/db.js` | `boardEmbeddings` projects `entity_ids` whole; new `entityIdsFor` (the collapse rule, one home for four callers), `entityNames`, `entitiesOnBoard`, `crateItemIds`, `addCrateItems`; `toggleCrateItem`'s add branch rerouted through it |
| `server/server.js` | the three HTTP consumers fan out; the clusters route names entities from the entities table |
| `server/mcp-tools.js` | `save_to_crate`; `resolveCrate` + `crateSection`; `crate` on `search_board`; the crates block on `describe_board`; `READ_TOOL`/`WRITE_TOOL` annotations on all five; `toolSpecs(write)` |
| `server/mcp.js` | `mcp_write` in `readConfig`; `cfg` threaded into `dispatch`; the switched-off refusal; `paneState`'s filtered tool list; the PATCH clause; the `listChanged` comment |
| `public/admin-mcp.js` | the Saving block, and an intro sentence that was no longer true |
| tests | `mcp-entity-fanout.test.js` (2), `mcp-write.test.js` (13), the annotations pin and a registry-compared tool list in `mcp-transport.test.js`, the switch folded into the existing browser test |

### 10.2 — Two things the build changed

**The `?? row.id` fallback stays.** §1.2 said it would go, on the grounds that
production cannot produce an entity-less instance — which is true, and measured:
zero live. But `insertTagged` in `embed-sweep.test.js` makes them freely, and 23
fixtures across that file lean on the old behaviour. Dropping it would have meant
rewriting a file that is not about this, to change what rows this fix has no
reason to touch. It now lives once, in `entityIdsFor`, with the reason written
next to it. Behaviour is identical for cardinality 0 and 1 and different only for
≥ 2, which is exactly the bug.

**The medoid naming needed a real assertion, twice.** The first version asserted
only that a cluster title is not a filename — which passes when the title is a
bare entity id, which is what the old naming degrades to once the payload columns
are gone. It now asserts the title *is* one of the entities' identities, and I
checked that it fails on `String(id)`.

Both halves were also checked the other way: with the projection reverted, test 2
fails `expected 20, actual 19` — the shared entity's second half missing from the
carving — and with `save_to_crate` rebuilt on `toggleCrateItem`, the retry test
fails. A pin that has not been watched failing is not a pin.

### 10.3 — The defect the live run turned up

The closing "…that button only appears once a board has at least one crate, so
this may be its first time on screen" fired on an **exact retry**. The condition
was `count === added + already` — "the crate holds exactly what I just sent" —
which looked equivalent to "I just made this crate" and is not: a retry satisfies
it too, so the person was told a control they had already used was about to
appear for the first time.

Now asked directly, before anything is created: did this board have any crates?
One `listCrates` call, which is the same question the sentence asks.

### 10.4 — Measured on the live `ui` board

```
tools/list                              5 tools, all annotated
search_board  1 facet + query, no images   362ms   matched 526 · returned 6
save_to_crate 6 ids                        170ms   "Saved 6 cards … now holds 6"
save_to_crate same 6 again                         "Saved 0 cards … 6 were already in it"
search_board  crate:"dark DATA tables"     904ms   matched 6 · returned 5 (ranked)
describe_board                                     "## saved sets (crates) / Dark data tables (6 cards)"
saving off → tools/list                    list_boards describe_board search_board get_items
saving off → tools/call                    isError result, no JSON-RPC error
```

The crate landed on `user_id 1` — the acting admin — private, as §2.3 says. The
case-insensitive resolve was exercised by that `dark DATA tables`. Afterwards the
instance was put back: crate deleted, `mcp%` settings dropped, endpoint 404.

The fan-out fix has **no live exercise** and cannot have one — zero multi-entity
rows exist. Its whole proof is the fixture, which is why §1.5 insisted on
watching it fail first.
