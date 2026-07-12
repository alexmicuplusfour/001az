# Deploy the 001az docker stack to the droplet.
#
# Builds the app + extractor images locally, ships them over SSH (docker save
# -> scp -> docker load; no registry involved), syncs the compose files, and
# restarts the stack. Postgres data, uploads, and TLS certs all live in named
# volumes on the droplet, so this only ever replaces code.
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
$appImage = "001az-app:$tag"
$extractorImage = "001az-extractor:$tag"

Write-Host "==> building $appImage" -ForegroundColor Cyan
docker build -t $appImage $here
if ($LASTEXITCODE) { exit $LASTEXITCODE }

Write-Host "==> building $extractorImage" -ForegroundColor Cyan
docker build -t $extractorImage (Join-Path $here "extractor")
if ($LASTEXITCODE) { exit $LASTEXITCODE }

# docker save to files instead of piping: PowerShell pipes are not byte-safe
# for binary streams.
$appTar = Join-Path $env:TEMP "001az-app.tar"
$extractorTar = Join-Path $env:TEMP "001az-extractor.tar"
Write-Host "==> saving images" -ForegroundColor Cyan
docker save -o $appTar $appImage
if ($LASTEXITCODE) { exit $LASTEXITCODE }
docker save -o $extractorTar $extractorImage
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Host ("    app {0:N0} MB  extractor {1:N0} MB" -f ((Get-Item $appTar).Length / 1MB), ((Get-Item $extractorTar).Length / 1MB))

Write-Host "==> uploading images + compose files" -ForegroundColor Cyan
& $scp[0] $scp[1..($scp.Length-1)] -C $appTar "${target}:/tmp/001az-app.tar"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $scp[0] $scp[1..($scp.Length-1)] -C $extractorTar "${target}:/tmp/001az-extractor.tar"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
& $scp[0] $scp[1..($scp.Length-1)] `
    (Join-Path $here "docker-compose.yml") `
    (Join-Path $here "docker-compose.prod.yml") `
    "${target}:$remoteDir/"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Remove-Item $appTar
Remove-Item $extractorTar

Write-Host "==> loading images + restarting stack" -ForegroundColor Cyan
$remote = @"
set -e
docker load -i /tmp/001az-app.tar && rm /tmp/001az-app.tar
docker load -i /tmp/001az-extractor.tar && rm /tmp/001az-extractor.tar
cd $remoteDir
grep -q '^APP_TAG=' .env && sed -i 's/^APP_TAG=.*/APP_TAG=$tag/' .env || echo 'APP_TAG=$tag' >> .env
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --wait app db extractor
docker image prune -f >/dev/null
docker images 001az-app --format '{{.Tag}}' | tail -n +4 | xargs -r -I{} docker rmi 001az-app:{}
docker images 001az-extractor --format '{{.Tag}}' | tail -n +4 | xargs -r -I{} docker rmi 001az-extractor:{}
echo '--- health ---'
curl -sf http://127.0.0.1:3001/api/health && echo
"@
& $ssh[0] $ssh[1..($ssh.Length-1)] $remote
if ($LASTEXITCODE) { Write-Host "deploy FAILED" -ForegroundColor Red; exit $LASTEXITCODE }

Write-Host "`ndeployed $appImage + $extractorImage" -ForegroundColor Green
if ($cfg.site) { Write-Host "live at $($cfg.site)" }
