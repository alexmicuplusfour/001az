# Deploy the 001az docker stack to the droplet.
#
# Builds the app + sidecar images (extractor, transcriber, object-detector)
# locally, ships the ones the droplet does not already hold over SSH (docker
# save -> scp -> docker load; no registry involved), syncs the compose files,
# and restarts the stack. Postgres data, uploads, and TLS certs all live in
# named volumes on the droplet, so this only ever replaces code.
#
# Connection settings live in deploy.local.json (gitignored) next to this file:
# { "host": "1.2.3.4", "user": "root", "key": "~/.ssh/deploy_key",
#   "remotedir": "/opt/001az", "site": "https://001.itsalex.me",
#   "exclude": ["transcriber", "object-detector"] }
#
# "exclude" names sidecars this particular host does not run — a small droplet
# has no business carrying a 3G detection model it will never use. Excluded
# services are not built, not shipped, and not started; their containers and
# images are removed from the host. The app degrades to whatever the excluded
# capability's other providers offer (the on-server sidecars are its keyless
# floor, so with one gone that capability needs a configured provider).
#
# WHICH services a host runs is a property of the host, so the list lives here
# rather than in the tracked compose files. That a sidecar CAN be left out is a
# property of the stack, and lives where it belongs: the two heavy ones carry
# compose profiles. The two mechanisms are complementary — profiles decide what
# a bare `docker compose up` starts, this list decides what a deploy builds,
# ships and starts — and the deploy keeps them in step by stamping the derived
# COMPOSE_PROFILES into the droplet's .env beside APP_TAG.
#
# Usage:  .\deploy.ps1
#         .\deploy.ps1 -Exclude transcriber   (adds to the config list, one run)

param(
    # Extra services to leave out of this run, on top of deploy.local.json's
    # "exclude". Same meaning: not built, not shipped, container removed.
    # PowerShell wants a literal here, so this is the one place the roster is
    # spelled twice — $services below is the other, and the only one code reads.
    [ValidateSet("app", "extractor", "transcriber", "object-detector")]
    [string[]]$Exclude = @()
)

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

$cfg = Get-Content (Join-Path $here "deploy.local.json") | ConvertFrom-Json
$excluded = [string[]](@($cfg.exclude) + $Exclude | Where-Object { $_ } | Select-Object -Unique)
function Test-Excluded([string]$service) { return $excluded -contains $service }
if ($excluded) { Write-Host "==> not on this host: $($excluded -join ', ')" -ForegroundColor Yellow }
$sshKey = [Environment]::ExpandEnvironmentVariables($cfg.key) -replace "^~", $env:USERPROFILE
$target = "$($cfg.user)@$($cfg.host)"
$remoteDir = $cfg.remotedir
$ssh = @("ssh", "-i", $sshKey, $target)
$scp = @("scp", "-i", $sshKey)

function Invoke-Remote([string]$script, [string]$failure = "remote command failed") {
    & $ssh[0] $ssh[1..($ssh.Length-1)] $script
    if ($LASTEXITCODE) { Write-Host $failure -ForegroundColor Red; exit $LASTEXITCODE }
}

# Tag = timestamp + short git sha so every deploy is identifiable and rollback
# is just re-pointing APP_TAG at a previous image.
$sha = (git -C $here rev-parse --short HEAD 2>$null); if (-not $sha) { $sha = "nogit" }
$tag = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $sha
# The whisper model is baked into the transcriber image at build time (see
# transcriber/Dockerfile). The default matches docker-compose.yml's and
# .env.example's — one knob, one answer, however the stack is started (this
# script used to say "base" while both of those said "small"). Nothing needs
# syncing on the droplet: the sidecar tells the app which model it runs, so
# the rest of the system follows this choice.
$whisperModel = if ($env:WHISPER_MODEL) { $env:WHISPER_MODEL } else { "small" }
# LLMDet is baked into the object-detector image at build (see
# object-detector/Dockerfile). $env:OBJECT_DETECTOR_MODEL overrides the default;
# nothing needs syncing on the droplet — the sidecar names its own model.
$objectDetectorModel = if ($env:OBJECT_DETECTOR_MODEL) { $env:OBJECT_DETECTOR_MODEL } else { "iSEE-Laboratory/llmdet_tiny" }

# The roster, once: every stage below (build, ship, compose up, prune, the
# closing summary) reads THIS, so a fifth sidecar is one row plus its name in
# the ValidateSet above. Repo and Image are derived from Service rather than
# typed, so the naming rule is stated once too.
# `Profile` is the compose profile that gates the service (null = always in
# the base stack) — what the stamped COMPOSE_PROFILES is derived from.
$services = @(
    [pscustomobject]@{ Service = "app"; Context = $here; BuildArgs = @(); Note = $null; Profile = $null }
    [pscustomobject]@{ Service = "extractor"; Context = (Join-Path $here "extractor"); BuildArgs = @(); Note = $null; Profile = $null }
    [pscustomobject]@{ Service = "transcriber"; Context = (Join-Path $here "transcriber"); Profile = "transcribe"
        BuildArgs = @("--build-arg", "WHISPER_MODEL=$whisperModel"); Note = "WHISPER_MODEL=$whisperModel" }
    [pscustomobject]@{ Service = "object-detector"; Context = (Join-Path $here "object-detector"); Profile = "detect"
        BuildArgs = @("--build-arg", "OBJECT_DETECTOR_MODEL=$objectDetectorModel"); Note = "OBJECT_DETECTOR_MODEL=$objectDetectorModel" }
)
foreach ($s in $services) {
    Add-Member -InputObject $s -NotePropertyName Repo -NotePropertyValue "001az-$($s.Service)"
    Add-Member -InputObject $s -NotePropertyName Image -NotePropertyValue "001az-$($s.Service):$tag"
}
$builds = @($services | Where-Object { -not (Test-Excluded $_.Service) })
if (-not $builds) { Write-Host "everything is excluded — nothing to deploy" -ForegroundColor Red; exit 1 }

foreach ($b in $builds) {
    Write-Host ("==> building $($b.Image)" + $(if ($b.Note) { " ($($b.Note))" })) -ForegroundColor Cyan
    $argv = @("build") + $b.BuildArgs + @("-t", $b.Image, $b.Context)
    docker @argv
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
}

# The droplet has a 24G disk and a full generation of these images is ~7G, so
# it cannot hold the running generation, an incoming one, and four tars at
# once — that is how deploys ran it out of space. Two things keep it in budget:
# an image whose content the droplet already has is retagged in place rather
# than re-shipped (only the app image usually changes), and the ones that do
# ship go one at a time, each tar deleted the moment it is loaded.
#
# Image IDs are content digests, identical on both hosts for identical builds,
# so they say whether the droplet already holds this exact image.
Write-Host "==> checking what the droplet already has" -ForegroundColor Cyan
$remoteLines = & $ssh[0] $ssh[1..($ssh.Length-1)] "docker images --no-trunc --format '{{.ID}} {{.Repository}}:{{.Tag}}'; df -h / | tail -1"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$remoteHas = @{}
foreach ($line in $remoteLines) {
    # A dangling image carries the content but no name to retag from, so it is
    # no use here even though its ID would match.
    if ($line -match '^(sha256:\S+)\s+(\S+)$' -and $Matches[2] -notlike "*<none>*" `
        -and -not $remoteHas.ContainsKey($Matches[1])) {
        $remoteHas[$Matches[1]] = $Matches[2]
    }
    if ($line -match '^/dev/') { Write-Host "    droplet disk: $line" }
}

# Retags are collected rather than issued here: they are three trivial commands
# that only need to land before the `up`, and one round trip beats one SSH
# handshake apiece.
$retags = @()
foreach ($b in $builds) {
    $localId = (docker image inspect --format '{{.Id}}' $b.Image)
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    if ($remoteHas.ContainsKey($localId)) {
        Write-Host "==> $($b.Repo): unchanged, retagging on the droplet" -ForegroundColor DarkGray
        $retags += "docker tag '$($remoteHas[$localId])' '$($b.Image)'"
        continue
    }
    # docker save to a file instead of piping: PowerShell pipes are not
    # byte-safe for binary streams.
    $tar = Join-Path $env:TEMP "$($b.Repo).tar"
    Write-Host "==> shipping $($b.Image)" -ForegroundColor Cyan
    docker save -o $tar $b.Image
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    Write-Host ("    {0:N0} MB" -f ((Get-Item $tar).Length / 1MB))
    & $scp[0] $scp[1..($scp.Length-1)] -C $tar "${target}:/tmp/$($b.Repo).tar"
    if ($LASTEXITCODE) { Remove-Item $tar; exit $LASTEXITCODE }
    Remove-Item $tar
    # load and rm on separate lines: joined by && a failed load is exempt from
    # set -e, which once let a half-loaded image through as a successful deploy.
    Invoke-Remote @"
set -e
docker load -i /tmp/$($b.Repo).tar
rm -f /tmp/$($b.Repo).tar
"@ "loading $($b.Repo) FAILED"
}

Write-Host "==> uploading compose files" -ForegroundColor Cyan
& $scp[0] $scp[1..($scp.Length-1)] `
    (Join-Path $here "docker-compose.yml") `
    (Join-Path $here "docker-compose.prod.yml") `
    "${target}:$remoteDir/"
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$compose = "docker compose -f docker-compose.yml -f docker-compose.prod.yml"
# One shell function for "drop these tags", emitted once and called twice
# below: an excluded repo loses every tag, a deployed one keeps the newest.
# Tags embed yyyyMMdd-HHmmss, so lexical sort -r = newest first. Do NOT trust
# docker images' own ordering: it sorts by image creation time, and fully
# cache-hit rebuilds (e.g. the extractor) all share one timestamp, making the
# order arbitrary — it once put the just-deployed tag in the "old" tail.
# Cleanup is best-effort; an in-use image must not fail the deploy.
$dropTags = @"
drop_tags() { # <repo> <keep-newest-count>
  docker images "`$1" --format '{{.Tag}}' | sort -r | tail -n +`$((`$2 + 1)) \
    | xargs -r -I{} docker rmi "`$1:{}" || true
}
"@

# An excluded service leaves for good: container stopped and removed, every tag
# of its image dropped. Idempotent, so a host that never ran it is untouched
# and one that did gets its disk back on the next deploy.
$dropExcluded = ($services | Where-Object { Test-Excluded $_.Service } | ForEach-Object {
    @"
$compose rm -sfv $($_.Service) >/dev/null 2>&1 || true
drop_tags $($_.Repo) 0
"@
}) -join "`n"

# Excluded repos are gone entirely (above); the rest keep exactly one tag. This
# drops one-command rollback — to roll back, re-deploy the previous git sha.
$pruneOld = ($builds | ForEach-Object { "drop_tags $($_.Repo) 1" }) -join "`n"

# Naming services explicitly starts them whatever their profile says (profiles
# gate the DEFAULT set, not addressability), so this list is the whole truth
# about what a deploy runs — and it is also what keeps the compose `caddy`
# service out of prod, where the host's own Caddy owns 80/443. db rides along
# rather than in a pass of its own: the app's depends_on still names it,
# so compose starts it first.
$rest = "db " + (($builds.Service) -join " ")

# …and the same answer in the form a BARE compose command reads, so an
# operator on the host starts exactly what the deploy does. Without this the
# two could disagree on a host excluding only one sidecar: the deploy would
# start the other (named explicitly), a bare `up` would not (its profile
# unmentioned). Empty value = neither engine, which is a valid answer.
$profiles = (($builds | ForEach-Object { $_.Profile } | Where-Object { $_ }) -join ",")

Write-Host "==> restarting stack ($rest)" -ForegroundColor Cyan
$remote = @"
set -e
cd $remoteDir
$dropTags
$($retags -join "`n")
$dropExcluded
set_env() { # <key> <value> — idempotent, and an empty value is a real answer
  grep -q "^`$1=" .env && sed -i "s|^`$1=.*|`$1=`$2|" .env || echo "`$1=`$2" >> .env
}
set_env APP_TAG $tag
set_env COMPOSE_PROFILES '$profiles'
# Ingestion drop root (compose binds ./ingest-root -> /data/ingest). Created
# here with open write perms so files can land via scp/sftp as any user —
# left to docker it appears root-owned 755 on first up.
mkdir -p ingest-root && chmod 777 ingest-root
$compose up -d --wait $rest
docker image prune -f >/dev/null
$pruneOld
echo '--- disk ---'
df -h / | tail -1
echo '--- health ---'
curl -sf http://127.0.0.1:3001/api/health && echo
"@
Invoke-Remote $remote "deploy FAILED"

Write-Host "`ndeployed $(($builds.Image) -join ' + ')" -ForegroundColor Green
if ($excluded) { Write-Host "not running here: $($excluded -join ', ')" -ForegroundColor Yellow }
if ($cfg.site) { Write-Host "live at $($cfg.site)" }
