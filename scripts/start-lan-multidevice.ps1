param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('coordinator', 'worker', 'preflight')]
  [string]$Mode,
  [string]$HubIp = '',
  [string]$DeviceId = '',
  [ValidateSet('', 'full', 'safe')]
  [string]$AccessMode = ''
)

$ErrorActionPreference = 'Stop'
$HubPort = 8787
$WebPort = 5173
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $ProjectRoot 'apps\agent-hub'
$WebRoot = Join-Path $ProjectRoot 'apps\web'
$LanRoot = Join-Path $HubRoot 'var\lan'
$SettingsFile = Join-Path $LanRoot 'settings.json'
$TokenFile = Join-Path $LanRoot 'pairing-token.txt'
$LogRoot = Join-Path $LanRoot 'logs'

Add-Type -AssemblyName System.Net.Http

function Invoke-NoProxyJson {
  param([Parameter(Mandatory = $true)][string]$Uri, [hashtable]$Headers = @{}, [int]$TimeoutSeconds = 2)
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
  try {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
    foreach ($entry in $Headers.GetEnumerator()) { $request.Headers.TryAddWithoutValidation([string]$entry.Key, [string]$entry.Value) | Out-Null }
    try {
      $response = $client.SendAsync($request).GetAwaiter().GetResult()
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (-not $response.IsSuccessStatusCode) { throw "HTTP $([int]$response.StatusCode): $content" }
      return $content | ConvertFrom-Json
    } finally { $request.Dispose() }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Read-JsonFile {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } catch { return $null }
}

function Save-Settings {
  param([Parameter(Mandatory = $true)][hashtable]$Value)
  New-Item -ItemType Directory -Path $LanRoot -Force | Out-Null
  $temporary = Join-Path $LanRoot "settings.$PID.tmp"
  $Value | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $SettingsFile -Force
}

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name, [string]$Help)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing $Name. $Help"
  }
}

function Read-TrimmedHost {
  param([Parameter(Mandatory = $true)][string]$Prompt)
  $value = Read-Host $Prompt
  if ($null -eq $value) { return }
  return ([string]$value).Trim()
}

function Add-CodexToPathIfInstalled {
  if (Get-Command 'codex' -ErrorAction SilentlyContinue) { return }
  if (-not $env:LOCALAPPDATA) { return }
  $root = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (-not (Test-Path -LiteralPath $root)) { return }
  $candidate = Get-ChildItem -LiteralPath $root -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { $env:Path = "$($candidate.DirectoryName);$env:Path" }
}

function Normalize-DeviceId {
  param([string]$Value)
  $normalized = ([string]$Value).Trim().ToLowerInvariant() -replace '[^a-z0-9._-]+', '-'
  $normalized = $normalized.Trim('-')
  if (-not $normalized) { throw 'Device ID cannot be empty.' }
  if ($normalized.Length -gt 64) { $normalized = $normalized.Substring(0, 64) }
  return $normalized
}

function Resolve-DeviceId {
  param([string]$Requested, [object]$Saved)
  if ($Requested) { return Normalize-DeviceId $Requested }
  if ($Saved -and $Saved.deviceId) { return Normalize-DeviceId ([string]$Saved.deviceId) }
  $default = Normalize-DeviceId $env:COMPUTERNAME
  $entered = Read-TrimmedHost "Unique device name [$default]"
  return Normalize-DeviceId $(if ($entered) { $entered } else { $default })
}

function Test-IPv4 {
  param([string]$Value)
  $address = $null
  return [System.Net.IPAddress]::TryParse($Value, [ref]$address) -and $address.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork
}

function Get-LocalLanAddresses {
  return @(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
      $_.AddressState -ne 'Duplicate' -and
      $_.IPAddress -ne '127.0.0.1' -and
      -not $_.IPAddress.StartsWith('169.254.')
    } |
    Sort-Object @{ Expression = { if ($_.IPAddress -eq '192.168.137.1') { 0 } else { 1 } } }, InterfaceAlias |
    Select-Object -ExpandProperty IPAddress -Unique)
}

function Resolve-HubAddress {
  param([string]$Requested, [object]$Saved, [string]$RunMode)
  if ($Requested) {
    if (-not (Test-IPv4 $Requested)) { throw "Invalid Hub IPv4 address: $Requested" }
    return $Requested
  }
  if ($Saved -and $Saved.hubIp -and (Test-IPv4 ([string]$Saved.hubIp))) {
    $savedAddress = [string]$Saved.hubIp
    if ($RunMode -eq 'preflight') { return $savedAddress }
    if ($RunMode -eq 'coordinator' -and $savedAddress -in (Get-LocalLanAddresses)) { return $savedAddress }
    if ($RunMode -eq 'worker' -and $savedAddress -ne '127.0.0.1') { return $savedAddress }
  }
  if ($RunMode -eq 'preflight') { return '127.0.0.1' }
  if ($RunMode -eq 'coordinator') {
    $addresses = Get-LocalLanAddresses
    if ($addresses -contains '192.168.137.1') { return '192.168.137.1' }
    Write-Host ''
    Write-Host 'Active IPv4 addresses on this computer:'
    for ($index = 0; $index -lt $addresses.Count; $index += 1) { Write-Host "  $($index + 1). $($addresses[$index])" }
    $default = if ($addresses.Count) { $addresses[0] } else { '' }
    $entered = Read-TrimmedHost "Hub IPv4 address [$default]"
    if (-not $entered) { $entered = $default }
    if (-not (Test-IPv4 $entered)) { throw 'A valid local IPv4 address is required.' }
    return $entered
  }
  $entered = Read-TrimmedHost 'Coordinator IPv4 address (shown on the coordinator)'
  if (-not (Test-IPv4 $entered)) { throw 'A valid coordinator IPv4 address is required.' }
  return $entered
}

function Resolve-AccessMode {
  param([string]$Requested, [object]$Saved)
  if ($Requested) { return $Requested }
  if ($Saved -and @('full', 'safe') -contains [string]$Saved.accessMode) { return [string]$Saved.accessMode }
  Write-Host ''
  Write-Host 'Local execution access:'
  Write-Host '  1. Full local access (private trusted devices)'
  Write-Host '  2. Workspace-only safe mode'
  $answer = Read-TrimmedHost 'Select [1/2, default 1]'
  return $(if ($answer -eq '2') { 'safe' } else { 'full' })
}

function Initialize-PairingToken {
  param([string]$RunMode)
  if ($env:HUB_TOKEN -and $env:HUB_TOKEN.Trim()) { return $env:HUB_TOKEN.Trim() }
  if (Test-Path -LiteralPath $TokenFile) {
    $savedToken = (Get-Content -LiteralPath $TokenFile -Raw).Trim()
    if ($savedToken) { return $savedToken }
  }
  if ($RunMode -eq 'coordinator') {
    $token = "A446-$([Guid]::NewGuid().ToString('N'))-$([Guid]::NewGuid().ToString('N'))"
  } else {
    $token = Read-TrimmedHost 'Pairing token shown on the coordinator'
    if (-not $token) { throw 'A pairing token is required.' }
  }
  New-Item -ItemType Directory -Path $LanRoot -Force | Out-Null
  Set-Content -LiteralPath $TokenFile -Value $token -Encoding Ascii -NoNewline
  return $token
}

function Install-DependenciesIfMissing {
  param([Parameter(Mandatory = $true)][string]$WorkingDirectory, [Parameter(Mandatory = $true)][string]$Marker)
  if (Test-Path -LiteralPath (Join-Path $WorkingDirectory $Marker)) { return }
  Write-Host "First run: installing signed package-lock dependencies in $WorkingDirectory ..."
  Push-Location $WorkingDirectory
  try {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  } finally { Pop-Location }
}

function Invoke-DevicePreparation {
  param([string]$RunMode, [string]$Address, [string]$Id, [string]$Access)
  Push-Location $HubRoot
  try {
    $raw = & node 'scripts/prepare-lan-device.mjs' --mode $RunMode --hub-ip $Address --device-id $Id --access $Access
    if ($LASTEXITCODE -ne 0) { throw 'Device discovery and configuration generation failed.' }
    return ($raw | ConvertFrom-Json)
  } finally { Pop-Location }
}

function Initialize-AntigravityAlias {
  param([object]$Manifest, [hashtable]$CurrentSettings)
  if (-not @($Manifest.workers | Where-Object { $_.provider -eq 'antigravity' }).Count) { return }
  $alias = [string]$CurrentSettings.antigravityAccountId
  if (-not $alias -and $env:A446_ANTIGRAVITY_ACCOUNT_ID) {
    $alias = $env:A446_ANTIGRAVITY_ACCOUNT_ID.Trim() -replace '^google-', ''
  }
  if (-not $alias) {
    Write-Host ''
    Write-Host 'Antigravity does not expose the signed-in account identity to its CLI.'
    Write-Host 'Use the same non-secret alias on every device that shares this account.'
    $alias = Read-TrimmedHost "Antigravity account alias [$($Manifest.deviceId)-google]"
    if (-not $alias) { $alias = "$($Manifest.deviceId)-google" }
  }
  $alias = Normalize-DeviceId $alias
  $CurrentSettings.antigravityAccountId = $alias
  $env:A446_ANTIGRAVITY_ACCOUNT_ID = "google-$alias"
  $env:A446_ANTIGRAVITY_ACCOUNT_LABEL = "Antigravity $alias"
}

function Test-WorkerConfigs {
  param([object]$Manifest)
  if (-not @($Manifest.workers).Count) {
    throw 'No ready provider was detected. Sign in to Codex or Antigravity on this device, then retry.'
  }
  foreach ($worker in @($Manifest.workers)) {
    Write-Host "Checking $($worker.provider) as $($worker.agentId) ..."
    Push-Location $HubRoot
    try {
      & node 'scripts/check-env.mjs' --config ([string]$worker.configFile)
      if ($LASTEXITCODE -ne 0) { throw "Environment check failed for $($worker.agentId)." }
    } finally { Pop-Location }
  }
}

function Show-ProviderSummaries {
  param([object]$Manifest)
  foreach ($worker in @($Manifest.workers)) {
    $provider = [string]$worker.provider
    $cache = Join-Path $LanRoot "provider-cache\preflight-$($Manifest.deviceId)-$provider.json"
    Push-Location $HubRoot
    try {
      $raw = & node 'scripts/provider-probe.mjs' --provider $provider --command ([string]$worker.command) --kind all --cache-file $cache --max-age-ms 30000 --timeout-ms 20000
      if ($LASTEXITCODE -ne 0) { Write-Warning "Provider details are temporarily unavailable for $provider."; continue }
      $snapshot = $raw | ConvertFrom-Json
      Write-Host ''
      Write-Host "Provider: $provider"
      Write-Host "Account:  $($snapshot.account.label)"
      Write-Host "Models:   $(@($snapshot.models).Count)"
      foreach ($model in @($snapshot.models)) {
        $efforts = @($model.reasoningEfforts) -join ', '
        Write-Host "  - $($model.id)$(if ($efforts) { " [$efforts]" } else { '' })"
      }
      Write-Host "Quota:    $($snapshot.quota.state) ($($snapshot.quota.source))"
      foreach ($window in @($snapshot.quota.windows)) {
        Write-Host "  - $($window.name): $($window.remainingPercent)% remaining; resets $($window.resetsAt)"
      }
    } finally { Pop-Location }
  }
}

function Start-HiddenNodeProcess {
  param([string[]]$Arguments, [string]$WorkingDirectory, [string]$Name)
  New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdout = Join-Path $LogRoot "$Name-$stamp.out.log"
  $stderr = Join-Path $LogRoot "$Name-$stamp.err.log"
  return Start-Process -FilePath (Get-Command node).Source -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr
}

function Wait-HubReady {
  param([System.Diagnostics.Process]$HubProcess, [string]$BaseUrl, [string]$Token)
  $headers = @{ Authorization = "Bearer $Token" }
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    if ($HubProcess.HasExited) { throw "Local Hub exited during startup with code $($HubProcess.ExitCode)." }
    try {
      $health = Invoke-NoProxyJson -Uri "$BaseUrl/health" -Headers $headers -TimeoutSeconds 1
      if ($health.ok) { return }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw 'Local Hub did not become ready within 15 seconds.'
}

function Wait-WorkersOnline {
  param([object]$Manifest, [System.Diagnostics.Process[]]$Processes, [string]$BaseUrl, [string]$Token)
  $expected = @($Manifest.workers | ForEach-Object { [string]$_.agentId })
  $headers = @{ Authorization = "Bearer $Token" }
  for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
    foreach ($process in $Processes) {
      if ($process.HasExited) { throw "A local Agent exited during startup with code $($process.ExitCode)." }
    }
    try {
      $agents = Invoke-NoProxyJson -Uri "$BaseUrl/v1/agents" -Headers $headers -TimeoutSeconds 1
      $online = @($agents.agents | Where-Object { $_.status -eq 'online' } | ForEach-Object { [string]$_.agentId })
      if (@($expected | Where-Object { $_ -notin $online }).Count -eq 0) { return }
    } catch {}
    Start-Sleep -Milliseconds 250
  }
  throw 'Local Agents did not all become ready within 20 seconds.'
}

function Start-ManifestWorkers {
  param([object]$Manifest)
  $processes = @()
  foreach ($worker in @($Manifest.workers)) {
    $leaf = Split-Path -Leaf ([string]$worker.configFile)
    $processes += Start-HiddenNodeProcess -Arguments @('src/worker-cli.mjs', '--config', "var/lan/config/$leaf") -WorkingDirectory $HubRoot -Name "worker-$($worker.agentId)"
  }
  return @($processes)
}

function Stop-StartedProcesses {
  param([object[]]$Processes)
  foreach ($process in @($Processes)) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $process.WaitForExit(5000) | Out-Null
    }
  }
}

function Start-Coordinator {
  param([object]$Manifest, [string]$Address, [string]$Token)
  $localAddresses = Get-LocalLanAddresses
  if ($Address -notin $localAddresses) {
    throw "This computer does not currently own $Address. Turn on the Windows mobile hotspot or select the correct LAN address."
  }
  $occupied = Get-NetTCPConnection -State Listen -LocalPort $HubPort, $WebPort -ErrorAction SilentlyContinue
  if ($occupied) {
    $ports = ($occupied | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object) -join ', '
    throw "Port(s) $ports are already in use. Stop the previous A446 LAN instance first."
  }
  $hubLeaf = Split-Path -Leaf ([string]$Manifest.hubConfigFile)
  $hubProcess = Start-HiddenNodeProcess -Arguments @('src/mock-hub-cli.mjs', '--config', "var/lan/config/$hubLeaf") -WorkingDirectory $HubRoot -Name 'hub'
  $workers = @()
  try {
    $baseUrl = "http://${Address}:$HubPort"
    Wait-HubReady -HubProcess $hubProcess -BaseUrl $baseUrl -Token $Token
    $workers = @(Start-ManifestWorkers -Manifest $Manifest)
    Wait-WorkersOnline -Manifest $Manifest -Processes $workers -BaseUrl $baseUrl -Token $Token
    Write-Host ''
    Write-Host 'A446 multi-device LAN is ready.'
    Write-Host "Console:       http://${Address}:$WebPort"
    Write-Host "Pairing token: $Token"
    Write-Host "Local Agents:  $(@($Manifest.workers).Count)"
    Write-Host 'Other devices: run the same package and select Worker Device.'
    Write-Host 'If Windows Firewall asks, allow Private networks only.'
    Write-Host 'Press Ctrl+C here to stop this coordinator instance.'
    Write-Host ''
    $env:HUB_HTTP_URL = $baseUrl
    $env:VITE_LAN_MODE = 'true'
    Start-Process "http://${Address}:$WebPort" | Out-Null
    Push-Location $WebRoot
    try {
      & node 'node_modules/vite/bin/vite.js' --host $Address --port $WebPort
      if ($LASTEXITCODE -ne 0) { throw "Web console exited with code $LASTEXITCODE." }
    } finally { Pop-Location }
  } finally {
    Stop-StartedProcesses -Processes $workers
    Stop-StartedProcesses -Processes @($hubProcess)
  }
}

function Start-WorkerDevice {
  param([object]$Manifest, [string]$Address)
  $workers = @(Start-ManifestWorkers -Manifest $Manifest)
  try {
    Write-Host ''
    Write-Host "$($workers.Count) local Agent process(es) started."
    Write-Host "Coordinator: http://${Address}:$WebPort"
    Write-Host 'They will reconnect automatically if the coordinator restarts.'
    Write-Host 'Press Ctrl+C here to stop this device Agents.'
    while ($true) {
      foreach ($process in $workers) {
        if ($process.HasExited) { throw "A local Agent exited with code $($process.ExitCode). Check var\lan\logs." }
      }
      Start-Sleep -Seconds 2
    }
  } finally { Stop-StartedProcesses -Processes $workers }
}

Assert-Command -Name 'node' -Help 'Install Node.js 20 or newer.'
Assert-Command -Name 'npm.cmd' -Help 'Install Node.js with npm.'
Add-CodexToPathIfInstalled
$nodeVersion = (& node --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js $nodeVersion is too old; version 20 or newer is required." }

Install-DependenciesIfMissing -WorkingDirectory $HubRoot -Marker 'node_modules\ws\package.json'
if ($Mode -eq 'coordinator') { Install-DependenciesIfMissing -WorkingDirectory $WebRoot -Marker 'node_modules\vite\bin\vite.js' }

$saved = Read-JsonFile -Path $SettingsFile
$settings = @{}
if ($saved) {
  foreach ($property in $saved.PSObject.Properties) { $settings[$property.Name] = $property.Value }
}
$resolvedDeviceId = Resolve-DeviceId -Requested $DeviceId -Saved $saved
$resolvedHubIp = Resolve-HubAddress -Requested $HubIp -Saved $saved -RunMode $Mode
$resolvedAccess = Resolve-AccessMode -Requested $AccessMode -Saved $saved
$env:A446_DEVICE_ID = $resolvedDeviceId

$manifest = Invoke-DevicePreparation -RunMode $Mode -Address $resolvedHubIp -Id $resolvedDeviceId -Access $resolvedAccess
Initialize-AntigravityAlias -Manifest $manifest -CurrentSettings $settings
$settings.deviceId = $resolvedDeviceId
if ($Mode -ne 'preflight') { $settings.hubIp = $resolvedHubIp }
$settings.accessMode = $resolvedAccess
$settings.updatedAt = (Get-Date).ToUniversalTime().ToString('o')
Save-Settings -Value $settings
Test-WorkerConfigs -Manifest $manifest

if ($Mode -eq 'preflight') {
  Show-ProviderSummaries -Manifest $manifest
  Write-Host ''
  Write-Host 'Preflight complete. No model task was executed.'
  exit 0
}

$pairingToken = Initialize-PairingToken -RunMode $Mode
$env:HUB_TOKEN = $pairingToken
if ($Mode -eq 'coordinator') { Start-Coordinator -Manifest $manifest -Address $resolvedHubIp -Token $pairingToken }
else { Start-WorkerDevice -Manifest $manifest -Address $resolvedHubIp }
