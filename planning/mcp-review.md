# MCP review pass — five defects in the shipped arc (2026-09-18)

> Companion to [mcp-server-plan.md](mcp-server-plan.md) (the arc) and
> [mcp-stage-1.md](mcp-stage-1.md) · [2](mcp-stage-2.md) · [3](mcp-stage-3.md) ·
> [4](mcp-stage-4.md) (the four stages, all SHIPPED in 7eca785, tab redesign in
> 4e6b374).
>
> **Status: §1–3 FIXED, uncommitted. §4–5 OPEN.** Five defects, each reproduced
> against a running instance or the test harness — no finding here is reasoned
> about. The suite was 84 MCP tests green when every one of them was found,
> which is the point; §7 records what the three fixes changed and how each new
> test was proved to fail against the code it replaces.
>
> None is load-bearing for the normal install — single-image boards, a token
> set, no MCP Apps host.

## The one-sentence answer

Four of the five are the same shape — **a rule the arc states in one place and
then quietly breaks in another**: counts at the wrong grain (§1), an address the
caller writes (§2), a parameter passed under the wrong name (§4), a name that
means two things (§5) — and the fifth is two features spending one budget (§3).

---

## 1 — `describe_board` counts images; everything else counts cards

Measured on the live `cars` board — 13 entities, 27 instance rows:

| door | `function/sports` | `function/utility` |
|---|---|---|
| `describe_board` | **18** | **8** |
| `search_board` `matched` | 10 | 5 |
| the gallery's filter drawer | 10 | 5 |

`category` is declared *"one value per card"* and its values sum to 26 across 13
cards, on the same screen.

### Why

`tagCounts` groups over `items`, which is one row per IMAGE. Everything else in
the app is entity grain: `listItems` unions an entity's instances' tags (db.js,
`for (const i of instances) for (const t of i.tags)`), `matchesCondition` runs
over that union, and `filters.js` counts once per card. So the number is only
right on a board where every card has exactly one image — `ui` 4676/4676,
`wardrobe` 461/461 — and wrong wherever derived identity or multi-image cards
land: `cars` 13/27, `emma` 2/15.

### What it costs

The tool description sells this as *"the cheapest way to answer counting
questions"*. A model asks how many sports cars, is told 18, can then never find
more than 10, and has nothing to tell it which number lied. It is stage 3 §1's
`entity_ids[1]` bug — a projection answering a different question than the one
asked — one function over.

### The fix

```js
const { rows } = await db.query(
  `SELECT tag, COUNT(DISTINCT eid)::int AS n
     FROM items i, unnest(i.entity_ids) AS eid, jsonb_array_elements_text(i.tags) AS tag
    WHERE i.board_id = $1
    GROUP BY 1`,
  [boardId]
);
```

Returns exactly 10 and 5. **The SRFs must be in the FROM clause.** Two
set-returning functions in the SELECT list run in lockstep since PG10, not as a
cross product — written that way the query silently answers `function/sports` as
0, because the tag lands on a row whose `eid` padded to NULL. Cost on `ui`:
18.7ms to 23.2ms.

### The test could never have caught it

`mcp-tools.test.js` asserts `describe_board` against a copy-paste of its own
SQL, so it agrees with the implementation by construction. The check that would
have caught it is the one this file's header already claims as its rule: for
each facet value, **`describe_board`'s count must equal `search_board`'s
`matched` for that value.** One selection, one number, whichever door.

---

## 2 — The loopback gate trusts a header the caller writes

Against this app through the test harness, `mcp_token` cleared:

```
no header                  -> 200
XFF 203.0.113.7            -> 401
XFF 127.0.0.1              -> 200   <-- every tool, no token
XFF 203.0.113.7, 127.0.0.1 -> 200
```

### Why

`isLoopback` reads `req.ip`, and with `trust proxy 1` that is the last
`X-Forwarded-For` entry, whatever it says. Confirmed against bare express:
`XFF=127.0.0.1` yields `req.ip=127.0.0.1` from a socket that is loopback only by
coincidence.

The irony is three lines up. The Origin gate refuses `req.get("host")` in those
words — *"Host is whatever the caller wrote"* — and `req.ip` is too.

### What it costs

Needs the token cleared (the pane offers exactly that, as "local clients only")
and the port reachable without a proxy that appends XFF. `docker-compose.yml`
publishes `8001:3001` on 0.0.0.0 and the caddy service is profile-gated behind
`COMPOSE_PROFILES=edge`, so a bare `docker compose up` is precisely that setup.
Grants every read tool plus crate writes, as the admin. Behind Caddy it is safe:
Caddy appends the real client IP last, so the chain ends honest.

### The fix

`req.socket.remoteAddress` alone is NOT the answer — it is wrong in the other
direction, because a reverse proxy on the same host makes every remote request
look loopback. Both halves:

```js
const isLoopback = (req) =>
  !req.get("x-forwarded-for") &&
  (LOOPBACK.has(req.socket.remoteAddress) || !!req.socket.remoteAddress?.startsWith("127."));
```

Direct spoof: header present, refused. Same-host proxy: the proxy added the
header, refused, correctly. Real `npm run server` on the machine: no header,
loopback socket, allowed — which is the whole case the path exists for.

### The test

Both assertions in `mcp-transport.test.js`'s "no token means local clients only"
pass unchanged. Add a third: `xff: "127.0.0.1"` must be 401. It returns 200
today and 401 after, with no change to the harness — the `xff` option already
does everything needed.

---

## 3 — Thumbnails and tool calls spend one 60/min bucket

Two grid renders at `limit: 30` inside one minute, against the harness:

```
render 1: 30 thumb GETs {403:30} · then tools/list -> 200
render 2: 30 thumb GETs {403:29, 429:1} · then tools/list -> 429 too many requests
```

### Why

One `limiter` instance, mounted on both the signed asset route and `POST /mcp`,
keyed by IP. An MCP App grid is one `<img>` per card, so a 30-card result spends
half the minute's budget on pictures.

### What it costs

MCP Apps hosts and `get_items` download links only — inline previews come off
disk and never touch the route. Two consequences: **the agent's next tool call
dies because the user's browser loaded images**, and a 429 aimed at an `<img>`
delivers a JSON body. Stage 1's known-gaps note records that every client shares
one bucket under Docker; it does not record that the grid spends it.

### The fix

Separate budgets — images are cheap and bursty, RPC is neither:

```js
const limiter = rateLimit({ windowMs: 60_000, max: 60 });        // POST /mcp
const assetLimiter = rateLimit({ windowMs: 60_000, max: 600 });  // /mcp/:kind/...
```

600 is twenty full renders a minute. Worth giving the asset path a 429 an
`<img>` can survive — an empty body rather than JSON.

---

## 4 — The empty-crate hint never prints

With saving switched ON:

```
"The crate "Empty one" on "Probe board" is empty."
```

The sentence the code is trying to say ends `… is empty. save_to_crate adds to
it.`

### Why

The short-circuit for a crate with no members passes `args` into a parameter
named `ctx`, and `emptyResultText` reads `ctx.write` — so it reads `args.write`,
undefined, and drops the half-sentence. The other call site passes `ctx`
correctly but cannot reach that branch: an empty crate always short-circuits
above it, because `item_count` and `crateItemIds` read the same table. **The
branch is unreachable from both directions.**

### The fix

`emptyResultText(board, inCrate, hasFacets, ctx, [])`.

The existing test asserts the sentence and stops one clause short of the bug,
which is why three green runs said nothing — the same shape as stage 2 §12.3's
"the edit that was supposed to teach it about crates silently did not apply".

---

## 5 — `save_to_crate` and `search_board` disagree about what a name means

A board holding one crate, `Shortlist`, public, owned by somebody else:

```
save_to_crate "Shortlist" -> Saved 1 card to "Shortlist" on "Probe board". The crate now holds 1.

crates after:  Shortlist · owner=admin · public=false · 1 card
               Shortlist · owner=other · public=true  · 0 cards

search_board crate:"Shortlist" -> matched 1
```

The shared crate stays empty. The agent reports success. The follow-up search
silently reads the new copy — `listCrates` orders own-crates-first — so nothing
anywhere says the two are different.

### Why

Reads go through `resolveCrate`, which uses `listCrates`: yours PLUS anyone's
public ones on the board. Writes skip it entirely and call `createCrate`, whose
unique key is `(user_id, board_id, name)`. Different lookup, same string. The
tool description's *"adds to it if it does [exist]"* is true only of crates the
acting user owns — and it is the same description that tells the model to check
the names first *"so you add to one rather than making a near-duplicate"*.

### The fix

Not "write to theirs": `addCrateItems` gates on `user_id` and should. So make
the collision visible instead of silent —

- `crateSection` prints name and count only. Add the owner when the crate is not
  the acting user's, so the model can see two `Shortlist`s and tell them apart.
- `save_to_crate` names which one it wrote to when a visible crate of that name
  is not the one it used: *"Made your own crate "Shortlist" — there is also a
  public one owned by Other, which an agent cannot add to."*

Refusing outright is the other option and the wrong one: it strong-arms a caller
out of a legal action over someone else's choice of name.

---

## 6 — Checked and found fine

Suspected, measured, not a problem — recorded so the next pass does not re-open
it.

- **`bigint` round-tripping.** `entity_ids` (OID 1016) and `COUNT` (OID 20) both
  have parsers set at the top of db.js, so `byEntity.get(Number(id))` and
  `valid.has(id)` land. `similar_to` would fail silently otherwise.
- **`recordsFor`'s `entity_ids && $1`** rides `idx_items_entities`, the GIN index
  from migration 0025.
- **The signed asset route.** Live: a thumb serves 200 `image/webp`, a tampered
  signature 403, and `/mcp/thumb/…` edited to `/mcp/asset/…` 403 — the kind is
  in the signature, exactly as stage 4 §2.3 claims.
- **The events wiring** (uncommitted, board-events arc): `flushEvents(req)` runs
  unconditionally in server.js's finish hook, so `ctx.touched` reaches it. Tool
  errors answer HTTP 200, but mcp.js guards on `!result?.isError` before it
  queues.
- **Live timings**, `ui` board: `describe_board` 25ms / 7.6KB, `search_board`
  111ms / 10KB without previews, 109ms / 145KB with twelve, 430ms / 215KB with a
  meaning query (the embed call and 7MB of vectors).

### Protocol nits, deliberately left

- **JSON-RPC batches are a parse error** while `2025-03-26` is still advertised,
  which allowed them. No client in the field sends one.
- **`structuredContent` ships with no `outputSchema`.** Optional in the spec;
  declaring one would pin a shape stage 4 may still move.
- **No argument validation against the input schemas.** Every handler cleans its
  own input (`cleanIds`, `clamp`, `String()`), which is the right layer — but it
  does mean `additionalProperties: false` is advice, not a gate. §4 is what that
  looks like when it goes wrong from the inside.

---

## 7 — Built and verified (§1–3)

### 7.1 — What changed

| file | change |
|---|---|
| `server/mcp-tools.js` | `tagCounts` counts `COUNT(DISTINCT eid)` over a FROM-clause cross product |
| `server/mcp.js` | `isLoopback` reads the socket and refuses any request carrying `X-Forwarded-For` |
| `server/mcp.js` | `assetLimiter` — a second 600/min window, wired to the signed asset route |
| `test/mcp-tools.test.js` | the count test now checks the OTHER door, on a fixture with a two-instance card |
| `test/mcp-transport.test.js` | two spoofed-loopback assertions inside the existing local-only test |
| `test/mcp-asset.test.js` | 61 image GETs must not refuse the next `tools/list` |

**Suite 1714 (browser included) green**, 85 of them MCP's — one test replaced,
one added. Nothing outside these files needed changing: `tagCounts`,
`isLoopback` and the asset window have no caller but this one.

### 7.2 — Each new test was proved to fail against the code it replaces

A test written after the fix is a test that has never seen the bug. So each was
run against the reverted file first:

```
tagCounts reverted   -> not ok — describe_board counts what search_board matches, in cards
                        'two cards carry it, not three rows'  (read: dark (3))
isLoopback reverted  -> not ok — no token means local clients only
assetLimiter unwired -> not ok — a grid's images do not spend the agent's request budget
                        'image 40 was throttled'
```

Image **40**, not 60 — the earlier tests in that file had already spent a third
of the shared window, which is the finding restated by accident.

### 7.3 — One thing the build dropped

§3 above suggests giving the asset route's 429 an empty body instead of JSON,
"so an `<img>` can survive it". It does not survive it either way — a 429 is a
broken image whatever the body says — and buying that would mean a new option on
`ratelimit.js` for one caller. The budget split is the whole fix; the body is
ceremony.
