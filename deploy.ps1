# Deploy the 001az docker stack to the droplet.
#
# Builds the app image locally, ships it over SSH (docker save -> scp -> docker
# load; no registry involved), syncs the compose files, and restarts the stack.
# Postgres data, uploads, and TLS certs all live in named volumes on the
# droplet, so this only ever replaces code.
#
# Connection settings live in deploy.local.json (gitignored) next to this file:
# { "host": "1.2.3.4", "user": "root", "key": "~/.ssh/deploy_key",
#   "remotedir": "/opt/001az", "site": "https://001.itsalex.me" }
#
# Usage:  .\deploy.ps1

$ErrorActionPreference = "Stop"
$here = $PSScriptRoot

$cfg = Get-Content (Join-Path $here "deploy.local.json") | ConvertFrom-Json
$sshKey = [Environment]::ExpandEnvironmentVariables($cfg.key) -replace "^~", $env:USERPROFILE
$target = "$($cfg.user)@$($cfg.host)"
$remoteDir = $cfg.remotedir
$ssh = @("ssh", "-i", $sshKey, $target)
$scp = @("scp", "-i", $sshKey)

# Tag = timestamp + short git sha so every deploy is identifiable and rollback
# is just re-pointing APP_TAG at a previous image.
$sha = (git -C $here rev-parse --short HEAD 2>$null); if (-not $sha) { $sha = "nogit" }
$tag = "{0}-{1}" -f (Get-Date -Format "yyyyMMdd-HHmmss"), $sha
$image = "001az-app:$tag"

Write-Host "==> building $image" -ForegroundColor Cyan
docker build -t $image $here
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# docker save to a file instead of piping: PowerShell pipes are not
# byte-safe for binary streams.
$tarball = Join-Path $env:TEMP "001az-app.tar"
Write-Host "==> saving image" -ForegroundColor Cyan
docker save -o $tarball $image
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Host ("    {0:N0} MB" -f ((Get-Item $tarball).Length / 1MB))

Write-Host "==> uploading image + compose files" -ForegroundColor Cyan
& $scp[0] $scp[1..($scp.Length-1)] -C $tarball "${target}:/tmp/001az-app.tar"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $scp[0] $scp[1..($scp.Length-1)] `
    (Join-Path $here "docker-compose.yml") `
    (Join-Path $here "docker-compose.prod.yml") `
    "${target}:$remoteDir/"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item $tarball

Write-Host "==> loading image + restarting stack" -ForegroundColor Cyan
$remote = @"
set -e
docker load -i /tmp/001az-app.tar && rm /tmp/001az-app.tar
cd $remoteDir
grep -q '^APP_TAG=' .env && sed -i 's/^APP_TAG=.*/APP_TAG=$tag/' .env || echo 'APP_TAG=$tag' >> .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait app db
docker image prune -f >/dev/null
docker images 001az-app --format '{{.Tag}}' | tail -n +4 | xargs -r -I{} docker rmi 001az-app:{}
echo '--- health ---'
curl -sf http://127.0.0.1:3001/api/health && echo
"@
& $ssh[0] $ssh[1..($ssh.Length-1)] $remote
if ($LASTEXITCODE) { Write-Host "deploy FAILED" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "`ndeployed $image" -ForegroundColor Green
if ($cfg.site) { Write-Host "live at $($cfg.site)" }
