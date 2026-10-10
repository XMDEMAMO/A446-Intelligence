param(
  [string]$Source = '',
  [string]$Home = ''
)

$ErrorActionPreference = 'Stop'

if (-not $Source) { $Source = $PSScriptRoot }
if (-not $Home) {
  if (-not $env:LOCALAPPDATA) { throw 'LOCALAPPDATA is required to determine the updater home.' }
  $Home = Join-Path $env:LOCALAPPDATA 'A446-Updater'
}

$entry = Join-Path $Source 'a446-updater.mjs'
if (-not (Test-Path -LiteralPath $entry)) { throw "Updater entry not found: $entry" }

New-Item -ItemType Directory -Path (Join-Path $Home 'lib') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Home 'logs') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $Home 'jobs') -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $Source 'a446-updater.mjs') -Destination $Home -Force
Copy-Item -LiteralPath (Join-Path $Source '*.mjs') -Path (Join-Path $Home 'lib') -Force -ErrorAction SilentlyContinue
Get-ChildItem -LiteralPath (Join-Path $Source 'lib') -Filter '*.mjs' -File | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Home 'lib') -Force
}

# Preserve existing config.json / state.json: the installer only refreshes code.
Write-Output "UPDATER_HOME=$Home"
Write-Output "ENTRY=$(Join-Path $Home 'a446-updater.mjs')"
Write-Output 'Next steps:'
Write-Output "  node `"$Home\a446-updater.mjs`" adopt --live <A446 package path> --role coordinator|worker"
