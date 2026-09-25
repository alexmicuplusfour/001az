# The plugin contract — from engine to ecosystem (2026-09-23)

**Status: PLANNED 2026-09-23. Stage 1 BUILT 2026-09-25, uncommitted — its
close read and build record are in the Stage 1 section. Stage 2 BUILT
2026-09-25, uncommitted — its close read rewrote the stage; the build record
follows it. Stage 3 BUILT 2026-09-25, uncommitted — its close read rewrote
the update order and the kill switch; the build record follows it. Stage 4
BUILT 2026-09-25, uncommitted — its close read found the sort already done
and moved the tag text, the conversion's host fill and the Verify; the build
record follows it. Stage 5 BUILT 2026-09-25, uncommitted — its close read
added ten fixes beside the doc, and two fresh sessions wrote working plugins
from PLUGIN.md alone; the build record follows it, then its second pass,
which fixed three defects of its own and three traps, and corrected the doc
in about fifty places. A simplification pass over Stages 1–5 followed: 157
lines fewer, one doc error fixed, recorded after Stage 5's second pass.** Deep dive
done against
HEAD `e28f0a1`; the three plugin test files (59 tests) are green locally.
Every stage below gets its own close read before a line is written, and this
doc gets rewritten wherever the read disagrees with the plan — that is the
method, and the stage most likely to move is Stage 1, the one that touches
working provider code. Stages 1 and 2 were planned independent of each
other (Stage 2's close read now leans on Stage 1's exported validateBuilt
and its pin); 3–5 build on both; 6 is gated and designed only. **Research
pass done the same day** (see **Research**, after the decisions): it
checked D1–D10 against nine other plugin ecosystems, reversed nothing, and
amended D1, D8, Stage 2, Stage 3 and Stage 6 — each amendment is marked
*(research)* where it lands.

## How this started

The deep dive's verdict: the engine is done and the ecosystem layer on top of
it is not. Loader, install with rollback, uninstall cleanup, boot isolation,
health ledger and runtime gating all exist and are tested. What does not exist
is a written contract, an update path, or discovery beyond two bundled
examples. Two questions came with the ask — should the Add modal split into
built-in and from-the-repository tabs, and is hosting community plugins in the
GitHub repo a good idea. Both are answered under **Decisions** (D8, D10) and
land in Stages 4 and 6.

The order matters and is the whole plan in one line: **contract first, then a
reference that proves it, then discovery.** Building a community tab before a
second author exists is the speculative complexity this repo does not do.

## What exists today (the deep dive, condensed)

*As of 2026-09-23, before Stage 1.* Stage 1 grew the ctx table below from
five members to eleven and removed the authoring asymmetry it describes; its
build record says how.

### One catalog, four registries, four kinds

[plugins.js](../server/plugins.js) composes every integration into one def
shape (id, kind, label, description, core, capabilities, configSchema, a
per-kind block); [plugin-loader.js:84](../server/plugin-loader.js#L84) holds
the four kinds in one `KIND_DEFS` table, each supplying catalogId,
validateManifest, validateBuilt, register and unregister; the lifecycle around
them (fetch, npm, validate, rename, register-last, persist, rollback) is shared
and never branches on kind.

| kind | catalog id | the factory returns | lands in |
|---|---|---|---|
| `ai-provider` | `ai:<id>` | a descriptor, the same shape a built-in factory returns | `PROVIDERS` via [registerProvider](../server/providers.js#L219) → the one `install()` write |
| `connector-provider` | `<domain>:<id>` | `{ label, needsKey, rpm, burst, search, fetchEntity, … }` | that domain's live providers map ([registerConnectorProvider](../server/connectors/index.js#L176)) |
| `connector-domain` | `<domain>:<id>` | `{ providers, defaultProvider, manifest, faces, faceProducers }` | `CONNECTORS` ([registerConnector](../server/connectors/index.js#L165)) + namespaced face producers |
| `source` | `source:<id>` | `{ manifest, backend }` | ingestion `BACKENDS` ([registerSource](../server/ingestion/sources/index.js#L34)) |

### The ctx surface, and the asymmetry it hides

A plugin's factory receives [makeCtx](../server/plugin-loader.js#L214):

| member | what it is |
|---|---|
| `apiVersion` | `1` — the host's contract number |
| `fetchJson(url, opts)` | fetch with the runtime's error shape (`.status`, `.retryAfter`) and the outbound deadline |
| `wires` | `{ anthropic, compat, google }` — the AI protocol families |
| `renderChart` | the price-chart face producer, for a domain that ships a chart face |
| `log` | console.log prefixed with the plugin id |

That is enough for the two bundled examples — both are descriptors on the
compat wire — and for the test fixtures, which reach the network only through
`fetchJson`. It is not enough to write a real data provider, and the proof is
that none of the three built-in ones could be written against it:

| built-in | imports from core that a plugin cannot reach |
|---|---|
| [coingecko.js:7-12](../server/connectors/crypto/coingecko.js#L7-L12) | `providerSignal`, `num` (runtime); `unsupported`, `createTtlCache`, `ytdDays`, `encodeArea`, `encodeCandles`, `CHART_TTL_LIVE`, `CHART_TTL_SETTLED` (chart-series); `createQuoteCache`, `pickFields` (sibling) |
| [coinmarketcap.js:18-23](../server/connectors/crypto/coinmarketcap.js#L18-L23) | the same, plus `walkLadder`, `keyFingerprint` |
| [financialmodelingprep.js:20-25](../server/connectors/stocks/financialmodelingprep.js#L20-L25) | the same, plus `providerBudgetMs`, `dedupeAscending`, `strideArea`, `aggregateCandles`, `utcDate` |

The AI side already crossed this bridge: since `eebde42` every built-in in
[ai-providers/](../server/ai-providers/index.js) is a `(wires) => descriptor`
factory — the plugin contract — and [providers.js:210](../server/providers.js#L210)
installs them through the same `install()` a plugin goes through. Sources
([ftp.js](../server/ingestion/sources/ftp.js), [s3.js](../server/ingestion/sources/s3.js),
[folder.js](../server/ingestion/sources/folder.js)) import only npm packages
and node builtins — already plugin-shaped. Connectors are the one family
whose built-ins are written against a different contract than their plugins.
"Built-ins and plugins ride identical rails" is true of the runtime dispatch
([runtime.js:298](../server/connectors/runtime.js#L298) calls
`provider.search(query, { apiKey, pace })` on both) and false of authoring.

### What install actually checks, per kind

| kind | manifest | the built object | not checked |
|---|---|---|---|
| ai-provider | common fields | ≥1 non-modifier capability, label, a wire method per advertised capability ([WIRE_VERB](../server/capabilities.js#L396)), defaultModel if tagging; then `install()`'s rpm/burst, images, prices rules | unknown `provides` keys pass ("counts as real"); an explicit `provides.tag` with no `wire.tag` passes |
| connector-provider | `domain` slug | `search` + `fetchEntity` are functions | rpm/burst (runtime defaults 30/15 at [runtime.js:47](../server/connectors/runtime.js#L47)); the optional methods' types |
| connector-domain | `domain` slug, not reserved, faceProducers namespaced | providers non-empty, defaultProvider === id, `manifest` exists, declared producers are functions | the manifest's shape: label, fields, template, browse, faces, chart, identity — a malformed template registers cleanly and breaks in [mapping-modal.js:1108](../public/mapping-modal.js#L1108) |
| source | common fields | `manifest.name === id`, `backend` is a function | connectionSchema / sourceSchema shape and field types; browsable / needsConnection |

The loader header promises "fail at install with a readable reason". It keeps
that promise for one kind.

### The lifecycle verbs

[installFromUrl](../server/plugin-loader.js#L414) (staging → fetch → validate
→ npm → unique dir → register-last → persist; a failure removes only the
just-fetched code), Retry (errored rows only — the same function's
errored-retry branch), and Remove: a built-in flips `installed`, an external
goes through [uninstall](../server/plugin-loader.js#L472), which deletes the
dir, both rows, and — for an AI provider —
[its key rows, bindings and board pins](../server/plugin-loader.js#L490).
There is no update. So updating the Ollama plugin today means Remove, which
deletes its connections, then re-add and re-enter them. A bundled example is
copied into the volume at install (`resolved_ref: local`) and an image upgrade
does not touch the copy.

### Discovery

The URL box ([plugin-add-modal.js:95](../public/plugin-add-modal.js#L95)); the
bundled examples listed as available rows by
[bundledPlugins](../server/plugins.js#L332) — shown in the Add modal with the
same "AI" tag as OpenAI, nothing saying they are examples
([tagFor](../public/admin-plugins.js#L29)); the welcome tiles, which install a
bundled tagger on click.

## Decisions (flag if wrong)

**D1 — what `apiVersion` covers.** The manifest, the ctx surface, the shape
each kind's factory must return (method signatures and return shapes, the
domain manifest schema, the source manifest schema), and the wire method
signatures an own-wire AI plugin implements. Integer; the host accepts an
equal major only (today's check, [validateManifest](../server/plugin-loader.js#L227));
additive changes never bump it, a breaking change to any of the above does.
Putting the shapes in the contract means validating them at install — that is
Stage 2.
*(research)* Kept. Two additions: `ctx.apiVersion` is documented as the
feature-detection hook (Obsidian's `requireApiVersion` pattern), and
`minAppVersion` — the field every app-plugin ecosystem uses to say "I need a
newer host" — is added to the manifest the day the app has tagged releases to
compare against; today it has none. Grafana's force-install hatch for an
incompatible plugin is declined: a plugin against a newer contract fails at
runtime, so refusing at install is the readable failure, not a guardrail.
*(Stage 1 second pass)* Stage 1 is the first additive ctx change, and it makes
this gap real: a copy of CoinGecko installed on a host from before Stage 1
fails at its factory with "Cannot read properties of undefined (reading
'unsupported')", while both hosts say apiVersion 1. Measured, not reasoned.
Nobody is exposed — no release, no community plugin — but before Stage 5
freezes the contract, D1 needs its answer: PLUGIN.md records which ctx members
arrived when, and either a manifest field lets a plugin require them or the
loader turns that TypeError into a sentence naming the missing member.
*(Stage 2 close read)* Two amendments. Stage 2 narrows what apiVersion 1
accepts, and D1 read literally makes that a bump. It isn't one: 1 has never
been written down (PLUGIN.md is Stage 5) and nothing outside this repo
depends on it. loadAll re-validates every external plugin at boot, so an
installed one that breaks a new rule becomes an errored card naming the
rule, not a crash. And "putting the shapes in the contract means validating
them at install" narrows: PLUGIN.md documents every shape, and the loader
enforces the ones whose breach throws inside the host, fails silently, or
leaves a card nameless. A rule for a field the runtime already repairs
would refuse a plugin that works.
*(Stage 5 close read)* Answered by building nothing. Every ctx member ships
with PLUGIN.md, so the doc is the baseline, and a host from before it can't
be taught a sentence now. The first member added after the doc gets a
"since" line in it, and the loader names a missing member from then on.

**D2 — one declaration shape.** `provides` is the documented form for
capabilities. The legacy fields (`defaultModel`/`models`/`modelFilter`,
`embeds`, `transcribes`, `detects`, `research`) stay accepted through
[normalizeProvides](../server/providers.js#L132) and are not written down.
The two bundled examples are converted so the reference matches the doc.
*(Stage 4 close read)* A `provides.tag` that leaves out its list or its
filter now registers what the legacy spelling of it does: it gets the empties
the legacy spelling is assembled with.
*(Stage 5 close read)* With `provides`, only `provides` declares: a wire's tag
method implies tagging for a legacy-shaped descriptor alone, and one that
tags through the legacy fields while writing `provides` without `tag` is
refused.

**D3 — ctx grows by exactly what the built-ins need.** Discovered, not
designed: Stage 1 makes the three built-in providers compile against ctx and
whatever they had to reach for is the surface. An import-allowlist test keeps
built-ins from ever growing a private path again. New members, from the table
above: `providerSignal(kind)`, `providerBudgetMs(kind)`, `num`, `series` (the
[chart-series](../server/connectors/chart-series.js) module whole — every
export there is provider-facing by design), `createQuoteCache`, `pickFields`.
The existing five members do not move: `ctx.wires.compat` is shipped contract.
*(close read)* Named as core already names them; the reason is under Stage 1.

**D4 — the rate limit is a contract for data providers too.** A connector
provider declares positive `rpm` and `burst` or it is refused — enforced at
the registry write ([bind](../server/connectors/index.js#L27) and
registerConnectorProvider) so built-ins are held to it like the AI side's
[requireRateLimit](../server/providers.js#L42). CoinMarketCap declares
[rpm 45](../server/connectors/crypto/coinmarketcap.js#L43) and no burst; it
gets `burst: 15`, the default it was already running on.
*(Stage 2 close read)* Enforced in the connector-provider validateBuilt, not
at `bind` or registerConnectorProvider: a throw in `bind` would strand a
domain plugin's face producers mid-register, and Stage 1's pin already
holds the built-ins to validateBuilt. Reasons under Stage 2.

**D5 — one provider per connector-domain plugin.** The providers map holds
exactly the plugin id. A second provider for a plugin's domain is a
`connector-provider` plugin, which is what that kind is for. This is what the
catalog already assumes ("one plugin = one primary card = one row") and it
closes the uninstall crumbs (a second provider's key slot and row surviving)
by construction rather than by a second cleanup loop.

**D6 — update is reinstall in place, keeping everything the admin chose.**
From the stored source; rows, keys, config, bindings and board pins survive
because nothing clears them; rollback is reloading the prior dir, which is
still on disk until the new load succeeds. Retry becomes the errored-row
spelling of the same verb, not a second path.
*(Stage 3 close read)* The rollback is not a reload: the old version keeps
serving until the new one is built and validated, and the swap is one
registry write, so a failed update never touched the registry. "From the
stored source" is literal — moving a plugin to a new source is Remove and
re-add.

**D7 — v1 is server-only, and the loader says so.** No client halves, no new
capabilities, no new wire families. A `provides` key the registry does not
know is refused with the valid list and the near-miss named (`embeds` →
`embed` is the trap the rename set). An own-wire plugin implementing the wire
methods itself stays allowed — that is a descriptor, not a family.

**D8 — an index of pointers in the repo, not the plugins.** `community/plugins.json`
lists id, kind, label, description, author, a pinned source and the two
listing hints, each entry pointing at the author's own repo. Reviewing an
entry is vetting a pointer, not maintaining code; an author ships a fix
without an app release; users are not upgrade-coupled to the image. Bundled
examples stay bundled — they are reference implementations, install offline,
and two is the right number — and get marked as examples. The Community tab
in the Add modal is built when the index has an entry the maintainer did not
write, and not before.
*(research)* Supported by Obsidian, Zed, Jellyfin and Homebridge, all
pointers-not-code. Three amendments: the index carries everything the tab
renders, so browsing never touches GitHub per plugin (the lesson HACS paid
for); an optional `checksum` per entry, Jellyfin-style; and an optional
`version` in the plugin manifest, which every ecosystem checked carries and
ours lacks.

**D9 — PLUGIN.md at the repo root, written once, last.** From the code as it
stands after Stages 1–4, every shape claim cross-referenced to the test that
pins it. README gets one line pointing at it. The plan you are reading holds
the contract as currently understood; the doc is written from the corrected
truth, not twice.
*(Stage 5 close read)* "Cross-referenced to the test that pins it" became one
test that reads the doc's own lists and compares them to the code: a test
name means nothing to a stranger, and naming one stops no drift.

**D10 — the Plugins page stays one list.** Splitting installed cards by
authorship would redraw the tier line the install model erased on purpose
([plugins-phase-2-install-model.md](plugins-phase-2-install-model.md): "a
community plugin is just another available connection — no separate tier").
The card already carries its source line and a real Remove. The split that
is right is in the Add modal, by source, because the two lists have different
failure modes and different trust — and that split arrives with the index.
*(research)* Both models exist; ours is VS Code's (one view, an `@builtin`
filter), not Obsidian's split — see Research.

## Research (2026-09-23) — the decisions against other plugin ecosystems

Checked against Obsidian, VS Code, Zed, Jellyfin, HACS (Home Assistant), n8n,
Homebridge, Grafana, Chrome extensions, and GitHub's and npm's own
supply-chain guidance. Verdict per decision; what changed is folded into the
decisions and stages above and marked *(research)* where it lands. Nothing
was reversed.

**D1 — the version number.** Two models exist. Chrome's `manifest_version`
is "an integer specifying the version of the manifest file format your
package requires", one accepted value at a time — our shape. Every
app-plugin ecosystem also lets the plugin say *which host it needs*:
Obsidian's `minAppVersion` (with a `versions.json` map so an older app
installs an older plugin version) plus `requireApiVersion()` for runtime
feature detection; Grafana's `grafanaDependency`, a node-semver range the CLI
has enforced since v12 with a ZIP install as the escape hatch; VS Code's
`engines.vscode`; Jellyfin's per-release `targetAbi`. The integer covers
breaking changes and nothing else — an additive ctx member has no way to be
required. We cannot adopt `minAppVersion` today: the app has no release
version to compare against (package.json says 1.0.0 and the container does
not know its commit). Kept, with the two additions recorded under D1.

**D3 / Stage 1 — built-ins on the plugin contract.** VS Code says it
outright: "many core features of VS Code are built as extensions and use the
same Extension API", and its repo's built-in extensions are the reference
implementations. n8n points community authors at n8n's own nodes for
patterns. Supported; Stage 1 is that model applied to connectors.

**D6 — Update.** Obsidian: "For security purposes, community plugins don't
update automatically" — a manual Check for updates / Update all that
replaces only `main.js`, `manifest.json` and `styles.css`, so plugin data
survives by construction. n8n shows an Update button per node; a specific
version there needs uninstall and reinstall. Supported; ours is the Obsidian
shape — manual, in place, from a pinned source.

**D7 — unknown keys.** The norm for manifest keys is warn-and-ignore:
Chrome's "Unrecognized manifest key" is a warning and the extension loads.
Our loader already ignores unknown *manifest* keys and stays that way. The
refusal is only for a `provides` key that would otherwise silently never
bind — a capability claim, not a manifest key. Kept, narrowed to exactly
that.

**D8 — the index.** Four ecosystems do pointers, not code. Obsidian's
`community-plugins.json` is `{ id, name, author, description, repo }`, the
code lives in the author's repo, install fetches the GitHub release whose
tag equals `manifest.version`, and submissions get an automated review. Zed's
extensions repo is git submodules pinned to a commit (HTTPS, public, the
commit on a branch) with `extensions.toml` carrying a version that must
match the extension's own at that commit, one extension per PR. Jellyfin's
repository *is* a manifest URL — third-party ones are added by URL and
appear in the same catalog — and each release row carries `sourceUrl`,
`checksum` (MD5), `targetAbi`, `timestamp`, `changelog`. Homebridge is an
npm keyword plus a maintained verified list. HACS is the cautionary tale: it
read every repository's metadata through the GitHub API, hit the
unauthenticated limit (60 requests an hour per IP), and moved to a
pre-generated dataset on Cloudflare R2 refreshed every 6 hours — custom
repositories still hit the API. GitHub's May 2025 change applies those
limits to `raw.githubusercontent.com` downloads too, and raw is cached about
5 minutes. Supported, with the three amendments under D8. One index fetch
every 10 minutes is 6 of the 60; a GitHub install spends one more on the API
tarball endpoint.

**D10 — one list.** Both models exist. Obsidian keeps Settings → Core
plugins and Settings → Community plugins apart — but Obsidian's core plugins
are togglable built-in features, which here is the Capabilities tab, not the
Plugins page. VS Code keeps one Extensions view with an `@builtin` filter and
lets built-ins be disabled individually. Jellyfin puts third-party
repositories in the same catalog and labels the repository. Kept; ours is
the VS Code shape, and Stage 6's chips are its `@builtin` filter.

**The trust model.** Every self-hosted precedent runs plugin code with the
host's full access and says so. Obsidian: "Community plugins run third-party
code on your behalf that could potentially do harm"; "Obsidian cannot
reliably restrict plugins to specific permissions or access levels";
Restricted Mode on by default, "only disable Restricted mode if you trust
the authors". n8n: "full access to the machine that n8n runs on", no
sandboxing, the checkbox "I understand the risks of installing unverified
code from a public source", Owner/Admin only. It is not theoretical: in
January 2026 eight malicious n8n community packages on npm, 752–8,385
downloads each, exfiltrated OAuth tokens and API keys during workflow
execution. On scripts and pins: npm 12 (July 2026) disables install scripts
by default and calls them "the single largest code-execution surface in the
npm ecosystem"; Homebridge's verified rules forbid post-install scripts that
modify the system; GitHub says pinning to a full commit SHA "is currently the
only way to use an action as an immutable release", because tags move.
Supported — scripts-off, admin-only, the confirm, and Stage 3's resolved sha
are exactly the precedents. Two amendments, both under Stage 3: the operator
kill switch that n8n and Obsidian both have and we do not, and the npm 12
note. A verified tier (n8n, Homebridge) is not built; the index review is
the light version of it.

**D2, D4, D5, D9** are internal consistency choices with nothing to check
against; every ecosystem above has an authoring doc at its root or docs
site, which is all D9 claims.

Sources: [Obsidian — Submit your plugin](https://docs.obsidian.md/Plugins/Releasing/Submit+your+plugin),
[Obsidian — Versions](https://docs.obsidian.md/Reference/Versions),
[Obsidian — Community plugins](https://obsidian.md/help/community-plugins),
[Obsidian — Plugin security](https://obsidian.md/help/plugin-security),
[Obsidian — Plugins](https://obsidian.md/help/plugins),
[Obsidian Hub — community-plugins.json entry](https://publish.obsidian.md/hub/04+-+Guides%2C+Workflows%2C+%26+Courses/Guides/How+to+add+your+plugin+to+the+community+plugin+list),
[VS Code — Extension API](https://code.visualstudio.com/api),
[VS Code — Extension Marketplace](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace),
[Zed — Publishing guide](https://zed.dev/docs/extensions/publishing/publishing-guide),
[Jellyfin — Plugins](https://jellyfin.org/docs/general/server/plugins/),
[Jellyfin — a repository manifest](https://raw.githubusercontent.com/danieladov/JellyfinPluginManifest/master/manifest.json),
[HACS — Data sources](https://www.hacs.xyz/docs/faq/data_sources/),
[HACS 2.0 announcement](https://www.home-assistant.io/blog/2024/08/21/hacs-the-best-way-to-share-community-made-projects/),
[n8n — Risks](https://docs.n8n.io/integrations/community-nodes/risks/),
[n8n — GUI installation](https://docs.n8n.io/integrations/community-nodes/installation-and-management/gui-installation/),
[n8n — environment variables](https://docs.n8n.io/deploy/host-n8n/configure-n8n/basic-configuration/use-environment-variables/nodes),
[n8n — Building community nodes](https://docs.n8n.io/integrations/community-nodes/building-community-nodes/),
[The Hacker News — n8n supply chain attack, Jan 2026](https://thehackernews.com/2026/01/n8n-supply-chain-attack-abuses.html),
[Homebridge — Verified plugins](https://github.com/homebridge/plugins/wiki/Verified-Plugins),
[Grafana — plugin.json](https://grafana.com/developers/plugin-tools/reference/plugin-json),
[Grafana — stricter compatibility checks](https://grafana.com/whats-new/2025-05-05-enforcing-stricter-version-compatibility-checks-in-plugin-cli-install-commands/),
[Chrome — manifest_version](https://developer.chrome.com/docs/extensions/reference/manifest/manifest-version),
[GitHub — secure use of Actions](https://docs.github.com/en/actions/reference/security/secure-use),
[GitHub — REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api),
[GitHub — unauthenticated rate limits, May 2025](https://github.blog/changelog/2025-05-08-updated-rate-limits-for-unauthenticated-requests/),
[The Hacker News — npm 12 disables install scripts](https://thehackernews.com/2026/06/github-to-disable-npm-install-scripts.html).

## Stages

### Stage 1 — built-in providers become factories on ctx

The discovery stage. Behaviour-identical; the full suite is the net.

**Close read (2026-09-23) — what it changed.** Four findings, folded into the
moves below.

1. *The AI engine does not import the ctx module.* The first draft had
   providers.js hand the built-in AI factories a full `makeCtx()`, which forced
   plugin-ctx.js to be a leaf and invented a `provider-utils.js` to keep it
   one. The five AI built-ins that take an argument read only `wires`, so
   `({ wires }) =>` is satisfied by providers.js passing `{ wires: WIRES }`,
   and plugin-ctx.js may then import the connector runtime directly. The
   runtime's whole import graph was mapped: nothing in it reaches the
   connector registry, the loader, or this module. provider-utils.js is gone
   from the plan, and the leaf constraint with it.
2. *`manifest.providers` has readers* — three test assertions
   ([connectors.test.js:31](../test/connectors.test.js#L31),
   [connectors.test.js:1043](../test/connectors.test.js#L1043),
   [stocks.test.js:24](../test/stocks.test.js#L24)). Deleted anyway; the three
   repoint to `getConnector(domain).providerList()`, the list the app actually
   serves, which carries `attribution` — the snapshot had already drifted by
   dropping it.
3. *The name `ctx` is taken.* All three providers already call their per-call
   argument `ctx` (ten functions: five in CoinGecko, four in CoinMarketCap, one
   in FMP — e.g. `fetchEntity(id, ctx = {})` at
   [coingecko.js:170](../server/connectors/crypto/coingecko.js#L170)). A
   factory parameter of that name would be shadowed inside every one. Built-ins
   destructure in the parameter list instead: no outer `ctx` exists, and the
   list is the file's declaration of what it takes from the host.
4. *Constants that look pure are not.* `marketFields`, `quoteFields` and
   `tradedVolume` call `num`; every cache is built from a ctx helper.
   Everything after the imports moves inside the factory, indented uniformly,
   so `git diff -w` shows only the real edits.

Confirmed, no change: FMP has no import-time effects (every module-level
binding is a cache or a table, env is read per call, the background refill is
lazy inside the universe fetch, no timers); the bulk signal kind is FMP-only,
so the kind argument stays; test identity is load-bearing and one line per
file fixes it; the quote cache belongs on ctx. No template literal in the three
files spans lines, so the indent cannot change a string.

**Naming, decided while amending.** ctx members take the names core already
uses — `providerSignal`, `providerBudgetMs`, `createQuoteCache` — not the
draft's `signal`, `budgetMs`, `quoteCache`. `signal` is already the per-call
AbortSignal option `fetchJson` takes, and one name for a function and an
AbortSignal on one surface is a trap; a factory reads as one when it is named
`create…`, like `createTtlCache`. Every provider body stays byte-identical.

**Moves:**

1. `server/plugin-ctx.js` (new): `PLUGIN_API_VERSION`,
   [fetchJson](../server/plugin-loader.js#L202) and
   [makeCtx](../server/plugin-loader.js#L214) move here from the loader. ctx
   gains `providerSignal`, `providerBudgetMs`, `num` (from the runtime),
   `series` (the [chart-series](../server/connectors/chart-series.js) module
   whole), `createQuoteCache` and `pickFields`. The loader imports
   `PLUGIN_API_VERSION` and `makeCtx` from it and drops its runtime,
   price-chart and WIRES imports; the one test importing the version from the
   loader switches.
2. `quote-cache.js` moves up from `connectors/crypto/` to
   [server/connectors/](../server/connectors/quote-cache.js) (`git mv`): it is id-keyed and generic, and a
   community provider gets the same economics rather than its own copy.
3. The three provider modules become
   `export default function ({ …what it uses… }) { … return { … }; }`. The
   parameter list destructures ctx, `series: { … }` nested; every former
   `export` drops its keyword; the returned object lists the former exports in
   their original order, the `_reset*`/`_age*` seams included.
4. [crypto/index.js](../server/connectors/crypto/index.js) and
   [stocks/index.js](../server/connectors/stocks/index.js) build each provider
   with `makeCtx({ id })`, one ctx per provider, as a plugin gets. The static
   `manifest.providers` snapshot is deleted from both. Stocks'
   `faces[].periods` reads off the instance.
5. The AI factories: `(wires) =>` becomes `({ wires }) =>` in the five that
   take an argument; [providers.js:210](../server/providers.js#L210) passes
   `{ wires: WIRES }`. A plugin's full ctx satisfies the same destructure, so a
   built-in AI descriptor copied into a plugin directory works as well.
6. Tests: seven files stop importing a provider as a module namespace and take
   the **registered** instance — `getConnector("crypto").providers.coingecko` —
   never a fresh one, because the seams must clear the caches the server uses.
   Call sites are untouched. The two live scripts build their own instance with
   `makeCtx`; they run without a server.
7. Pins, in a new `test/builtin-plugins.test.js`:
   - **allowlist**: every module in `server/connectors/crypto/`,
     `server/connectors/stocks/`, `server/ingestion/sources/` and
     `server/ai-providers/` (each minus `index.js`) imports only `./` siblings,
     `node:` builtins and npm packages — never `../`. This keeps D3 true after
     today.
   - **the built-ins pass the plugin rules**: each connector provider file's
     factory output passes the loader's `connector-provider` validateBuilt;
     each AI descriptor's passes `ai-provider`'s, except the sidecar-backed ones
     that declare `liveCatalog` (wire null, exempt by the loader's own rule).
     validateBuilt is exported for this.
   - **a built-in copied verbatim is a plugin**: each built-in connector
     provider file, copied into a temp directory as `index.js` beside a
     `connector-provider` manifest, loads through `loadDir` and exposes the same
     keys as the registered instance. That is the reference-plugin claim made
     testable, and it is why this stage exists.

**The alternative, kept on record:** leave the modules as namespaces, add the
helpers to ctx, keep only the allowlist. No indent diff; but a built-in is then
not copyable verbatim, and the AI/connector symmetry stays prose.

**Verify:** full suite unchanged. Compose (`docker compose up -d --build app`):
a crypto board and a stocks board — browse with a filter, add, refresh, chart
face, lightbox chart, all unchanged; `scripts/verify-coingecko-live.mjs`
keyless; FMP live if a key is stored.

**Built 2026-09-25 — uncommitted.** Unit suite 1886/1886 (four new, in
[builtin-plugins.test.js](../test/builtin-plugins.test.js)), browser suite
52/52. New: [plugin-ctx.js](../server/plugin-ctx.js). Moved:
`connectors/crypto/quote-cache.js` → [connectors/quote-cache.js](../server/connectors/quote-cache.js).

Decided while building:

- The pin file reads its provider list off the registry (`listConnectors()`)
  rather than globbing the domain directories: a helper module left in a
  domain directory is not mistaken for a provider, and a registered provider
  whose file lives elsewhere fails loudly.
- The allowlist covers `server/ai-providers/` too; every descriptor there was
  already clean.
- `test/connectors.test.js` also asserts `manifest.providers` is gone. The
  snapshot was deleted because a second copy drifts; one line keeps it from
  coming back.
- Five stale comments fixed while there: the runtime and the registry said a
  provider "exports" its methods (it returns them now), and one comment named a
  loader path that never existed (`server/plugins/loader.js`).

Removal checks — each pin, with the thing it guards undone:

1. `import { num } from "../runtime.js"` put back into coingecko.js. The
   allowlist fails naming `connectors/crypto/coingecko.js imports
   "../runtime.js"`; the verbatim copy fails with `ERR_MODULE_NOT_FOUND`.
   Restored byte-identical.
2. openai.js put back on `(wires) =>`. The plugin-rules pin fails with the
   loader's own sentence, "a embed ai-provider descriptor needs wire.embed".
   Measured what the app does with the same mistake: the registry boots with
   OpenAI's wire undefined and `provides` reading embed and transcribe —
   tagging silently gone, failures only at the first call. Only the pin catches
   it.
3. Three test files handed a private provider instance instead of the
   registered one: two tests fail (connectors: "POST /api/boards/:id/entities:
   creates connector entity with bound fields"; liveness: "retag_on_refresh
   gates the cascade AND the movement snapshot"). The seams reset a cache the
   server never reads — identity is load-bearing, measured rather than assumed.

Second pass:

- The three HEAD modules imported beside the new instances: all 63 exports
  have the same keys, the 35 functions have identical source ignoring
  whitespace and the same arity, and the 28 values are deep-equal.
- `git diff -w` on the providers shows only the dropped imports, the factory
  header, the dropped `export` keywords and the returned object.
- No stale references left: no `crypto/quote-cache`, no namespace import of a
  provider, no `manifest.providers` reader, no version import from the loader.

Real app (compose, `docker compose up -d --build app`): booted clean. One
scratch board per domain — no facets, auto-tag off — driven from inside the
container by a script calling what the routes call, against the real database
and the stored keys:

- browse filters: CoinGecko 1,040 categories; FMP type, sector, exchange and
  159 industries.
- filtered list: a layer-1 category gave ETH BNB SOL TRX ADA; Technology gave
  NVDA AAPL MSFT TSM AVGO.
- add: two of each enqueued exactly as the bulk-add route does. The running
  worker's fetch leg landed all four with 11 fields stamped by their provider,
  drew their chart faces (600×360 webp on disk), and parked them held.
- refresh: `price` set live at one minute; the worker refreshed all four about
  65 seconds after landing and logged the two crypto prices that moved.
- lightbox chart: ETH 1m candles 180 points intraday; NVDA 1m candles 23 points
  daily. Search and fetchEntity answered for both domains.
- FMP pacing read 300/2 — the admin's saved override merging onto the
  plain-object instance, as it did onto the module namespace.
- Boards, entities and face files deleted after; the script removed from the
  container.

`scripts/verify-coingecko-live.mjs`, keyless: six of seven steps passed, the
zero-HTTP warm-cache read among them. `history 30d` hit CoinGecko's keyless
per-IP limit (429, Retry-After 35) twice; retried once after the window, it
returned 721 points over the 30 days. The keyed `history()` path is
the one the two crypto chart faces above were drawn from. The FMP live script
was not run: it wants the key in the host environment, and the in-container
check already ran FMP live on the stored key.

The setup phase's browse and filter calls stay on the usage meter as app-scope
connector requests; the scratch boards' own requests went with the boards,
since deleteBoard drops a board's meter rows, and job_log cascades. Health
rows healed — what using the app does. The compose app
now runs a locally built image of the uncommitted tree;
`docker compose pull app && docker compose up -d app` returns it to the
published one.

**Second pass (2026-09-25, on request).** What it checked, and what it found:

- **Client-facing payloads.** HEAD checked out into a temporary worktree and
  both trees' output compared as JSON: `listConnectors()`, every domain
  manifest minus the deleted snapshot, `renderableFaces` for each provider, the
  connector and AI entries of `pluginDefs()`, and `providerCatalog()`. All five
  identical.
- **Lint** (`no-undef`, the repo's one rule) over every touched file: clean. CI
  does not run it, so this is the only place it ran.
- **The parameter lists.** Every destructured ctx member is used in its body;
  none is missing (lint). The header comment's "everything this file takes
  from the app" holds both ways.
- **The copy test's premise.** It relies on Node detecting ES module syntax in a
  directory with no package.json; CI and the image are both on Node 22, which
  does, and real plugin installs already depended on it.
- **What the live check left behind.** Nothing names the scratch boards or
  their entities in any board-, entity- or item-keyed table.
- **The FMP 300/2 claim** checked against its plugin row: `{"rpm": 300,
  "burst": 2}`.

Corrected: the ctx-parameter count above (it was a count of lines); this
record's meter sentence, which claimed the check left board-scoped requests on
the meter; the deep-dive section, now dated; the "no reader" claim under Found
along the way. Fixed in code: the engine header in providers.js still said
two wire families and left detect out of its dispatchers — both stale since
before this arc, in the paragraph Stage 1 edited — and stocks.test.js now
asserts the snapshot's absence, as connectors.test.js already did. Added to D1:
the first additive ctx change makes its gap real.

### Stage 2 — the contract is enforced at install

Readable throws in KIND_DEFS, register-last as before.

**Close read (2026-09-25) — what it changed.** Eight findings, folded into the
rules below.

1. *The route nit would have broken the welcome flow.* The plan said the UI
   never sends `installed` for an external plugin. It does:
   [welcome.js:329](../public/welcome.js#L329) sends `PATCH { installed: true }`
   unconditionally — on purpose, as a no-op — including for the bundled tagger
   it installed a moment earlier, which is an external row. A 400 for any
   `installed` would fail the welcome flow for every bundled example; the
   browser suite's "a failed connect says why" drives Ollama through exactly
   that call. Narrowed: only `installed: false` is refused, the one value that
   makes the card and resolution disagree.
2. *A template is a board mapping, and validateMapping already checks one.*
   [applyTemplate](../public/mapping-modal.js#L1171) loads it into the mapping
   pane wholesale, and the tests save `manifest.template` as a board's mapping
   verbatim. Every template rule the plan hand-wrote — no identity, no card,
   each fn in the catalog with the catalog's kind, the face producer and its
   period — is already in [validateMapping](../server/server.js#L2382), along
   with key syntax, duplicates, instructions, options and refresh. A second
   copy in the loader would drift from the one the board save runs. So
   validateMapping moves out of server.js (the loader can't import server.js,
   which imports the loader) and takes its connector lookup as a parameter, so
   the loader can hand it the candidate domain before registering it. The
   template is checked as the mapping it is. Each catalog field is checked as a
   one-field mapping, because the pane turns a catalog entry into a board field
   by copying its key, kind and fn
   ([mapping-modal.js:655](../public/mapping-modal.js#L655)) — a key like
   `Price` would be offered by the menu and refused by the save. A plugin is
   then refused at install exactly when a board save would refuse it, with the
   same sentence.
3. *D4 belongs in validateBuilt, not the registry.* (a) connector-domain's
   `register` writes its face producers before `registerConnector`, so a throw
   inside `bind` would leave them registered — the check meant to enforce the
   contract would break register-last. (b) Stage 1's pin already runs the
   provider rules on every built-in, which is what "held to it like the AI
   side" needed; a registry check could only ever fire on a test double. (c)
   Four test doubles register rate-less providers straight into the registry
   (two in chart.test.js, one each in connectors.test.js and faces.test.js).
   So the check lives in the connector-provider validateBuilt, and the pin is
   what makes CoinMarketCap declare its burst.
4. *Good fixtures fail the rules as written.* acme-weatherface has no
   `fields`, no `template`, a face with no label or periods, and a provider
   with no rpm or burst. domain-clash has `fields: []`, which "non-empty"
   would refuse before the shadow check its test asserts (`/already exists/`)
   ever ran. "The good fixtures keep loading" was false. Under the rules below
   only acme-weatherface changes: its provider gains rpm and burst.
5. *Several rules would refuse plugins that work.* The runtime already
   repairs these: `defaultSort` missing from `sorts` (the provider falls back
   to its own default), `pageSize` (the route clamps to 1–100 and defaults to
   50), `chart.defaultRange` and the chart kinds (the runtime clamps to what it
   has; the client draws anything but candles as an area), a missing
   `template` (the pane says the domain "doesn't provide a board template"), a
   domain with no fields (face-only is legitimate — acme-weatherface is one),
   and the source flags `browsable` and `needsConnection` (read with `!!`
   everywhere). The test for a rule is now: breaking it throws inside the
   host's code, fails silently, or leaves a card or picker entry nameless.
   Everything else goes in PLUGIN.md as documented shape and is not enforced.
   This narrows D1 — see its note.
6. *Two rules check fields nothing reads.* `sourceSchema[].type`: the source
   chooser reads the path field and `recursive` by key
   ([source-chooser.js:67-68](../public/source-chooser.js#L67-L68)), and every
   other entry only contributes its default. A domain's `identity.label`: the
   mapping pane has read `identity.blurb` alone since the card-key arc
   ([mapping-modal.js:480](../public/mapping-modal.js#L480)). Both rules are
   gone, and `identity.label` is deleted from both built-ins and from
   listConnectors' fallback, so PLUGIN.md never describes a dead field.
7. *Stale reasons.* An explicit `provides.tag` with no `wire.tag` no longer
   throws at the first item — resolution disqualifies it
   ([disqualified](../server/capability-resolve.js#L56): "has no tagging wire
   of its own"). It installs, advertises tagging on its card, and can never
   serve, which is why the rule stands. `CAPABILITY_IDS` already includes
   `research`, so "∪ modifiers" was redundant. The `version` semver check has
   no reader: nothing orders versions (Update reinstalls from the stored
   source; the index compares strings), so `version` is shown and not checked.
   It is already stored — `external_plugins.manifest` is JSONB — so there's no
   migration.
8. *Verify can't run on compose.* `test/` is in .dockerignore, so a fixture
   path pasted into the compose URL box names nothing. Stage 2's Verify runs on
   the host dev server, as Stage 3's already does.

Measured, not reasoned: a domain whose `manifest.faces` is an object makes
the per-domain loop behind /api/connectors throw — `(mod.manifest.faces ||
[]).map is not a function` — for crypto and stocks too, since the route has
no try around one domain.

Confirmed, no change: a source plugin claiming `core: true` is contained —
pluginCatalog forces `core: false` on any external, and capability-status
reads that payload. The seven optional provider methods are exactly the set
the runtime calls. Compose has no external plugins installed, so boot
re-validation there touches nothing; the droplet was not checked.

**Rules.** Each says why it exists: *throws* (inside the host's code),
*silent* (fails with nothing on screen tracing it to the plugin), *nameless*
(a card or picker entry with no name), or the decision it carries.
*(second pass)* "When present" means neither undefined nor null — every
reader treats null as absent, so the loader does too. And *nameless* is
about the three things with a card of their own (a domain, a provider, a
source): their sub-entries — catalog fields, filters, sorts, faces — show
their key when they carry no label.

**common manifest:** optional `version`, shown on the card beside the ref
([admin-plugins.js:303](../public/admin-plugins.js#L303)). No format rule —
a malformed one breaks nothing.

**connector-domain** — split in two, so the built-in domains can be held to
the shape half:

- *plugin identity* (plugins only): `providers` has exactly one key, and it
  is `manifest.id` (D5, with the existing defaultProvider rule); every
  declared face producer is backed (exists).
- *domain shape* (plugins, and crypto and stocks through the pin):
  - `manifest.label` a string *(nameless: the template picker and the browse
    title print it)*.
  - `manifest.fields`, when present, an array *(throws: validateMapping
    `.find`s it on every save of a board that binds one of its fields)*; each entry passes validateMapping as a
    one-field connector mapping — key syntax, kind ∈ text|number|url|date, a
    fn *(silent until the save refuses a field the menu offered)*.
  - `manifest.template`, when present: `input.connector === manifest.domain`
    *(silent: a template naming another domain binds boards to it)*, then
    validateMapping against the candidate domain.
  - `manifest.faces`, when present, an array *(throws: measured above — every
    domain's catalog goes down)*; each `name` a key of the built `faces` map
    *(silent: produceFace finds no producer and the card keeps the fallback
    tile forever)*; `periods`, when present, an array.
  - the built `faces` map: every value names a registered producer or one of
    the plugin's declared `faceProducers` *(silent, same fallback)*.
  - `manifest.browse`, when present: `columns` an array *(throws: the browse
    modal iterates it unguarded)*, each `kind` one the host knows —
    `FILTER_KIND`'s keys in ingestion/connector.js: text, number, usd,
    percent, date *(silent: any other kind leaves the browse table's cells
    blank and filters as text)*; `sorts` an array when present *(throws)*;
    `filters` an array when present *(throws: /connector-list calls `.some`
    on it)*, each with a `key` and either an `options` array or
    `from: "provider"` *(throws on non-array options; silent on a `from`
    typo, which renders no control)*.
  - `manifest.chart`, when present: `ranges` and `kinds` arrays *(throws: the
    chart route answers 502 with a TypeError)*.
  - each provider passes the connector-provider rules.

**connector-provider** (and a domain's providers): `label` a string
*(nameless: its card)*; `search` and `fetchEntity` functions (exists); `rpm`
and `burst` positive numbers (D4 — CoinMarketCap gains `burst: 15`, the
default it already ran on); `list`, `history`, `chart`, `testConnection`,
`prefetch`, `fetchFields`, `filterOptions` functions when present *(throws: a
truthy non-function turns the card's capability flag on and throws at first
use)*.

**source:** `label` a string *(nameless)*; `connectionSchema`, when present,
an array *(throws)* that is non-empty exactly when `needsConnection` is
*(silent: with needsConnection off, the declared form is never shown and the
backend gets no connection)*, each entry with a `key`, a `label` and a
`type` ∈ text|number|secret|toggle. The type rule matters most in this stage:
a near-miss like `password` renders as a visible text box, is stored
verbatim, and is echoed unmasked by every connection read, because
[maskConnection](../server/server.js#L2950) masks only `secret`.
`sourceSchema`, when present, an array of entries with a `key` *(throws: the
chooser `.find`s it)*. `backend` a function, not called at install;
`manifest.name === id` (both exist).

**ai-provider:** `provides` keys ⊆ `CAPABILITY_IDS` (D7), else a throw naming
the valid set and the near-miss — derived from providers.js's legacy-name
table (`embeds` → `embed`, …) rather than hand-listed, plus `extract` →
"read from tag". An explicit `provides.tag` requires `wire.tag` (finding 7).

**The route nit:** `PATCH /api/admin/plugins/:id` with `installed: false` on an
external → 400, "external plugins are removed, not toggled"
([pluginCatalog](../server/plugins.js#L370) forces `installed: true` on an
external while [disqualified](../server/capability-resolve.js#L56) and the
connector runtime read the row). `installed: true` stays the no-op the
welcome flow relies on.

**Moves:**

1. validateMapping and its four helpers (`MAPPING_KINDS`, `MAPPING_KEYS`,
   `validateRefresh`, `slotSources`) move from server.js into their own module
   (working name `server/mapping-rules.js`), the connector lookup a parameter
   defaulting to `getConnector`. Two small changes ride along:
   `normaliseIdentity` moves from worker.js to field-sources.js (a pure
   one-liner, and the loader must not import worker.js), and
   `producer.periods.includes` gets a `?.`, so a period saved against a
   period-less face is refused instead of answering 500.
2. connector-domain's validateBuilt splits into its plugin half and an
   exported shape half. builtin-plugins.test.js runs the shape half on crypto
   and stocks, and the source rules on folder, ftp and s3, so the rules can
   never be stricter than what core ships.
3. `identity.label` deleted from crypto, stocks and listConnectors' fallback,
   and its comment.
4. Comments that go stale: the loader's "an id the registry doesn't know
   counts as real" (D7 reverses it), and ingestion/connector.js's
   "plugin-domain loading validates no browse shapes at all" (presets still
   pass only through presetsOf, which stays their gate).

**Tests:** one table in dynamic-plugins.test.js — a good built object per
kind, one mutation per rule, the sentence it must throw — run against the
exported validateBuilt, instead of a fixture directory per rule. loadDir keeps
two end-to-end cases: a domain rejected after its build leaves no connector
and no face producer behind (register-last), and `bad-domain-template`, the
fixture the Verify pastes. acme-weatherface's provider gains rpm and burst.
The route nit: `installed: false` on an external → 400; `installed: true` →
200 and nothing changes.

**The alternative, kept on record:** the rules as first written, with the
template and field rules hand-written in the loader. That avoids moving ~180
lines out of server.js, but it keeps a second copy of rules the board save
already runs.

**Verify:** on the host dev server (`test/` is not in the image): paste
`test/fixtures/plugins/bad-domain-template` into the URL box. Expect an inline
error naming the field, the page unchanged, nothing registered. On compose:
both bundled examples still install from the Add modal. The browser suite
passes — its welcome file drives a bundled plugin through the PATCH the nit
narrows.

**Built 2026-09-25 — uncommitted.** Unit suite 1924/1924 (38 new), browser
suite 52/52 on source and on the built frontend, lint clean on every touched
file. New: [mapping-rules.js](../server/mapping-rules.js) (validateMapping,
moved verbatim but for its lookup parameter and the `periods?.`), the
`bad-domain-template` fixture. The rules live in
[plugin-loader.js](../server/plugin-loader.js): `validateConnectorProvider`,
the exported `validateDomainModule` (the shape half), `validateSourceManifest`.

Decided while building:

- `tag` joined `WIRE_VERB` rather than getting a case of its own beside the
  loop. The loader is WIRE_VERB's only reader; its NOTE 2 in capabilities.js
  now says why tag was left out and why that was wrong.
- A `provides` entry counts when it is truthy, as the catalog counts it.
  Without that, adding tag to WIRE_VERB would have newly refused
  `provides: { tag: null }`.
- listConnectors' identity fallback went with its label. The mapping pane
  already says "each entry is its own card" itself when a domain declares no
  blurb, so the server's copy of the sentence was a second default; a plugin
  domain without `identity` now serves `identity: null`.
- A browse column needs a `key` as well as a kind: the same failure (blank
  cells).
- The version rides the card's `source` block (`sourceOf` in plugins.js) and
  prints between the URL and the ref. acme-gecko's manifest carries
  `version: "1.0.0"` so the install route test pins it on the payload.

Removal checks — each guard undone, and what caught it:

1. `periods?.` back to `periods.` → "a period against a face that offers none
   is refused, not a 500" fails.
2. The route nit removed → the PATCH test fails.
3. `tag` out of WIRE_VERB → "tagging that can never serve" fails.
4. CoinMarketCap's burst removed → three fail in builtin-plugins: the provider
   pin, the domain pin and the verbatim copy.
5. A stocks column kind set to `category` → the domain pin fails, naming
   stocks.
6. The candidate-domain lookup swapped for the registry → 17 fail, the plain
   acme-weather install among them (`unknown connector: "weather"`). The
   lookup is load-bearing.
7. The unknown-`provides` refusal removed → the three D7 rules fail.

Finding 3(a), measured rather than read: with D4 moved into `bind` as first
planned, a domain plugin whose provider has no rate limit is refused and its
face producer **stays registered**. As built, nothing is left.

Real app. The browser suite's harness — the real server on this tree, real
Chromium: the fixture path pasted into the Add modal's URL box answered
`domain manifest.template: unknown connector field fn "humidity" for
"humidity"` inline, the modal open with the path kept, the install confirm
shown once, and nothing registered (no domain, no face producer, no install
record, absent from /api/connectors). Ollama and DeepSeek were then added from
the same modal: installed external cards, no confirm, no page errors. Compose,
rebuilt (`docker compose up -d --build app`), booted clean on Node 22; inside
the container, against the real database: all 9 stored board mappings (3 on a
connector) pass the moved validateMapping; crypto, stocks and the three sources
pass the shape rules; both bundled examples install from the image's
`examples/` and uninstall again, leaving no external plugin and no plugin row
behind. The compose app now runs a local build of the uncommitted tree;
`docker compose pull app && docker compose up -d app` returns it to the
published one.

Line endings, for the record: two of the build's scripts wrote LF over five
CRLF working-copy files (server.js, worker.js, field-sources.js,
mapping-modal.js, stocks/index.js). A removal-check restore's byte hash caught
it; each file's size cached in git's index confirmed the original ending; all
five were converted back. Commits were never affected (autocrlf normalizes),
and `git diff --stat` is identical before and after.

**Second pass (2026-09-25, on request).** What it checked, and what it found:

- **Client payloads against HEAD**, through a temporary worktree: the
  connector list, every domain manifest and every connector card are
  identical except the four intended paths — `identity.label` gone from
  crypto and stocks, in the list and in the manifests. The AI catalog is
  identical, and so is each connector card's config (CoinMarketCap's burst
  default was already 15).
- **A defect: the loader refused `null` where the runtime reads it as
  absent.** Measured, not read: a domain with `fields`, `faces`,
  `template`, `browse`, `chart`, `browse.sorts`, `browse.filters`, a
  filter's `from` or a face's `periods` set to null — and a source with
  `sourceSchema`, or `connectionSchema` when it needs no connection — ran
  through every server-side reader without a throw, and the loader refused
  all 11. That broke the principle this stage states; `!== undefined` was
  the cause. Fixed: optional means undefined or null — not any falsy value,
  since `false` does break the `?.` readers (`sourceSchema?.find` throws on
  it).
- **Two pickers were still nameless.** The face drawer drew a face's
  `label` and the browse modal a sort's `label` with no fallback, where
  their siblings (catalog fields, filters, the ingest modal's sorts) show
  the key. The repo's own acme-weatherface fixture has an unlabelled face.
  Fixed with the same fallback, and measured in a real browser both ways:
  reverted, a blank sort option and a face row with no name; fixed, `name`
  and `tile`.
- **Two garbled messages.** A faces map written as a producer name
  (`faces: "price-chart"`) was walked a character at a time
  (`faces.0 names face producer "p"`), and a template that isn't an object
  was told "not null". Both now say what the shape should be.
- **Comments.** mapping-rules.js named PATCH /api/boards/:id as its caller;
  the board create and the admin PATCH run it too. plugins.js described an
  update verb that doesn't exist yet.
- **Checked, no change:** the errored card prints the version too (both
  cards draw the same source line); nothing else sends `installed: false`
  for an external plugin; no README or example describes anything this
  stage changed; with the two fallbacks in, every remaining label rule is
  one of the three things with a card of its own.

Corrected in this doc: the fields rule said "every board save" (it is
every save of a board that binds one of the catalog's fields); the Tests
paragraph promised two loadDir cases, and one test covers both — the
fixture declares a face producer, so its refusal also shows none leaked;
and on compose the bundled examples installed through installFromUrl inside
the container, while the Add-modal half of that Verify ran in the harness.

After the fixes: unit 1927/1927 (3 new), browser 52/52 on source and on the
built frontend, lint clean; four more removal checks (null arrays, a null
template, a null browse, the faces-map message), each failing the test
meant to catch it. Compose rebuilt on the fixed tree and the in-container
check re-run: the same 9 mappings pass, the same install and uninstall,
nothing left behind.

### Stage 3 — Update

**Close read (2026-09-25) — what it changed.** Eleven findings, folded into
the steps below.

1. *The planned order broke register-last.* Step 4 unregistered the running
   version and then awaited the new one's load — the moment the loader's first
   invariant ("validate everything BEFORE touching a registry") exists to
   prevent. Measured with the bundled Ollama installed and elected embedder
   through a connection: between the two calls PROVIDERS has no
   `community.ollama`, embed resolves to the local floor, tag to nothing, and
   the card reads "failed to load". The gap is the new module's whole import —
   1–2 ms for Ollama here, longer for a plugin that imports dependencies — and
   an embedding job that resolves inside it embeds with another model. Now the
   new version is built and validated while the old one serves, and the swap
   is one synchronous registry write: every registry overwrites on
   re-register, and the only registers that can refuse (the AI registry's
   `install()` rules, a provider whose domain is gone) throw before their
   write, so a refusal leaves the old version in place. The rollback reload
   goes with it — a failed update never touched the registry. What's left to
   unregister after the swap is what the old version registered and the new
   one doesn't: face producers. *(second pass)* For a domain, overwriting is
   also what loses the providers other plugins added to it; the register now
   carries them over.
2. *The swap needs one rule the old order got for free.* While the old
   version is still registered, a new faces map naming a producer the old
   version declared and the new one drops would pass validation (the producer
   is still registered), then point at nothing once the leftover is
   unregistered — Stage 2's silent fallback tile. A producer in the plugin's
   own namespace counts only when its manifest declares it.
3. *The id check alone lets the kind change.* A connector-provider and a
   connector-domain share the catalog id shape `<domain>:<id>`. A domain
   plugin updated into a provider plugin would register its provider into its
   own old domain and leave that domain registered with nothing to remove it;
   the other way round, it would overwrite the domain it had been a provider
   of — someone else's. The staged manifest must match the row's id and kind,
   which is also what makes skipping the shadow check (step 5) safe.
4. *`stage()` can't include npm.* install checks for its 409 between reading
   the manifest and running npm, so a refused source never runs npm. Update's
   id-and-kind check sits at the same point: stage() is staging → fetch →
   manifest → catalog id, the caller checks, then npm.
5. *Every GitHub ref moves, not just the default.* A branch moves the way the
   default does, and the https form spells a subdirectory install as
   `/tree/<branch>/…`; phase 2 deferred exactly "SHA-pinning a github branch
   ref". Measured against GitHub: the API tarball's top directory is
   `owner-repo-<sha7>` (octocat/Hello-World → `octocat-Hello-World-7fd1a60`),
   its pax header carries the full sha, and the short sha is itself a valid
   tarball ref (the API answers 302). So resolved_ref becomes `<ref or
   default>@<sha7>` for every GitHub source — unless the ref already is that
   sha — and the card hands the admin a pin they can paste back.
6. *The planned sha test can't reach the GitHub path.* The hermetic tarball
   test installs `http://127.0.0.1:…/plugin.tgz`, which resolves to kind
   `tarball` (ref `url`); no archive shape routes it through the GitHub
   source, and the API base is hard-coded. The top-directory reading is a pure
   function with a unit test; the live path is verified on compose with a
   real GitHub install.
7. *The confirm rule named the wrong precedent.* The Add modal skips its
   confirm for a bundled row, not for a server path — a path typed into the
   URL box confirms like any URL. And a server path isn't free of internet
   code: its npm dependencies come from the registry, and an update that turns
   on `allowScripts` runs theirs. So the rule is the Add modal's own: no
   confirm for a bundled source (the image's code; both examples have no
   dependencies), the reinstall confirm for everything else. An installed row
   no longer says it came from the image, so the catalog marks it —
   `source.bundled`, a stored path under BUNDLED_DIR.
8. *The kill switch would have broken the welcome flow.* The install route is
   also the Add modal's bundled Add and the welcome tiles' install
   ([welcome.js:212](../public/welcome.js#L212)); a 403 for every install
   turns a locked instance's first run into an error. Bundled sources are
   exempt — they are the app's own code, the counterpart of the built-in nodes
   and core plugins that n8n's switch and Obsidian's Restricted Mode leave
   alone — and the client learns the switch from the catalog payload. Renamed
   `PLUGIN_INSTALL_DISABLE=1`, after the repo's one other surface switch,
   `MCP_DISABLE=1`. *(flag if wrong)*
9. *The errored-retry branch isn't dead code.* The URL box reaches it whenever
   an errored plugin's id is pasted again — from any source, which today is
   the only way to move a plugin to a new source (a tag pin, a new repo)
   without Remove, and Remove clears its keys. After this stage a plugin's
   source is fixed at install; moving it is Remove and re-add. No external
   plugin exists anywhere to lose that (compose has none) and nothing asks for
   re-sourcing, so it is recorded here and in PLUGIN.md, not built.
10. *Verify can run on compose, and the survival half shouldn't.* `examples/`
    is in the image (`/app/examples/plugins`), so editing the example inside
    the container and pressing Update on the real app is the upgrade path the
    Risks note describes — no host server needed. Electing Ollama embedder
    there would point the real instance's embedding at a server that isn't
    running, so the survival checks (connection, election, pin, config) run in
    the harness and the unit suite.
11. *No boot sweep of orphaned dirs.* Found along the way named this stage
    its home. It isn't one: the automatic backups are db-only
    ([backup.js](../server/backup.js), `kind: "db"`), so restoring one can
    bring back a row whose dir survived only because nothing swept it — and
    that dir can be the last copy of the code (a deleted repo, a scratch
    path). The compose orphan is inert; removing it is a manual step.

Measured, not reasoned, and folded in because it is the same rule: removing
an **errored** connector-domain plugin takes down a domain another plugin has
claimed since. With plugin A errored on domain `weatherx`, and plugin B then
installed on it and starred, removing A left `weatherx` unregistered, the
star cleared, and B's card reading "failed to load" — until a restart, which
reloads B but not its star. uninstall unregisters the stored manifest
unconditionally, and cleanupPluginConfig clears a domain's star outright. An
errored row registered nothing, so neither verb may touch what it names.

Confirmed, no change: the model-list cache holds the vendor's raw list and
assembles it per request from the live descriptor, so a changed filter shows
at once; the pacing buckets take rpm and burst on every call and adapt; the
image runs npm 10.9.9 on Node 22.23.3, so the npm 12 note stays a follow-up;
`installed_at` has no reader (an update restamps it).

**Server** ([plugin-loader.js](../server/plugin-loader.js)):

- `loadDir` splits into a build half (manifest → build → validateBuilt, no
  writes) and the register write; install and boot run both, as today.
- `installFromUrl` splits into `stage(url)` (resolve → staging dir → fetch →
  manifest → catalog id) and the rest. Its errored-retry branch goes: any
  existing row answers 409 — "already installed — update or remove it", or
  for an errored row, "… failed to load — Retry it from its card".
- `updatePlugin(db, id)`:
  1. `row = getExternalPlugin(db, id)`, or throw ("not an installed plugin —
     built-ins update with the app").
  2. `stage(row.source_url)`; the staged catalog id and kind
     must equal the row's ("the source now names a different plugin: …").
  3. npm, then rename into a fresh unique dir, as install does.
  4. Build and validate the new dir, own-namespace producers counting only
     when declared (finding 2). On failure: remove the new dir; for an errored
     row, store this attempt's reason; rethrow. A healthy row's registration
     was never touched.
  5. Register. A healthy row overwrites its own live entry — the domain shadow
     check is for other plugins' domains; an errored row registered nothing,
     so it gets the shadow check a fresh install gets. Then, for a healthy
     row, unregister the face producers the old manifest declared and the new
     one doesn't.
  6. `upsertExternalPlugin` (new dir, ref, manifest; load_error null); remove
     the prior dir.

  No `cleanupPluginConfig`, no `setPluginState`: keys, config, bindings and
  board pins survive by construction, which is the whole point of the verb.
- `uninstall`: an errored row's manifest isn't unregistered, and an errored
  domain plugin clears the domain's star only when it names that plugin's own
  provider (the measurement above).

**resolved_ref tells the truth for GitHub** (findings 5, 6). The GitHub fetch
reads the archive's top directory before stripping it and records `<ref or
default>@<sha7>`; the reading is a pure function beside resolveSource. It
must not list the whole archive through execFile's 1 MB output buffer — a
large monorepo would then fail on the listing, not the install.

**Route:** `POST /api/admin/plugins/:id/update`, admin; answers the fresh
card, as install does.

**Operator kill switch** *(research; finding 8)*: `PLUGIN_INSTALL_DISABLE=1`,
read per request. Set, the install and update routes answer a readable 403
for any source but a bundled one; the catalog payload carries the state, the
Add modal hides its URL box, and the cards hide Update and Retry for
non-bundled sources. Already-installed plugins keep loading and Remove keeps
working. n8n ships this pair (`N8N_COMMUNITY_PACKAGES_ENABLED`,
`…PREVENT_LOADING`) and Obsidian ships Restricted Mode; we had no way for an
operator to lock the door. A knob with the open default, not a law.
Documented in `.env.example`. Lands here because this stage already rewrites
the install/update route pair.

**npm 12 note** *(research)*: npm 12 (July 2026) turns install scripts off by
default and replaces `--ignore-scripts` with per-package approval. When the
image's Node carries it, `allowScripts` keeps its meaning and its flag
changes — a one-line follow-up, not this arc. *(close read)* The image runs
npm 10.9.9.

**Client:** an Update button on external cards beside Remove
([pluginRow](../public/admin-plugins.js#L282)). No confirm for a bundled
source; for everything else, the reinstall confirm Retry already shows,
retitled for Update and without "from the internet" for a path. The errored
card's Retry calls the same route and keeps its label. Both stay `busy` while
npm runs.

**Tests** ([plugin-install.test.js](../test/plugin-install.test.js)):

- update keeps `ai_keys` rows, the embed election, a board pin and
  `plugins.config`;
- a failing update of a healthy plugin — a factory that throws, and a
  register-time refusal (a bad `prices` block) — leaves the same registered
  object, the prior dir on disk, no load_error and no new dir;
- a failing update of an errored plugin keeps its dir and refreshes its
  reason (today's errored-retry test, moved onto update; its source a temp
  copy, broken in place);
- a source that now names another id, or the same id as another kind, is
  refused and changes nothing;
- a connector-domain update registers the new producer function, unregisters
  a dropped one, and refuses a faces slot naming a dropped producer of its
  own;
- the GitHub reading and the `<ref>@<sha7>` rule — built through fetchModule
  itself, a github source aimed at a local server (the build record says why);
- install answers 409 for any existing row, naming Retry for an errored one;
- the route: admin-only, answers the card, refuses a built-in;
- the switch: install and update answer 403 for a URL and a typed path, a
  bundled path still installs, the payload says the box is off;
- removing an errored domain plugin leaves another plugin's live domain and
  star alone.

**Verify:** in the harness (real server, real Chromium): install a temp copy
of the Ollama example through the URL box, add a connection, elect it
embedder, pin a board's tagging to it, edit the copy's description, press
Update — confirm shown, since a typed path isn't bundled — and the card shows
the new text with the connection, the badge and the pin unchanged. Then with
the switch set: the URL box is gone, Update is disabled on that card, saying
why, and a bundled example still installs from the list. On compose, rebuilt:
install bundled Ollama (through installFromUrl inside the container — the Add
modal half runs in the harness), edit
`/app/examples/plugins/ollama/index.js`'s description inside the container,
and Update (no confirm) shows the new text. Install DeepSeek from the public
repo (`https://github.com/alexmicuplusfour/001az/tree/main/examples/plugins/deepseek`):
the card shows `main@<sha7>` equal to origin/main's short sha, and Update
keeps it. Remove both.

**Built 2026-09-25 — uncommitted.** Unit suite 1937/1937 (eleven new; the
errored-retry test moved onto update), browser suite 52/52 on source and on
the built frontend, lint clean. The verb is
[updatePlugin](../server/plugin-loader.js), beside the `stage` / `commitDir`
halves it shares with install and the `buildDir` / `refuseShadow` halves it
shares with loadDir; the route is `POST /api/admin/plugins/:id/update`. The
lock is `PLUGIN_INSTALL_DISABLE=1` in [.env.example](../.env.example), and
`isBundledSource` in [plugins.js](../server/plugins.js) is the one answer to
"is this the image's own example" for the catalog's `source.bundled`, the
install route and the update route.

Decided while building:

- "Holds a registration" is asked of the registries — the catalog lists
  exactly what they hold — not read off load_error. A provider plugin whose
  domain plugin was removed has no load_error and nothing registered. Update
  and uninstall both ask it.
- The GitHub path is tested for real rather than as a pure function (finding
  6): fetchModule already takes a resolved source, so a github-kind source
  aimed at a local server runs GitHub's actual download, unpack and naming,
  with no seam added. It runs the subdirectory branch too, which no test had
  ever run. A real GitHub archive (octocat/Hello-World, pax header and all)
  through the same path on this machine's tar (GNU 1.35) gave
  `default@7fd1a60` and staged nothing but the repo's file.
- One unpack path for every archive: extract without `--strip-components`,
  read the single top directory, lift the wrapper's contents or the subdir
  within it. The top directory's name comes for free, the two branches became
  one, and an archive without exactly one top-level directory is refused with
  a sentence — it used to install whatever strip-components left of it.
  *(second pass)* Only directories count: loose files at the root are dropped,
  as strip-components dropped them.
- The lock disables Update and Retry, with the reason as the title, rather than
  hiding them — the page's existing pattern (Retry with no source on record,
  Remove on a built-in). The Add modal says why its URL box is gone.
- The update route checks the lock before anything runs; an unknown id falls
  through to updatePlugin's "not an installed plugin".

Removal checks — each guard undone, the test that caught it, the file restored
byte-for-byte:

1. The swap undone (unregister before building, as first planned) → "a
   version that fails leaves the running one exactly as it was".
2. Own-namespace producers counted without being declared → "a domain
   plugin's face producers follow the new version".
3. The kind check removed → "a source that now names another plugin, or the
   same id as another kind, is refused".
4. Dropped producers left registered → the face-producer test.
5. An errored row's update without the shadow check → "a domain plugin that
   never loaded: Retry can't take the domain another plugin holds…".
6. An errored row's failed update storing no reason → "Retry on an errored
   plugin".
7. install retrying an errored id in place again → "an errored one is
   pointed at Retry".
8. uninstall unregistering unconditionally → the never-loaded domain test.
9. uninstall clearing a domain star outright → the same test, on the star.
10. The lock covering bundled sources → the PLUGIN_INSTALL_DISABLE test.
11. GitHub recording the ref alone → the GitHub archive test.

Real app. The harness — the real server on this tree, real Chromium: a temp
copy of Ollama installed through the URL box (one confirm), given a
connection, the embed election and a board's tagging pin, then edited on disk.
Update showed one confirm, with the new text; the card then read the new
description with "1 connection" and the "default embedder" badge unchanged,
and the election and the pin were unchanged in the database. With the lock
set: the typed-path card's Update was disabled ("Installing plugins is turned
off on this server"), the Add modal showed its note instead of the URL box,
and the bundled DeepSeek was added and then updated with no confirm either
time. No page errors, no failed requests; gear · Update · Remove fit the card.
Compose, rebuilt: inside the container, against the real database, bundled
Ollama installed from `/app/examples` (`source.bundled` true); the image's
index.js edited as root; the update read "Updated in the image. …" from a
fresh dir, the prior dir gone, no load_error. DeepSeek from
`https://github.com/alexmicuplusfour/001az/tree/main/examples/plugins/deepseek`
recorded `main@7f02846`, which is origin/main, and its update kept it. Both
removed: no external plugin, no plugin row; the example file restored and the
script removed. The orphan `ai__community.ollama@local-10b003` was
byte-identical to HEAD's Ollama example (index.js and the README equal to the
image's, the manifest equal to HEAD's blob) and was removed by hand, as
agreed; the volume holds only `.staging`. The compose app runs a local build
of the uncommitted tree (Stages 1–3); `docker compose pull app && docker
compose up -d app` returns it to the published one.

**Second pass (2026-09-25, on request).** What it checked, and what it found:

- **A defect: updating a domain plugin dropped the providers other plugins
  had added to it.** Measured: with a connector-provider plugin extending a
  plugin domain and starred as its default, updating the domain plugin left
  only the domain's own provider; the other plugin's card read "failed to
  load", and the domain quietly resolved to its own provider instead of the
  starred one — until a restart. The swap binds a new domain object around the
  new version's providers map, and the other plugin's provider lived in the
  old one. The close read's order had the same hole: it comes with replacing
  a domain, not with when. Fixed in the connector-domain register: providers
  in the domain it replaces that the new version doesn't have move into the
  new map. Install and boot replace nothing (the shadow check), so only an
  update reaches it.
- **A defect: the meter's rates didn't follow the plugin.** The rate table
  (pricing.js) is rebuilt at boot — after loadAll, so plugin rates count —
  and whenever a price is stored; install, update and uninstall rebuilt
  nothing. Measured with a plugin declaring prices: after install the meter
  read it as unpriced; after an update from 3/15 to 5/25 it still stamped
  3/15; after uninstall 3/15 lingered. Costs are stamped at write time and
  never recomputed, so an update that changed a rate would have written the
  old one into the billing record until the next restart. The install half
  predates this arc; the update made it a normal event. Fixed: all three
  verbs rebuild the table.
- **A regression in the new unpack.** `--strip-components=1` dropped loose
  files at an archive's root, and the one-unpack-path rule refused any
  archive with more than one root entry. Measured with GNU tar on an archive
  holding `._plugin` beside `plugin/` — the AppleDouble entry macOS tar
  writes: the old path staged the plugin, the new one refused it. Now only
  directories count toward the one top-level directory; loose files are
  dropped, as before.
- **Comments.** Five described behavior that is gone or a verb that didn't
  exist: the loader's lifecycle pointer (named install, not update),
  unregister's "failed reload" (nothing reloads now), db.js's upsert ("or
  re-install") and setExternalLoadError ("a later Retry can reload it" —
  Retry fetches from the source), and the Add modal's header (the URL box is
  conditional now).
- **Checked, no change:**
  - `registered()` rests on the catalog listing every live registration:
    providerCatalog maps every PROVIDERS key, connectorDefs every provider of
    every domain, sourceDefs every backend. Exact.
  - Two updates of one plugin at once, measured twice: both succeed and one
    dir remains, the one the row names — the second update's row read queued
    behind the first's write. A different interleaving could leave the
    loser's dir behind, inert; install has had the same window since phase 2.
    Not guarded.
  - Other caches an update could leave stale: the worker's prompt cache
    holds the board's own research flag, not the descriptor's; the per-board
    resource cache holds key strings; the feed window cache holds rows (data,
    not code); the price learner's `askedAt` is a cadence.
  - The payload changes are the two additive fields — `installLocked` on the
    catalog, `source.bundled` on an external entry; nothing else in the
    catalog's path changed.
  - `.dockerignore`'s `*.md` matches root files only: the examples' READMEs
    ship in the image (seen on compose), and PLUGIN.md at the root stays out
    of it, as Stage 5 says.

Corrected in this doc: stage takes the URL and resolves it itself; the GitHub
test runs fetchModule rather than a pure function (the Tests list); the lock
disables Update rather than hiding it (the Verify); on compose the bundled
install ran through installFromUrl inside the container while the Add modal
ran in the harness; the unpack's rule counts directories only; and the build
record's 1937 ran before the shadow case joined the never-loaded test, whose
file re-ran green then. Stage 5 gains the lock.

After the fixes: unit 1939/1939 (two new tests, one extended),
browser 52/52 on source and on the built frontend, lint clean; five more
removal checks (the carry-over, each verb's rate rebuild, the loose-file
rule), each failing the test meant to catch it. The harness check re-ran
unchanged. Compose rebuilt on the fixed tree and the in-container check
re-run: the bundled update from an edited image example, DeepSeek from GitHub
at `main@7f02846`, both removed, nothing left behind.

### Stage 4 — the examples say what the doc will say; the Add modal names them

**Close read (2026-09-25) — what it changed.** Five findings, measured in the
real app — the harness, and real tag calls through the Ollama running on this
machine — and folded into the steps below.

1. *The sort was already there, and the mark didn't survive an add.* The
   route appends the bundled rows after the whole catalog and the Add modal
   keeps the payload's order: ten app rows, then DeepSeek and Ollama. But once
   added, an example is an ordinary catalog row: it moved up among the AI rows
   and its tag read plain "AI", in the Add modal and on its card. So one
   predicate — a bundled row, or a plugin installed from a bundled source
   (Stage 3's `source.bundled`) — drives both the tag and the order, and an
   example stays marked, and last, after it is added. Its card's tag gives up
   the role word ("AI · tagger"), which the card's serving badges already
   show.
2. *"Example · ships with the app" didn't fit a phone.* At a 390px viewport
   it took 168 of the row's 302px and left the name and description 61px (198
   with "AI"), and it was the only tag not led by the card's family ("AI ·
   tagger", "Data · crypto"). The tag is `<family> · example`: "AI · example",
   84px.
3. *The conversion needs one host fill to be written the way the doc will
   teach it.* Written in full — each tag block keeping `models: []` — both
   examples register exactly what they do today (only `provides.tag`'s key
   order differs). Written with only what each has (no model lists), they
   install, fill every model picker from a live Ollama, and tag: real calls
   through both shapes returned the same answer and token counts (177 in, 17
   out). But the legacy spelling of tagging is assembled with its empties
   filled (`models: []`, `filter: null`), while `provides.tag` was taken as
   written, so the short form put `models: undefined` into providerCatalog —
   dropped by JSON, so nothing on screen noticed, but the same trap the
   catalog already closed for `research`. `provides.tag` now gets the same
   fill, and the examples declare only what they have.
4. *The READMEs were stale beyond the field names.* Both taught a
   paste-a-path install, when both examples have been one click in Add plugin
   since the welcome work (and under Stage 3's lock the paste is closed, the
   list is not); both named "the board's AI settings", which the board
   editor calls AI models (the close read's report said "Tagging settings" —
   wrong: that section holds no picker); Ollama's index.js said
   `embeds.models` must stay an array because the admin modal reads `.length`
   — false, measured: a copy without it drew every picker with no error;
   DeepSeek's said its embeds and transcribes "stay null".
5. *The tag in the Verify can be real.* This machine runs Ollama (0.32.5,
   `llama3.2:latest` pulled), and the compose app reaches it at the example's
   default base, `host.docker.internal:11434`. The example's default model
   (`llama3.1:8b`) isn't pulled, so the check picks `llama3.2:latest` — on a
   scratch board pinned to the connection, never the app default. The
   capability's probe is a key test (14 ms), not a tag.

Found for Stage 5, and recorded there: an embed-only plugin gets onto a
shared wire only by saying `tag: null` *(corrected in the second pass: the
build found the second way on)*.

Confirmed, no change: the welcome flow never calls tagFor, and the default
model its test reads ("Ollama · llama3.1:8b") survives the conversion; the
hint pin holds (keyless and needsBase are flags, not capability fields);
`research: false` and `embeds: null` / `transcribes: null` becoming absent
changes nothing any reader tells apart (the compat wire never reads
`research`); nothing covered the Add modal in a browser.

**Examples.** [deepseek/index.js](../examples/plugins/deepseek/index.js)
declares `provides: { tag: { default } }` and
[ollama/index.js](../examples/plugins/ollama/index.js)
`provides: { tag: { default, filter }, embed: { default, filter } }` — no model
lists, no `research: false`, no `embeds: null` / `transcribes: null`: absent
means absent. Both READMEs and both files' comments re-read against the code.

**Server** ([normalizeProvides](../server/providers.js)): an explicit
`provides.tag` gets the empties the legacy spelling is assembled with —
`models: []`, `default: null`, `filter: null` — so the two spellings register
the same catalog.

**Client.** `isExample(p)` in [admin-plugins.js](../public/admin-plugins.js) —
`p.bundled || p.source?.bundled`. tagFor answers `<family> · example` for one
(a load error still wins), and the Add modal lists the app's own rows first
and the examples after them, added or not. Welcome is untouched.

**Tests:**
- provides.test.js: a tag block that leaves out its list and its filter
  registers what the legacy spelling of it does, and survives a JSON round
  trip;
- plugin-install.test.js: each bundled example, built with makeCtx, carries
  no legacy capability field before `install()` backfills them (the hint pin
  beside it still holds keyless/needsBase);
- a new browser file, plugin-add.test.js — nothing covered Add: open it, and
  the examples carry the tag and sort last; add one, and it stays marked and
  last, and its card says so.

**Verify:** in the harness, the Add modal at desktop width and at 390px, where
the name column keeps its room. On compose, rebuilt: the Add modal shows both
examples marked and last; add Ollama from it; give it a connection to the
host's Ollama; pin a scratch board's tagging to it (`llama3.2:latest`); tag
one text item through it; then delete the board and remove Ollama. The
welcome flow is the browser suite's welcome file.

**Built 2026-09-25 — uncommitted.** Unit suite 1942/1942 — three new: the
short tag block's fill, the examples' `provides` pin, and the Add modal's
browser case (`npm test` runs test/browser too) — browser suite 53/53 on
source and on the built frontend, lint clean. The fill is `tagCatalog` in
[providers.js](../server/providers.js), the one helper both spellings of
tagging now go through; `isExample` and a family-first tagFor are in
[admin-plugins.js](../public/admin-plugins.js), the order in
[plugin-add-modal.js](../public/plugin-add-modal.js).

Decided while building:

- The fill is a helper both spellings call, so the two get the same empties
  by construction rather than by a second copy of the rule.
- tagFor leads every tag with its family word from one map, so the example
  branch names any kind's family (a connector example would read "Data ·
  example") without a second copy of the words.
- The pin reads the examples directory itself, not bundledPlugins, which
  lists only what isn't installed — a failure elsewhere that left one
  installed would otherwise hide it from the pin.
- Measured against HEAD's example files on the fixed host: DeepSeek
  registers the identical catalog entry and plugin def; Ollama's differs only
  in `provides.embed` no longer carrying `models: []`, which no reader tells
  from an empty list (the close read's pickers, and the real tag below). On
  the descriptor, `embeds: null`, `transcribes: null` and `research: false`
  became absent, as planned.
- The close read's report called the per-board picker "Tagging settings";
  it is the editor's AI models strip, which is what the READMEs now name.
- For Stage 5 (added to its note): `provides: { tag: null, … }` also gets an
  embed-only plugin onto a shared wire — the explicit null overrides the
  wire's claim — and it is written in `provides`.

Removal checks — each fix undone, the test that caught it, the file restored
byte-for-byte:

1. `provides.tag` taken as written again → "…and so does a provides tag
   block that leaves out a list and a filter it doesn't have".
2. An example given back a legacy field (`research: false` in DeepSeek) →
   "bundled: each example declares what it does in `provides` alone".
3. tagFor without the example branch → the Add modal case, at "both
   examples, and only they, wear the tag".
4. The mark read off the un-added row only → the same case, at "added, it
   is the same example: still tagged, still last".
5. The Add modal in payload order again → the same case, at the same
   assertion.

Real app. The harness — the real server on this tree, real Chromium: the Add
modal lists the ten app rows, then DeepSeek and Ollama tagged "AI · example";
at 390px an example row's tag is 84px and its name column 145px (the S3 row
beside them keeps 126px), and nothing overflows sideways; with both examples
added they stay last, as "Added", and their cards read "AI · example" while
every other card's tag is unchanged; no page errors, no failed requests.
Compose, rebuilt on this tree — the real database, real Chromium, through a
one-hour admin session deleted afterwards: the same order and tags among the
instance's own rows, and Ollama added from the modal stays last, its card
"AI · example · /app/examples/plugins/ollama · local". Then a connection to
the host's Ollama, a scratch board pinned to it (`llama3.2:latest`; the
instance's tagging default is OpenAI and stayed so), and one text item, "A
ripe tomato on a plate.": the worker tagged it through the example — the
ledger read tag · community.ollama · llama3.2:latest, 676 tokens in, 59 out,
$0, and the embed ran on the local model. The first answer came back with
reasoning ("it is red") and no valid pick — the 3B model's; a retag returned
`color/red`. Then the board deleted (its ledger rows go with it) and Ollama
removed: no external plugin, no plugin row, no connection, the volume holding
only `.staging`, and Ollama on offer again as an example. The compose app runs
a local build of the uncommitted tree (Stages 1–4); `docker compose pull app
&& docker compose up -d app` returns it to the published one.

**Second pass (2026-09-25, on request).** What it checked, and what it found:

- **The examples misstated what they do.** Declaring `tag` also serves field
  extraction — extract is declared by tag's entry (capabilities.js,
  `declaredBy: "tag"`), and the plugin modal offers a Field extraction row
  for any tagger (the close read saw one on the Ollama copy). DeepSeek's new
  comment said "tagging, and nothing else"; Ollama's named tagging and
  embeddings, and its list of what it doesn't do left out detection. Both say
  it now, and DeepSeek's README ("Tagging only") names extraction beside it.
- **Two test comments said more than their tests.** provides.test.js called
  the short tag block both examples' shape — Ollama's keeps its filter; the
  Add modal case said an added example "starts serving roles" — only once it
  is elected.
- **This section's summary line went stale in the build.** It said an
  embed-only plugin can't sit on a shared wire; the build measured two ways
  on. Corrected.
- **Checked, no change:**
  - normalizeProvides has two callers, install() and the loader's
    validateBuilt; the fill builds a new object, so an author's `provides` is
    never mutated, and normalizing a filled block again changes nothing.
  - The upgrade every existing install takes, measured: HEAD's legacy-shaped
    Ollama installed, elected for tagging and embedding over one connection,
    a board pinned to it; its source replaced by the new example and updated
    — both elections, the pin and resolution unchanged, and the embed
    picker's answer the same.
  - `isExample` reads `p.source?.bundled`, and `source` is also a source
    plugin's own block (`{ needsConnection, browsable }`) on a built-in's def:
    no `bundled` in it, so false there. An installed external source plugin's
    provenance replaces that block, and nothing reads the block (grep).
  - tagFor's family-first rewrite gives every other row the text it gave
    before: the Add modal's rows before (close read) and after (harness)
    match one for one, and the cards follow the same rules.
  - No other doc names the examples' fields — not the root README, not
    test/browser/README.md.
  - Line endings, byte-level.
- **For Stage 5** (added to its note): declaring `tag` also offers
  extraction, which the doc has to say; and an embed-only plugin, in either
  spelling, leaves `defaultModel` and `models` undefined in providerCatalog —
  measured, the JSON round trip fails for both, while the built-in on-device
  providers dodge it by declaring `defaultModel: null, models: []`. The
  Stage 4 fill is tagging's half; the non-tagger's half is the same trap, and
  closing it belongs with the doc that teaches embed-only plugins.

After the fixes — comments only — the files they touch re-ran green and lint
is clean; compose was rebuilt so the image's examples carry the corrected
comments.

### Stage 5 — PLUGIN.md, and the traps it would otherwise have to teach

Written last, from the code as it stands after 1–4. Root of the repo — a
stranger cloning this has to find it without reading `planning/`.
`.dockerignore`'s `*.md` matches root files only, so PLUGIN.md stays out of
the image (Stage 3 second pass).

**Close read (2026-09-25) — what it changed.** Four read-only inventories,
one per kind — every field and method the host reads, each with its line —
plus the checks named below, against the tree Stages 1–4 left. The outline
held. What it missed is below, and the stage now fixes ten traps instead of
documenting them.

The decisions the plan had left open:

1. *Embed-only plugins.* When a descriptor has `provides`, only `provides`
   declares: a wire with a tag method no longer counts as tagging. That is
   what makes "what `provides` leaves out it doesn't do" — the examples' own
   comment — true for every plugin that follows the doc. No built-in writes
   `provides`, so the legacy spelling keeps its inference. A descriptor that
   tags through the legacy fields but writes `provides` without `tag` is
   refused with a sentence, so a half-converted one can't install silently
   as embed-only. The hybrid test (`provides.tag` beside a legacy `embeds`)
   still passes: a legacy catalog object is a declaration, not an inference.
2. *D1.* Nothing built. Every ctx member ships with the doc, so the doc is the
   baseline, and the failure Stage 1's second pass measured — a new plugin on
   an old host — can't be fixed from this side. A member added after the doc
   gets a "since" line, and the loader's sentence for a missing member is
   built with that first addition.
3. *"How to get listed."* Dropped: it would describe an index that doesn't
   exist (Stage 6 is gated). The section is "Sharing a plugin": publish the
   directory, others paste it into Add plugin.
4. *Test names in the doc.* Replaced by one test that reads PLUGIN.md's lists
   — ctx members, capabilities and wire methods, the kinds, the provider
   methods, the connection field types, the column kinds, the reserved
   domains, and the built-in domains' field tables — and fails when one
   drifts from the code. A test file name means nothing to a stranger and
   stops no drift. D9 amended.
5. *Removing a source plugin kept its connections.* cleanupPluginConfig
   returned early for a source from the day the kind arrived (cc0fb28), under
   a comment — "like connector keys, deliberately survive a reinstall" — that
   was false then too: connector keys were cleared. The Remove confirm said
   the connections "become unusable until you add it back", while an AI
   plugin's connections and a data plugin's key went with no word in theirs.
   No plan ratified the exception, and Update (Stage 3) retired the reinstall
   it served. **Decided with the user:** a source plugin's connections are
   deleted on Remove like every other kind's, and every Remove confirm names
   what it deletes.

Traps fixed rather than taught:

6. *`ctx.fetchJson` put the full URL in its error,* query string included. A
   key passed as `?apikey=` reached the health ledger, the admin's error
   banner and — through /connector-list's 502 body — any member of a board
   browsing the domain. The built-ins dodge it by hand (CoinGecko sends a
   header, FMP redacts). The message names the URL without its query.
7. *Embeddings had to be unit-length Float32Arrays,* by a rule written
   nowhere: storage reads `vector.buffer`, so a plain array threw after the
   batch was metered, and the batch went back to be paid for again. The
   search score is a plain dot product, so a vector that isn't unit length
   ranks wrong in silence. embedTexts — the one door every embed call goes
   through — hands back unit Float32Arrays whatever the wire returned,
   detectObjects' normalizing precedent.
8. *The compat wire had no defaults.* A descriptor without `compat` threw on
   every tag; one without `maxTokensField` sent a body field literally named
   "undefined"; and the default key test asked for `/models/<defaultModel>`,
   which an embed-only plugin doesn't have. Defaults: `maxTokensField:
   "max_tokens"` (five of the six compat descriptors' choice) and `keyTest:
   "list"`.
9. *An embed-only descriptor,* in either spelling, left `defaultModel` and
   `models` undefined in providerCatalog (Stage 4 second pass). Derived, as
   `research` is.
10. *The loader's sentences named `defaultModel` and "the legacy … fields",*
    which the doc never mentions. They name `provides.tag.default` and
    `provides`.
11. *A domain named `embed`, `transcribe` or `detect`* shares its
    `<domain>_provider` setting with the AI embedder's, transcriber's or
    detector's election, so starring or removing it would rewrite that
    election. Those names are reserved, derived from the capabilities that
    store a provider setting.
12. *Two nameless sub-entries Stage 2 missed.* A browse column without a label
    showed a blank header — in the browse table and, through the feed
    descriptor, in the ingest modal's filters and preview — and a face
    without periods read "a undefined chart". Both fall back as their
    siblings do: the key, and the face's name.
13. *`category`* is declared by both built-in domains, shipped by
    listConnectors, read by nothing, and commented as grouping the template
    picker, which it doesn't. Deleted, as Stage 2 deleted `identity.label`.
14. *CoinGecko's and CoinMarketCap's fetchEntity threw "not found" with no
    status.* The fetch leg retried it five times over about 35 minutes, and
    callProvider paused the whole provider for a minute each time. The doc
    tells authors to throw a 404 and the built-ins are the reference copies
    (Stage 1), so they carry one.
15. *A source plugin with no connection* drew the built-in folder's sentence
    ("… the server's ingest root (INGEST_ROOT)") in its settings, and one that
    can't be browsed drew "✗ this source can't be browsed" on its ingest tile,
    because the tile's probe browses. The sentence is the folder's alone, and
    the probe skips a source that can't be browsed.

What the doc says that the outline didn't — the inventories' findings, no
code change:

- *connector-provider:* `symbol` is an item's identity across providers
  (lowercased; the provider's id when there is none), so two providers of a
  domain must agree on it. `search` only re-finds an item after the domain
  switches provider. Without `list()` the browse table is empty and feeds
  refuse. `fetchFields` must answer every field it's asked for, or the host
  falls back to `fetchEntity`. `unsupported` is an answer only from
  `chart()`. `pacesRequests` means calling `await pace()` before each
  request, which also meters it. A status-less error pauses the provider for
  a minute. `periods` is not read on a provider — dropped from the list. The
  crypto and stocks field catalogs are tables in the doc, pinned.
- *connector-domain:* the pane binds a domain only through its `template`, and
  the + button adds only through `browse`, so both are required in practice
  though the loader leaves them optional. A face is fed by `history()` alone.
  Today's domains assume market data: identity by symbol, and the chart face
  reads `price`. Removing a domain plugin leaves its provider plugins errored
  at the next boot.
- *ai-provider:* the `compat` block's ten keys and `nativeBase`; each wire
  method's exact arguments (detect's `queries` and `threshold`, transcribe's
  `audio` and `filename`, and its optional `turns`); `usage.input` excludes
  cache reads; any 4xx but 408 and 429 fails an item at once — not 422 alone;
  declaring tagging also serves field extraction and facet review.
- *source:* `key` is a file's identity across scans, with `size` and
  `modified` as its change check; `test()` runs only for a source with
  connections; `conn` is the stored config as saved, so a field added in a
  later version has no default at runtime; labels are rendered as HTML.
- *manifest:* `version`; the manifest's label and description show only until
  the code runs; a `package.json` wants `"type": "module"` (measured on Node
  22.16: without it every load logs MODULE_TYPELESS_PACKAGE_JSON; the image
  runs 22.23.3).
- *install:* with Docker, a path is a path inside the container.

Confirmed, no change: the trust line — admin-only routes, a confirm naming
full access and no sandbox, scripts off unless `allowScripts`, the ref on the
card; the six install source forms; the host's error classification
(failOrRequeue); the face producer signature, `(series, { symbol, name,
period }) → { webp, w, h } | null`.

The Verify, amended. A fresh session's crypto provider can't serve a board on
compose without being made crypto's default, which would route the real
crypto boards' refreshes through it, and the browser harness runs no worker.
So the full flow runs on the host server against a scratch database, and
compose sees install, Test and Remove. A second fresh session writes a
connector-domain — the section with the most requirements the loader doesn't
enforce.

**Moves:**

1. [providers.js](../server/providers.js): normalizeProvides infers tagging
   from `wire.tag` only for a descriptor without `provides`; embedTexts
   returns unit Float32Arrays; providerCatalog derives `defaultModel` and
   `models`.
2. [plugin-loader.js](../server/plugin-loader.js): the half-converted refusal;
   the sentences name `provides`; the reserved domains gain the capabilities'
   provider-setting names; cleanupPluginConfig deletes a source's
   connections; the lists the doc prints are exported for its test.
3. [plugin-ctx.js](../server/plugin-ctx.js): fetchJson's message drops the
   query.
4. [compat.js](../server/ai-providers/wires/compat.js) and
   [google.js](../server/ai-providers/wires/google.js): the quirk block's
   defaults.
5. `category` out of both built-in domains and listConnectors.
6. CoinGecko's and CoinMarketCap's not-found carries 404.
7. The column label falls back to its key in the feed descriptor
   ([ingestion/connector.js](../server/ingestion/connector.js)) and the browse
   table; the face row names a face without a period sanely.
8. The folder sentence and the tile probe
   ([plugin-modal.js](../public/plugin-modal.js),
   [ingest-modal.js](../public/ingest-modal.js)); the Remove confirms
   ([admin-plugins.js](../public/admin-plugins.js)).
9. PLUGIN.md at the root; one README line pointing at it.

**PLUGIN.md, in order:** what a plugin is (a directory, `manifest.json`, a
`main` default-exporting `(ctx) => …`; the four kinds; the trust note,
plainly); the manifest; installing, developing, updating and removing; ctx;
each kind's contract (ai-provider, connector-provider with the built-in
domains' field tables, connector-domain, source); errors; versions (the
`apiVersion` policy and the ctx baseline); sharing a plugin.

**Tests:** the doc's lists against the code (new, plugin-doc.test.js); with
`provides`, a wire's tag method declares nothing, and the half-converted
descriptor is refused; an embed-only catalog entry survives the JSON round
trip; a wire's plain, non-unit vectors come back unit Float32Arrays; the
compat wire with no quirk block builds a `max_tokens` body and tests a key by
listing models; the loader's sentences; the reserved domains; fetchJson's
message; a source's connections go with it on Remove and another source's
stay; the built-ins' not-found carries 404; the feed descriptor's label
fallback; no domain ships `category`; a Remove confirm names what it
deletes, in a real browser.

**Verify:** each fix undone, the test that catches it. In the harness: an
unlabelled column's header in the browse table and the ingest modal, a
period-less face's row, a connectionless source's settings and tile. On the
host server against a scratch database: a fresh session writes a
connector-provider for crypto from PLUGIN.md alone, it installs from a path,
is made crypto's default, and a board made from the crypto template browses,
adds and refreshes through it; a second fresh session does the same for a
connector-domain of its own. Each session's transcript is checked for any
source file it opened. On compose, rebuilt: the crypto plugin installs from
a path in the container, its Test passes, and Remove leaves nothing; a
source plugin with a connection is removed and its connection goes with it.

**Built 2026-09-25 — uncommitted.** Unit suite 1967/1967 — 25 new: the doc's
twelve pins (plugin-doc.test.js), and one each for the provides rule, the
embed-only catalog, the unit vectors, the compat defaults, fetchJson's
message, the embed-only plugin on a shared wire, the three loader sentences,
the built-ins' 404 (crypto, and FMP), the column label, and the Remove confirm
in a real browser (plugin-remove.test.js) — browser 54/54 on source (inside
the suite) and on the built frontend, lint clean. New:
[PLUGIN.md](../PLUGIN.md), [plugin-doc.test.js](../test/plugin-doc.test.js),
[plugin-remove.test.js](../test/browser/plugin-remove.test.js).

Decided while building:

- The compat defaults are one reading of the block, `quirks(desc)` in
  compat.js, which google.js imports; every `desc.compat` read goes through
  it.
- `unitVector` passes an already-unit Float32Array through untouched (within
  1e-4), so the shared wires' vectors, normalized already, cost nothing.
- The half-converted refusal counts a legacy field only when it declares
  something — `defaultModel` non-null, `models` non-empty, `modelFilter`
  non-null — so the on-device built-ins' `defaultModel: null, models: []`
  declares nothing.
- FMP's "no quote" got the 404 too: the close read named CoinGecko and
  CoinMarketCap, and FMP had the same status-less not-found.
- coingecko.js said withRetry never slows the bucket — stale since a 429
  halves it; fixed while in the file. The other stale comments stay under
  Found along the way.
- A period-less face also drew an empty "How much history" select in its
  drawer; it's hidden now, the same finding as the row.
- A connectionless plugin source's settings say "This source needs no
  connection…" under Connections; the ingest-root sentence is the built-in
  folder's (`core`) alone.
- The Remove confirm names what the server deletes, in its order
  (`uninstallDeletes`). A built-in source's Remove only switches it off, so
  its "unusable until you add it back" stays, and stays true; an errored card
  names the kinds of thing, since its counts never loaded.
- No cache eviction for a removed source's connections: a read through a
  cached listing refuses at the install gate, and a new connection gets a new
  id.
- PLUGIN.md's pinned lists sit under HTML-comment markers the test reads; a
  reader never sees them.
- DeepSeek's README links its two mentions of "the contract" to PLUGIN.md;
  Ollama's README has none.
- `liveCatalog` and `provides.<cap>.note` stay out of the doc: the first
  serves the built-in sidecars and routes no call, the second is a sidecar's
  display line.
- The untracked movies plan names `category: "entertainment"`, a field that
  no longer exists — for that arc to drop when it starts.

Removal checks — each fix undone, the test that caught it, the file restored
byte-for-byte:

1. Tagging inferred from the wire despite `provides` → the provides rule, the
   embed-only plugin on a shared wire, and "declaring nothing" (which then
   read as a tagger with no default).
2. The half-converted refusal removed → its RULES row.
3. The embed vectors passed through as the wire gave them → the embed-sweep
   case.
4. The embed-only catalog passing `undefined` through → the JSON round trip.
5. The compat block without defaults → the compat case.
6. fetchJson naming the full URL → its case.
7. The capability names not reserved → the manifest test and the doc's pin.
8. A source's connections outliving it → the install test and the browser
   case.
9. `category` back on crypto → the crypto manifest test.
10. CoinGecko's not-found without a status → the crypto 404 case.
11. FMP's the same → the FMP case.
12. The unlabelled column named nothing in the feed descriptor → its case.
13. The loader naming `defaultModel` again → "a tagger with no default".
14. A ctx member the doc doesn't list → the ctx pin.
15. The doc dropping a reserved name → that pin.
16. The Remove confirm saying only the code goes → the browser case.

Real app.

- *The harness, both ways.* A domain plugin with an unlabelled column and a
  period-less face, and a source plugin with no connection that can't be
  browsed. Reverted, the browser showed a blank browse header, "a undefined
  chart, once", a blank filter option, the ingest-root sentence on the
  plugin's settings, and "✗ this source can't be browsed" on its tile. Fixed:
  "humidity", "a tile, once", "humidity", "This source needs no connection",
  no error. No page errors either way.
- *The host server with its worker* — `node server/server.js` on a scratch
  database cloned from the test template, driven by real Chromium through the
  Add dialog, then a board from the domain's template, browse, add, and the
  worker's own legs. A static plugin proved the check first: fields from it,
  a refresh through it a minute later, two chart faces.
- *The fresh sessions.* Two agents, each given PLUGIN.md and nothing else.
  Their transcripts were audited: the one repo file either opened was
  PLUGIN.md. The crypto session wrote `fresh.coinpaprika` on CoinPaprika's
  keyless API; the domain session wrote `fresh.openmeteo`, a `weather` domain
  of 148 cities on Open-Meteo. Both installed from a path through the Add
  dialog and served a board end to end: live browse rows ("1 Bitcoin BTC
  $84,069.76", "Jakarta JKT Indonesia Clear sky 33.4"), two items added,
  every field landed from the plugin (11 for crypto, with its own derived
  30-day change; 10 for weather), a refresh through it a minute later, and
  faces drawn — 1y price lines, and temperature lines. No page errors, no
  server errors.
- *What they found.* 23 gaps and 35, overlapping heavily; every one the code
  could answer went into PLUGIN.md, each checked against the code: ctx's
  quote cache and chart helpers spelled out, `t`'s unit, the per-call
  argument renamed `call` (it shadowed `ctx`), search's fallback and what an
  empty answer means, duplicate symbols, `list`'s options and value units,
  how often each method runs, a keyless provider's key field, pacing's scope
  and cost, the template's rules, `face.producer` holding a face's name, the
  two "manifests" and two "faces", the card's label, the provider serving
  from install, periods as plain strings, what renderChart draws, a custom
  face's encoder, multi-file plugins, ESM without a package.json, and the
  domain example that mapped a face it never declared. The sessions ran
  against the first version; the revision answers them and was not run past
  a third session.
- *One host behavior they surfaced.* A `percent` column renders as a signed,
  colored change: humidity read "+50.00%" in green. Documented — a plain
  percentage reads better as `number` with "%" in its label — not changed.
- *Compose, rebuilt* (`docker compose up -d --build app`), the real database
  and routes, a one-hour admin session made in the container and deleted
  after: PLUGIN.md is not in the image. The crypto session's plugin installed
  from `/tmp` in the container (ref `local`, version 1.0.0), its Test passed
  against the live API, and Remove left no install record, plugin row, key
  or dir, with crypto's default still CoinGecko. A source plugin given a
  connection holding a secret was removed, and the connection went with it.
  One app-scope `api` request stays on the meter — the Test's real call.
  The container's copies were removed; the plugins volume holds only
  `.staging`. The compose app runs a local build of the uncommitted tree
  (Stages 1–5); `docker compose pull app && docker compose up -d app`
  returns it to the published one.

**Second pass (2026-09-25, on request).** Five read-only agents, one per
part of PLUGIN.md, each told to check every claim in its part against the
code — the code the truth, the doc under test — and to report what's wrong,
what's missing that would break a plugin written from the doc, and what it
confirmed, with file and line. None had read the plan. Every finding was
re-read in the code before anything changed, and the ones that matter were
measured. Beside them, a re-read of the stage's own code changes. What it
found:

- **A defect: a domain plugin's Remove confirm left out the domain.**
  Measured in a real browser: "This is the default p2weather provider. /
  This deletes its downloaded code. Existing boards keep their data." — while
  the Remove took the whole domain, every board on it stopped refreshing, and
  another plugin's provider for it broke. The stage's own decision was that
  every Remove confirm names what it deletes, and the doc said this one did.
  Fixed: the catalog marks an external domain plugin
  (`connector.addsDomain`, from its stored manifest), and its confirm reads
  "It adds the tides domain, which goes with it: boards on tides stop
  refreshing, and Other Tides, which provides tides, stops working." in place
  of the default-provider line, which its own provider nearly always holds.
- **A defect: the compat defaults held for a key left out, not one written
  as `undefined` or `null`.** Measured: `maxTokensField: undefined` still sent
  a body field named "undefined", `null` one named "null" with
  `temperature: null` — the trap fix 8 claimed to close, and the arc's own
  rule (Stage 2's second pass) is that a `null` is absent. Fixed: `quirks()`
  drops null and undefined values before the defaults.
- **A test gap: the browse pin compared keys, not the kinds printed beside
  them.** A column's kind decides whether `list` answers a number or a
  string there. Now both.

Traps the doc's own contract walked into — fixed in the host as the stage
fixed its ten, each at the one place the value passes:

- **The anthropic wire tagged at the wrong server.** Its `tag` built the SDK
  client on `desc.base` while `testKey` and `listModels` read the
  connection's own URL, so a gateway plugin (`needsBase`) passed Test and
  then sent every tag — with that connection's key — to the descriptor's
  default, or to Anthropic's own API with none. Measured over real HTTP
  through callTagger against a local stand-in: reverted, "Connection error."
  and the gateway saw nothing; fixed, it got `/v1/messages` with the
  connection's key. Fixed: `base || desc.base`, as its siblings.
- **A source's `list` got no `accept` or `maxBytesFor` while browsing.** The
  doc lists both, and every built-in defaults them, which hid it. Measured in
  a real browser with a source written the way the doc says: the folder tree
  read "opts.accept is not a function", "Use this folder" stayed disabled, and
  the ingest tile's probe fails the same way. Fixed: browsing passes both,
  letting every file through, so the built-ins list exactly what they did.
- **A source entry's `size` and times had to be whole numbers.** The ledger's
  columns are BIGINT, and a plugin stamping `modified` from `stat.mtimeMs`
  failed every run — measured: `invalid input syntax for type bigint:
  "1727270000123.456"`. The built-in folder rounds its own. Fixed where a
  listing becomes candidates (files.js `toCandidates`): rounded, and anything
  that isn't a number is null, through the app's own `num`.

The line between the two: the host normalizes what only the host reads
(sizes and times go to the ledger and nowhere back), and the doc states what
the plugin gets back — a source's `key`, a provider's ids and its filter
values arrive as strings, so the doc says to give strings. Coercing those
would hand a plugin back something it didn't write.

Corrected in PLUGIN.md — each against the code, the dev loop measured:

- *Installing and developing.* The `docker compose cp` loop was broken:
  measured on compose, a second copy lands inside the first
  (`/tmp/x/my-plugin`) and Update loads the old files; `./my-plugin/.`
  copies the contents either time. A tarball URL has to end in `.tgz` or
  `.tar.gz`; npm takes an exact version or none; GitHub and npm are fetched
  without credentials, so only public ones install; Update keeps `domain` as
  well as `id` and `kind`; `allowScripts` runs the plugin's own install
  scripts too.
- *The manifest.* The `keyless` and `needsBase` hints are read only for the
  app's bundled examples (the first-run screen; `needsBase` by nothing), so
  they do nothing for anyone else's plugin; `description` shows on the Add
  list, not the failed card; "a second install of the same id" was per
  catalog id.
- *Removing.* Other plugins' providers for a removed domain stop at once —
  measured: their card read "failed to load", with the real reason only
  after Retry or a restart — not "from the next restart"; and what the
  confirm names.
- *Versions.* A newer ctx member fails at the call — at load only when the
  factory makes it. The doc's own connector example calls `ctx.num` inside
  its methods.
- *ai-provider.* `strictTools` recovers from one refusal only, a schema too
  big to compile; `models` also limits what `transcribe` and `detect` can
  save; a keyless connection can still carry a token; a blank server URL
  falls back to `base`, and the anthropic wire's `base` goes without `/v1`;
  the compat call isn't forced by default; `detect` gets Test's PNG and an
  image the app couldn't re-encode as it was; transcription is audio only; an
  admin's price and `listPrices` outrank the descriptor's; testKey's `model`
  is usually null; research needs the anthropic or google wire; and the app
  puts no deadline on a wire call.
- *connector-provider.* Feeds stop only at an empty page and send neither
  `query` nor filters; `prefetch` errors pause the provider like any other;
  `history` should answer `[]` for a period it can't serve (retried either
  way); `filterOptions` runs more often than on open, and its values must be
  strings; ids come back as strings; `honorsSorts` must hold both ways;
  `search` runs every time for an item added under another provider; an item
  without a symbol can't be found after a switch and gets no live chart.
- *connector-domain.* Where the domain's slug shows; a `null` inside the
  template is not absent (it's checked as a board's save, and the host was
  left so: loosening it would loosen every board save); presets'
  shape; filter option strings; `price` must be a number; face-producer name
  characters; `chart()` is reached only on a board with a connector face and
  for an item with a symbol; an `unsupported` pair serves the range's other
  kind first; `aggregateCandles` takes daily candles and can pass `max`; the
  lightbox reads numbers as money.
- *source and Errors.* While browsing, `source` is only the type, the
  connection and the folder open; a saved `path` has no trailing `/`;
  secrets are trimmed; where `help` shows; `type` is required; `key` is a
  string. Transcription's temporary errors pause transcription on the key —
  tagging too — with no limit on retries; embedding isolates a text only when
  another in its batch succeeds, and every other failure, a batch of one
  included, pauses the whole key for a minute.

Checked, no change: the doc's four code examples pass validateManifest and
validateBuilt (the domain assembled from the doc's own template, browse and
face snippets); every in-doc link and anchor resolves; the built-in providers
import nothing, so the copy-and-install claim holds; the stage's embedding,
source-removal, label and loader changes read right on a second look. The
agents' confirmed lists ran to some 150 claims.

After the fixes: unit 1971/1971 — four new: the null quirks, the anthropic
wire's connection URL, a doc-written source browsing and landing a
fractional time, and the domain Remove confirm in a real browser — browser
55/55 on source and on the built frontend, lint clean. Removal checks, each
fix undone and its test failing, the file restored byte-for-byte: the null
quirks; the anthropic base; browsing without `accept`; the rounding (and,
with the test's equality check dropped too, the ledger's own bigint refusal);
the confirm's domain line; the catalog's mark; a wrong kind in the doc's
browse table. Two of the new tests were written first and failed on the
unfixed code. Real app: the source's tree and tile in a real browser, both
ways; the gateway over real HTTP, both ways; the domain confirm, both ways.
Compose rebuilt on this tree: healthy, the four fixes in the image,
PLUGIN.md still not in it.

**Simplification pass (2026-09-25, on request — Stages 1–5).** Six
read-only agents, one per area: the loader and install, the AI providers,
the connectors and ingestion, the admin UI, the tests, and PLUGIN.md. Each
looked only at this arc's changed lines, for the same rule written twice,
dead code, a helper the code already had, and comments that tell how a fix
was found, and said exactly what each change would alter. Every finding was
re-read in the code before anything changed, and only changes that keep
behavior went in, with the one exception named below. 157 lines fewer across
26 files: 107 of code, 34 of tests, 16 of PLUGIN.md.

What went:

- `WIRE_VERB` (capabilities.js). Once Stage 2 added `tag` to it, it was
  every declarable capability's own `verb` field written again; its note
  said it was "narrower", which Stage 2 undid. The loader reads
  `CAPABILITY[cap].verb`, and so does the doc-pin test.
- `tagCatalog` (providers.js). The empties are filled once, after the merge,
  not by a helper called for each spelling: exactly one of the two spellings
  produces `tag`.
- `buildDir` and `refuseShadow` (plugin-loader.js), which existed so Update
  could skip one check. Now it's `loadDir(dir, { replacing })`. Update
  registers the manifest it reads from the committed dir, as install always
  has.
- `stage()` and its two callers' `finally` blocks (plugin-loader.js).
  `withStage(url, fn)` owns the staging dir and removes it whether `fn`
  returns or throws. No test proved the staging dir was cleaned up, before
  this pass or after it; one does now.
- The compat wire's own vector normalization. The embed funnel Stage 5 added
  (providers.js `unitVector`) does it for every wire. This is the pass's one
  change in behavior: a compat vector already within 1e-4 of unit length is
  now stored as the provider sent it, like every other wire's, instead of
  being divided by its norm first. That changes the last bits of a float.
  Measured through embedTexts with a stubbed answer: [3, 4] still lands as
  (0.6, 0.8), a zero vector stays zero, and the order holds.
- plugin-ctx.js `fetchJson` built the error that the AI wires'
  `providerError` (tool.js) already builds, a fifth copy of it. It now calls
  `providerError`.
- Dead members that the factory conversion carried into the built-ins'
  return objects: `periods` on CoinGecko and CoinMarketCap (only FMP's is
  read, and crypto's domain names its own face periods), and CoinMarketCap's
  `_ageChartCache`, which no test calls. The live-check scripts now use the
  domain's own provider instances instead of building their own.
- Admin UI:
  - Update/Retry takes its label from the card's state instead of comparing
    a label string later. Its "No source URL on record" branch is gone: no
    external row can reach it, because `source_url` is NOT NULL and is only
    set from a URL that fetched.
  - `uninstallDeletes` no longer builds a parts array for what is at most
    one part.
  - `ctx` is the state spread, as admin-capabilities builds it, so a new
    state field is added in one place, not three.
  - The Remove confirm writes its heading and join once.
  - A no-connection source's section is now one section, with its heading
    and sentence chosen by one condition.
- Loader smalls:
  - one namespace rule for face producers, where it was written twice;
  - a `!b ||` inside a `!= null` check, removed;
  - the two 409s written in the codebase's `Object.assign` idiom.
- Comments:
  - trimmed to the rule and its reason where they told how a fix was found
    ("Stage 5 second pass", "decided with the user");
  - the examples' header paragraphs cut where the body said the same thing;
  - providers.js named Gemini two lines after saying no vendor name appears
    in the file, and no longer does.
- Tests:
  - The two compat quirk tests are now one, over three cases (no block,
    undefined, null), and each case also checks what the other test asserted.
  - The Remove browser test:
    - shares one plugin writer and one temp root;
    - its source's backend is `() => ({})`, since nothing calls it;
    - its cleanup lost a guard that was dead, because `req()` doesn't throw on
      a 4xx.
  - The tarball test serves its archive through `serving()`.
  - A null `provides` entry joins the table of null entries.
  - provides.test.js registers providers through one `withProviders`.
- PLUGIN.md:
  - One real error, fixed. Prefetch and history said an error "without a 4xx
    status" pauses the provider, which leaves out the 429 that does
    (runtime.js). Both now point to Errors, where the rule is right.
  - Facts said twice, now said once:
    - boards keep their items;
    - the tagger trap;
    - the item literal (the example already returns one);
    - where the labels show (the tables say);
    - the chart fallback, merged, now naming `chart.defaultRange` and then
      the last range still offered, as the runtime does;
    - the 404 reason and fetchJson's URL rule in Errors;
    - the Versions sentence;
    - the source list in Sharing;
    - ctx.log's description.

Checked and left:

- The provider-map merge rewritten as a spread. It would reorder providers
  when an update adds one, and replace the map object that the domain's own
  code may hold.
- One route helper for install and Update. It covers only two routes that
  share the codebase's usual try/catch shape, and the helper would have to
  encode "no row" as `source != null`.
- Moving CoinGecko's eight fetch sites onto `ctx.fetchJson`. It changes the
  error text users see.
- Deleting source connections in one SQL statement. It's a rare admin
  action, and the db functions read fine.
- `modelId` reading the quirk block for each row. The cost is negligible,
  and returning raw rows is `modelRows`' contract.
- The three-line "written as a plugin" note in each built-in provider. Each
  file is meant to be read and copied on its own.
- A doc agent's claim that a failed card shows the manifest's description.
  It doesn't: erroredRow renders the label, source, reason and tag. The doc
  was right.
- A test helper for admin sign-in. There are five older copies outside this
  arc.
- A shared temp root in plugin-install.test.js. The file's own pattern is
  that each test cleans up its own dir.

After:

- Unit 1971/1971, exit 0, lint clean: the same count as before, since two
  tests merged into one and one is new, for the staging dir.
- Browser 55/55 on source (in the suite) and on the built frontend.
- PLUGIN.md's four examples still pass validateManifest + validateBuilt.
- Removal checks on every proof the pass restructured or relied on. Each fix
  was undone, its test failed, and the file was restored byte-for-byte:
  - the null quirks;
  - the domain confirm line;
  - source connections outliving an uninstall;
  - a null provides entry counted as declared;
  - the tag fill;
  - the loader's verb check;
  - the shadow check on a live domain's update;
  - Retry skipping that check;
  - the staging cleanup, which nothing caught until the new test.
- Real app, in a real browser, running the old and new client code and
  comparing the two, with identical results for:
  - Update and Retry labels and titles;
  - both buttons disabled under PLUGIN_INSTALL_DISABLE, with the lock's
    title;
  - the built-in, external and errored Remove confirms;
  - both no-connection source sections.
- Compose rebuilt on this tree: healthy, the changes in the image, PLUGIN.md
  still not in it.

### Stage 6 — the community index (gated; designed, not built)

Not built until the index would hold an entry the maintainer did not write.
Designed now so D8's decisions are concrete and PLUGIN.md can describe it.

- `community/plugins.json` in the app repo:
  ```json
  { "apiVersion": 1,
    "plugins": [
      { "id": "vendor.name", "kind": "ai-provider", "label": "…",
        "description": "…", "author": "…", "version": "1.2.0",
        "source": "github:owner/repo/dir@v1.2.0",
        "checksum": "sha256:…",
        "keyless": true, "needsBase": true, "domain": "crypto" } ] }
  ```
  A PR to it is reviewed as a pointer: the manifest at the source validates,
  kind and id match, the ref is a tag or sha — never a branch. *(research)*
  The index carries everything the tab renders — label, description, kind,
  hints, version — so browsing costs one file fetch and never a per-plugin
  GitHub read (HACS hit the unauthenticated limit doing that and moved its
  whole dataset to a CDN). `checksum` is optional and, when present, the
  installer verifies the tarball against it before unpacking.
- Server: `GET /api/admin/plugins/community` fetches `PLUGIN_INDEX_URL`
  (default: the repo's raw `main` URL), caches 10 minutes, returns entries
  minus installed ids plus `fetchedAt`, or a readable error. The fetch lives
  in [plugin-fetch.js](../server/plugin-fetch.js) with the rest of the network
  code.
- Client: the Add modal gets a chip row above the list — `Included ·
  Community` — the same `.pill-row` the Plugins page uses for its kind
  filter, no new CSS. Community rows install through the URL path with the
  install confirm; a failed fetch shows its reason in its own tab and never
  empties Included.
- Not a separate repo yet; the file can move and the env var follows it. The
  app knows only its package version, not its commit, so the index cannot be
  pinned to the app build — the loader's apiVersion check stays the guard.

## Verify (compose stack, end of each stage / all at end)

1. Stage 1: crypto and stocks boards behave exactly as before across browse,
   add, refresh, face and lightbox chart; the suite is unchanged.
2. Stage 2 (host dev server — `test/` is not in the image): a broken domain
   fixture pasted into the URL box errors inline naming the field. Compose:
   the bundled examples still install. The browser suite's welcome file
   passes.
3. Stage 3 *(close read)*: in the harness, an edited copy of Ollama updates
   with its connection, election and pin intact; on compose, the bundled
   Ollama edited inside the container updates to the new text, and DeepSeek
   installed from GitHub shows `main@<sha7>`.
4. Stage 4 *(close read)*: on compose, the Add modal shows the examples
   marked and last, before and after one is added; a text item on a scratch
   board is tagged through Ollama added from it (`llama3.2:latest`, the
   host's server).
5. Stage 5 *(close read)*: two fresh sessions, PLUGIN.md only, write a
   connector-provider for crypto and a connector-domain; on the host server
   against a scratch database each installs from a path and serves a board
   end to end, without the session opening a source file. On compose: the
   crypto plugin installs, tests and removes cleanly.
6. Stage 6: nothing to verify until the gate opens.

## Risks / notes

- **Stage 1 is the only stage touching working code at scale** — ~1,600
  lines of provider code get an indent. Per file, suite green between files,
  and the alternative in the stage is the fallback if the close read finds
  state that does not survive a factory.
- **The cycle constraint dissolved in the close read.** The AI engine never
  imports plugin-ctx.js, and the runtime's import graph never reaches the
  connector registry or the loader, so plugin-ctx.js imports the runtime
  freely. Should a later change make the runtime import either, boot would
  hit a temporal-dead-zone read; the suite boots the server in most files,
  so it would fail loudly rather than quietly.
- **The trust model does not change.** Update and the index add no new way
  to run code — they add a way to see which code ran (the sha) and a way to
  refresh it without losing configuration.
- **`examples/` stays in the image** (not in `.dockerignore`), so bundled
  paths keep working and Update on a bundled install re-copies from the
  image — that is the upgrade path for examples after an image pull.
- **Windows dev:** `pluginsDir()` falls to `/data/plugins` when `PLUGINS_DIR`
  is unset, which is `C:\data\plugins` on a host `npm run server`. Tests set
  it. Not this arc's to fix; noted.
- **The Add modal's tab split waits for the index** (D8) and the Plugins page
  never splits (D10).

## Found along the way — not this arc, but real

- `usage_meter.provider` is not namespaced by family (the metering ledger's
  known-open): one `vendor.name` used as both an AI and a data provider would
  collide. Unchanged; a migration when it is touched.
- [buildModule](../server/plugin-loader.js#L306)'s `?t=` cache-bust never
  matters — every install and update lands in a fresh dir. Harmless.
- `manifest.providers` on both built-in domains: the deep dive said it had no
  reader; Stage 1's close read found three test readers. Deleted in Stage 1,
  the readers repointed to the live list.
- The acme-weather fixture's `identity: { from }` drift — fixed by the card-key arc (slot deleted); Stage 2 would have caught it.
- `FILTER_KIND` (ingestion/connector.js) knows `date`, which the browse table
  doesn't draw: a domain declaring a date column gets a working feed filter
  and a blank browse column. A host gap, not the plugin's — Stage 2's column
  rule accepts `date` for that reason.
- The WIDGETS stub in ingest-connector.test.js still carries the
  `manifest.providers` snapshot Stage 1 deleted from the built-ins. Test data
  with no reader; harmless.
- *(Stage 2 build)* Compose's plugins volume holds
  `ai__community.ollama@local-10b003`, dated 2026-09-14, with no install
  record behind it. Nothing sweeps an install dir whose row is gone — loadAll
  clears only `.staging` — so one outlives a restore or an interrupted
  uninstall forever. Left in place; Stage 3 rewrites the dir lifecycle and is
  the natural home for a boot sweep of unreferenced dirs. *(Stage 3 close
  read)* Not built — Stage 3, finding 11: a db-only restore can bring back a
  row whose dir survived only because nothing swept it, and that dir can be
  the last copy of the code. *(Stage 3 build)* The compose orphan was a
  byte-identical copy of HEAD's Ollama example, and was removed by hand.
- *(Stage 3 build)* The admin page doesn't fit a phone: at a 390px viewport
  `main.panels` is 697px inside a 342px layout, so the Plugins page scrolls
  sideways with the built-ins alone (measured before any Stage 3 card was on
  it). Not this arc's.
- *(Stage 5 close read)* Real, and not this arc's:
  - A plugin's `listPrices` returning one negative or NaN rate makes
    setModelPrices throw, which drops the whole price-learning pass,
    community rows included.
  - The compat and google wires refuse a PDF part with a status-less error,
    so a PDF board on those taggers retries five times before it fails.
  - A compat transcription's network error is neither status-bearing nor
    `transient`, so a clip parks on it.
  - A source's `fetch()` runs outside the try that removes the temp file, so
    a throwing fetch leaves one behind.
  - Stale comments: coingecko.js says withRetry never slows the bucket (it
    does, on a 429); resource-pool.js says a provider's concurrency is set on
    the Plugins page (env only); server.js and schedule.js say CoinMarketCap
    has no history() (it has); server.js says health tracking uses `search`
    (no such call).
  - The connector card's `capabilities` flags have no reader; `desc.external`
    is written and never read.
  - One plugin id in two domains shares a pacing bucket, a pool slot and the
    meter's provider name (the metering ledger's known-open, from the other
    side).
  - The shadow check is exact-case: a domain "Crypto" registers beside
    "crypto".
  - acme-weatherface's fetchEntity returns `name`, not `display_name`.
  - A domain with no browse columns throws in the ingest modal's "+ filter";
    a filter keyed `sort`, `page` or `query` overwrites the list options.
  - A connectionless external source reads "— 0 connections" on the
    Capabilities tab, and its tag says "Source · remote".
- *(Stage 5 second pass)* Real, and not this arc's — each measured or read
  to the line:
  - After a domain switches provider, a hand refresh ("Refresh data +
    chart") or Reprocess sends the item to the fetch leg, which calls
    `fetchEntity` with the id stored under the old provider
    (worker.js → fetchProjectedEntity, no provider check). With the built-ins'
    404 an unknown id now fails the item at once (it failed after five
    retries before); where two providers' ids overlap it would fetch another
    asset and overwrite the card's identity. Refresh, faces and charts
    re-resolve by symbol; this path doesn't.
  - An item whose symbol the active provider's `search` can't find stays
    due: refresh returns with the fields' old times, already past, so the
    item is searched again on every sweep tick, bounded only by the
    provider's rate limit. The id `search` finds is never stored either, so
    every refresh of a switched item starts with a paced search.
  - Embedding's salvage round marks any failure — a 429, a 5xx, a timeout —
    as a permanent skip once one text in the batch succeeded; and a lone
    poison text (a batch of one) is never isolated, so it pauses the key,
    tagging included, every minute until something joins its batch.
  - Update or Retry failing at the fetch or the manifest leaves an errored
    card's old reason: the fetch (`withStage`) runs before updatePlugin's
    try.
  - A transcribe or detect plugin declaring `models` and a `filter` gets
    pickers offering live models the save then refuses.
  - A board's toolbar chip and the browse window's search box show the
    domain's slug, capitalized, not its label; the lightbox lists connector
    fields by key and formats numbers by key name. Documented under "What a
    domain assumes today".
