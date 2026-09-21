param(
  [string]$Version = 'v0.5.0-preview1',
  [string]$Date = '20260919'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$ReleaseRoot = Join-Path $ProjectRoot 'releases'
$PackageName = "A446-MultiDevice-LAN-$Version-$Date"
$ZipPath = Join-Path $ReleaseRoot "$PackageName.zip"
$HashPath = "$ZipPath.sha256"

if (Test-Path -LiteralPath $ZipPath) { throw "Refusing to overwrite existing package: $ZipPath" }
if (Test-Path -LiteralPath $HashPath) { throw "Refusing to overwrite existing hash file: $HashPath" }

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) "a446-lan-package-$([Guid]::NewGuid().ToString('N'))"
$stagingRoot = Join-Path $temporaryRoot $PackageName
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

function Copy-SourceItem {
  param([Parameter(Mandatory = $true)][string]$RelativePath)
  $source = Join-Path $ProjectRoot $RelativePath
  if (-not (Test-Path -LiteralPath $source)) { throw "Package source is missing: $RelativePath" }
  $destination = Join-Path $stagingRoot $RelativePath
  New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
  Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
}

function Assert-SafeTemporaryRoot {
  $resolvedTemp = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\')
  $resolvedTarget = [System.IO.Path]::GetFullPath($temporaryRoot).TrimEnd('\')
  if (-not $resolvedTarget.StartsWith("$resolvedTemp\a446-lan-package-", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Unsafe temporary cleanup target: $resolvedTarget"
  }
}

try {
  New-Item -ItemType Directory -Path $ReleaseRoot -Force | Out-Null
  foreach ($relative in @(
    'START-A446-MULTI-DEVICE-LAN.bat',
    'STOP-A446-MULTI-DEVICE-LAN.bat',
    'MULTI-DEVICE-LAN-README.md',
    'README.md',
    'scripts\start-lan-multidevice.ps1',
    'scripts\stop-lan-multidevice.ps1',
    'scripts\build-lan-package.ps1',
    'scripts\test-lan-runtime.ps1',
    'scripts\test-package-structure.ps1',
    'docs\AI_AGENT_MANUAL.md',
    'apps\agent-hub\AI_IMPLEMENTATION_GUIDE.md',
    'apps\agent-hub\package.json',
    'apps\agent-hub\package-lock.json',
    'apps\agent-hub\src',
    'apps\agent-hub\scripts',
    'apps\agent-hub\protocol',
    'apps\agent-hub\docs',
    'apps\agent-hub\test',
    'apps\web\package.json',
    'apps\web\package-lock.json',
    'apps\web\index.html',
    'apps\web\eslint.config.js',
    'apps\web\tsconfig.json',
    'apps\web\tsconfig.app.json',
    'apps\web\tsconfig.node.json',
    'apps\web\vite.config.ts',
    'apps\web\public',
    'apps\web\src',
    'apps\web\test'
  )) { Copy-SourceItem -RelativePath $relative }

  # Keep the cmd.exe entry points portable across Windows code pages.
  foreach ($batName in @('START-A446-MULTI-DEVICE-LAN.bat', 'STOP-A446-MULTI-DEVICE-LAN.bat')) {
    $batPath = Join-Path $stagingRoot $batName
    if (Test-Path -LiteralPath $batPath) {
      $batText = [System.IO.File]::ReadAllText($batPath)
      $batText = $batText.Replace("`r`n", "`n").Replace("`r", "`n").Replace("`n", "`r`n")
      [System.IO.File]::WriteAllText($batPath, $batText, [System.Text.Encoding]::ASCII)
    }
  }

  $sourceCommit = (& git -C $ProjectRoot rev-parse HEAD).Trim()
  $sourceBranch = (& git -C $ProjectRoot branch --show-current).Trim()
  $dirty = [bool](& git -C $ProjectRoot status --porcelain)
  $files = @(Get-ChildItem -LiteralPath $stagingRoot -File -Recurse | Sort-Object FullName | ForEach-Object {
    [ordered]@{
      path = $_.FullName.Substring($stagingRoot.Length + 1).Replace('\', '/')
      size = $_.Length
      sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  })
  $manifest = [ordered]@{
    schemaVersion = 1
    package = $PackageName
    builtAt = (Get-Date).ToUniversalTime().ToString('o')
    sourceCommit = $sourceCommit
    sourceBranch = $sourceBranch
    sourceTreeDirty = $dirty
    architecture = 'one coordinator plus N worker devices; local JSON files; no database'
    excludes = @('credentials', 'tokens', 'node_modules', 'dist', 'var', 'workspaces', 'logs', 'apps/server-hub', 'deploy', 'old releases')
    files = $files
  }
  $manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stagingRoot 'PACKAGE-MANIFEST.json') -Encoding UTF8

  Add-Type -AssemblyName 'System.IO.Compression.FileSystem'
  [System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $ZipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)
  $hash = (Get-FileHash -LiteralPath $ZipPath -Algorithm SHA256).Hash.ToLowerInvariant()
  Set-Content -LiteralPath $HashPath -Value "$hash  $([System.IO.Path]::GetFileName($ZipPath))" -Encoding Ascii
  Write-Output "PACKAGE=$ZipPath"
  Write-Output "SHA256=$hash"
} finally {
  Assert-SafeTemporaryRoot
  if (Test-Path -LiteralPath $temporaryRoot) { Remove-Item -LiteralPath $temporaryRoot -Recurse -Force }
}
