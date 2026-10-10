function Resolve-WorkerNode {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$HubRoot,
    [switch]$ValidateOnly
  )

  $runtimeRoot = Join-Path $HubRoot 'var\staging-launcher\node-runtime'
  $candidates = @(Get-Command node.exe -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
  if (Test-Path -LiteralPath $runtimeRoot) {
    $candidates += @(Get-ChildItem -LiteralPath $runtimeRoot -Directory | ForEach-Object { Join-Path $_.FullName 'node.exe' })
  }
  foreach ($candidate in $candidates) {
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $version = [string](& $candidate --version)
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.') {
      if ([int]$Matches[1] -ge 20) { return $candidate }
    }
  }
  if ($ValidateOnly) { throw 'Node.js 20+ is missing. Run a normal launcher to download portable Node.js 24 LTS.' }

  Write-Host '未找到兼容 Node.js，正在从 nodejs.org 下载便携版 Node.js 24 LTS（不修改系统安装）。' -ForegroundColor Cyan
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $architecture = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $versions = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -TimeoutSec 60
  $release = $versions | Where-Object { $_.version -match '^v24\.\d+\.\d+$' -and $_.lts } | Select-Object -First 1
  if (-not $release) { throw 'The official Node.js index did not contain a Node.js 24 LTS release.' }
  $archiveName = "node-$($release.version)-win-$architecture.zip"
  $baseUrl = "https://nodejs.org/dist/$($release.version)"
  $checksums = (Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/SHASUMS256.txt" -TimeoutSec 60).Content
  $checksumMatch = [regex]::Match([string]$checksums, ('(?m)^([a-fA-F0-9]{64})\s+' + [regex]::Escape($archiveName) + '\s*$'))
  if (-not $checksumMatch.Success) { throw 'The official SHA-256 list did not include the requested Windows runtime.' }

  New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
  $runtimeRoot = (Resolve-Path -LiteralPath $runtimeRoot).Path
  $stageRoot = Join-Path $runtimeRoot ('download-' + [guid]::NewGuid().ToString('N'))
  $nodeHome = Join-Path $runtimeRoot ([IO.Path]::GetFileNameWithoutExtension($archiveName))
  New-Item -ItemType Directory -Path $stageRoot | Out-Null
  try {
    $archivePath = Join-Path $stageRoot $archiveName
    Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/$archiveName" -OutFile $archivePath -TimeoutSec 180
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $checksumMatch.Groups[1].Value) {
      throw 'Portable Node.js SHA-256 verification failed.'
    }
    $extractRoot = Join-Path $stageRoot 'extracted'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot
    $extractedNode = Join-Path $extractRoot ([IO.Path]::GetFileNameWithoutExtension($archiveName))
    if (-not (Test-Path -LiteralPath (Join-Path $extractedNode 'node.exe') -PathType Leaf)) { throw 'Portable Node.js archive has no node.exe.' }
    foreach ($movePath in @($extractedNode, $nodeHome)) {
      if (-not [IO.Path]::GetFullPath($movePath).StartsWith($runtimeRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Portable runtime move target escaped the launcher runtime directory.'
      }
    }
    if (Test-Path -LiteralPath $nodeHome) { throw "An incomplete runtime already exists; inspect this directory before retrying: $nodeHome" }
    Move-Item -LiteralPath $extractedNode -Destination $nodeHome
    $nodePath = Join-Path $nodeHome 'node.exe'
    $installedVersion = [string](& $nodePath --version)
    if ($LASTEXITCODE -ne 0 -or $installedVersion.Trim() -ne [string]$release.version) { throw 'Downloaded Node.js version verification failed.' }
    Write-Host "便携 Node.js 已就绪：$installedVersion；官方 SHA-256 校验通过。" -ForegroundColor Green
    return $nodePath
  } finally {
    $resolvedStage = (Resolve-Path -LiteralPath $stageRoot).Path
    if (-not $resolvedStage.StartsWith($runtimeRoot + '\download-', [StringComparison]::OrdinalIgnoreCase)) {
      throw 'Portable runtime cleanup target escaped its verified download directory.'
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
  }
}
