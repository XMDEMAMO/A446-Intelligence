[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$Label,
  [Parameter(Mandatory = $true)][string]$TokenEnvironment
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $RepoRoot 'apps\agent-hub'
$resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path

try {
  $Host.UI.RawUI.WindowTitle = "A446 Worker - $Label"
} catch {}

if (-not [Environment]::GetEnvironmentVariable($TokenEnvironment, 'Process')) {
  throw "Worker Token environment is missing: $TokenEnvironment"
}

$config = Get-Content -LiteralPath $resolvedConfig -Raw | ConvertFrom-Json
if ([string]$config.authTokenEnv -ne $TokenEnvironment) {
  throw 'Worker configuration and Token environment do not match.'
}

Write-Host "A446 Worker: $Label" -ForegroundColor Cyan
Write-Host "Agent ID: $($config.agentId)"
Write-Host "Device ID: $($config.deviceId)"
Write-Host "Hub: $($config.hubUrl)"
Write-Host '保持此窗口打开；按 Ctrl+C 或关闭窗口可停止该 Worker。'
Write-Host ''

Push-Location $HubRoot
try {
  & node 'src/worker-cli.mjs' --config $resolvedConfig
  if ($LASTEXITCODE -ne 0) {
    throw "Worker exited with code $LASTEXITCODE."
  }
} catch {
  Write-Host "`nWorker 运行失败：$($_.Exception.Message)" -ForegroundColor Red
} finally {
  Remove-Item "Env:$TokenEnvironment" -ErrorAction SilentlyContinue
  Pop-Location
}

Write-Host ''
[void](Read-Host 'Worker 已停止，按 Enter 关闭窗口')
