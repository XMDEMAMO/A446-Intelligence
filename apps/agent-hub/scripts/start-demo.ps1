$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$NodePath = (Get-Command node -ErrorAction Stop).Source
$VarDir = Join-Path $ProjectRoot 'var'
$LogDir = Join-Path $VarDir 'process-logs'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null

$ExistingHub = $null
try {
  $ExistingHub = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1
} catch {
  $ExistingHub = $null
}
if ($ExistingHub.ok) {
  throw 'A Hub is already listening on http://127.0.0.1:8787. Stop it before starting the demo.'
}

function Start-AgentProcess([string]$Name, [string[]]$Arguments) {
  $quoted = $Arguments | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }
  Start-Process -FilePath $NodePath `
    -ArgumentList $quoted `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput (Join-Path $LogDir "$Name.out.log") `
    -RedirectStandardError (Join-Path $LogDir "$Name.err.log") `
    -WindowStyle Hidden `
    -PassThru
}

$Hub = Start-AgentProcess 'hub' @(
  (Join-Path $ProjectRoot 'src/mock-hub-cli.mjs'),
  '--config',
  (Join-Path $ProjectRoot 'config/hub.local.json')
)

$HubReady = $false
for ($Attempt = 0; $Attempt -lt 20; $Attempt++) {
  if ($Hub.HasExited) {
    throw "Hub exited during startup. Check $LogDir\hub.err.log."
  }
  try {
    $Health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/health' -TimeoutSec 1
    if ($Health.ok) {
      $HubReady = $true
      break
    }
  } catch {
    Start-Sleep -Milliseconds 150
  }
}
if (-not $HubReady) {
  Stop-Process -Id $Hub.Id -ErrorAction SilentlyContinue
  throw "Hub did not become healthy. Check $LogDir\hub.err.log."
}

$AgentA = Start-AgentProcess 'agent-a' @(
  (Join-Path $ProjectRoot 'src/worker-cli.mjs'),
  '--config',
  (Join-Path $ProjectRoot 'config/agent-a.mock.json')
)
$AgentB = Start-AgentProcess 'agent-b' @(
  (Join-Path $ProjectRoot 'src/worker-cli.mjs'),
  '--config',
  (Join-Path $ProjectRoot 'config/agent-b.mock.json')
)

@{
  projectRoot = $ProjectRoot
  processes = @(
    @{ name = 'hub'; pid = $Hub.Id; startedAt = $Hub.StartTime.ToUniversalTime().ToString('O') },
    @{ name = 'agent-a'; pid = $AgentA.Id; startedAt = $AgentA.StartTime.ToUniversalTime().ToString('O') },
    @{ name = 'agent-b'; pid = $AgentB.Id; startedAt = $AgentB.StartTime.ToUniversalTime().ToString('O') }
  )
} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $VarDir 'demo-pids.json') -Encoding UTF8

Write-Output "Demo healthy. Hub PID=$($Hub.Id), Agent A PID=$($AgentA.Id), Agent B PID=$($AgentB.Id)"
Write-Output "Loopback demo is unauthenticated unless HUB_TOKEN was already set in this shell."
Write-Output "Try: node src/hubctl.mjs send --agent agent-a --input 'hello' --route agent-b --wait"
Write-Output "Stop: ./scripts/stop-demo.ps1"
\n