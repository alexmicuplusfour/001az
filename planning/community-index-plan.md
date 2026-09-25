# The community index — a list of pointers, and the tab that reads it (2026-09-25)

**Status: PLANNED 2026-09-25, from the Stage 6 deep dive of
[plugin-contract-plan.md](plugin-contract-plan.md). All five stages BUILT
2026-09-25, uncommitted — each after its close read, five, nine, ten, eight
and six findings folded in; the build records follow them. This doc
supersedes that plan's D8 and Stage 6, which now point here. D10 went the
default way — all five built — and the list ships empty (Stage 5's close
read). Every stage got its own close read before a line was written, and
this doc was rewritten wherever the read disagreed with it.**

## How this started

The plugin-contract arc (Stages 1–5, pushed as `1036a2a`) made plugins a
contract a stranger can write against: PLUGIN.md at the root, install checks,
Update in place, two bundled examples. What it left designed and unbuilt was
discovery — a way to find a plugin someone else wrote without being handed a
URL. The parent plan's answer (D8) was an index of pointers in the app repo
and a Community tab in the Add dialog, gated on the index holding an entry the
maintainer did not write.

The deep dive on 2026-09-25 read that design against the code that shipped.
Most of it holds. Two things in it would go wrong — the index could never
update anyone, and its pins could move — one field pinned the wrong thing,
and four smaller details disagreed with decisions the arc had since made. The
gate's numbers: the repo has 0 forks, 1 star and 0 watchers, public since
2026-09-02. Nobody is near the gate, and nobody can submit to a list that
doesn't exist.

## What exists today (the deep dive, condensed)

**The install path.** [plugin-fetch.js](../server/plugin-fetch.js)
`resolveSource` turns a string into a source: `github:owner/repo[/dir][@ref]`
or a github.com URL, `npm:name[@version]` or a bare package name, an https
`.tgz` URL, or a local path. `fetchModule` downloads a tarball into the
staging dir (`downloadTarball` buffers the whole archive, capped at 50 MB,
then unpacks with `tar`) or copies a directory. For npm, `npmTarball` reads
the registry's metadata and uses `dist.tarball`; the registry's
`dist.integrity` hash beside it is not read. For GitHub, the API tarball
endpoint takes any ref, a full commit sha included; the archive's top
directory names the commit (`<owner>-<repo>-<sha7>`), and `githubRef` records
`<ref>@<sha7>` — or the ref alone when it already is the sha.
[plugin-loader.js](../server/plugin-loader.js) `installFromUrl` refuses a
catalog id that has a row already (409), commits the dir, loads it
(`loadDir`: validate, then register), and writes the row with its
`source_url`.

**Update.** `updatePlugin(db, id)` fetches `row.source_url` again, refuses a
changed catalog id or kind, loads the new dir while the old one serves, and
the upsert overwrites `source_url`, `resolved_ref` and `dir`. The route
(`POST /api/admin/plugins/:id/update`) takes no body. Nothing lets an update
come from a different source, which is what an index that moves needs.

**The Add dialog.** [plugin-add-modal.js](../public/plugin-add-modal.js)
renders one array — the catalog plus the bundled examples, which
[plugins.js](../server/plugins.js) `bundledPlugins` composes in the same row
shape (`manifestEntry`, with a `bundled: { path, keyless, needsBase }` block)
and appends to `GET /api/admin/plugins`. `row(p)` shows label, description
and `tagFor`'s tag; an installed row (healthy or errored) reads "Added",
disabled; the Add button branches on `p.bundled` (install from its path,
no confirm) or PATCHes `installed: true`. Above the list, the URL zone
installs with the confirm that names the risk; the operator's lock
(`PLUGIN_INSTALL_DISABLE`) replaces the zone with a sentence and holds Update
and Retry on non-bundled cards. `tagFor` reads a connector row's domain from
`p.connector?.domain`, which a manifest-only row lacks, so it reads
"Data · external" there.

**Chips.** The Plugins page's kind filter is a `.pill-row` of `.pill` buttons
([admin-plugins.js](../public/admin-plugins.js) `filterPill`;
[styles.css](../public/styles.css)). The Usage tab uses the same. No new CSS
is needed for "Included · Community".

**A remote list the app already reads.** [price-learner.js](../server/price-learner.js)
pulls LiteLLM's price map from a raw GitHub URL: `MODEL_PRICE_SOURCE_URL`
with a default, empty meaning off (the air-gapped answer), a fetch with a
timeout, and a failed pull keeps the last good rows. The index fetch has that
shape to copy.

**What guards a built-in's name — measured.** Two impostor plugins, manifest
id `coingecko` (connector-provider, crypto) and `openai` (ai-provider), were
installed against a scratch server. Both were refused by the manifest rule
that an id is `vendor.name` with a dot — built-ins have none. Underneath,
all three registries (`registerConnectorProvider`, `registerProvider` →
`install`, `registerSource`) overwrite an existing name in silence, so the
dot rule is the only guard. It holds; it has no test of its own.

**Not checked today.** The loader never validates a manifest's `version`
(a number passes; the card prints it). npm's integrity hash is ignored.

**GitHub's numbers** (the parent plan's research, sources there): raw
downloads are rate-limited at 60 an hour per IP unauthenticated since May
2025; the API tarball is one call per install. GitHub's generated archives
are not promised to stay byte-identical — in 2023 a compression change
altered every archive's checksum and broke Homebrew and others; GitHub
reverted and promised notice before any future change, not permanence.

## Decisions (flag if wrong)

**D1 — pointers in the app repo, not code.** `community/plugins.json` on
`main`, one entry per plugin, each pointing at the author's own repository or
package. Inherited from the parent plan's D8, with its research: Obsidian,
Zed, Jellyfin and Homebridge all do pointers. Reviewing an entry is vetting a
pointer, not maintaining code; an author ships a fix without an app release.

**D2 — immutable sources only.** An entry's `source` is
`github:owner/repo[/dir]@<full 40-character commit sha>` or
`npm:name@<exact version>`. Not a tag, not a branch, not the default ref,
not a tarball URL. The parent plan allowed "a tag or a sha" while its own
research quotes GitHub that a full sha is the only immutable release, because
tags move; a moved tag is unreviewed code behind a reviewed entry. The
reviewer's script resolves the author's tag to the sha it pointed at when
reviewed; `version` stays the human label the tab shows. The installer needs
no change for this: a sha is already a valid ref, and the card already shows
one as written.

**D3 — no `checksum` field.** The parent plan's optional tarball checksum
(Jellyfin's idea, needed there because Jellyfin's `sourceUrl` is a mutable
zip) pins the wrong thing here: GitHub's archives aren't promised byte-stable,
so a tarball hash would break on GitHub's side, not the author's, while the
sha already makes the content immutable. On npm, the registry hands out
`dist.integrity` with every version and the installer ignores it; verifying
it is free and helps every npm install, index or not. Direct `.tgz` URLs
have no pin and stay out of the index (D2). Less machinery, a stronger
guarantee.

**D4 — the index carries everything the tab shows, plus `apiVersion`.**
Label, description, kind, domain, author, version. (The two listing hints,
`keyless` and `needsBase`, were carried and checked until Stage 5's close
read, which found nothing showing them; the user dropped them.) One
file fetch per open; never a per-plugin GitHub read (the lesson HACS paid for,
in the parent plan). Unknown fields in an entry are ignored, as unknown
manifest keys are, so a later index can add fields without breaking an older
app. An entry whose `apiVersion` this app doesn't speak is shown as "needs a
newer app", not offered and failed at install.

**D5 — installed entries are shown, marked "Added".** The parent plan
returned "entries minus installed ids". The Add dialog's rule since Stage 4 is
that installed rows stay visible as "Added", and D6 needs the installed entry
present. Each row carries whether it's installed and from which source.

**D6 — an update from the index is Update with a new source.** When the index
moves an entry to a newer pin, the tab offers "Update to 1.3.0", which calls
Update with the entry's source. `updatePlugin` already refuses a changed id or
kind and already overwrites `source_url`; it gains a `sourceUrl` argument and
the route a `url`. The card's own Update button keeps re-fetching what's
stored — pinned, and honest about it. Without this the index could never
update anyone: an index install stores the pin, Update re-fetches the pin,
and the only way to the new version is remove-and-add, which deletes keys and
settings — the thing Stage 3 built Update to avoid.

**D7 — community rows ride the catalog's row shape.** `communityPlugins(db)`
in `plugin-index.js` builds each entry with plugins.js's `manifestEntry`
(exported for it — beside `bundledPlugins` it would close a second import
ring, Stage 3's close read) and a `community` block (source, version,
apiVersion, author, domain, installedSource, updateAvailable, needsApp) the
way bundled rows carry a `bundled` block. The dialog's `row()` renders them unchanged; its Add button
branches on `p.community` as it does on `p.bundled`; `tagFor` reads a domain
from `p.community?.domain` when there's no live `p.connector` — a half
`connector` block would read as a descriptor that ran, which the bundled
rows' comment already refuses. Fetched by their own route when the Community
chip is clicked, not appended to `GET /api/admin/plugins`: the page load
never waits on GitHub, and a failed fetch shows its reason in its own tab and
never empties Included.

**D8 — the fetch copies the price learner.** `PLUGIN_INDEX_URL`, default the
repo's raw `main` URL for `community/plugins.json`, empty meaning off (the
chip isn't drawn). A 10-minute in-process cache, so the 60-an-hour raw limit
holds at 6. A 15-second timeout — it answers a click, not a schedule. A
1 MB cap and a shape check, because it's remote input. A failed refresh
keeps the last good list and says it's stale, with the reason.

**D9 — review is a script that fetches and reads, never runs.** A CI job on
pull requests that touch `community/plugins.json` runs
`scripts/check-plugin-index.mjs`: for each changed entry it checks the shape,
resolves the source (D2), fetches it with the existing `fetchModule`, reads
the manifest with the existing `validateManifest`, and checks that id, kind,
domain, label, version and apiVersion match the entry. It never builds the
module and never runs npm install: CI would be executing a stranger's pull
request. A human merges. This is Obsidian's automated review, on code that
exists. The workflow has read permissions only.

**D10 — when to build (the user's call).** The parent plan gated the tab on
an outside entry, reasoning that a list holding only the maintainer's plugins
isn't a community list. Nobody is near the gate (0 forks), and a list that
doesn't exist can't be submitted to. Two ways through:

- *(a) keep the gate.* Build Stages 1, 2 and 5 now — they hold without a
  tab: the integrity check, the submission file with its validator, the
  doc's "how to get listed". Leave 3 and 4 for the first outside PR. Cost:
  the first author submits into a list no app shows yet.
- *(b) build all five.* The Community chip's empty state ("None listed yet —
  PLUGIN.md says how to get listed") is the invitation. Verified with a
  scratch index served locally, and with one real entry pointing at the
  repo's own example at a sha — verification only; whether that entry ships
  in the file is a separate call.

Default: (b). Stages 3 and 4 are small, the empty state is designed, and
every piece is verifiable today, so nothing speculative gets built. Flag it.

**D11 — the bundled examples stay bundled, and are not index entries.** They
ship in the image and install offline; listing them twice would put two
Ollama rows in one dialog. The chips are "Included" (the app's catalog and its
examples, today's list) and "Community" (the index). The Community chip is
drawn whenever the index is on, empty or not. The reviewer refuses an entry
that takes a bundled example's catalog id (Stage 4's close read, the user's
call): the Community row would offer "Update to …" on every server running
that example, and one click would move it onto the listed source. The server
doesn't refuse one — a fork's own index is its operator's choice.

**D12 — the confirm is the URL install's, unchanged.** A listing is a pointer
review, not a security audit, and the dialog must not read as one. Index rows
install through the same route with the same confirm, and the operator's
lock applies to them as to any URL.

## The contract

### The file — `community/plugins.json`

```json
{
  "apiVersion": 1,
  "plugins": [
    {
      "id": "acme.tides",
      "kind": "connector-domain",
      "domain": "tides",
      "label": "Tides",
      "description": "Tide heights for harbours worldwide — no key needed.",
      "author": "acme",
      "version": "1.2.0",
      "apiVersion": 1,
      "source": "github:acme/001az-tides@3f2a9c1e7b0d4a5f6c8e9d0b1a2c3d4e5f6a7b8c"
    }
  ]
}
```

| field | | |
|---|---|---|
| `id` | required | The plugin's manifest id, `vendor.name` — the same rule the loader applies. The catalog id it makes (`ai:…`, `<domain>:…`, `source:…`) is unique in the file; the id itself may repeat across kinds, as the loader allows. |
| `kind` | required | One of the four kinds. |
| `domain` | connector kinds | The manifest's `domain`. |
| `label`, `description` | required | Strings; what the tab shows. |
| `author` | required | A name or handle, shown on the row. |
| `version` | required | A string, shown as written; nothing compares versions. Bumped with `source` when the author updates the pin. The manifest's version, when it names one, must equal it. |
| `apiVersion` | required | The manifest's `apiVersion`. An app that doesn't speak it shows the entry as "needs a newer app". |
| `source` | required | D2: `github:owner/repo[/dir]@<40-hex sha>` or `npm:name@<exact version>`. |

The file's own `apiVersion` is `1`; an app reading a file it doesn't speak
shows that as the tab's error. Unknown entry fields are ignored.

### The routes

- `GET /api/admin/plugins` gains `communityIndex: true|false` beside
  `installLocked`, so the dialog knows whether to draw the chip before
  fetching anything.
- `GET /api/admin/plugins/community` → `{ plugins, fetchedAt, stale, error }`.
  `plugins` are catalog-shaped rows (D7), each with
  `community: { source, version, apiVersion, author, domain,
  installedSource, updateAvailable, needsApp }` and
  `state: { installed, config: {}, health: null }`. `installed` is "an
  external row with this catalog id exists" (healthy or errored, as
  `bundledPlugins` counts it); `updateAvailable` is `installed &&
  installedSource !== source`; `needsApp` is the entry's `apiVersion`
  differing from the app's. A failed fetch answers the last good rows with
  `stale: true` and `error`, or no rows and `error`. With the index off, 404.
- `POST /api/admin/plugins/:id/update` takes an optional `{ url }`. With one,
  `updatePlugin(db, id, { sourceUrl })` fetches that source instead of the
  stored one; the id-and-kind check is unchanged and is what makes this safe.
  The operator's lock checks the given url.

### The installer

- `npmTarball` returns the registry's `integrity`; `downloadTarball` verifies
  the buffered archive against it before unpacking (SRI: `<algo>-<base64>`,
  the strongest algorithm listed) and refuses a mismatch by name:
  "npm tarball for name@version doesn't match the registry's integrity hash".
  Node's `crypto` does it; no dependency.
- `validateManifest`: `version`, when present, is a string.

### The validator — `scripts/check-plugin-index.mjs`

`node scripts/check-plugin-index.mjs community/plugins.json [--base <file>]`.
Exports `checkIndex(text, { base })` for the tests and runs when invoked. The
file and entry rules live in `server/plugin-index.js` — `validateIndex`,
`entrySource`, `manifestMismatches`, the field list — because the server
reads the same rules in Stage 3 and the image doesn't carry `scripts/`. With
`GITHUB_TOKEN` in the environment, GitHub API calls carry it. Checks, in
order, and reports every failure it finds before exiting non-zero:

1. The file parses; `apiVersion` is `1`; `plugins` is an array.
2. Every entry (changed or not): the fields above, by type and rule — the
   ones a manifest has through the loader's `validateManifest` itself;
   `source` per D2 — `resolveSource` accepts it, the kind is `github` with a
   40-hex ref or `npm` with an exact `major.minor.patch` version; catalog ids
   unique, and none a bundled example's (D11).
3. Every changed entry (new, or any field different from the base's entry
   with its catalog id — a relabel at the same pin is a change — against
   `--base`, the PR's base commit's copy of the file; without `--base`,
   every entry):
   fetch into a temp dir with `fetchModule`, read `manifest.json` through
   `manifestIn` (every manifest rule), and check id, kind, domain, label and
   apiVersion against the entry, the version when the manifest names one,
   and, for GitHub, that the archive's commit is the pinned one. The module
   is never imported, npm never runs.

`.github/workflows/plugin-index.yml`: on `pull_request` and on `push` to
`main`, `paths: [community/plugins.json]`; `npm ci` (the reviewer imports the
loader); on a pull request, `--base` is the base commit's copy of the file, a
missing one counting everything as changed; on a push, no base, so every
pointer is re-checked; `GITHUB_TOKEN` in the environment;
`permissions: contents: read`.

### The doc

PLUGIN.md's "Sharing a plugin" gains **Getting listed**: open a pull
request adding an entry to `community/plugins.json`; the fields; the source
pinned to a commit or an exact npm version, and why (a listing is reviewed
once, and what it points at must not move); the checks a PR must pass; that a
listing is a pointer review and installs still show the confirm; how to ship
an update (a PR bumping `source` and `version`) and what users see ("Update
to …"). "Installing" gains the npm integrity bullet. "Updating" gains the
Community tab's update.

## Stages

Each stage: a close read first, reported and ending in one question; then
the build, its tests, a removal check per proof, and a real-app check; then a
second pass on request. Stage order is by what holds without the stage after
it: 1 and 2 are true with no tab at all.

### Stage 1 — what's true without an index (the installer and the loader)

**Close read (2026-09-25) — what it changed.** Five findings, folded into the
steps below.

1. *The dot-rule test already exists.*
   [dynamic-plugins.test.js](../test/dynamic-plugins.test.js) refuses
   `id: "nodot"` with "namespaced". What was missing was the meaning: that
   this rule is what keeps a plugin from taking a built-in's name, because
   all three registries overwrite an existing name in silence. The built-ins'
   own ids join that assertion, with a sentence at the rule; no new test.
2. *The registry always sends an integrity hash.* Measured on `left-pad`:
   1.3.0 and 0.0.3 (from 2014) both carry `integrity` (sha512) and `shasum` —
   the registry filled the field in for versions older than it. The open
   question (absent → log and install, or refuse) answers itself: a
   log-and-install branch would be dead code. An answer without one is
   refused, by name. The one place this stage is stricter than today.
3. *The test needs no HTTP helper.* `withFetch` replaces global `fetch` for
   both calls, so one stub answers the packument for one URL and
   `new Response(tgz)` for the other; a Response built from a buffer streams
   through `Readable.fromWeb` with a null content-length, which
   `downloadTarball` reads as unknown and caps while streaming. No
   `serving()`. plugin-fetch.js's header ("npm's registry lookup is the one
   network path they don't run") is corrected.
4. *The real-app check can be real.* The hash is checked before the manifest
   is read, so `fetchModule` against the real registry for `left-pad@1.3.0`
   runs the new code on real bytes, and the same run with the packument's
   hash altered by a wrapping fetch is refused — without a plugin existing.
5. *`null` is absent.* The version rule reads `!= null`, the arc's rule since
   Stage 2's second pass. Impact: the only manifest with a `version` today is
   the acme-gecko fixture, a string; the examples have none; the card prints
   whatever is stored.

Steps:

1. npm integrity in `plugin-fetch.js`: `npmTarball` returns the registry's
   `integrity` and refuses its absence; `downloadTarball` takes an options
   object (`headers`, `subdir`, `integrity`) and, for an npm download,
   compares the buffered archive with the strongest hash it can check
   (sha512, sha384, sha256; other entries and `?options` ignored) after the
   size cap and before anything is written or unpacked. Mismatch: "npm
   tarball for name@version doesn't match the registry's integrity hash".
   No known algorithm: refused, naming the three. Node's `crypto`, no
   dependency.
2. `validateManifest`: `version`, when not null, is a string —
   "manifest.version must be a string — it is shown as written, never
   compared".
3. The built-ins' ids (`coingecko`, `openai`, `folder`) join the existing
   id-rule assertion, and the rule's comment says what it guards.
4. PLUGIN.md: the Installing bullet on npm gains "and the download is checked
   against the registry's integrity hash"; the manifest table's `version`
   row says it's a string.

Tests ([plugin-install.test.js](../test/plugin-install.test.js), in-process):
a stubbed registry — packument and tarball through one `withFetch` handler —
where a matching hash installs and records the version, several hashes
compare the strongest, a wrong hash is refused by name with nothing
registered and nothing left in staging, and no hash or an unknown algorithm
is refused by name. dynamic-plugins.test.js: the built-in ids; `version` as a
string, null and a number.

Removal checks: the compare deleted → the wrong-hash test fails; the absence
refusal deleted → fails; the algorithm refusal deleted → fails; the version
rule deleted → fails; the dot in the id rule loosened → the built-in ids
fail.

Real app: `fetchModule` for `left-pad@1.3.0` against the real registry lands
its files; the same with the packument's hash rewritten is refused. Nothing
visible changes in the app.

**Build record (2026-09-25).** As amended, in one pass.

- [plugin-fetch.js](../server/plugin-fetch.js): `strongestHash` (the three
  algorithms, `?options` ignored — the test carries one), `downloadTarball`
  on an options object, the compare after the size cap and before the
  archive is written, `npmTarball` returning `integrity: { hash, of }` and
  refusing an answer without one. The error names the package
  (`left-pad@1.3.0`), not the URL. The header corrected.
- [plugin-loader.js](../server/plugin-loader.js): the version rule, and the
  id rule's comment naming what it guards.
- PLUGIN.md: the npm bullet and the `version` row.
- Tests: plugin-install.test.js "an npm package is checked against the
  registry's integrity hash" — five cases in one test: a match installs and
  records `1.3.0`; the strongest of several hashes is compared; a wrong hash
  is refused by name with nothing registered and `.staging` empty; no hash
  and an `md5-` hash are refused by name. dynamic-plugins.test.js: the
  built-ins' ids refused, `version` as a string and null passing, a number
  refused. Unit 1972/1972 (one new), lint clean, the browser suite inside it.
- Removal checks, each fix undone and its test failing, the file restored
  byte-for-byte: the compare; the absence refusal; the algorithm refusal;
  the version rule; the dot in the id rule.
- Real registry: `fetchModule` for `left-pad@1.3.0` resolved `1.3.0` and
  landed its eight files in 427 ms; with the packument's hash rewritten by a
  wrapping fetch, "npm tarball for left-pad@1.3.0 doesn't match the
  registry's integrity hash" and nothing landed. Nothing visible changes in
  the app; compose not rebuilt for this stage.

### Stage 2 — the file and its validator

**Close read (2026-09-25) — what it changed.** Nine findings, folded into the
contract above and the steps below.

1. *CI would hit GitHub's unauthenticated limit.* Measured: the API tarball
   endpoint answers `X-RateLimit-Limit: 60` per IP, and Actions runners share
   IP pools. The script sends `Authorization: Bearer $GITHUB_TOKEN` to
   `api.github.com` when set — a fork PR's read-only token still
   authenticates, a thousand an hour per repository — by wrapping `fetch`
   for that host inside the script; the installer is untouched. The limit is
   charged on the API call; the redirect to codeload goes without the header.
2. *The entry rules can't live in the script.* `.dockerignore` keeps
   `scripts/` out of the image, so the server (Stage 3) couldn't import them
   there. They live in `server/plugin-index.js`; the script imports them.
3. *Two uniqueness rules contradicted each other* — the table's "id unique
   in the file" and the test's "one id across two kinds passes". The loader's
   rule is the catalog id; the table now says so.
4. *No HTTP helper, no injected fetch.* `withFetch` with `new Response(tgz)`
   covers a download in-process (Stage 1); the test stubs the tarball URL
   and counts calls. Only `tgzOf` moves to helpers.js.
5. *The real check's target had no version.* The examples' manifests carry
   none; the acme-gecko fixture does and is in `1036a2a`. The match rule
   loosened to "the manifest's version, when it names one, must equal the
   entry's", so a plugin without one can be listed.
6. *Two checks come free.* `fetchModule` returns a GitHub sha as written only
   when the archive's top directory names it, so the script asserts that;
   Stage 1's npm integrity check runs in CI too. `manifestIn` applies every
   manifest rule with the loader's own wording.
7. *Hints must match* when the entry gives them (Ollama's manifest has both).
8. *Push fetches everything.* `--base` only on a pull request; a first change
   creating the file has no base and counts everything as changed.
9. *An exact npm version has its own rule* — `resolveSource` takes any
   string; the index takes `major.minor.patch`, a prerelease suffix allowed.

Steps:

1. `community/plugins.json`: `{ "apiVersion": 1, "plugins": [] }`.
2. `server/plugin-index.js`: the file and entry rules (the contract above),
   pure. The fields an entry shares with a manifest go through the loader's
   own `validateManifest`, with the app's apiVersion substituted, so a rule
   is written once; an entry's `apiVersion` is held to a positive integer
   (D4).
3. `scripts/check-plugin-index.mjs`: `checkIndex(text, { base })` and the
   command line — the token wrapper, `--base`, one line per problem, the
   exit code. The GitHub fetch goes through `resolveSource` + `fetchModule`,
   so a sha ref, a subdir and the top-directory unwrap are the installer's
   own code.
4. `.github/workflows/plugin-index.yml` (the contract above).
5. `tgzOf()` moves from plugin-install.test.js to
   [helpers.js](../test/helpers.js).

Tests (`test/plugin-index-check.test.js`, a fetch stub for GitHub and npm):
the file's shape (not JSON, another apiVersion, `plugins` not an array);
every entry rule refused by name, each naming its entry — a tag, a branch,
the default branch, a short sha, a tarball URL, a path, an npm range, no npm
version, a missing source, an unknown kind, an id without a dot, a number for
a version, a missing author, a string apiVersion, a reserved domain, a
non-boolean hint — and a catalog id made twice, while one id across two kinds
passes; a changed entry whose manifest matches passes and is the one fetch,
its `index.js` throwing at import to prove nothing runs it; label, version,
apiVersion and a hint each refused naming the field; id and domain likewise;
a manifest without a version passes; no manifest reads as the loader says;
an archive cut from another commit is refused; against a base, the same
source isn't fetched while a different pin, a missing entry and a base that
isn't an index are; a malformed file fetches nothing; an npm entry passes
through the registry stub with its integrity hash.

Removal checks: the sha rule, the exact-version rule, the duplicate catalog
id, the base comparison, the label match, the archive-commit check, the
file's apiVersion — each deleted, its test fails, the file restored.

Real app: the script on the host against a scratch index holding one entry,
`github:alexmicuplusfour/001az/test/fixtures/plugins/acme-gecko@1036a2a…` —
a real GitHub fetch — passes; the same with the label changed fails naming
`label`; with `--base` the same file, nothing is fetched; with a token from
`gh auth token`, the same download succeeds through the wrapper. The
workflow is exercised by the first change that touches the file.

**Build record (2026-09-25).** As amended, with one thing found while
building: an entry whose `version` is a number was reported twice — once by
the loader's rule Stage 1 added (through `validateManifest`), once by the
index's own — so the index's rule now covers absence only, and a non-string
is the loader's sentence.

- `community/plugins.json`, empty. `server/plugin-index.js`: `validateIndex`,
  `entryProblems`, `entrySource`, `manifestMismatches`, `ENTRY_FIELDS`,
  `INDEX_API_VERSION`. `scripts/check-plugin-index.mjs`: `checkIndex` and
  the command line (usage exits 2, a problem 1). The workflow. `tgzOf` in
  helpers.js.
- Tests: `test/plugin-index-check.test.js`, four tests as listed (the shape
  test runs seventeen refused entries). Unit 1976/1976 (four new), lint
  clean, the browser suite inside it.
- Removal checks, each undone, its test failing, the file restored
  byte-for-byte: the sha rule; the exact-version rule; the duplicate catalog
  id; the file's apiVersion; the label match; the archive-commit check; the
  base comparison.
- Real GitHub, on the host: the scratch index with the acme-gecko fixture at
  `1036a2a…` — "1 fetched, 0 problem(s)", exit 0; the label changed —
  `plugins[0] (acme.gecko): label: the entry says "Gecko Pro", the manifest
  "Acme Gecko"`, exit 1; `--base` the same file — "0 fetched"; with
  `GITHUB_TOKEN` from `gh auth token` — fetched and passed through the
  wrapper. The workflow file parses; it runs for the first time on the
  first change to the file.

### Stage 3 — the server: the route, and Update from a new source

**Close read (2026-09-25) — what it changed.** Ten findings, folded into D7
and the steps below.

1. *The env line would have shipped the tab off.* Compose loads `.env` from
   `.env.example`, and under D8 an empty `PLUGIN_INDEX_URL=` means off — so
   the line written the ingest tunables' way (empty) would turn the chip off
   on every install copied from the example. It lists the full default URL,
   as `MODEL_PRICE_SOURCE_URL` does (the user's call: one convention in the
   file; a copied `.env` pins today's URL, and a fork points at its own).
2. *The fetch lives in `plugin-index.js`, not `plugin-fetch.js`.* Stage 2 put
   the rules there and its header promised the fetch; rules, fetch, cache and
   rows are one module, no longer "pure". `plugin-fetch.js` lends the capped
   body read — the declared-size check and streaming loop inside
   `downloadTarball` become one exported `readBody(res, maxBytes, what)` that
   both use, rather than a copy. A network failure is made readable by the
   wires' `compatFetch`, the one place the app already turns undici's "fetch
   failed" into its cause — this text reaches an admin's screen.
3. *D7's placement would have made a second import ring.* `communityPlugins`
   beside `bundledPlugins` means plugins.js → plugin-index.js →
   plugin-loader.js → plugins.js. The existing ring is accepted because the
   alternative was a duplicated rule; here the alternative is exporting
   `manifestEntry`, so `communityPlugins(db)` lives in plugin-index.js and no
   ring forms. The row shape is D7's, unchanged.
4. *The server must skip an entry it can't read (D4), and `validateIndex`
   handed it every entry.* It now returns `plugins` as the readable entries
   (the first of a duplicate pair kept) beside `problems`; the server logs
   the problems once per fetch and shows the rest. The reviewer is
   unaffected — it refuses the file on any problem — and its base helper
   loses a try/catch. "Needs a newer app" is an entry this app can read whose
   apiVersion differs; one it can't read (a kind it doesn't know) is skipped,
   never shown wrong.
5. *Last-good earns its lines because it is the cache not being thrown away.*
   A refresh that fails past the ten minutes answers the cached rows with
   `stale: true` and the reason, and doesn't advance the clock, so the next
   click retries — the price learner's rule. The cache holds the file's
   entries and the URL they came from (a moved env, which the tests do, never
   serves another file's rows); `installed` and `updateAvailable` are
   composed per call against the live install records, so they flip the
   moment an install lands.
6. *The A-to-B update test needs no served archive:* two temp copies as
   `file:` sources through the file's `copyOf` and `rewrite`. The lock's
   test: lock on, bundled Ollama installed, an update naming a GitHub url —
   403 naming the lock, where today's route would pass the lock and go to
   the network.
7. *Env is read per request*, as `installLocked()` is, never at import.
8. *A blank `url` counts as none*, as the install route reads its body; the
   lock judges the given url or the stored one; the log line names the
   source that ran. No `GET /:id` exists, so `/community` can't be shadowed.
9. *Source strings compare as strings*, which is enough: an index install
   stores the entry's string verbatim and an index update stores the new one.
   A plugin added from the URL zone at a branch reads "Update to …" once,
   which moves it onto the reviewed pin.
10. *The real check on the host* is the server started by the test harness
    (a scratch database), a local static server for the index, and real
    GitHub for the install; "the cache expires" is `now` handed to the
    function, no knob. The two-sha update belongs to Stage 4, after the push
    makes a second commit holding the fixture. Until that push the default
    URL 404s, and a dev build's tab shows the failed state.

Steps:

1. `plugin-fetch.js`: `readBody(res, maxBytes, what)` extracted from
   `downloadTarball`, exported; the tarball's messages unchanged.
2. `plugin-index.js`: `indexUrl()` (`PLUGIN_INDEX_URL`, default the repo's
   raw `main` URL, empty = off); `fetchPluginIndex({ now })` — 15 s, 1 MB,
   `validateIndex`, the ten-minute cache keyed by URL, last-good with
   `stale` and `error`; `communityPlugins(db, { now })` → `{ plugins,
   fetchedAt, stale, error }`, rows per D7 over `listExternalPlugins`.
   `validateIndex` returns the readable entries.
3. `plugins.js`: `manifestEntry` exported.
4. `server.js`: `communityIndex` on `GET /api/admin/plugins`;
   `GET /api/admin/plugins/community` (404 when off); `{ url }` on the update
   route, the lock judging it.
5. `plugin-loader.js`: `updatePlugin(db, id, { sourceUrl })` — the stored
   source unless one is given; the row records the one that ran.
6. `.env.example`: `PLUGIN_INDEX_URL` with its full default and what empty
   means. `.dockerignore`: `community` — the server reads the file from its
   URL, never from disk.
7. `scripts/check-plugin-index.mjs`: the base helper reads `plugins` as the
   readable entries.

Tests (`test/plugin-index.test.js`, a `jsonBox` serving the index, the env
pointing at it): rows in the catalog shape with `community` and `state`,
`needsApp` on `apiVersion: 2` only, `communityIndex: true`; an installed
entry is `installed` with its source and `updateAvailable` when the pin
differs, not when it matches, and the second call makes no fetch; a bumped
pin shows once the clock passes ten minutes; a failed refresh answers the
last rows with `stale` and the reason, and the next call retries; an entry
the app can't read is skipped and the rest shown; a malformed file at another
URL answers a readable error and no rows (the cache is keyed by URL); a 2 MB
body is refused by name; an empty env answers `communityIndex: false` and
404. In plugin-index-check.test.js: `validateIndex` returns the readable
entries. In plugin-install.test.js: install from A, update with source B —
the row's `source_url` is B, the description is B's, the connection survives;
a B naming another plugin is refused with the row untouched; the route with
`{ url }` and with a blank one; under the lock, an update naming a GitHub url
on a bundled plugin is refused.

Removal checks: the cache deleted → the one-fetch test fails; the URL key
deleted → the other-URL test fails; last-good deleted → the stale test fails;
the readable filter reverted → its tests fail; the cap deleted → the 2 MB
test fails; `sourceUrl` ignored in `updatePlugin` → the A-to-B test fails;
the lock's url check reverted → its test fails; the flag deleted → the 404
test fails.

Real app: the server started by the harness on the host with
`PLUGIN_INDEX_URL` at a local static server serving a scratch index that pins
the acme-gecko fixture at `1036a2a…`; the route answers the row; the fixture
installed from that GitHub pin through the install route (a real download);
the row reads installed, from that source, with no update; the scratch file's
pin bumped and the clock passed — an update appears; the update route with
`{ url }` moves the plugin to a local copy and back to the GitHub pin, the row
recording each; with the env empty, the flag is false and the route 404s.

**Build record (2026-09-25).** As amended, with two things found while
building, both in the new test file: the clock handed to the cache has to
advance cumulatively (a fresh "now plus eleven minutes" on each call landed
inside the window of the one before), and port 1 is on fetch's blocked-port
list, so undici answers "bad port" before connecting — the unreachable case
uses a port a box just gave back.

And one Stage 2 defect, found by this stage's real check. The reviewer
counted an entry as reviewed when its *source* matched the base's, so a pull
request that relabelled a listed plugin without moving its pin was never
fetched, and the label never met the manifest — the script's own header
promised otherwise. An entry now counts as reviewed only when every field in
`ENTRY_FIELDS` matches the base's; the base test gains that case and the
relabel-at-the-same-pin refusal, and the removal check (the comparison back
to source only) fails it. On real GitHub, the Stage 2 scratch index
relabelled "Gecko Pro" at the same pin, against the old file as base — "0
fetched, 0 problem(s)" before the fix — is now fetched and refused naming
`label`, exit 1; the same file as its own base still fetches nothing.

- [plugin-fetch.js](../server/plugin-fetch.js): `readBody(res, maxBytes,
  what)` extracted from `downloadTarball` and exported; the tarball's
  messages unchanged.
- [plugin-index.js](../server/plugin-index.js): `indexUrl`,
  `fetchPluginIndex({ now })` — fifteen seconds, one megabyte, the
  ten-minute cache keyed by URL, the last good copy marked stale with the
  reason, the wires' `compatFetch` for a readable network failure — and
  `communityPlugins(db, { now })`; `validateIndex` returns the readable
  entries. [plugins.js](../server/plugins.js) exports `manifestEntry`.
  [server.js](../server/server.js): `communityIndex` on the catalog payload,
  `GET /api/admin/plugins/community` (404 when off), `{ url }` on the update
  route with the lock judging it. [plugin-loader.js](../server/plugin-loader.js):
  `updatePlugin(db, id, { sourceUrl })`, the row recording the source that
  ran. `.env.example`: `PLUGIN_INDEX_URL` in full. `.dockerignore`:
  `community`. The reviewer's base helper reads the readable entries.
- Tests: `test/plugin-index.test.js`, five tests as listed; the readable
  entries in plugin-index-check.test.js; the A-to-B update and the lock's
  url in plugin-install.test.js. Unit 1982/1982 (six new), lint clean, the
  browser suite inside it.
- Removal checks, each undone, its test failing, the file restored
  byte-for-byte: the cache; the URL key; last-good; the readable filter
  (the rules' test and the server's); the cap; `sourceUrl` ignored; the
  lock's url check; the flag; the 404.
- Real check on the host: the harness's server with the index at a local
  static server — the flag true; the row; the fixture installed from its
  GitHub pin at `1036a2a…` in 2.1 s, the ref recorded as the full sha; the
  row installed from that source with no update; the pin bumped to
  `7f02846…` — unseen within ten minutes (one fetch), seen with the clock
  passed (two); the update route moving the plugin to a local copy
  (`source_url` the path, ref `local`) and back to the GitHub pin in 2.1 s
  (`source_url` the pin, ref the sha); with the env empty, the flag false
  and the route 404. Compose untouched: nothing visible changes until
  Stage 4.

### Stage 4 — the dialog

*Later: the chips became tabs at the dialog's top and the URL box moved
behind a footer button — see [After the arc](#after-the-arc-2026-09-25).*

**Close read (2026-09-25) — what it changed.** Eight findings and one
question, folded into D11 and the steps below.

1. *The real check needs no push.* The acme-gecko fixture sits at `7f02846`
   and `1036a2a`, and the two differ by its manifest's `version` line alone
   (measured with `git diff`) — an author bumping a version, exactly. Stage
   3's note that the two-pin update waited on a push was wrong. The check
   uses the fixture rather than the Ollama example, so it can't move a plugin
   the compose instance actually runs.
2. *The page drops the flag.* `loadPluginState` keeps only `plugins` and
   `installLocked` from the payload, so the chip would never be drawn. It
   carries `communityIndex`.
3. *Update's confirm would say the wrong thing.* The card's Update warns that
   it fetches the plugin again from its stored source; "Update to 1.3.0"
   fetches another source. It asks the install question instead, naming the
   new source — the URL box's warning, moved into one function the box and
   both Community buttons call (D12). The card's own Update keeps its
   re-fetch warning.
4. *One state can't be real in a browser test.* The server goes stale only
   after ten real minutes, and a test knob for the clock is machinery nobody
   runs. The browser test feeds that one answer through Playwright's route
   interception, built from a real answer; the server's side of stale is
   Stage 3's test, and the compose check waits the ten minutes out for real.
   Every other state is real: the index from a `jsonBox`, GitHub and npm
   answered by a fetch wrapper in the test's own process (the server runs
   in it), a moved pin seen by pointing the env at a new URL (the cache is
   keyed by URL).
5. *Button precedence.* "Needs a newer app" first — the loader refuses any
   apiVersion but its own, so an install or an update would fail there; then
   "Update to <version>" (installed, from another source); "Added"; "Add".
   The lock disables Add and Update, titled as the card's Update is.
6. *"Needs a newer app" rows are shown, disabled* — the open question
   answered: a count would hide what's listed. The label is right for every
   entry that can exist while the app speaks 1.
7. *The card's source line repeats more than the plan said.* An npm install
   prints `npm:x@2.1.0 · 2.1.0 · 2.1.0` when the manifest names the same
   version. The rule: drop a part the url already ends with, or one already
   printed — the sha pin's repeat is its first case.
8. *Reuse, no new CSS.* The chips are the Plugins page's `filterPill`,
   exported, its count optional (Community's isn't known until the click);
   the author line is the card's provenance style, `.p-src`; a failed or
   stale state wears `.p-err`. After a Community install the dialog stays
   open and the row reads "Added", as Included rows do; the Included list
   keeps the snapshot it opened with, as today.

The question — an entry reusing a bundled example's id — answered yes: D11's
rule, in the reviewer.

Steps:

1. `admin-plugins.js`: `loadPluginState` carries `communityIndex`; `tagFor`
   reads `p.community?.domain` when there's no live `p.connector`;
   `filterPill` exported, its count optional; the lock's title exported;
   `sourceLine` prints each part once.
2. `plugin-add-modal.js`: `confirmInstall(what, source)` — the URL box's
   warning, shared; the chip row when `communityIndex` is true, Included
   first and today's list; Community fetched on the first click, once per
   dialog, a switch back while it loads left alone; rows through `row()`,
   with a `.p-src` line "by <author> · <version> · <source>"; the button per
   finding 5; the states — loading, failed (the reason), empty ("None
   listed yet"), stale (a note over the rows).
3. `plugins.js`: `bundledManifests()` — the examples scan `bundledPlugins`
   already does, shared. `plugin-index.js`: `validateIndex(text, { reserved })`
   refuses an entry whose catalog id is reserved; the server passes none.
   The reviewer reserves the bundled examples' ids.

Tests ([test/browser/plugin-add.test.js](../test/browser/plugin-add.test.js)):
the chips only with the index on, Included the list as before; Community's
rows — tags, the author line — and Add from a GitHub pin and from an npm
version, each after the install warning, the row reading "Added" and the card
underneath printing its pin once; a moved pin reads "Update to 1.1.0", the
warning names the new source, and updating keeps the plugin's config and
moves its card; "Needs a newer app" disabled with its title; with the lock,
Add and Update disabled with the lock's title; empty, failed and stale. In
plugin-index-check.test.js: an entry taking a bundled example's id is
refused and nothing is fetched.

Removal checks: the chip gate; the flag in `loadPluginState`; the update's
`url`; the `needsApp` branch; the lock branch; the empty, failed and stale
branches; the source line's rule; `tagFor`'s community domain; the
reviewer's reserved ids.

Real app, on compose: the image rebuilt; `PLUGIN_INDEX_URL` pointing at a
static server on the host through `host.docker.internal`, set by an extra
compose file in the scratchpad (no repo file touched); a scratch index with
the acme-gecko fixture at `7f02846` and an entry for a newer app. In a real
browser: the chips; the rows; Add — a real GitHub download — and the card's
pin printed once; the index moved to `1036a2a`, the app restarted, "Update to
1.0.0" — a second real download — with the card's config kept; the static
server stopped and ten minutes waited: stale; restarted: failed; an empty
index: empty; the lock; the index off: no chips. Then the fixture removed,
the extra file dropped, compose back as it was.

**Build record (2026-09-25).** As amended, in one pass; nothing found while
building.

- [plugin-add-modal.js](../public/plugin-add-modal.js), rewritten around
  two lists: `showIncluded` (today's list), `showCommunity` (the route, once
  per dialog, a switch back while it loads left alone), `communityList` (the
  states), `row(p, button)` with the listing's `.p-src` line, `addButton`
  (today's Add), `communityButton` (the precedence), `confirmInstall` (the
  one warning, shared with the URL box), `asAdded` on modal.js's `claim`.
- [admin-plugins.js](../public/admin-plugins.js): the flag carried,
  `tagFor`'s community domain, `filterPill` exported with its count
  optional, `INSTALL_LOCKED_TITLE` exported, `sourceLine`'s rule.
  [plugins.js](../server/plugins.js): `bundledManifests()`, which
  `bundledPlugins` now reads. [plugin-index.js](../server/plugin-index.js):
  `validateIndex(text, { reserved })`. The reviewer reserves the bundled
  examples' ids.
- Tests: five in [plugin-add.test.js](../test/browser/plugin-add.test.js)
  — the chips; the rows, and Add from a GitHub pin and from an npm version
  with each card's provenance printed once; the moved pin's "Update to
  1.1.0", its warning naming the new source, the config kept, the card
  moved; the lock; empty, failed and stale — and one in
  plugin-index-check.test.js. Unit 1988/1988 (six new), lint clean; the
  browser suite 60/60 against the built frontend too.
- Removal checks, each undone, its test failing, the file restored
  byte-for-byte: the chip gate; the flag in `loadPluginState`; the update's
  `url`; the `needsApp` branch; the lock branch; the empty, failed and
  stale branches; the source line's rule; `tagFor`'s community domain; the
  reviewer's reserved ids.
- Compose, the image rebuilt, a real browser, the index served from the host
  (a Node static server on loopback, reached from the container through
  `host.docker.internal`): the chips; Acme Gecko listed at `7f02846` with
  "by 001az · 0.9.0 · github:…" and "Data · crypto", Acme Later disabled as
  "Needs a newer app" with its title; Add — the warning naming the pin, a
  real GitHub download inside the container in 2.4 s, the card printing the
  pin once; the index moved to `1036a2a`, the app restarted: "Update to
  1.0.0", titled "Installed from …@7f02846…", the warning naming the new
  pin, a real download in 3.9 s, the card reading "…@1036a2a… · 1.0.0" and
  the plugin's rpm of 7 kept; the index server stopped and the ten minutes
  waited out: "Fetched 11 minutes ago; the refresh failed: the plugin index:
  ECONNREFUSED — http://host.docker.internal:18765/plugins.json" over the
  rows; the app restarted with the server still down: the failure, no rows;
  an empty index: "None listed yet"; with `PLUGIN_INSTALL_DISABLE=1` and the
  index back at `7f02846`: the lock sentence in place of the URL box, and
  "Update to 0.9.0" — a pin moved to an older commit reads as an update —
  disabled with the lock's title (a locked Add is the browser test's); with
  the index off: no chips, and the route 404. No page errors, no failed
  requests. Then the fixture removed, the session dropped, the app
  recreated from the repo's compose files alone.

### Stage 5 — the doc, the parent plan, and the first entry

**Close read (2026-09-25) — what it changed.** Six findings and one
question.

1. *Two sentences in PLUGIN.md are wrong now.* "Sharing a plugin" says "a
   tag or a commit is a fixed install" — a tag can be moved, only a commit
   is fixed (D2's own research) — and "there's no directory of community
   plugins yet". "Updating" says moving a plugin to another source means
   removing it; the Community tab's "Update to …" moves it and keeps what it
   saved.
2. *The list ships empty.* D10's other option was the repo's own example as
   a worked entry, which D11's rule now refuses, and the repo's only other
   plugin is a test fixture. "None listed yet" is what every app shows until
   the first submission. The doc carries a made-up example entry instead,
   and a test holds it to the rules.
3. *The Installing step is done:* the npm integrity bullet went in with
   Stage 1.
4. *More of the doc touches the list:* Trust — the app asks before an
   update too, not only an install, and a listing is a pointer review;
   Installing — the Community tab, and `PLUGIN_INDEX_URL` for operators;
   Versions — "Needs a newer app"; Locking installs — the Community buttons
   are held too.
5. *"Getting listed" says what the reviewer does:* the pull request, the
   fields, why the pin, every check that fails a pull request, that a person
   merges, how to run the check yourself, how to ship an update and what
   users see, and how soon a merged entry shows.
6. *`community/README.md`* — two lines pointing at the doc, because that
   folder is where a stranger lands on GitHub; JSON holds no comment.

The question — `keyless` and `needsBase`, carried and checked but shown
nowhere — answered: drop them (the user's call). Unknown entry fields were
already ignored by the reviewer's change detection but still type-checked
through the manifest rules; `entryProblems` now hands the rules only the
entry's fields, so an old entry carrying a hint passes.

Steps:

1. `plugin-index.js`: `ENTRY_FIELDS` without the hints; `entryProblems`
   validates the entry's own fields only; `manifestMismatches` without the
   hints; the `community` block without them.
2. PLUGIN.md: Trust, Installing, Updating, Locking installs, Versions, and
   "Sharing a plugin" with a new "Getting listed" — an example entry and
   the field table under pin markers.
3. `community/README.md`.
4. The list ships empty, as it is.

Tests: [plugin-doc.test.js](../test/plugin-doc.test.js) — the field table's
fields are `ENTRY_FIELDS`, and the example entry carries every field and
passes `validateIndex`. plugin-index-check.test.js — an entry's unknown
fields, a hint among them, are ignored, by the rules and by the manifest
comparison. plugin-index.test.js — the block carries no hints.

Removal checks: a field row deleted from the doc's table; a field added to
`ENTRY_FIELDS`; the example's source changed to a tag; the whole entry handed
to the manifest rules again; the hints back in the block; the hint
comparison back.

Real check: a fresh session gets PLUGIN.md and the acme-gecko fixture's
manifest at `7f02846` and `1036a2a` — nothing else — and writes the list
with the fixture at the first commit, then the list after shipping the
second as an update. The reviewer checks the first against real GitHub, and
the second with the first as its base; the session's notes on what the doc
left unclear are read and acted on. Then PLUGIN.md's new text is re-read
against the code, claim by claim.

**Build record (2026-09-25).** As amended, in one pass; the fresh session's
notes and the re-read changed the doc after the first draft.

- [plugin-index.js](../server/plugin-index.js): `ENTRY_FIELDS` without the
  hints; `entryProblems` hands the manifest rules the entry's own fields
  only; `manifestMismatches` and the `community` block without the hints.
- PLUGIN.md: Trust (the app asks before an update too; a listing is listed,
  not vouched for); Installing (the two tabs, `PLUGIN_INDEX_URL`, a commit
  pin records the commit); Updating (the card's Update fetches the source on
  record, "Update to" moves a listed plugin, no versions compared); Locking
  installs; Versions; "Sharing a plugin" with the tag sentence corrected and
  **Getting listed** — the example entry and the field table under pins,
  which fields are required, why the pin, what the check fails on, what it
  prints and can't catch, running it with and without `--base`, the review,
  the quarter hour, shipping an update. `community/README.md`.
- Tests: two in plugin-doc.test.js (the table's fields are `ENTRY_FIELDS`;
  the example carries every field and passes `validateIndex`);
  plugin-index-check.test.js (an entry's other fields ignored by the rules
  and by the manifest comparison); plugin-index.test.js (the block's keys).
  Unit 1990/1990 (two new), lint clean.
- Removal checks, each undone, its test failing, the file restored
  byte-for-byte: a field row deleted from the doc's table; a field added to
  `ENTRY_FIELDS`; the example's source changed to a tag; the whole entry
  handed to the manifest rules; the hints back in the block; the hint
  comparison back.
- Real check: a fresh session with PLUGIN.md and the fixture's two
  manifests, nothing else, wrote the list with the fixture at `7f02846`
  (labelled 0.1.0 — its manifest names no version) and the list after the
  update to `1036a2a` (1.0.0); both passed the reviewer on its first run,
  against real GitHub. Re-run here: the listing passes; the update, checked
  against the listing as its base, is the one entry fetched and passes; the
  listing against itself fetches nothing. The session named eight places it
  had to guess, and the doc now answers each: the `version` of a manifest
  with none; which fields are required; that "Update to" means a different
  pin, not a different version string; a folder deeper than one level; the
  file's own `apiVersion`; what a local run downloads, and `--base`; what the
  check prints; that it can't catch a broken factory, so install the pin
  yourself first. The claim-by-claim re-read changed three more sentences:
  the card's Update after a move fetches the new pin; the examples' rule is
  about installing as one, which takes the kind as well as the id; Included
  holds what you've added too.
- The list ships empty; "None listed yet" is what an app shows until the
  first submission is merged.

## Simplification pass (2026-09-25)

Asked for after Stage 5. One read-only reviewer per area — the install and
update path, the list and its reviewer, the dialog, the tests, the doc —
told behavior-preserving only and to name what a change would alter; every
finding re-read in the code before acting. Three of them were bugs, not
simplifications, and are fixed with proofs of their own.

**Bugs found and fixed.**

- *The dialog rebuilt a tab's rows on every chip click* from what it opened
  with: a plugin added a moment ago read "Add" again after a switch away and
  back, and a row still busy installing came back as a fresh, clickable
  button — a second install of the same plugin, concurrently. Each list's
  rows are now built once and the same nodes put back. Proof: both browser
  tests switch away and back and read "Added"; undoing either half fails its
  test.
- *The reviewer named the manifest where it meant the entry* for a sentence
  that mentions a field mid-sentence: an entry with no `domain` was told
  "connector-provider requires manifest.domain". Every `manifest.` in a
  loader sentence is now `entry.`; the refused-entries table gains the case.
- *The script's arguments depended on their order:* `--base before.json
  community/plugins.json` checked before.json with no base. It reads them
  with `util.parseArgs` now — either order; an unknown flag or a bare
  `--base` is the usage line (exit 2). Checked by hand both ways.

**What went.**

- Server: an unreachable second "index off" check in the fetch (the route
  answers 404 first); a coercion of a string to a string; a comment that
  restated the error below it; `manifestMismatches` as one field list; the
  unused `apiVersion` in `validateIndex`'s answer; three exports nobody
  imports.
- Reviewer: the base as an empty map rather than null and a guard; the
  repo's own main-module idiom; the workflow's hand-written empty index — a
  missing base file reads as no base already.
- Dialog: `filterPill` uses `appendCount` (utils.js named the chip as the
  other copy); the provenance line is one element builder, `provenance()`,
  shared by the card and the listing's line; two guards the server's answer
  makes impossible; a comment that said the install warning was the only
  one. The stale note uses `relTime` — **"Fetched 12m ago"** where it said
  "12 minutes" — the one visible text change: the app says "N ago" one way
  everywhere, and the helper exists to stop hand-rolled copies.
- Tests: three assertions that couldn't fail on the rule they named now can
  — the retry after a failed refresh is asked at the same moment (a failure
  that advanced the clock would pass the old one); a malformed file holds a
  good entry too, so the shape-first rule is what keeps it unfetched; the
  several-hashes case gives a wrong sha256 beside a right sha512, so only
  the strongest, with its `?options` dropped, passes. One npm stub
  (`sri`, `npmAnswers`, `answering` in helpers.js) instead of three
  hand-built packuments; the reviewer's test on one `review()` helper; the
  caller-named-source test now shows the blank update fetching the recorded
  pin; six repeated assertions and two history comments.
- Doc: the Updating section says the card's Update once; the pinning
  paragraph doesn't repeat "Sharing a plugin"; "never runs your code" once;
  the review is "of the pointer, not an audit" without restating the
  warning; "Shipping an update" points at Updating; the `domain` row doesn't
  repeat the sentence under the table. Corrected: a fault in the file itself
  prints one line and no count.

**Declined.** Inlining the SRI helper — a named concept reads better named.
Dropping `bundledPlugins`' early return — it keeps the old no-examples path
free of a database read. `!plugins.length` in the failed state's test — it
spells the state's definition. The Installing sentence about the Community
tab — the admin-facing half of what "Getting listed" tells authors.

**Checks.** 36 removal checks, every one caught — each proof the pass
restructured (the list's rules and comparisons, the cache and its URL key,
last-good, the cap, the flag and 404, the caller's source and the lock, the
integrity compare and refusals, the dialog's states, print-once and the
update's url) and the new ones (the rows kept across a switch, both lists;
a failure not advancing the clock; the strongest hash and its options; the
shape first; the entry's field names). The script by hand: the file and
`--base` either way round, a bare `--base`, an unknown flag, no file, and a
run from another folder. Old front end against new on one server in real
Chromium, dumped and diffed: the card's source line, both chip rows, every
row of both lists with its title and class, errors and failed requests —
identical but for the stale note's wording. Unit 1990, 1989 green: the one red, mcp-asset.test.js's tamper check, is a flake in code this pass didn't touch — it tampers a signature by swapping its last character for X, which changes nothing when the character already is X, about one run in 64 — and passed on three reruns, lint clean, the
browser suite 60/60 against the built frontend. Net about ten lines fewer;
the gain is in duplication gone, not length.

## After the arc (2026-09-25)

Asked for once the arc was pushed, on the dialog Stage 4 built:

- The Included · Community chips became the board editor's segmented tabs,
  at the top of the dialog — one builder now, `paneToggle` in modal.js, which
  the board editor uses too. `filterPill` is the Plugins page's alone again.
- "Connections you can add…" is gone.
- The URL box moved into a drawer behind **Install from a URL…** in the
  footer, with its explanation and its error. Under the lock the footer says
  so in words, as the sentence in the box's place did.
- The dialog has a height floor, an id rule in modal.css: an empty Community
  tab had folded it to the tabs and one line. The width never moved.

Its second pass found the drawer could be dismissed with an install still
running — the failure then silent, and a second install free to start beside
it. The footer's button now holds until the install ends, and the end
arrives as a toast.

## Verify (compose, end of each stage)

1. Stage 1: nothing visible; the suite is the proof.
2. Stage 2: the script against a real GitHub-pinned entry, on the host.
3. Stage 3: the route with a local index, on the host; compose reaches the
   host's static server through `host.docker.internal`.
4. Stage 4: the dialog's every state in a real browser on compose; one real
   install and one real update from sha-pinned entries.
5. Stage 5: PLUGIN.md re-read against the shipped code, the doc-pin test
   green.

## Risks / notes

- **The trust model does not change.** The index adds a way to find a
  pointer, not a way to run code; the confirm, the lock, scripts-off and the
  admin-only routes are untouched. The review is a pointer review and the
  doc says so.
- **Rate limits.** 6 raw fetches an hour at most per app instance; the API
  tarball on install is one more. Several instances behind one IP share the
  60. The validator fetches changed entries only, so a PR costs a handful.
- **Privacy.** The server's IP reaches GitHub only when an admin opens the
  Community chip, at most once per 10 minutes. Empty env, nothing leaves.
- **`main` is the index's only branch.** Every merge to main republishes the
  file, and raw caches it about 5 minutes; the app's 10-minute cache sits on
  top. An entry is live within a quarter of an hour of merging.
- **CI runs on a stranger's pointer.** The validator downloads and unpacks
  what a PR names, in a temp dir, and never imports or installs it. The
  workflow is read-only, and a fork's token is anyway. `tar` sees the same
  archives the installer does.
- **The source line repeats a sha** for any sha-pinned install today
  (`github:o/r@abc… · abc…`); Stage 4 prints it once.
- **No versions are compared anywhere.** "Update to 1.3.0" is "the pin
  differs", labelled with the entry's version. A pin moved to an older
  commit still reads as an update, which is what it is.

## Open for the close reads

- Stage 1: the SRI parse; whether a registry answer with no `integrity` is
  installed unverified (yes, with a log line) or refused.
- Stage 2: `--base` on push; whether the script should also refuse an entry
  whose catalog id is a built-in's (the dot rule already does).
- Stage 3: where the shared entry rules live (plugin-fetch.js, or a small
  `plugin-index.js` beside it); whether last-good-on-failure earns its lines.
  Answered: plugin-index.js (Stage 2), and yes — it is the cache not being
  discarded (Stage 3's close read).
- Stage 4: whether "Needs a newer app" rows show at all, or only a count.
  Answered: shown, disabled (Stage 4's close read).
