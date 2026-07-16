# Plugins phase 2 — dynamic loading (install community plugins from a URL)

**Status: SLICES 1–2 SHIPPED 2026-07-16 (slice 1 committed 3ce0f4c; slice 2 local); slices 3–4 planned.**
Slice 2 = fetch (github/npm/tarball/file) + npm install + install/uninstall routes.
358 tests (10 in `test/plugin-install.test.js`, incl. a **hermetic tarball-download**
path — a local HTTP server serving a real `.tgz`, the only test that runs the
network branch). A review pass + that smoke test fixed 4 loose ends: (1) OOM-unsafe
tarball buffering (cap ran after `arrayBuffer()`) → reject on content-length +
stream with a running cap; (2) `execFile` 1 MB maxBuffer → 16 MB (a chatty npm
install would ENOBUFS); (3) no connector-domain install coverage → added; (4) a
cross-platform tar bug the smoke test caught — GNU tar read a Windows drive-letter
path `C:\…` as a `host:path` spec → run tar with `cwd` + a RELATIVE archive name.
A **second review pass (2026-07-16)** fixed the one real bug it turned up: a failed
(re)install could destroy the already-installed code. The commit dir was keyed
`<catalogId>@<ref>`, so an errored-retry with the same ref overwrote the old dir
in place, then the `loadDir`-catch `rm`'d it — leaving no code on disk and a row
pointing at nothing (next boot: a misleading "no manifest.json"). Fix: **commit
into a unique `…@<ref>-<nonce>` dir**, so every install lands in its own directory;
delete the prior dir only AFTER the new load + persist succeed; on a failed retry
drop only the just-fetched code and `setExternalLoadError` the fresh reason —
pre-install state is always recoverable. (Dir names are cosmetic: dedupe is by
catalog id in the DB, `resolved_ref` is displayed from its own column.) Also added
the missing **ai-provider install** test (the third registration path) + a test
that pins the failed-errored-retry rollback. See the slice-2 section for the shape.
Slice 1 = the loader + registry seams + boot-load, provable offline from fixtures
(no network). 13 tests in `test/dynamic-plugins.test.js`; the lone full-suite
flake is the pre-existing ingest-sweep `until()` race — passes isolated. A first
review pass fixed 4 loose ends: (1) a connector-domain could clobber a built-in
domain → guard; (2) a loaded external read installed:false without a plugins-table
row → presence⇒installed in the catalog; (3) loadAll cleared load_error every boot
→ heal only when errored; (4) validateBuilt checked `typeof wire === "function"`
but wire is a dispatch object → truthiness like aiDefs. A **second review pass
(2026-07-16)** fixed 3 more: (5) `validateBuilt` required `defaultModel`
unconditionally for ai-provider, rejecting an embed-only descriptor (wire null +
embeds — the built-in `local` shape) its own `wire||embeds` check accepts → require
defaultModel only when `wire`; (6) `loadAll` iterated `external_plugins` in
arbitrary DB order, so a connector-provider extending another plugin's domain could
load before that domain and error → sort connector-domain rows first; (7)
`validateManifest` guarded `main` against `..` but not `id`/`domain` → id restricted
to path/id-safe chars, domain to a slug, and a connector-domain can't claim a
reserved segment (`ai`/`media`/`source`) that would collide in the catalog. Landed:
`server/plugin-loader.js` (PLUGIN_API_VERSION=1, validateManifest, ctx facade with
`fetchJson`/`renderChart`/`log`, factory build, register-last, `loadDir`/`loadAll`/
`unregister`); the single-source refactor (connectors derive descriptors live via
`providerList()`; `providers.js` `registerProvider`, `connectors/index.js`
`registerConnector`/`registerConnectorProvider` + unregisters; `plugins.js`
`resetDefs()` + external/errored catalog entries); migration
`0020_external_plugins.sql` + db helpers; boot hook in `server.js` after `initDb`.
NOTE: files are `server/plugin-loader.js` (not `server/plugins/loader.js` — avoids
colliding with `server/plugins.js`); slice 2's fetch will be `server/plugin-fetch.js`.

**This is "phase 2 proper" from the
roadmap in `plugin-ecosystem-plan.md` (its §Vision: *"users add their own plugins
— self-hosted, npm/GitHub trust model, NOT a hosted marketplace"*). Phase 1
(unify → f849254) and the install-model phase (installed/available + Add modal →
84640ba) shipped first and built the *shape* this phase drops modules into. Read
those two docs for the registry + install-state mechanics; this one is
self-contained for a fresh session.

Two decisions taken with the user (2026-07-16), both the richest option:
- **Install = runtime fetch-from-URL.** Paste a GitHub/npm URL; the server
  downloads, installs, validates, and loads it live — no image rebuild, no
  restart. (Alternatives considered + rejected: a drop-in `plugins/` volume; an
  npm-dependency config list.)
- **Full npm install per plugin.** After extraction, `npm install --omit=dev`
  runs in the plugin dir, so a plugin may depend on a real SDK. (Alternative
  rejected: self-contained/dep-free only.)

Trust model is already ratified (2026-07-04): ordinary open-source dependency
trust — **self-hosted, no sandbox / signing / permissions**. That is the premise,
not a gap. Consequences are surfaced honestly in §Risks, mitigated (admin-only,
a risk-naming confirm, a pinned+displayed resolved ref) but never hard-gated —
*flexibility over guardrails*.

---

## Repo context (skim if you know the app)

001az: agnostic boards/entities app. Node/Express + Postgres, build-less
vanilla-JS frontend, docker compose on :8001 (`docker compose up -d`), tests
`npm test`. Migrations are numbered files in `server/migrations/` run in order by
initDb (latest is `0019_source_connections.sql` → **this phase adds 0020**).
Container is `node:22-slim`, `WORKDIR /app`, `USER node` (non-root), npm present.
The app service mounts the persistent named volume `appdata:/data`; `INGEST_ROOT`
already lives at `/data/ingest`, so **`/data/plugins` is the natural home** for
installed code (survives restarts AND image rebuilds — it's on the volume, not
in the image).

**The four integration registries are structurally identical** — a static,
name-keyed map filled by explicit imports, each already saying *"no dynamic
loading; adding one is one import + one map entry"*:

| kind | the map | a module is… |
|---|---|---|
| ai | `PROVIDERS` in `server/providers.js` (~:360) | a data descriptor (wire/base/models/embeds/research/keyTest) |
| connector | `CONNECTORS` via `bind()` in `server/connectors/index.js:39` | pure data: `providers` map + `defaultProvider` + `manifest` + `faces`; `runtime.js` does all dispatch |
| media | `MANIFESTS` in `server/sources/index.js` | file-bytes handler + manifest (has a client `kinds.js` half) |
| source | `BACKENDS` in `server/ingestion/sources/index.js:15` | manifest + `backend()` factory (has client UI) |

`server/plugins.js` (`pluginDefs()`/`pluginCatalog()`) already composes all four
into one uniform catalog entry; the admin page renders it and the Add modal
(`public/plugin-add-modal.js:6`) has the seam comment. **Dynamic loading = letting
modules that are NOT in those static maps get fetched, validated, registered, and
served through the exact same catalog.** Nothing about `apiVersion` or
namespacing exists yet — that is net-new here.

## Scope — server-only tier first

First cut supports the two **server-only** kinds: **AI providers** (a new
`PROVIDERS` descriptor) and **connectors** (a new provider under an existing
domain, or a whole new domain). These are pure data / pure server — no client
half, no image system-deps. **Media and source plugins are deferred**: they carry
a `kinds.js` client module and (for pdf/docx) binaries in the image — the
"advanced tier" both prior plan docs park. This phase makes the loader, contract,
and UI; media/source ride the same rails in a later slice.

## The model

### Manifest (`manifest.json` at the plugin root)

```json
{ "id": "vendor.name",        // dot-namespaced; distinct from built-in colon ids
  "apiVersion": 1,             // contract major; must match core's PLUGIN_API_VERSION
  "kind": "connector-domain",  // "ai-provider" | "connector-provider" | "connector-domain"
  "domain": "crypto",          // connector-provider only: the existing domain to extend
  "label": "Acme Prices",
  "description": "…",
  "main": "index.js" }
```

- **id** is `vendor.name` (dot), so the catalog id is unambiguous and collision-
  free: `ai:vendor.name`, or `<domain>:vendor.name` for a connector. Built-in ids
  keep their `segment:name` colon form; the dot inside the name marks "external".
- **apiVersion**: core exports `PLUGIN_API_VERSION = 1`. Major mismatch → refuse
  to load, record a readable `load_error`, show an errored card (never crash boot).
- **kind is explicit, never inferred.** Three kinds, so the manifest's required
  shape never depends on what the host happens to already have: `ai-provider`
  (a new AI backend), `connector-provider` + `domain` (a backend added to a domain
  that must already exist), `connector-domain` (a whole new data domain, carrying
  its full manifest). Validation is crisp per kind — no "does this host already
  have crypto?" guesswork.

### Module contract — a `factory(ctx)`, not core-by-path

An external plugin lives at `/data/plugins/…` and **cannot import core by
relative path** (the path wouldn't resolve, and we don't want that coupling). So
its `main` **default-exports a factory** that core calls with a narrow `ctx`
facade — the same "reach core only through a ctx" rule ratified for the old
adapter design:

```js
// index.js  (a connector plugin)
export default function (ctx) {
  const acme = { label: "Acme", needsKey: true, rpm: 30, burst: 15,
    async search(q, { apiKey }) { … ctx.fetchJson(url, { apiKey, signal: ctx.signal() }) … },
    async fetchEntity(id, { apiKey }) { … }, async testConnection({ apiKey }) { … } };
  return { providers: { acme }, defaultProvider: "acme", manifest: {…}, faces: {…} };
}
```

`ctx` is the stable **protocol surface** (versioned by `apiVersion`) — the
primitives that make a plugin speak core's protocol, not a grab-bag of helpers:
`fetchJson` (throws errors carrying `.status`/`.retryAfter`, so a plugin gets
core's rate-limit + 429 backoff for free — `runtime.js` `withRetry` keys off
exactly those; a plugin using raw `fetch` + a plain `Error` silently falls out of
the retry contract), `renderChart` (the face renderer), `log`, `apiVersion`.
Per-request context (`apiKey`, the abort `signal`) rides the per-call opts
(`provider.search(q, { apiKey, signal })`), NOT ctx. A plugin's OWN `node_modules`
(installed at slice 2) resolve normally, so an SDK-based plugin does
`import Stripe from "stripe"` etc. Built-ins stay direct-import (privileged). An AI
plugin's factory returns a single descriptor instead of a connector shape.

> **Ergonomics gap found in slice 1:** an AI descriptor carries a `wire` dispatch
> object ({tag, embed, testKey}). The commonest external AI provider is just
> another OpenAI-compatible endpoint, but `compatWire` is core and not importable
> — so without help every AI plugin reimplements the wire. **Slice 4's ctx must
> expose a `compatWire` / `makeCompatProvider({base, …})` helper.** Connectors
> don't have this problem — they're plain fetch through `ctx.fetchJson`.

### Where extension lands (all three first-class)

One registration seam, one write per plugin, no deferrals — the single-source-of-
truth refactor below is what makes `connector-provider` as clean as the other two:

- `ai-provider` → `PROVIDERS[vendor.name] = desc`. Flows through
  `providerCatalog()` → `aiDefs()` → page + board modal with zero further edits
  (`providerCatalog()` already reads `PROVIDERS` live).
- `connector-provider` (existing `domain`) → one write into that domain's live
  `providers` map. Mappings bind to `crypto:price`, never the provider, so nothing
  downstream changes.
- `connector-domain` (new `domain`) → `CONNECTORS[name] = bind(name, mod)`. Because
  the mapping modal / template picker / browse all read `listConnectors()` per
  request, a server-registered domain reaches the client with no client-half work
  — the payoff of the connector layer being data-driven.

### Storage — one new table (migration `0020_external_plugins.sql`)

```sql
CREATE TABLE external_plugins (
  id          TEXT PRIMARY KEY,   -- catalog id, e.g. "crypto:vendor.name"
  kind        TEXT NOT NULL,
  source_url  TEXT NOT NULL,      -- what the admin pasted
  resolved_ref TEXT,              -- commit sha / npm version actually installed
  dir         TEXT NOT NULL,      -- /data/plugins/<id>@<ref>
  manifest    JSONB NOT NULL,
  installed_at BIGINT,
  load_error  JSONB               -- {message, at} when the last load failed
);
```

The **existing `plugins` table is unchanged** and keeps owning
installed/config/health for built-ins AND externals (an external plugin gets a
`plugins` row for its config/health exactly like a built-in). `external_plugins`
is only the *install record* (where it came from, where the code is). The DB row
is authoritative; the on-disk dir holds the code; boot loads each row's `dir`.

### Lifecycle

- **Boot**: `loader.loadAll(db)` reads `external_plugins`, and for each row
  validates + `import()`s `dir/main`, calls the factory with `ctx`, registers into
  the live maps, then busts the `plugins.js` `DEFS` cache once. Each load is
  try/caught → on failure the row's `load_error` is set and an **errored catalog
  entry** is emitted (surfaced via the phase-1 health ledger), boot continues.
- **Install** (`POST /api/admin/plugins/install {url}`): resolve → download →
  extract to a staging dir → `npm install --omit=dev` → read+validate manifest →
  load (same path as boot) → on success move staging → `dir`, persist row, live-
  register, bust cache → return the new catalog entry. Any step fails → clean up
  staging, return a readable error (nothing half-registered).
- **Uninstall** (`DELETE /api/admin/plugins/:id`, external ids only):
  unregister from the maps → delete the `external_plugins` row → delete the
  `plugins` row (config/health) → `rm -rf` the dir → bust cache. Built-in ids
  reject with "use Remove (installed:false), built-ins aren't uninstallable".

### Registry mutation seams (single source of truth)

The refactor that makes all three kinds equally solid: **derive the catalog
descriptors from the live maps; stop keeping a parallel snapshot.** Today
`crypto/index.js:46` freezes `manifest.providers` (a descriptor array) at
module-eval time, separate from the live `providers` map the runtime resolves
against — so a live insert updates resolution but not the card (the one real
two-places-to-sync hazard). Fix: `listConnectors()` / `connectorDefs()` build the
descriptor list live from `conn.providers` at call time; `manifest.providers`
stops being authoritative. Then every register is ONE write and card + resolution
move together.

- `providers.js`: `registerProvider(name, desc)` / `unregisterProvider(name)`
  (mutate `PROVIDERS`; stamp `desc.external = true`). `providerCatalog()` already
  reads `PROVIDERS` live — nothing else to change.
- `connectors/index.js`: `registerConnector(name, mod)` (new domain via `bind()`)
  + `registerConnectorProvider(domain, name, providerMod)` (one write into the
  domain's live `providers` map) + the unregister pair.
- `plugins.js`: `resetDefs()` (null the memoized `DEFS`); `pluginDefs()` appends
  externals from the loaded modules.
- **Register last, all-or-nothing.** Build + fully validate the module object
  BEFORE touching any map, so a factory that throws mid-build never leaves a
  registry partially mutated. A failed load = zero writes + an errored card. This
  is the invariant that makes runtime loading trustworthy.

## Slices

### Slice 1 — loader + registry seams + boot-load (no fetch, no UI)
The whole runtime, driven by files already on disk (a test fixture).
- `server/plugins/loader.js`: `validateManifest`, `loadDir(db, row|dir)` (import
  factory, call with `ctx`, register by kind), `loadAll(db)`, `unload(id)`.
  `ctx` facade assembled here from existing helpers (`providerSignal`,
  `renderChart`, a `fetchJson`, `log`).
- Registry seams above (`registerProvider`/`registerConnector*`/`resetDefs`) +
  `external_plugins` table (0020) + db helpers (`listExternalPlugins`,
  `upsertExternalPlugin`, `deleteExternalPlugin`, `setExternalLoadError`).
- Boot hook: server startup calls `loader.loadAll(db)` after initDb, before the
  worker starts. `PLUGINS_DIR` env, default `/data/plugins`.
- `pluginDefs()`/`pluginCatalog()` include loaded externals; an errored plugin is
  a catalog entry with `state.health.lastError` set and `state.loadError:true`.
- Tests: a fixture connector dir loads + registers + appears in the catalog + is
  callable through `runtime.search`; a fixture AI descriptor registers into
  `PROVIDERS`; bad `apiVersion` → errored entry, others still load; a throwing
  factory → errored entry, boot survives.

### Slice 2 — fetch + npm install + install/uninstall routes (no UI) — SHIPPED 2026-07-16
- `server/plugin-fetch.js` — `resolveSource(url)` (pure) → one of four kinds, and
  `fetchModule(source, stagingDir)` (the only network in the phase):
  - `github:owner/repo[@ref]` / a github.com URL (incl. `/tree/<ref>`) → the API
    tarball endpoint (defaults to the repo's default branch, redirects to codeload;
    no `git` binary). `npm:name[@version]` / a bare (scoped) name → registry
    metadata → the version's `dist.tarball`. A direct `https://…​.tgz` URL. And
    **`file:` / a local path → a dir copy** — a real feature (dev / air-gapped /
    vendored) AND the hermetic test vector (no network, no npm).
  - Download → size cap → `tar -xzf --strip-components=1` (both github + npm wrap
    in one top dir). System `tar` (present in the image; no new dep).
- `npm install` lives in `plugin-loader.js` and is **skipped entirely when the
  plugin declares no deps** — so a dep-free connector/AI plugin needs no npm and
  installs offline. When it runs: `--omit=dev --no-audit --no-fund` +
  **`--ignore-scripts` by default** (nothing executes until the manifest validates
  and the factory loads); a plugin opts into lifecycle scripts with
  `manifest.allowScripts: true` (native modules). `npm_config_cache=/data/.npm`.
- `installFromUrl(db, url)`: resolve → staging dir → fetch → validate manifest →
  **reinstall policy** (a healthy id → 409 "remove first"; an ERRORED id → retried
  in place) → npm install → **atomic rename** staging → `PLUGINS_DIR/<catalogId>@
  <ref>` (dir named from the catalog id, so one vendor.name across two domains
  can't collide) → `loadDir` (register-last; on failure rm the dir) → persist
  `external_plugins` row + `setPluginState(installed:true)`. `finally` cleans
  staging. `uninstall(db, id)`: unregister → drop both rows → rm dir; a built-in id
  (no install record) → readable throw.
- Routes: `POST /api/admin/plugins/install {url}` (requireAdmin; 409 via
  `err.status`; returns the new card) + `DELETE /api/admin/plugins/:id`
  (requireAdmin; built-in → 400). Slice-1 refinement folded in: `catalogIdFor` is
  manifest-only (connector-domain `defaultProvider === id`), so identity is known
  pre-load — needed to name the dir + dedupe reinstalls.
- Tests (`test/plugin-install.test.js`, 10): resolveSource matrix; a `file:` install
  → registers + persists + `installed`+`external` card → uninstall reverses all of
  it; a connector-domain install; an ai-provider install (the third register path);
  a failed errored-retry preserves the prior dir/row + refreshes the reason; healthy
  reinstall → 409; a validation-failing fresh install persists nothing; the two
  routes incl. admin-gating + built-in DELETE 400; a hermetic tarball download.
  358 suite green.
- Deferred (noted, not blocking): an install-time concurrency lock (two installs of
  one id); an HTTP deadline for long npm installs (slice 3 streams progress); a boot
  sweep of a stale `.staging` after a hard kill; git-URL deps (need `git` in the
  image); SHA-pinning a github branch ref (a later hardening).

### Slice 3 — the UI (Add-modal "from URL" + external Remove)
- `public/plugin-add-modal.js`: add a **"Install from URL"** field + button above
  the browse list (fills the seam at :6). Paste → confirm modal that NAMES the
  risk ("this downloads and runs code from the internet as the server — only
  install sources you trust") → `POST …/install` with a progress state → on
  success refresh + close; on error show it inline.
- `public/admin-plugins.js`: external cards show `source_url` + `resolved_ref`
  (small subtitle) and a real **Remove** (→ `DELETE`, confirm) distinct from a
  built-in's "available" toggle; an errored external card shows its `load_error`
  and a Retry (re-run install from the stored `source_url`).
- No new CSS files — reuse the shared modal/button kit (house rule: no component
  duplication).

### Slice 4 — the contract: SDK surface + reference plugin + PLUGIN.md
- Freeze the `ctx` surface as **the** `apiVersion: 1` contract; add a one-line
  `ctx.apiVersion` so a plugin can feature-detect.
- **Reference plugin**: extract CoinGecko into a standalone example
  (`examples/plugin-coingecko/` — manifest + `index.js` factory + `package.json`,
  installable from its own path/URL). Proves the contract end-to-end and is the
  copy-paste starting point.
- **PLUGIN.md** (repo root): manifest fields, `apiVersion`, the `factory(ctx)`
  contract + the full `ctx` surface, how deps work (`npm install --omit=dev`,
  scripts off), the two connector shapes + the AI shape, publishing (npm keyword
  `001az-plugin` / GitHub topic `001az-plugin`), and the honest trust note.

## Verify (compose stack, per slice / all at end)
1. Boot with an empty `external_plugins` → app behaves exactly as today; the four
   built-in kinds render unchanged.
2. Seed a fixture external connector on the volume → boots, card appears, a board
   can add it and refresh through it.
3. Install the CoinGecko reference from a GitHub URL → downloads, `npm install`
   runs, card appears live (no restart), a crypto board can pick it.
4. Restart the container → the installed plugin reloads from the volume (survives).
5. Rebuild the image → still present (it's on `appdata`, not in `/app`).
6. Install a deliberately broken plugin (bad `apiVersion`, then a throwing
   factory, then a failing `npm install`) → each gives a readable error, nothing
   half-registered, boot/health survive; the errored card shows why + offers Retry.
7. Uninstall → card gone, dir gone, rows gone, boards fall forward per the
   phase-1 all-removed rules.
8. Confirm the install dialog names the code-execution risk.
9. Headless page screenshot (manual; no DOM harness, as ever).

## Risks / notes
- **Arbitrary code execution is the premise, not a bug.** Installing a URL fetches
  and runs code as the app user — a hostile URL = full compromise. No sandbox by
  ratified decision. Mitigations kept (all soft): admin-only routes, a confirm that
  names the risk, `--ignore-scripts` on npm install, and a pinned+displayed
  `resolved_ref` so you can see exactly what ran. Documented loudly in PLUGIN.md.
- **`/data` must be writable by `node`** (the container's non-root user) for the
  plugin dir + npm cache. The `appdata` volume may need an ownership fix in the
  Dockerfile/entrypoint (chown /data to node, or an init step) — verify on the
  compose stack; `INGEST_ROOT` already writes under `/data` so this may be fine.
- **npm install at runtime needs network + time.** The install route is long-
  running (stream progress in slice 3); a plugin with git-URL deps would need
  `git` in the image (not there) — first cut targets registry-dep plugins;
  document the limitation.
- **Live registration mutates long-lived module maps.** `resetDefs()` after every
  install/uninstall is the one required cache-bust; the connector rpm/burst bucket
  already live-updates. One test pins that a freshly installed provider is
  immediately resolvable without restart.
- **Namespacing prevents collisions but a plugin can still shadow a slot default.**
  Same "truthful UI" rule as the prior phases — show the star on the setting's
  provider with a falling-back note rather than moving it.
- **deploy.ps1 has no artifact list** (docker `COPY . .`) — new `server/plugins/*`
  and `public/*.js` need no deploy edits. Prod droplet is still pre-ingestion;
  nothing here changes that. The `examples/` reference plugin should be
  `.dockerignore`d so it isn't baked into the image (it's installed at runtime,
  not shipped).

## Phase 3 pointer (self-healing)
This phase delivers the second of self-healing's two prerequisites — the health
ledger (phase 1) + dynamic loading (here). Phase 3's loop (failure threshold →
hand the AI the plugin source + contract + failing exchange → patch → re-run
`testConnection` → human approve → hot-reload the patched dir) now has everything
it needs: structured `last_error`, the plugin source on the volume, and a live
reload path. Still deliberately undesigned.
