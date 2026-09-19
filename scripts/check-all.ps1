param(
  [switch]$RequirePostgres
)

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

function Invoke-ProjectStep {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [Parameter(Mandatory = $true)][string]$Reproduce
  )
  Write-Output $Name
  try {
    & $Action
  } catch {
    Write-Error "$Name failed. Reproduce with: $Reproduce`n$($_.Exception.Message)"
  }
}

Invoke-ProjectStep -Name 'Running Hub tests...' -Reproduce 'cd apps\agent-hub; npm.cmd test' -Action {
  Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\agent-hub') -Arguments @('test')
}

Invoke-ProjectStep -Name 'Checking PostgreSQL Server Hub package...' -Reproduce 'cd apps\server-hub; npm.cmd run check' -Action {
  Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\server-hub') -Arguments @('run', 'check')
}

Invoke-ProjectStep -Name 'Running web lint...' -Reproduce 'cd apps\web; npm.cmd run lint' -Action {
  Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\web') -Arguments @('run', 'lint')
}

Invoke-ProjectStep -Name 'Building web production bundle...' -Reproduce 'cd apps\web; npm.cmd run build' -Action {
  Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\web') -Arguments @('run', 'build')
}

Invoke-ProjectStep -Name 'Running combined end-to-end smoke test...' -Reproduce 'powershell -ExecutionPolicy Bypass -File scripts\smoke-e2e.ps1' -Action {
  & (Join-Path $ProjectRoot 'scripts\smoke-e2e.ps1')
}

Invoke-ProjectStep -Name 'Installing locked browser E2E dependencies...' -Reproduce 'cd tests\e2e; npm.cmd ci --ignore-scripts' -Action {
  Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'tests\e2e') -Arguments @('ci', '--ignore-scripts')
}

Invoke-ProjectStep -Name 'Running browser contract E2E...' -Reproduce 'cd tests\e2e; npm.cmd test' -Action {
  Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'tests\e2e') -Arguments @('test')
}

foreach ($Package in @('apps\agent-hub', 'apps\server-hub', 'apps\web')) {
  $PackagePath = Join-Path $ProjectRoot $Package
  Invoke-ProjectStep -Name "Auditing production dependencies in $Package..." -Reproduce "cd $Package; npm.cmd audit --omit=dev" -Action {
    Invoke-NpmStep -WorkingDirectory $PackagePath -Arguments @('audit', '--omit=dev')
  }
}

if ($env:A446_TEST_DATABASE_URL) {
  Invoke-ProjectStep -Name 'Running dedicated PostgreSQL acceptance tests...' -Reproduce 'cd apps\server-hub; npm.cmd run test:postgres' -Action {
    Invoke-NpmStep -WorkingDirectory (Join-Path $ProjectRoot 'apps\server-hub') -Arguments @('run', 'test:postgres')
  }
} elseif ($RequirePostgres) {
  throw 'PostgreSQL release gate failed: A446_TEST_DATABASE_URL is not set. Use a dedicated disposable database; never use production.'
} else {
  Write-Warning 'PostgreSQL acceptance was not run because A446_TEST_DATABASE_URL is not set. This check-all result is not a release approval. Reproduce after setting a dedicated disposable test database: cd apps\server-hub; npm.cmd run test:postgres'
}

if ($env:A446_TEST_DATABASE_URL) {
  Write-Output 'All project checks passed, including dedicated PostgreSQL acceptance.'
} else {
  Write-Output 'All non-PostgreSQL project checks passed. This result is not a release approval.'
}
