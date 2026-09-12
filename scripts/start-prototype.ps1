$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $ProjectRoot 'apps\agent-hub'
$WebRoot = Join-Path $ProjectRoot 'apps\web'
$StartedHub = $false

if (-not (Test-Path (Join-Path $HubRoot 'node_modules\ws'))) {
  throw 'Hub dependencies are missing. Run npm.cmd ci --ignore-scripts in apps\agent-hub.'
}

if (-not (Test-Path (Join-Path $WebRoot 'node_modules'))) {
  throw 'Web dependencies are missing. Run npm.cmd ci in apps\web.'
}

$ExistingHub = $null
try {
  $ExistingHub = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1
} catch {
  $ExistingHub = $null
}
if ($ExistingHub.ok) {
  Write-Output 'Port 8787 is already in use. The prototype will use the existing Hub.'
} else {
  & (Join-Path $HubRoot 'scripts\start-demo.ps1')
  $StartedHub = $true
}

try {
  Push-Location $WebRoot
  Write-Output 'Opening A446 Intelligence at http://127.0.0.1:5173'
  npm.cmd run dev -- --host 127.0.0.1
} finally {
  Pop-Location
  if ($StartedHub) {
    & (Join-Path $HubRoot 'scripts\stop-demo.ps1')
  }
}
\n