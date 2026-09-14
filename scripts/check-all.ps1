$ErrorActionPreference = 'Stop'

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Invoke-NpmStep {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  Push-Location $WorkingDirectory
  try {
    & npm.cmd @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "npm.cmd $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

Write-Output 'Running Hub tests...'
Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\agent-hub') -Arguments @('test')

Write-Output 'Running web lint...'
Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\web') -Arguments @('run', 'lint')

Write-Output 'Building web production bundle...'
Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\web') -Arguments @('run', 'build')

Write-Output 'Running combined end-to-end smoke test...'
& (Join-Path $ProjectRoot 'scripts\smoke-e2e.ps1')

Write-Output 'All project checks passed.'
