# MCP stage 4 — MCP Apps, and the client that cannot see them (2026-09-18)

> Companion to [mcp-server-plan.md](mcp-server-plan.md) (the arc) and stages
> [1](mcp-stage-1.md) / [2](mcp-stage-2.md) / [3](mcp-stage-3.md), all shipped
> and all uncommitted.
>
> **Status: SHIPPED 2026-09-18, uncommitted** — built on the user's call after
> §0's recommendation not to. Suite **1692** green across three consecutive
> full runs, live-verified on the `ui` board. §8 records what was built and
> the three things the build changed.
>
> §0 still stands as written: the client the Agents tab sets up cannot render
> any of this, and the text result it falls back to is what §5's last test
> exists to protect.
>
> Spec details below come from SEP-1865 (Final, 2026-01-26) and the `ext-apps`
> draft. The SEP page itself warns that changes made after finalization are not
> reflected there, so **every exact key and method name in §1 is re-verified
> against the current specification on the day this gets built**, not trusted
> from here.

## The one-sentence answer

MCP Apps is real, final, and a good fit for a gallery — and the client this
instance's own setup command targets **cannot render it**, which makes the
question not "how" but "for whom".

---

## 0 — The finding that should decide this

`claude mcp add --transport http boards …` is the line the Agents tab hands the
operator. It configures **Claude Code**. From
[anthropics/claude-code#95149](https://github.com/anthropics/claude-code/issues/95149),
opened **2026-09-17** — yesterday — and still open with no maintainer response:

> *"`capabilities.extensions` does not advertise `io.modelcontextprotocol/ui`,
> so the server correctly falls back to text."*

And the workaround that issue recommends to everyone hitting this:

> *"returning an image content block beside the text gets you _a_ visual in
> Claude Code today, since image content does render. It is not interactive,
> but it beats a path."*

**That workaround is what stage 1 already ships.** Every `search_board` result
carries an inline preview beside its text, sized and budgeted
([mcp-stage-1.md §5.7](mcp-stage-1.md)). The thing people are asking for as a
stopgap is the thing this server has done since the first stage.

So stage 4's honest audience is Claude **web and desktop**, VS Code, Goose and
Postman — not the terminal. That audience is not empty: stage 1's Streamable
HTTP + bearer design is exactly the remote-MCP shape Claude web wants, and
`001.itsalex.me` is exactly the address it would connect to. But it is a
different sitting position from the one this arc was built in, and nobody has
sat in it yet.

The arc doc's own gate was *"Only once stages 1–3 have been used in anger."*
They have been live-verified. They have not been used.

---

## 1 — What MCP Apps actually is

### 1.1 — An extension, negotiated

Identifier `io.modelcontextprotocol/ui`. The client advertises it in
`initialize`:

```json
{ "capabilities": { "extensions": {
  "io.modelcontextprotocol/ui": { "mimeTypes": ["text/html;profile=mcp-app"] } } } }
```

Servers **SHOULD** check that before offering UI-enabled tools. §2.1 is about
whether we can.

### 1.2 — `ui://` resources, and the tool that points at one

A predeclared resource, not an inline blob in a tool result — so hosts can
prefetch, cache and security-review the template before anything runs:

```json
{ "uri": "ui://001az-boards/board-grid",
  "name": "board_grid",
  "mimeType": "text/html;profile=mcp-app",
  "_meta": { "ui": { "csp": { … }, "permissions": …, "prefersBorder": … } } }
```

`mimeType` **MUST** be `text/html;profile=mcp-app`. The tool links to it:

```json
{ "name": "search_board",
  "_meta": { "ui": { "resourceUri": "ui://001az-boards/board-grid",
                     "visibility": ["model", "app"] } } }
```

A tool **MUST** still return a meaningful `content` array even when a UI is
available. Our tools already do; nothing about stage 1–3's output changes.

### 1.3 — The iframe talks JSON-RPC over postMessage

Not a bespoke message protocol — the same JSON-RPC 2.0, which is why the
messages stay auditable and loggable. The view calls `ui/initialize`, then
`ui/notifications/initialized`. After that it may call standard MCP methods —
`tools/call`, `tools/list`, `resources/read`, `sampling/createMessage` — plus
UI-specific ones: `ui/open-link`, `ui/download-file`, `ui/message`,
`ui/request-display-mode`, `ui/update-model-context`.

Data reaches the view as notifications: `ui/notifications/tool-input` with the
original arguments, `ui/notifications/tool-result` with `content`,
`structuredContent` and `_meta`.

**`structuredContent` is the channel stage 4 needs**, and we do not emit it
today. Stage 1 deliberately shipped text blocks only.

### 1.4 — The CSP is the constraint that shapes everything

Sandboxed iframe, `allow-scripts allow-same-origin`, and if the resource
declares no `ui.csp` the default is:

```
default-src 'none';
script-src  'self' 'unsafe-inline';
style-src   'self' 'unsafe-inline';
img-src     'self' data:;
connect-src 'none';
```

Read that for a gallery and two things fall out immediately:

- **`connect-src 'none'`** — the view cannot fetch anything. Not the instance,
  not a CDN. Everything it knows arrives in the tool result or over postMessage.
- **`img-src 'self' data:`** — images come from the view's own origin or as
  data URIs. **`'self'` is the iframe, not this server.**

External origins are whitelisted per resource through `resourceDomains`,
`connectDomains`, `frameDomains` and `baseUriDomains`; a host **MUST NOT** allow
undeclared ones. Since we serve the resource, we can generate that list from
`BASE_URL` at read time. Whether hosts accept an `http://localhost:8001` origin
in it is an open question worth testing before relying on it (§7).

---

## 2 — Four of this arc's decisions that stage 4 tests

### 2.1 — No sessions: the decision survives

Stage 1 chose statelessness deliberately — the transport spec makes
`Mcp-Session-Id` a MAY, and a search server has nothing to keep. Stage 4 looks
like it breaks that: capabilities arrive at `initialize`, `tools/list` is a
separate POST, and with no session we cannot correlate the two. The spec says to
check capabilities before offering UI tools, and we structurally cannot.

**The resolution is to not need to.** `_meta` is MCP's extension slot and
unknown keys are ignored by construction; a client with no MCP Apps support that
receives `_meta.ui.resourceUri` does exactly what Claude Code does today —
renders the text and the image, drops the rest. The SHOULD is aimed at servers
registering tools that are *useless without a UI*, and ours are the opposite
case: the spec already **requires** a meaningful `content` array, and stage 1
built one before the question came up.

So: attach `_meta.ui` unconditionally, at a cost of ~60 bytes per tool, and keep
the stateless transport. Introducing sessions to satisfy a SHOULD we already
satisfy in substance would be the tail wagging the dog.

The one real cost: a host that prefetches templates will `resources/read` even
when it will never render. One small read.

### 2.2 — "Reusing `public/`" is false

The arc doc promised *"a `ui://` resource rendering the board grid
in-conversation, reusing `public/`"*. Measured:

```
grid.js pulls 22 modules, 253 KB of source, containing 20 fetch() calls
api.js bulk.js checkbox.js cluster-core.js crates.js data.js detail-open.js
dropdown.js facet-match.js filters.js grid.js kinds.js lazy-door.js modal.js
patterns.js search.js sort.js state.js tag-editor.js toast.js utils.js view.js
```

Twenty `fetch()` calls in a closure that has to run under `connect-src 'none'`.
`grid.js` is not a grid component; it is the gallery — polling, dropdowns, the
lightbox door, bulk select, the tag editor. Plus `styles.css` is 77 KB written
against that DOM.

What is honestly reusable is the part that was already written to be:
**`facet-match.js` (5.9 KB, pure, three consumers already)** and
`cluster-core.js`. The rendering is new, and it should be small — §3.

This is the same shape of correction as stage 3's `MCP_READONLY`: a line in the
arc doc written before anyone looked.

### 2.3 — The signed asset route already fits, by accident

`/gallery` and `/thumbnails` are both `requireAuth` (cookie). An iframe has no
cookie for this instance, so **neither is reachable from a view**.

The one image path that is: stage 2's signed asset route. It takes no bearer —
deliberately, so the instance token never lands in a transcript — and it skips
the Origin check, with a comment saying that gate is for JSON-RPC rebinding and
means nothing on a GET of an image. Which is precisely what an `<img>` in a
sandboxed iframe needs.

It serves the **original** file, though. For a grid we want the `.webp` thumbs
the preview blocks already read, so stage 4's one genuinely new mechanism is a
**thumbnail tier on the signed route** — same signature scheme, different
directory.

Measured, on a 30-result page of the `ui` board:

| | |
|---|---|
| card data as JSON (ids, identity, tags, filename, dims) | **15,080 bytes** |
| thumbnails, average | **13,977 B** each |
| …all 30 embedded as `data:` URIs | **~409 KB raw, ~545 KB base64** |

**So: URLs, not data URIs.** 15 KB in the tool result and thirty parallel image
GETs the host makes on its own, against 545 KB of base64 riding through the
protocol — and every byte of that base64 sits in a payload the model may also be
handed. The thumbnail tier is not a nicety; it is what keeps the result small.

That needs `resourceDomains: ["<BASE_URL>"]` in the resource's `_meta.ui.csp`,
generated per instance at `resources/read` time.

### 2.4 — The SDK question, reconsidered

Stage 1 hand-rolled the transport rather than take
`@modelcontextprotocol/sdk`, on the grounds that the spec's minimum for a search
server is one path, plain JSON, 405 on GET, no sessions — and that 150 lines of
dispatch is not worth a dependency. Stage 4 adds:

- `resources` capability, `resources/list`, `resources/read` — two more cases in
  the same switch
- `_meta.ui` on tools — a literal
- the extension declaration — a literal

That is not an SDK's worth of work. **The answer is still no**, and it is now
better supported than it was: three stages in, the dispatch is still a switch
statement, and the one thing an SDK would have bought (session plumbing) is the
thing §2.1 concludes we do not want.

The *view* side is different — it needs a JSON-RPC-over-postMessage client. That
is ~80 lines hand-rolled, and it ships inside the resource rather than into
`node_modules`, so it is not a dependency in the sense the rule cares about.
`@mcp-ui/client` exists and would be the alternative; taking it would put a
third-party bundle inside a sandboxed iframe we tell hosts to security-review,
which is the wrong direction for a repo that is about to be read by strangers.

---

## 3 — What the app should be

Three scopes, in increasing order of what they cost and what they prove:

**A — a grid.** Renders the search result as thumbnails with their facet values,
click to open the original. No tool calls back. Cheapest, and it turns a
vertical list of text-plus-image blocks into something scannable. Modest.

**B — a grid you can select from, and save.** Adds tick boxes and one button
that calls `save_to_crate` through the view's `tools/call`. **This is the right
stage 4.** It closes, visibly, exactly the loop stage 3 built: search → see the
grid → tick nine → save. It reuses a tool that already exists, already refuses
politely when the tab's saving switch is off, and is already additive and
retry-safe — which is what makes it safe to expose to a button.

**C — live facet refinement in the view.** The rail re-runs `search_board`
without a round trip through the model. The most valuable, because the facets
are this app's whole differentiator — and the most work, with real questions
about what a refine costs and what the model is told about it. **Not stage 4.**

Scope B, and the resource is one HTML file: inline `<style>`, inline `<script>`
(the default CSP allows `'unsafe-inline'` for both), no external anything.
`scripts/build-frontend.mjs` already bundles with esbuild and already has the
per-entry, no-splitting stance that this needs; a new entry emitting an IIFE to
inline is a small addition to a script that exists.

---

## 4 — The build, if and when

1. **The thumbnail tier** on the signed asset route (§2.3). Same HMAC, a
   `kind` segment or a suffix, and a test that a thumb link cannot be walked
   into a gallery link.
2. **`resources` capability** + `resources/list` + `resources/read`, serving one
   `ui://001az-boards/board-grid` with `_meta.ui.csp.resourceDomains` built from
   `BASE_URL`.
3. **`structuredContent` on `search_board`** — the card array the view renders,
   beside the text blocks that already exist. Stage 1's text output does not
   change; this is additive.
4. **`_meta.ui.resourceUri` on `search_board`**, unconditionally (§2.1).
5. **The view**: one HTML entry, an ~80-line postMessage JSON-RPC client,
   a grid, tick boxes, and a save button wired to `save_to_crate`.
6. **The tab** gains one line under the tool table saying which clients render
   it and which fall back to text — because §0 is a thing an operator will hit
   and should not have to discover.

---

## 5 — Tests

- `resources/list` and `resources/read` answer the declared URI, with the right
  mimeType, and the CSP names this instance's own origin and nothing else
- the resource is self-contained: **no `src=`/`href=` to anything but the asset
  route**, asserted by parsing the served HTML — the one assertion that keeps a
  future bundler change from quietly re-introducing a CDN
- a thumb link serves the thumb; the same signature does not serve the original
- `search_board`'s text content is **byte-identical** with and without the UI
  metadata — the fallback is the contract, and it is what every Claude Code user
  gets
- `_meta.ui.resourceUri` names a URI `resources/read` actually serves (the spec
  requires the resource to exist when linked)
- a browser test driving the view against a stub host: `ui/initialize`, a
  `tool-result` notification, thirty tiles, a tick, one `tools/call`. **One
  file, one page load** — stage 2 §12.5 and stage 3's review both caught this
  file's cost twice, and a view test is a third browser file.

---

## 6 — What it costs, what it buys

Roughly: a thumbnail tier (small), three protocol cases (small), one HTML entry
and its build wiring (medium), a view (medium), one browser file (expensive, in
the specific way this repo has now measured twice).

What it buys: a grid, in the conversation, for people using Claude web, Claude
desktop, VS Code, Goose or Postman against this instance.

What it does not buy: anything at all for anyone using Claude Code, which is the
client the tab tells you to set up.

---

## 7 — Recommendation

**Do not build this yet.** Not because it is hard or wrong — the spec fits this
app unusually well, and §2.3 shows stage 2 already built the one piece that a
sandboxed iframe needs. Build it when either:

- **anthropics/claude-code#95149 ships**, and the client the tab targets can
  render what the server sends; or
- **the instance is actually connected from Claude web or desktop** and the grid
  is the thing that is missing — which is the arc's own "used in anger" gate,
  and which requires the prod instance to have this code at all.

That second clause is the more pressing fact in this document: **stages 1, 2 and
3 are all uncommitted.** `001.itsalex.me` does not have an MCP endpoint. Nothing
downstream of this arc can be used in anger, by any client, until that changes —
and that is worth more than a fourth stage.

Two things to check before committing to the design, both cheap and both better
answered by experiment than by reading:

1. **Will a host accept `http://localhost:8001` in `resourceDomains`?** If not,
   the whole local-development story for stage 4 is data URIs, and §2.3's
   measurement says that is 545 KB a page.
2. **What does a UI-initiated `tools/call` do to the conversation?** Whether a
   save from the button is visible to the model, prompts the user, or is silent
   changes what the button should say.

---

## 8 — Built and verified

Built in the §4 order, on the user's call after §7 recommended against it.
**Suite 1692** (1681 before), green three times running.

### 8.1 — What shipped

| | |
|---|---|
| `server/mcp.js` | the `kind`-signed two-tier link (`/mcp/asset`, `/mcp/thumb`); `UI_EXT`/`UI_MIME`/`UI_URI`; the template read once at load; `uiMeta(baseUrl)`; `extensions` + `resources` in `initialize`; `resources/list` and `resources/read`; `thumbLink` in the tool ctx |
| `server/mcp-app.html` | the view — 10 KB, one file, no build step |
| `server/mcp-tools.js` | `facetSplit` extracted so the tile caption and the prose share one implementation; `ok(blocks, structured)`; `structuredContent` on `search_board`; the `ui: true` marker and `toolSpecs(write, uiUri)` |
| `public/admin-mcp.js` | one line under the tool table naming which clients render the grid and which fall back |
| tests | `mcp-app.test.js` (10), the view driven against a stub host inside the existing browser file, and updated capability/ctx fixtures |

**No build entry, no bundler, no dependency.** §4 planned an esbuild entry
emitting an inlined IIFE; once the view imports nothing there is nothing to
bundle, and a hand-written file is what the CSP wants anyway.

### 8.2 — Three things the build changed

**The caption estimate was 2.7× wrong.** §2.3 predicted ~4.5 KB of
`structuredContent` for 30 cards. Measured live: **11,967 bytes** — because the
`ui` board tags nine facets deep and the caption was all of them, which is also
unreadable in a one-line overlay. Capped at three facets: **7,196 bytes**. The
text block still prints the full row, because the model wants it and a tile does
not.

**The self-contained pin failed on its own documentation.** "No `src`/`href`
leaves the document" caught the view's `<img src="${esc(c.thumb)}">`, which is
the runtime signed URL, and "no `fetch(`" caught the word `fetch()` in the
header comment explaining why there is no fetch. Both now assert what they
meant: every reference must be an interpolation, and the code is checked with
comments stripped.

**The view hid its own confirmation.** The status line lived inside the save
bar, and a successful save clears the selection — which takes the bar away in
the same tick. It wrote "Saved 2 cards" and hid it before anyone could read it.
Caught by the browser test, on its first run, which is the entire argument for
having written one.

### 8.3 — Where the view test lives, and why

Not a third browser file. It uses `app.browser.newPage()` and `setContent`, so
it costs a page object and **no navigation against the server at all** — the
view talks to its host and to nothing else. A new file would have been a new
Chromium and a new Postgres clone, which is the cost that made
`welcome.test.js` and `ingest-sweep.test.js` fail twice during this arc.

Writing the stub host also reproduced a real ordering rule: the first version
created the iframe before attaching the `message` listener, so the view's
`ui/initialize` landed before anything was listening and was lost. A real host
attaches first and frames second for exactly that reason.

### 8.4 — Measured on the live `ui` board

```
resources/list                     1 resource, text/html;profile=mcp-app
resources/read                     10,024 bytes of HTML
  csp.resourceDomains              ["http://localhost:8001"]  — generated from BASE_URL
  csp.connectDomains               []                          — the view never fetches
search_board limit 30, no images   285ms
  structuredContent                7,196 bytes  (11,967 before the caption cap)
  content (text)                   18,436 bytes — unchanged by any of this
thumb link, unauthenticated        200 · image/webp · 28,182 bytes · 600x375
same link with /thumb/ -> /asset/  403  — the kind is signed, so it cannot be walked
```

Afterwards the instance was put back: `mcp%` settings dropped, endpoint 404.

### 8.5 — Still not answered

§7's two experiments both need a real host and neither can be run from here:

1. ~~**Will a host accept `http://localhost:8001` in `resourceDomains`?**~~
   **Answered — as far as it can be here.** A browser test now composes the
   spec's whole default policy, widened by the `resourceDomains` the server
   ACTUALLY serves, and asks Chromium: an undeclared origin is blocked, ours is
   not. So a plain `http://127.0.0.1:<port>` origin is honoured by CSP and local
   development renders thumbnails. What is still unknown is whether a given host
   applies its own extra validation before composing that policy — the CSP
   mechanism is fine; a host's own opinion about `http` is not testable here.

   Writing that test found the sharp edge the hard way: the first version set
   only the `img-src` directive, and `script-src` fell back to
   `default-src 'none'` — which blocked the test's own probe script. The view's
   inline `<script>` lives or dies by that one `'unsafe-inline'`.
2. **What does a UI-initiated `tools/call` do to the conversation?** The Save
   button works against a stub. Whether a real host prompts, tells the model, or
   does it silently changes what that button should say.

And §0 is unchanged: none of this is visible from Claude Code.

---

## 9 — The flake this arc kept hitting, fixed

Three times across stages 2–4, a full parallel run failed on a test in a file
none of this arc touched: `welcome.test.js` twice, `ingest-sweep.test.js` twice.
Each time it passed in isolation, and each time the working theory was load —
that the browser files were simply too expensive and were starving their
neighbours. Stage 2 §12.5 rewrote a file on that theory; stage 3's review pass
trimmed a round trip on it.

The theory was wrong, or at most half right. Both tests contained a **specific,
documented race**, and load only widened the window.

`ingest-sweep.test.js` carries this comment above its own helper:

> *"The run-state stamp and the job-log row are written separately, and runOnce
> below only waits for the stamp … a test that snapshots the log can catch it a
> row short; the row then lands during the next run and that run gets blamed for
> writing it. Wait for the count instead."*

…and provides `jobRowsAtLeast(id, n)` to do exactly that. **Two tests were not
using it** — they read `(await jobRows(id))[0]` straight after `runOnce`, which
is the case that comment describes, and were then asserting against the previous
run's row. Both now wait for the count.

`welcome.test.js` waited for `#w-disclose` to exist and immediately counted
`#w-disclose-marks svg`, which paints a tick later. Now it waits for the marks.

**Six consecutive full runs green** afterwards, against a prior rate near one
failure in seven. Six runs is not proof on its own — at that rate the odds of a
clean streak are about 2 in 5 — but the evidence that matters is not the streak:
it is that each failing test was reading a value its own file documents as
arriving asynchronously, and now waits for it.

The lesson worth keeping is the one that cost three rounds to learn: **"it only
fails under load" is a description, not a diagnosis.** Load is what makes a race
visible. Twice this arc treated the symptom by making the suite cheaper, which
is real work and did not fix anything.
