$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$StopScript = Join-Path $ProjectRoot 'apps\agent-hub\scripts\stop-demo.ps1'

if (Test-Path $StopScript) {
  & $StopScript
}
