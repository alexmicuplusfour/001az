# Prebuilt images — GitHub builds on push, GHCR serves the pulls (2026-09-02)

**Status: COMPLETE — all three stages shipped 2026-09-02 (Stage 1 in 99616f7,
Stages 2+3 same day; see the addendum at the bottom for what implementation
taught the design). Written the day the repo went public (bd019d8), which is
what makes all of this free.**
Self-contained for a fresh session. Design agreed in-session 2026-09-02;
the sidecar-presence plan named prebuilt images its one deferred adoption win
("would turn the remaining ~3GB build into a ~2-minute pull — after this
plan, not inside it"). This is that plan.

## Why now

A stranger's `git clone && docker compose up -d` builds the base stack from
scratch (~3.5GB of images) and, with both engines opted in, ~7.3GB — a
20–30 minute wall before the first screen. Every one of those images is
deterministic from the repo at a given sha; strangers are all building the
same bytes. GitHub should build them once, on push, and everyone pulls.

Going public flipped every constraint that used to make this awkward:

- **GHCR public packages: free, no storage or transfer caps.** (Private
  packages cap at 500MB storage / 1GB-a-month transfer on the free plan with
  a $0 spending limit — pushes would simply have failed. This is why the
  plan waited for the visibility flip.)
- **Actions minutes: unlimited on public repos** (private: 2,000/month).
- **Anonymous pulls.** Nobody — stranger or droplet — needs a token to pull
  a public package.
- Native arm64 runners (`ubuntu-24.04-arm`) are free on public repos —
  multi-arch without QEMU, if ever wanted (non-goal below).

## Facts the design rests on

Verified in-session or from the repo; the open questions are marked as such.

- Four images, one per service, named like the local builds: `001az-app`,
  `001az-extractor`, `001az-transcriber`, `001az-object-detector` → GHCR as
  `ghcr.io/alexmicuplusfour/001az-<service>` (owner already lowercase, which
  GHCR requires).
- Image weights: app 2.64GB, extractor 431MB, transcriber 1.21GB,
  object-detector 3.0GB. One runner per image (matrix) sidesteps the
  ~14GB-free runner disk; the detector is the only one that might need a
  free-disk-space step (contingency, not default).
- Model bakes are BUILD args with defaults: `WHISPER_MODEL=small`,
  `BAKE_MODELS=` (just the default), `OBJECT_DETECTOR_MODEL=llmdet_tiny`.
  Published images = defaults. A host baking differently (e.g. the author's
  local `BAKE_MODELS=small,medium`) builds locally, exactly as today —
  compose keeps `build:` either way.
- [.dockerignore](../.dockerignore) excludes docs/compose/test/scripts from
  the app context, so the app image's real inputs are: `server/`, `public/`,
  `examples/`, `package.json`, `package-lock.json`, `Dockerfile`. Those are
  the path filters. Sidecars: their own directory each.
- [ci.yml](../.github/workflows/ci.yml) has a `build` job that smoke-builds
  only the app under the stale name `inspo-gallery`, tags nothing, pushes
  nothing. Superseded by this workflow; delete it.
- `GITHUB_TOKEN` with `packages: write` pushes to GHCR from Actions — no PAT.
- Cold-build estimates (2-vCPU runner): extractor ~3min, app ~8
  (npm ci + the ~90MB embedder pre-download), transcriber ~12 (whisper +
  diarization model downloads), detector ~15 (torch CPU wheel + HF model).
  Warm (layer cache): minutes each, since model layers rarely bust.
- GH Actions cache is 10GB/repo, LRU-evicted. All four caches don't fit
  together with torch in the mix; accepted — the heavy images change rarely,
  so their cold rebuilds are infrequent by construction (path filters).

## Stage 1 — images.yml: build on push, publish to GHCR

New workflow, `.github/workflows/images.yml`:

- **Trigger:** `push` to `main` + `workflow_dispatch` (manual catch-up /
  first run). No PR trigger — this repo doesn't do PRs, and CI's test job
  already guards main.
- **Change detection:** first job runs `dorny/paths-filter` with the four
  path sets above (plus the workflow file itself → rebuild everything);
  its JSON output feeds the build job's matrix via `fromJSON`, so a
  docs-only push builds nothing and a server/ push builds only the app.
- **Build job (matrix over affected images):** `docker/setup-buildx-action`,
  `docker/login-action` (ghcr.io + `GITHUB_TOKEN`),
  `docker/metadata-action` for tags, `docker/build-push-action` with
  `cache-from/to: type=gha, scope=<image>`, `push: true`.
- **Tags:** `latest` + `sha-<shortsha>`. The sha tag is the rollback /
  pinning currency (same philosophy as the deploy's timestamp-sha tags);
  `latest` is the stranger-facing default.
- **Concurrency:** group `images-${{ github.ref }}`, cancel-in-progress —
  a superseded push stops building; registry pushes are atomic at the end
  of a build, so cancellation never half-publishes.
- **permissions:** `contents: read, packages: write` — nothing else.
- **ci.yml:** delete the stale `build` job in the same commit.

Verification: push a server/-only change → exactly one build runs, both
tags appear under the repo's Packages; `docker pull
ghcr.io/alexmicuplusfour/001az-app:latest` succeeds anonymously from any
machine; a sidecar-dir change builds only that sidecar; a docs-only push
builds nothing.

## Stage 2 — strangers pull instead of building

The adoption payoff, and it needs ONE measured answer first.

**Open question (measure, don't assume):** compose behavior when a service
has BOTH `image:` and `build:`. The spec suggests build is the default
resolution when both are present, with `pull_policy` modulating. The
experiment: set `image: ghcr.io/...:latest` + `build:` on a service, then
on a machine without the image run plain `up`, `up --build`, and
`pull_policy: missing` variants, and record which pulls and which builds.
The outcome decides between:

- **(a) both keys in the base file** — fresh clone pulls by default,
  `--build` still works for hackers; one file, zero docs. Best if the
  semantics cooperate.
- **(b) docs-only** — README says `docker compose up` (builds) or pull
  first; zero file changes.

Whichever lands, the model-bake caveat travels with it: published engine
images carry default bakes; custom bakes remain a local build.

Also in this stage: the README (when it grows back past "work in progress")
documents the pull path as the quickstart default.

## Stage 3 — the deploy pulls too (optional, biggest personal payoff)

deploy.ps1's save→scp→load pipeline exists because there was no registry.
With GHCR serving anonymously:

- deploy pins `APP_TAG` to the pushed commit's `sha-<shortsha>` tag and the
  droplet does `docker compose pull` — the entire shipping half of the
  script (digest comparison, tar, scp, load, retag) deletes. The prod
  override's `pull_policy: never` flips to the default.
- Sequencing: a deploy right after a push must wait for Actions to finish
  (`gh run watch` or poll the package). Or keep the local-build path as the
  fallback for offline/urgent deploys — decide when implementing.
- `exclude` semantics (what a host runs) are untouched — profiles and the
  stamped `COMPOSE_PROFILES` already carry that; only the transport changes.

This stage is deliberately optional and last: the current deploy works, and
Stages 1+2 deliver the public value without touching it.

## Non-goals / open questions

- **Multi-arch (arm64).** Free native arm runners make it a real option
  (Apple-silicon strangers currently run amd64 images under emulation —
  workable for the app, painful for torch). Needs a per-arch matrix +
  `buildx imagetools` manifest merge. Do it if anyone actually asks.
- **Tag retention.** Public storage is free but sha tags accumulate
  forever; an optional monthly `delete-package-versions` workflow (keep
  newest N) is hygiene, not necessity.
- **Release tags** (`v1`, semver) — meaningless until the project versions
  itself; `latest` + sha is enough for a WIP repo.
- **Build-time model downloads** (HF, GitHub releases) make image builds
  network-dependent; a flaky upstream fails a build. Accepted — retry is
  `workflow_dispatch`, and the bake-at-build design is load-bearing
  (offline runtime, healthcheck-verified models) per the transcriber's
  Dockerfile comments.

## Addendum — what implementation taught the design (2026-09-02, same day)

**Stage 2's experiment (compose v5.1.4, measured):** with BOTH `image:` and
`build:` and NO `pull_policy` — image absent → plain `up` PULLS (the feared
build-by-default never happened); image present → reused, no network;
`up --build` → builds and tags the result under the image name; a local
build is never clobbered by a later plain `up`. So option (a) landed in its
simplest form: four `image: ghcr.io/...:latest` lines, nothing else.
Verified live: the author's stack recreated under the GHCR names from LOCAL
builds, custom transcriber bake intact (/health reports small+medium).

**Stage 1 had a correctness hole, fixed before Stage 3 could stand on it:**
path-filtered builds mean each image's newest `sha-` tag differs, so no
single APP_TAG existed to pin — and diffing against `event.before` silently
skips a cancelled/failed run's changes (push A cancelled by push B → B's
diff never contains A's files). images.yml v2: the diff base is the LAST
GREEN run's head sha (`gh run list --status success`, `actions: read`
permission; no base found → build everything), change detection is plain
`git diff` in a script (dorny/paths-filter dropped — one less third-party
action), and a `retag` job stamps this commit's sha tag onto every image it
did NOT rebuild via `docker buildx imagetools create` from `:latest`
(manifest-only, no rebuild). Invariant: EVERY green run leaves all four
images addressable at `sha-<short of its commit>`.

**Stage 3 (deploy.ps1 rewritten, local-only file):** build/digest-compare/
save/scp/load all deleted — the deploy verifies HEAD == origin/main (push
first), waits for that commit's Images run to go green, uploads the compose
files, stamps `APP_TAG=sha-<short>` + COMPOSE_PROFILES, `compose pull`,
`up -d --wait`, then prunes: excluded repos to zero tags, the pre-GHCR
legacy image names to zero (one-time disk reclaim, idempotent), deployed
repos keep two tags. Rollback = `.\deploy.ps1 -Sha <short>` for any green
commit. SEMANTICS CHANGE, deliberate: the deploy ships the PUSHED commit,
never the working tree — a dirty tree gets a warning, an unpushed HEAD a
refusal. The old script survives in git history before ca03cf2.

**Not yet exercised:** the first real pull-deploy to the droplet (downloads
a full generation, ~3.1GB for its app+extractor set — no shared layers with
the locally-built images it replaces; 13G free, fits) and the path-filter
skip/retag behavior on a natural docs-only push. Both prove themselves on
next use.
