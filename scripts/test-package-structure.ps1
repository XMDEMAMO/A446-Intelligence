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

  # 4. Bit-for-bit 1:1 verification of all files against PACKAGE-MANIFEST.json (path, size, sha256)
  Write-Host "Verifying 100% 1:1 match against manifest file entries (SHA-256 hashes & sizes)..."
  $sha256Provider = [System.Security.Cryptography.SHA256]::Create()
  $archiveFileEntries = @{}
  foreach ($entry in $archive.Entries) {
    if ($entry.FullName.EndsWith('/')) { continue }
    $normPath = $entry.FullName.Replace('\', '/')
    $archiveFileEntries[$normPath] = $entry
  }

  $manifestPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)

  foreach ($mFile in $manifest.files) {
    $p = $mFile.path
    $manifestPaths.Add($p) | Out-Null
    if (-not $archiveFileEntries.ContainsKey($p)) {
      throw "Manifest file '$p' is missing from ZIP archive!"
    }
    $entry = $archiveFileEntries[$p]
    if ($entry.Length -ne $mFile.size) {
      throw "File size mismatch for '$p': ZIP has $($entry.Length), manifest has $($mFile.size)"
    }

    $eStream = $entry.Open()
    $computedHashBytes = $sha256Provider.ComputeHash($eStream)
    $eStream.Close()
    $computedHash = [System.BitConverter]::ToString($computedHashBytes).Replace('-', '').ToLowerInvariant()

    if ($computedHash -ne $mFile.sha256.ToLowerInvariant()) {
      throw "SHA-256 hash mismatch for '$p': ZIP computed $computedHash, manifest has $($mFile.sha256)"
    }
  }

  # Check that every non-directory file in archive is accounted for (either in manifest.files or is PACKAGE-MANIFEST.json)
  foreach ($entryKey in $archiveFileEntries.Keys) {
    if ($entryKey -eq 'PACKAGE-MANIFEST.json') { continue }
    if (-not $manifestPaths.Contains($entryKey)) {
      throw "ZIP archive contains extra unexpected file not declared in manifest: '$entryKey'"
    }
  }
  Write-Host "Manifest 1:1 verification PASSED ($($manifest.files.Count) files verified bit-for-bit)!" -ForegroundColor Green

} finally {
  $archive.Dispose()
}

# 5. Simulate extraction to $PackageName folder and verify direct accessibility
$tempPath = [System.IO.Path]::GetTempPath()
$simGuid = [System.Guid]::NewGuid().ToString()
$testExtractDir = Join-Path $tempPath "pkg-sim-extract-$simGuid"
try {
  $targetFolder = Join-Path $testExtractDir $manifest.package
  Write-Host "Simulating extraction into $targetFolder..."
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $targetFolder -Force

  $expectedBat = Join-Path $targetFolder 'START-A446-MULTI-DEVICE-LAN.bat'
  if (-not (Test-Path -LiteralPath $expectedBat)) {
    throw "Simulated extraction failed: $expectedBat not found at root of $targetFolder"
  }

  $nestedFolder = Join-Path $targetFolder $manifest.package
  if (Test-Path -LiteralPath $nestedFolder) {
    throw "Simulated extraction failed: Found double-nested folder: $nestedFolder"
  }

  Write-Host "Simulated extraction PASSED: entering '$($manifest.package)' immediately reveals START-A446-MULTI-DEVICE-LAN.bat without double-nesting." -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $testExtractDir) {
    Remove-Item -LiteralPath $testExtractDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host "Package structure and 1:1 integrity verification ALL PASSED!" -ForegroundColor Green
