param(
  [switch]$RunLiveBrowser,
  [string]$EvidenceFile = ''
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

if (-not $env:A446_TEST_DATABASE_URL) {
  throw 'Release gate requires A446_TEST_DATABASE_URL pointing to a dedicated disposable PostgreSQL database.'
}

& (Join-Path $PSScriptRoot 'check-all.ps1') -RequirePostgres
if ($LASTEXITCODE -ne 0) {
  throw "check-all.ps1 -RequirePostgres failed with exit code $LASTEXITCODE."
}

if ($RunLiveBrowser) {
  Push-Location (Join-Path $ProjectRoot 'tests\e2e')
  try {
    & npm.cmd run test:live
    if ($LASTEXITCODE -ne 0) {
      throw "Live browser release E2E failed. Reproduce with: cd tests\e2e; npm.cmd run test:live"
    }
  } finally {
    Pop-Location
  }
}

if ($EvidenceFile) {
  $EvidencePath = (Resolve-Path -LiteralPath $EvidenceFile).Path
  & node (Join-Path $ProjectRoot 'tests\e2e\verify-release-evidence.mjs') $EvidencePath
  if ($LASTEXITCODE -ne 0) {
    throw "Release evidence validation failed for $EvidencePath."
  }
}

Write-Output 'Strict release gate passed.'
