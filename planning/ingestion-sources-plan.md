# Ingestion sources — a new plugin type + FTP and S3

**Status: SHIPPED 2026-07-15 (local, uncommitted).** All 7 slices built; 319
tests green (was 309 — 10 new: connection CRUD/masking/blank-keeps, catalog
`connectionCount`, the FTP backend + file adapter e2e against an in-process
ftp-srv, the board sources/browse routes, and `validateSource`). S3 backend
live-verified against a real MinIO (list recursive + prefix-as-dir + fetch +
`accept` filtering). Browser DOM not automated as ever — the new front-end
(source picker in ingest-modal.js, source-browse-modal.js, the connections
manager in plugin-modal.js) is syntax-checked; eyeball on next manual visit.

What shipped vs the plan: as written, with these notes —
- **Zero data migration.** Only `0019_source_connections.sql` (a new table).
  `source:folder` coalesces to installed (core); ftp/s3 to available; a file
  board's `ingest.source.type` absent ⇒ folder. Existing boards untouched.
- `validateIngest` no longer validates the source at all — source validation
  moved to the adapter's async `validateSource(db, source)` (keyed off the
  INCOMING type, since a board can switch sources). `buildBoardContentUpdate`
  became async to await it; two tests moved from `validateIngest` to
  `validateSource`.
- The folder backend keeps its historical `source.folder` key (remote sources
  use `source.path`); the adapter reads whichever. Folder browsing keeps its
  existing flat dropdown; the new tree-browse modal is for remote sources.
- `docker-compose.yml` gained opt-in `ftp` + `minio` services under a
  `dev-sources` profile (never started by a plain `up`).

Original plan below, kept for the record.

---

**Status: PLAN (2026-07-15).** Extends automatic ingestion (`ingestion-plan.md`)
and the plugin ecosystem (`plugin-ecosystem-plan.md`, `plugins-phase-2-install-model.md`).
Builds a fourth plugin **kind** — `source` — so a file board can ingest from a
**remote** source, not just the local `INGEST_ROOT` folder. Ships two concrete
sources (**FTP/FTPS** and **S3**) plus a reusable backend interface so the next
one is a single small file.

Decisions ratified with the user (2026-07-15):
- **First sources: FTP/FTPS _and_ S3** (build both this pass to prove the
  interface generalises past a filesystem to an object store).
- **Saved connections (reusable), not per-board credentials.** A connection
  (host/bucket + login) is created once by an admin — like an AI key — and any
  board references it plus a subpath. One place to rotate a password.
- Design the `source` backend interface so SFTP / WebDAV / Google Drive drop in
  later with no core edits.

---

## Repo context (skim if you know the app)

Automatic ingestion is a per-board sweep. `resolveIngestAdapter(board)`
(`server/ingestion/index.js`) picks an **adapter**; each adapter declares a
`descriptor()` (source schema, filter catalog, sorts, trigger modes) and
implements `enumerate(db,board,cfg)` → candidates and `admit(db,board,cand)` →
entity+item+ledger row. Two adapters exist:

- **folder** (`server/ingestion/folder.js`) — file boards. Walks a jailed
  subpath under `INGEST_ROOT`, `admit` = copy-to-tmp → `admitFile` (the shared
  upload/ingest birth path, `server/ingest.js`) → `recordIngest`.
- **connector** (`server/ingestion/connector.js`) — crypto/stocks boards. Pages
  the connector's catalog; not a file source.

The sweep (`worker.js ingestDue`), the dedup ledger (`ingest_log(board_id,
source_key)`, `db.js`), the filter engine (`server/ingestion/filter-engine.js`),
the routes (`server/server.js:481–578`) and the modal (`public/ingest-modal.js`,
descriptor-driven, two-stage preview) are all **adapter-blind** — they already
speak the interface. Adding an ingestible source should stay that way.

The plugin registry (`server/plugins.js`) composes three kinds into one catalog
(`ai`, `connector`, `media`) with an **installed / available** state (a
capability is core+always-installed; a connection you **Add** from the Add
modal). The Plugins page (`public/admin-plugins.js`) is a flat card list; the
gear opens `public/plugin-modal.js` (per-kind sections). AI providers already
manage a **key registry** in that modal (`ai_keys` table + `keysSection`) — the
exact shape a source's saved-connection registry will mirror.

Design rule that governs every choice below: **flexibility over guardrails** —
defaults not laws, graceful degradation not prevention.

## The model

A **source** is a place files come from. The local folder is one; FTP and S3 are
two more. In the plugin vocabulary:

| concept | AI analogue | source |
|---|---|---|
| the plugin (a **type**, install/available) | `ai:anthropic` | `source:ftp`, `source:s3`, `source:folder` |
| an instance you configure (holds secrets) | a row in `ai_keys` | a row in **`source_connections`** |
| where a board points | `boards.ai_key_id` | `board.ingest.source.connectionId` |

- `source:folder` is **core** (always installed; it's the built-in local
  ingest — no saved connection, uses `INGEST_ROOT`).
- `source:ftp` and `source:s3` are **available** — Add them on the Plugins page.
- A **connection** (FTP host+login, or S3 bucket+keys) is created **once** by an
  admin in the source plugin's gear modal, exactly like an AI key. Boards pick a
  connection + a subpath; they never see or store the credentials.

### Per-board config (`board.ingest.source`)

```js
board.ingest.source = {
  type: "ftp",            // source backend name; ABSENT → "folder" (back-compat)
  connectionId: 12,       // a source_connections row; absent for folder (uses INGEST_ROOT)
  path: "exports/daily",  // subpath (folder: under INGEST_ROOT; ftp: dir; s3: key prefix)
  recursive: true,
}
```

No secrets in `boards.ingest` — the whole reason for saved connections. A board
manager configuring ingestion picks from connections an admin already made.

### The source backend interface (the contract for contributors)

A backend is a small module: a static `manifest` + a `backend(connectionConfig)`
factory. The factory returns three methods; everything else (walk, filter, sort,
dedup, admit, the modal, the routes) is shared and already written.

```js
// server/ingestion/sources/ftp.js
export const manifest = {
  name: "ftp", label: "FTP / FTPS",
  description: "Ingest files from an FTP or FTPS server",
  browsable: true,          // the source-browse modal can navigate it
  needsConnection: true,    // remote → requires a source_connections row
  core: false,
  // Fields to CREATE a connection (admin form). secret:true → masked on read.
  connectionSchema: [
    { key: "host",     type: "text",   label: "Host", required: true },
    { key: "port",     type: "number", label: "Port", default: 21, min: 1 },
    { key: "secure",   type: "toggle", label: "Use FTPS (TLS)", default: false },
    { key: "user",     type: "text",   label: "Username", default: "anonymous" },
    { key: "password", type: "secret", label: "Password" },
  ],
};

export function backend(conn) {           // conn = resolved connection config (secrets included)
  return {
    // ONE directory level when recursive=false (the browse modal); a bounded
    // walk when recursive=true (enumerate). type is "file" | "dir".
    async list({ path = "", recursive = false, limit = Infinity }) {
      return { entries: [/* { key, name, path, type, size, modified, created } */], truncated: false };
    },
    async fetch(key, tmpPath) { /* download one file to tmpPath */ },
    async test() { /* connect + list root; throw on failure */ },
  };
}
```

- `key` is the stable ledger `source_key` (path relative to the connection root
  for FTP; the object key for S3). Deletion of an item never re-ingests it
  (existing "user wins" ledger rule).
- `folder`'s backend takes **no** connection and reuses the current
  `resolveJailed` + walk + `copyFile` logic verbatim — it's the refactor target,
  not new code.

### The shared file adapter

`server/ingestion/files.js` — `fileAdapter(board)` replaces `folder.js` as the
adapter for file boards. It owns the file filter catalog (identical to today's
folder descriptor: name/extension/path/file_size/modified/created + the four
sorts) and dispatches enumerate/admit to the backend named by
`cfg.source.type` (default `"folder"`):

```js
async function resolveBackend(db, source = {}) {
  const type = source.type || "folder";
  const mod = getSourceBackend(type);                       // sources/index.js
  if (!mod) throw new Error(`unknown source "${type}"`);
  if (!(await pluginInstalled(db, `source:${type}`)))
    throw new Error(`the ${mod.manifest.label} source isn't installed`);
  if (!mod.manifest.needsConnection) return mod.backend();  // folder
  const conn = await getSourceConnection(db, source.connectionId);
  if (!conn) throw new Error("that connection was removed — pick another for this board");
  return mod.backend(conn.config);
}
```

`enumerate` = `resolveBackend` → `backend.list({path, recursive, limit})` →
keep `type==="file"` entries that pass `acceptsName` + the 10 MB cap → map to the
same `{key,label,values}` candidate shape `folder.js` emits today (so the engine,
sweep, ledger and preview list are untouched). `admit` = `resolveBackend` →
`backend.fetch(key, tmp)` → `withTx(admitFile + recordIngest)` → unlink tmp —
byte-for-byte the folder adapter's admit, minus the fs-specific copy.

`resolveIngestAdapter`: connector name → `connectorFeed`; else → `fileAdapter`.

## Storage

**One new table** — `source_connections`, mirroring `ai_keys` (migration
`0019_source_connections.sql`):

```sql
CREATE TABLE IF NOT EXISTS source_connections (
  id         BIGSERIAL PRIMARY KEY,
  type       TEXT   NOT NULL,               -- backend name: ftp | s3
  label      TEXT   NOT NULL,
  config     JSONB  NOT NULL DEFAULT '{}',  -- all connection fields incl. secrets
  created_at BIGINT NOT NULL,
  updated_at BIGINT
);
```

Secrets are stored plaintext in `config`, consistent with the app's existing
posture (`ai_keys.api_key`, connector keys in `settings` are plaintext too) —
encryption-at-rest is an app-wide decision, out of scope here. **No plugins-table
migration**: `source:folder` coalesces to installed (core), `source:ftp`/`:s3`
to available (absent row → default). `board.ingest.source.type` absent ⇒
`"folder"`, so every existing file board keeps working with zero data change.

## Slices

### Slice 1 — backend interface + folder refactor (behaviour-identical)
- New `server/ingestion/sources/index.js` (registry: `folder`, later `ftp`/`s3`;
  exports `MANIFESTS`, `getSourceBackend`).
- Move `folder.js`'s fs logic into `sources/folder.js` as a connection-less
  backend (`resolveJailed`/walk → `list`; `copyFile` → `fetch`; root check →
  `test`). New `server/ingestion/files.js` = `fileAdapter` (descriptor + dispatch
  + the admit-through-`admitFile` block, unchanged).
- `resolveIngestAdapter` → `fileAdapter(board)` for file boards.
- **Pin:** the existing `ingest-folder.test.js` / `ingest-engine.test.js` /
  `ingest-sweep.test.js` stay green untouched (the behaviour contract). Add one:
  a stub backend drives `fileAdapter` enumerate/admit/dedup.

### Slice 2 — source_connections store + the `source` plugin kind
- Migration `0019`; `db.js` helpers `listSourceConnections` (with `boards_using`
  via a JSONB scan `ingest->'source'->>'connectionId'`), `getSourceConnection`,
  `createSourceConnection`, `updateSourceConnection` (blank-secret-keeps merge),
  `deleteSourceConnection`.
- `plugins.js` `sourceDefs()`: `kind:"source"`, `segment:"source"`; folder
  `core:true`; carries `connectionSchema`; `configSchema:[]` (no global config —
  the connections store IS its state). `pluginCatalog` adds
  `state.connectionCount` for source kind.
- Admin routes (mirror `ai-keys`, all `requireAdmin`):
  `GET/POST/PATCH/DELETE /api/admin/source-connections` (+ `/test`, and a typed
  `POST /api/admin/source-connections/test` for pre-save checks). GET masks
  secret fields → presence booleans; POST/PATCH validate `config` against the
  backend `connectionSchema`. Deleting a connection a board uses is **allowed**
  (graceful) — the board's next run surfaces a readable error, no crash.
- Tests: connection CRUD + validation matrix, secret mask on read, blank-keeps on
  edit, `boards_using` count, catalog exposes source defs + `connectionCount`.

### Slice 3 — the FTP and S3 backends
- `sources/ftp.js` (`basic-ftp`): `list` via MLSD (recursive walk bounded by
  `limit`), `fetch` via `downloadTo`, `test` via connect+list. `secure` →
  FTPS. `sources/s3.js` (`@aws-sdk/client-s3`): `list` via `ListObjectsV2`
  (`Delimiter:"/"` for one level → CommonPrefixes as dirs; no delimiter for
  recursive), `fetch` via `GetObject` stream, `test` via a 1-key list;
  connectionSchema = endpoint(optional, for MinIO/R2)/region/bucket/accessKeyId/
  secretAccessKey(secret)/forcePathStyle(toggle).
- Register both in `sources/index.js`.
- Tests: **FTP** integration against an in-process `ftp-srv` (seed a tree →
  real `basic-ftp` list/fetch/test/recursive; FTPS with a self-signed cert).
  **S3** adapter logic via a fake backend in unit tests + a **gated** live test
  against MinIO (`INGEST_S3_TEST=1`) for prefix listing + fetch.

### Slice 4 — board-facing routes
- `GET /api/boards/:id/ingest` (+ `sources`): for a file board, the installed
  source backends `[{ type, label, browsable, needsConnection, ready,
  connections:[{id,label}] }]` (connections filtered to that type, no secrets).
  Connector boards unchanged (`sources` absent).
- `POST /api/boards/:id/ingest/source/browse` [manager] `{source:{type,
  connectionId,path}}` → `resolveBackend` → `list({path, recursive:false})` →
  `{path, parent, entries}` for the source-browse modal.
- `validateIngest`: source validation for file boards moves to
  `fileAdapter.validateSource(db, source)` (type installed? connection exists for
  remote? `path` a string?), called from `buildBoardContentUpdate`. Generic
  filter/sort/limit/trigger checks stay in `validateIngest`. `preview`/`run`
  need no change — they already go through the adapter.
- Tests: browse route (dir level, bad connection → readable 400), source
  validation matrix, preview over a stub remote, manager can't reach the admin
  connection routes.

### Slice 5 — Plugins page: the source plugin modal
- `plugin-modal.js`: a `connectionsSection` for `kind:"source"` — the type's
  connections (label · host/bucket hint · Test · Remove) + a schema-driven Add
  form (from `connectionSchema`, secret→password input, blank-keeps on edit),
  mirroring `keysSection`. Folder → an informational "core, uses INGEST_ROOT"
  panel (like `mediaSection`).
- `admin-plugins.js`: `tagFor` source → `Source · files` (folder → `Source ·
  core`); `keyNote` → `connectionCount` ("3 connections" / "no connections yet");
  `removalImpact` → "N boards pull from a <type> connection." Add modal already
  lists non-core plugins → `source:ftp`/`:s3` appear automatically.

### Slice 6 — ingest modal: source picker + source-browse modal
- `ingest-modal.js` Source section (when `info.sources` present): a **source-type
  `<select>`** of installed sources. Folder → the existing folder dropdown +
  recursive (unchanged). Remote → a **connection `<select>`** (that type's
  connections) + a **path** field + a **Browse…** button + recursive; empty
  connection list → a note pointing at the Plugins page. Remote sources default
  the trigger to `interval` with a hint that `continuous` polls every 30 s.
- New `public/source-browse-modal.js` (shared `pagedTableScaffold`, connector-
  browse chrome): navigate `entries` — folders descend, a breadcrumb / "up",
  files listed read-only, **Use this folder** sets `cfg.source.path`. Fetches the
  browse route. The existing two-stage **Preview** (count → results) works for
  remote sources unchanged (it runs through `enumerate`).

### Slice 7 — deps, compose, docs, verify
- `package.json`: `basic-ftp`, `@aws-sdk/client-s3`; dev `ftp-srv`. (Both
  clients are pure JS — no Dockerfile system deps.)
- `docker-compose.yml`: optional `ftp` + `minio` services for dev/testing with
  env passthrough; `.env.example` additions. deploy.ps1 needs no artifact edit
  (docker `COPY . .`; new `public/*.js` ship automatically).
- Full live verify (below).

## Verify (compose stack)
1. Boot: no migration surprises; folder ingestion still works exactly as before
   (Slice-1 refactor is invisible).
2. Plugins page: **Add** FTP and S3 → cards appear (`Source · files`).
3. FTP gear → **Add connection** (host/user/password) → **Test** ✓; S3 gear →
   add a MinIO connection → Test ✓.
4. A file board → ingestion modal → Source → pick **FTP** → pick the connection →
   **Browse…** navigates the server tree → **Use this folder** → **Preview**
   shows the count → the results list → **Save + Run now** ingests real files;
   dedup holds on a second run; a deleted item isn't resurrected.
5. Same against **S3** (prefix browse, object fetch).
6. **Remove** the FTP connection an in-use board points at → the board's next run
   shows a readable error, existing items untouched; re-point → resumes.
7. Remove the FTP/S3 plugin → its boards degrade readably; folder plugin Remove
   is disabled (core).

## Risks / notes
- **In-tick network I/O.** FTP/S3 `fetch` runs inside the worker tick (like the
  connector feed's `fetchEntity`). `INGEST_RUN_CAP` (25) bounds a tick; big runs
  drain across ticks. Known-benign family; documented in the adapter header.
- **Ledger key stability.** FTP key = path relative to the connection root; S3
  key = object key. Changing a board's base `path` changes which files it sees
  but not already-ledgered keys (no re-ingest of prior paths) — acceptable,
  noted in the modal.
- **Dangling connectionId.** No FK (it lives in JSONB) — deletion is graceful by
  design (readable per-board error), not blocked. The delete confirm names the
  boards using it (`boards_using`).
- **Admin vs manager split.** Connections (credentials) are admin-only; boards
  (manager) only reference them + browse (server-side, credentials never sent to
  the client). Browsing exposes file/dir names to a manager — the same exposure
  the local folder picker already has.
- **S3 has no dirs.** "Folders" are `Delimiter:"/"` prefixes; the browse modal
  treats CommonPrefixes as dirs. The `type:"file"|"dir"` entry shape hides this
  from the shared code.
- **Trigger modes.** File sources keep `continuous` available, but the modal
  defaults remote sources to `interval` and hints that continuous is a 30 s poll
  (there's no token bucket on file sources — the metering that gates connector
  feeds doesn't apply).
- **Phase-3 seed.** Wrap the backend `enumerate`/`admit`/`test` calls with
  `recordPluginHealth("source:<type>")` so a failing source surfaces its last
  error in the gear modal, mirroring connectors.
- **Naming.** `server/ingestion/sources/` (ingestion source backends) is distinct
  from `server/sources/` (media file handlers) — the path disambiguates; call
  them "ingestion sources" vs "media handlers" in comments.
