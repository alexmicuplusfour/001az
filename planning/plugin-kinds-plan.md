# Plugin kinds — a definition-driven loader (every integration pluggable)

**Status: MOVES 1–2 SHIPPED locally 2026-07-17 (uncommitted). The plugin loader
now iterates a `KIND_DEFS` table instead of ~6 per-kind switch statements
(behavior-identical for the 3 existing kinds), and `source` is added as the 4th
kind — an ingestion source (ftp/s3/webdav/…) can install from a URL. Adding a
future kind (media/audio) is one more `KIND_DEFS` entry + its registry seam, no
loader edit. Self-contained for a fresh session.**

## Why (the vision this serves)

If the app goes public, third parties should add and maintain their OWN
integrations — AI providers, data connectors, file sources — so the maintainer
isn't personally on the hook for dozens of third-party APIs. That only works if
(a) *every* integration type is installable-from-a-URL and (b) adding a new *type*
of integration is cheap. Today (a) mostly holds but (b) doesn't: the install
lifecycle is shared, but each KIND's logic is smeared across the loader, so every
new kind is a hand-wired bolt-on. This makes the loader kind-agnostic.

## Current state — what's general vs. what's scattered

- **Already general** (phase-2 slice 2, untouched here): the whole lifecycle —
  `installFromUrl` (fetch → npm install → validate → register → persist),
  `uninstall`, `loadAll`/`loadDir`, the error-card + health handling. Every kind
  shares it.
- **Per-kind, scattered** (what this fixes): for each `manifest.kind`, logic lives
  in ~6 places in `server/plugin-loader.js`:
  1. `KINDS` set — is this kind allowed
  2. `validateManifest` — kind-specific manifest checks (connector `domain`, `faceProducers`)
  3. `validateBuilt` — the returned-object shape
  4. `catalogIdFor` — `ai:<id>` vs `<domain>:<id>`
  5. `registerBuilt` — which registry to write
  6. `unregister` — how to undo
- The three kinds today: `ai-provider` (→ `PROVIDERS`), `connector-provider` (→ a
  domain's providers map), `connector-domain` (→ `CONNECTORS` + its face producers).

## The design — one KIND DEFINITION per kind

A kind becomes a single object carrying everything the loader needs:

```js
// illustrative — one entry per kind, all in one KIND_DEFS table
{
  kind: "source",
  catalogId:        (m) => `source:${m.id}`,
  validateManifest: (m) => { /* kind-specific manifest checks */ },
  validateBuilt:    (m, built) => { /* the shape its registry expects */ },
  register:         (m, built) => registerSource(m.id, built),
  unregister:       (m) => unregisterSource(m.id),
}
```

The loader keeps the COMMON manifest checks (id / apiVersion / label / main) and
the entire lifecycle. Everywhere it currently `switch`es on `manifest.kind`, it
instead looks the kind up in `KIND_DEFS` and calls that method. `KINDS` derives
from the table (`new Set(Object.keys(KIND_DEFS))`).

**Adding a kind = one entry in `KIND_DEFS`** + (if the target registry is new) a
`register`/`unregister` seam on it. The loader file itself stops changing.

## Moves

### Move 1 — make the loader definition-driven (behavior-identical)
- Add `KIND_DEFS` in `plugin-loader.js` with one entry per existing kind
  (`ai-provider`, `connector-provider`, `connector-domain`), each carrying
  `catalogId` / `validateManifest` / `validateBuilt` / `register` / `unregister`,
  moved **verbatim** from the current switch bodies.
- Rewrite `validateManifest` (common checks, then `def.validateManifest`),
  `validateBuilt` (`def.validateBuilt`), `catalogIdFor` (`def.catalogId`),
  `registerBuilt` (`def.register` + `resetDefs`), `unregister` (`def.unregister` +
  `resetDefs`) to dispatch through the table.
- No new behavior. The existing `plugin-install` + `dynamic-plugins` tests
  exercise all three kinds — full suite green IS the proof. (Re-expressing the 3
  kinds as definitions is not a separate step; it *is* move 1. The review just
  confirms each old switch-arm maps 1:1 to a definition.)

### Move 2 — add `source` as the 4th definition + a live source registry
- **Make the source registry live** — `server/ingestion/sources/index.js` today
  computes `SOURCE_MODULES`/`MANIFESTS` once at import (frozen arrays), so a live
  insert wouldn't show up (the same "parallel snapshot" fixed for connectors).
  Change them to read `BACKENDS` at call time and add `registerSource(name, mod)`
  / `unregisterSource(name)`. Update the readers (`plugins.js` `sourceDefs`,
  `ingestion/files.js` `listSources`) to the live form.
- **Add the `source` definition** to `KIND_DEFS`: `catalogId` = `source:<id>`;
  `validateManifest` (a source needs a name + a `connectionSchema`);
  `validateBuilt` (the module's `backend` is a factory returning `list`/`fetch`/
  `test`); `register`/`unregister` via the new seams.
- A from-URL source (e.g. SFTP / WebDAV / Dropbox — pure-npm like `basic-ftp` /
  `@aws-sdk/client-s3`, no system binary) now installs, shows up in the ingest
  modal + browse (both already generic — "no adapter, route, sweep or modal
  edits"), and uninstalls cleanly.
- Tests + a fixture source plugin: install → appears in `listSources` → a board
  can browse through it → uninstall reverses it; a built-in source id is not
  uninstallable (existing rule).

## Verify (compose stack)
1. After move 1: `npm test` green and unchanged — the refactor is behavior-identical;
   install/uninstall of an AI, a connector-provider, and a connector-domain still work.
2. After move 2: install a fixture source from a `file:` path → it's in the source
   catalog + the ingest modal, a board browses through it, uninstall removes it;
   folder/ftp/s3 are unchanged.

## Risks / notes
- **Move 1 touches working code.** It's a pure structural refactor (switch → table
  lookup), no behavior change; the existing tests are the net. One pass, full suite,
  don't mix in the source work.
- **Not everything can be kind-agnostic — and that's correct.** Each definition
  still holds genuinely kind-specific validate/register logic (an AI and a source
  plug into different systems). The win is it's defined ONCE per kind, in one
  place, not smeared across six.
- **Lifecycle untouched** — no change to fetch/npm/persist/health, so no new
  security surface. The trust model (runs code as the server, no sandbox) is
  unchanged.
- **This is the seam media/audio slots into later** — the deferred media/source
  handler kind becomes one more `KIND_DEFS` entry (+ its registry + its client
  half), not a loader edit.
- **Authoring is the other half of the vision.** For third parties to actually
  maintain integrations you need the contract frozen + documented (PLUGIN.md) + a
  reference plugin — that's phase-2 slice 4, separate from this, and it's what
  makes "others maintain it" real rather than possible. Noted, not in this plan.
