[CmdletBinding()]
param([string]$OutputDirectory = '')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $RepoRoot 'apps\agent-hub'
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $RepoRoot 'releases' }
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path
$version = (Get-Content -LiteralPath (Join-Path $HubRoot 'package.json') -Raw | ConvertFrom-Json).version
$buildDate = (Get-Date).ToUniversalTime().ToString('yyyyMMdd')
$archivePath = Join-Path $OutputDirectory "A446-Worker-Windows-$version-$buildDate.zip"
if (Test-Path -LiteralPath $archivePath) { throw "Bundle already exists. Choose a new output directory: $archivePath" }
$stagingParent = Join-Path $HubRoot 'var\bundle-build'
New-Item -ItemType Directory -Path $stagingParent -Force | Out-Null
$stagingParent = (Resolve-Path -LiteralPath $stagingParent).Path
$stage = Join-Path $stagingParent ([guid]::NewGuid().ToString('N'))
$bundleRoot = Join-Path $stage 'A446-Worker-Windows'
New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
$utf8 = New-Object Text.UTF8Encoding($false)

function Copy-BundleFile {
  param([string]$RelativeSource, [string]$RelativeTarget = '')
  if (-not $RelativeTarget) { $RelativeTarget = $RelativeSource }
  $source = Join-Path $RepoRoot $RelativeSource
  $target = Join-Path $bundleRoot $RelativeTarget
  New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $target
}

try {
  # Only explicitly selected source trees and files enter the distributable.
  foreach ($tree in @('apps\agent-hub\src', 'apps\agent-hub\protocol', 'apps\agent-hub\test')) {
    $sourceTree = Join-Path $RepoRoot $tree
    foreach ($source in (Get-ChildItem -LiteralPath $sourceTree -File -Recurse)) {
      if ($source.Extension -notin @('.mjs', '.json')) { continue }
      $relative = $source.FullName.Substring($RepoRoot.Length + 1)
      Copy-BundleFile -RelativeSource $relative
    }
  }
  foreach ($relative in @(
    '启动规划执行Worker.cmd', '启动审核Worker.cmd', '启动预发布Worker.cmd',
    'scripts\start-staging-workers.ps1', 'scripts\run-staging-worker.ps1', 'scripts\bootstrap-worker-node.ps1',
    'apps\agent-hub\package.json', 'apps\agent-hub\package-lock.json',
    'apps\agent-hub\scripts\check-env.mjs',
    'apps\agent-hub\scripts\prepare-lan-device.mjs', 'apps\agent-hub\scripts\provider-probe.mjs',
    'apps\agent-hub\config\worker.codex.example.json', 'apps\agent-hub\config\worker.antigravity.example.json',
    'apps\agent-hub\docs\protocol-v1.md', 'apps\agent-hub\AI_IMPLEMENTATION_GUIDE.md'
  )) { Copy-BundleFile -RelativeSource $relative }
  Copy-BundleFile -RelativeSource 'docs\WINDOWS_DUAL_DEVICE_QUICKSTART.md' -RelativeTarget '使用说明.md'

  $sourceHead = [string](& git -C $RepoRoot rev-parse HEAD)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot identify source Git commit.' }
  $sourceChanges = @(& git -C $RepoRoot status --porcelain)
  if ($LASTEXITCODE -ne 0) { throw 'Cannot identify source working-tree status.' }
  $files = @(Get-ChildItem -LiteralPath $bundleRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($bundleRoot.Length + 1).Replace('\', '/')
      bytes = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    kind = 'dual-device-windows-worker-test-bundle'
    version = $version
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceCommit = $sourceHead.Trim()
    sourceWorkingTreeDirty = ($sourceChanges.Count -gt 0)
    files = $files
  }
  [IO.File]::WriteAllText((Join-Path $bundleRoot 'bundle-manifest.json'), ($manifest | ConvertTo-Json -Depth 8), $utf8)
  Compress-Archive -LiteralPath $bundleRoot -DestinationPath $archivePath -CompressionLevel Optimal
  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
  [IO.File]::WriteAllText(($archivePath + '.sha256'), ($hash + '  ' + [IO.Path]::GetFileName($archivePath) + "`r`n"), $utf8)
  Write-Output "Bundle: $archivePath"
  Write-Output "SHA-256: $hash"
  Write-Output "Source files: $($files.Count); source includes working-tree changes: $($manifest.sourceWorkingTreeDirty)"
} finally {
  $resolvedStage = (Resolve-Path -LiteralPath $stage).Path
  if (-not $resolvedStage.StartsWith($stagingParent + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Bundle cleanup target escaped its verified build directory.'
  }
  Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
