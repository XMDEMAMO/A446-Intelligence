param(
  [string]$HubIp = '192.168.137.1'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $ProjectRoot 'apps\agent-hub'
$WebRoot = Join-Path $ProjectRoot 'apps\web'
$LogRoot = Join-Path $HubRoot 'var\lan\runtime-test-logs'
$DeviceId = "lan-runtime-test-$PID"
$Token = "A446-runtime-test-$([Guid]::NewGuid().ToString('N'))"
$Processes = @()

Add-Type -AssemblyName System.Net.Http

function Invoke-NoProxyRequest {
  param([string]$Uri, [hashtable]$Headers = @{}, [switch]$Json)
  $handler = [System.Net.Http.HttpClientHandler]::new()
  $handler.UseProxy = $false
  $client = [System.Net.Http.HttpClient]::new($handler)
  $client.Timeout = [TimeSpan]::FromSeconds(2)
  try {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $Uri)
    foreach ($entry in $Headers.GetEnumerator()) { $request.Headers.TryAddWithoutValidation([string]$entry.Key, [string]$entry.Value) | Out-Null }
    try {
      $response = $client.SendAsync($request).GetAwaiter().GetResult()
      $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if ($Json -and $response.IsSuccessStatusCode) { return $content | ConvertFrom-Json }
      return [pscustomobject]@{ StatusCode = [int]$response.StatusCode; Content = $content }
    } finally { $request.Dispose() }
  } finally {
    $client.Dispose()
    $handler.Dispose()
  }
}

function Start-TestProcess {
  param([string[]]$Arguments, [string]$WorkingDirectory, [string]$Name)
  return Start-Process -FilePath (Get-Command node).Source -ArgumentList $Arguments `
    -WorkingDirectory $WorkingDirectory -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogRoot "$Name.out.log") `
    -RedirectStandardError (Join-Path $LogRoot "$Name.err.log")
}

function Get-HttpStatus {
  param([string]$Uri, [hashtable]$Headers = @{})
  return [int](Invoke-NoProxyRequest -Uri $Uri -Headers $Headers).StatusCode
}

New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
$env:HUB_TOKEN = $Token
$env:A446_DEVICE_ID = $DeviceId
$env:A446_ANTIGRAVITY_ACCOUNT_ID = 'google-lan-runtime-test'
$env:A446_ANTIGRAVITY_ACCOUNT_LABEL = 'Antigravity LAN runtime test'
$env:HUB_HTTP_URL = "http://${HubIp}:8787"
$env:VITE_LAN_MODE = 'true'

try {
  Push-Location $HubRoot
  try {
    $raw = & node 'scripts/prepare-lan-device.mjs' --mode coordinator --hub-ip $HubIp --device-id $DeviceId --access safe
    if ($LASTEXITCODE -ne 0) { throw 'LAN runtime test configuration failed.' }
    $manifest = $raw | ConvertFrom-Json
  } finally { Pop-Location }
  if (-not @($manifest.workers).Count) { throw 'LAN runtime test found no ready provider.' }

  $Processes += Start-TestProcess -Arguments @('src/mock-hub-cli.mjs', '--config', 'var/lan/config/hub.lan.json') -WorkingDirectory $HubRoot -Name 'hub'
  $health = $null
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    try { $health = Invoke-NoProxyRequest -Uri "http://${HubIp}:8787/health" -Headers @{ Authorization = "Bearer $Token" } -Json } catch {}
    if ($health.ok) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $health.ok) { throw 'LAN runtime test Hub did not become ready.' }

  foreach ($worker in @($manifest.workers)) {
    $leaf = Split-Path -Leaf ([string]$worker.configFile)
    $Processes += Start-TestProcess -Arguments @('src/worker-cli.mjs', '--config', "var/lan/config/$leaf") -WorkingDirectory $HubRoot -Name ([string]$worker.agentId)
  }
  $agents = @()
  for ($attempt = 0; $attempt -lt 160; $attempt += 1) {
    try {
      $agents = @((Invoke-NoProxyRequest -Uri "http://${HubIp}:8787/v1/agents" -Headers @{ Authorization = "Bearer $Token" } -Json).agents)
    } catch {}
    if (@($agents | Where-Object { $_.status -eq 'online' }).Count -eq @($manifest.workers).Count) { break }
    Start-Sleep -Milliseconds 250
  }
  if (@($agents | Where-Object { $_.status -eq 'online' }).Count -ne @($manifest.workers).Count) {
    throw 'LAN runtime test Agents did not all become ready.'
  }

  $Processes += Start-TestProcess -Arguments @('node_modules/vite/bin/vite.js', '--host', $HubIp, '--port', '5173') -WorkingDirectory $WebRoot -Name 'web'
  $unpairedStatus = $null
  for ($attempt = 0; $attempt -lt 60; $attempt += 1) {
    try { $unpairedStatus = Get-HttpStatus -Uri "http://${HubIp}:5173/api/health" } catch {}
    if ($unpairedStatus) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($unpairedStatus -ne 401) { throw "LAN Web guard expected HTTP 401, received $unpairedStatus." }
  $pairedStatus = Get-HttpStatus -Uri "http://${HubIp}:5173/api/health" -Headers @{ 'x-a446-lan-token' = $Token }
  if ($pairedStatus -ne 200) { throw "Paired LAN Web proxy expected HTTP 200, received $pairedStatus." }

  [pscustomobject]@{
    result = 'PASS'
    agents = @($agents).Count
    providers = @($agents | ForEach-Object { $_.account.provider }) -join ','
    modelCounts = @($agents | ForEach-Object { @($_.models).Count }) -join ','
    quotaStates = @($agents | ForEach-Object { $_.quotaSnapshot.state }) -join ','
    unpairedWebStatus = $unpairedStatus
    pairedWebStatus = $pairedStatus
    realModelTasksExecuted = 0
  } | Format-List
} finally {
  foreach ($process in @($Processes)) {
    if ($process -and -not $process.HasExited) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      $process.WaitForExit(5000) | Out-Null
    }
  }
}
