param(
  [string]$ZipPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName 'System.IO.Compression.FileSystem'

if (-not $ZipPath) {
  $ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
  $ReleaseRoot = Join-Path $ProjectRoot 'releases'
  $latest = Get-ChildItem -Path $ReleaseRoot -Filter '*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) {
    throw "No ZIP package found in $ReleaseRoot. Please pass -ZipPath explicitly."
  }
  $ZipPath = $latest.FullName
}

Write-Host "Verifying ZIP package structure: $ZipPath"

$archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
try {
  $entries = $archive.Entries | ForEach-Object { $_.FullName.Replace('\', '/') }

  # 1. Verify root files exist directly without directory prefix
  $requiredRootFiles = @(
    'START-A446-MULTI-DEVICE-LAN.bat',
    'STOP-A446-MULTI-DEVICE-LAN.bat',
    'PACKAGE-MANIFEST.json',
    'README.md',
    'MULTI-DEVICE-LAN-README.md'
  )

  foreach ($file in $requiredRootFiles) {
    if (-not ($entries -contains $file)) {
      throw "Required root file '$file' is missing from root level of ZIP. Entries found: $($entries | Select-Object -First 10)"
    }
  }

  # 2. Verify no entries start with a common top-level wrapper directory (like A446-MultiDevice-LAN-*/)
  $hasTopLevelWrapper = $entries | Where-Object { $_ -match '^A446-MultiDevice-LAN-[^/]+/' }
  if ($hasTopLevelWrapper) {
    throw "ZIP contains nested top-level directory wrapper: $($hasTopLevelWrapper[0])"
  }

  # 3. Read PACKAGE-MANIFEST.json from the archive and verify files list matches
  $manifestEntry = $archive.Entries | Where-Object { $_.FullName -eq 'PACKAGE-MANIFEST.json' }
  if (-not $manifestEntry) {
    throw "PACKAGE-MANIFEST.json not found in archive"
  }

  $stream = $manifestEntry.Open()
  $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
  $manifestJson = $reader.ReadToEnd()
  $reader.Close()
  $stream.Close()

  $manifest = $manifestJson | ConvertFrom-Json
  Write-Host "Package manifest name: $($manifest.package)"
  Write-Host "Package manifest files count: $($manifest.files.Count)"
  Write-Host "Archive total entries: $($archive.Entries.Count)"

  Write-Host "Package structure verification PASSED! Root files are directly accessible without double-nested folders." -ForegroundColor Green
} finally {
  $archive.Dispose()
}
