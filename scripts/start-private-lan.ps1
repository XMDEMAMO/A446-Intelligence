param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('server', 'gemini')]
  [string]$Mode
)

$ErrorActionPreference = 'Stop'

# This launcher is intentionally fixed for the user's private Windows Mobile Hotspot.
$HubIp = '192.168.137.1'
$HubPort = 8787
$WebPort = 5173

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $ProjectRoot 'apps\agent-hub'
$WebRoot = Join-Path $ProjectRoot 'apps\web'
$HubHttpUrl = "http://${HubIp}:$HubPort"

function Initialize-PrivateLanToken {
  param([Parameter(Mandatory = $true)][string]$RunMode)

  if ($env:HUB_TOKEN -and $env:HUB_TOKEN.Trim()) {
    return $env:HUB_TOKEN.Trim()
  }

  $tokenFile = Join-Path $HubRoot 'var\private-lan-token.txt'
  if (Test-Path -LiteralPath $tokenFile) {
    $savedToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
    if ($savedToken) { return $savedToken }
  }

  if ($RunMode -eq 'server') {
    $token = "A446-$([Guid]::NewGuid().ToString('N'))-$([Guid]::NewGuid().ToString('N'))"
  } else {
    $token = (Read-Host 'Enter the private LAN token shown on Device 1').Trim()
    if (-not $token) {
      throw 'A private LAN token is required. Start Device 1 first and copy the token it displays.'
    }
  }

  New-Item -ItemType Directory -Path (Split-Path -Parent $tokenFile) -Force | Out-Null
  Set-Content -LiteralPath $tokenFile -Value $token -Encoding Ascii -NoNewline
  return $token
}

function Assert-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing $Name. Install Node.js 20 or newer, then run the launcher again."
  }
}

function Add-CodexToPathIfInstalled {
  if (Get-Command 'codex' -ErrorAction SilentlyContinue) { return }
  if (-not $env:LOCALAPPDATA) { return }
  $codexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (-not (Test-Path -LiteralPath $codexBinRoot)) { return }
  $candidate = Get-ChildItem -LiteralPath $codexBinRoot -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1
  if ($candidate) {
    $env:Path = "$($candidate.DirectoryName);$env:Path"
  }
}

function Invoke-NpmCiIfMissing {
  param(
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$Marker,
    [switch]$IgnoreScripts
  )
  if (Test-Path -LiteralPath (Join-Path $WorkingDirectory $Marker)) { return }
  Write-Output "First run: installing dependencies in $WorkingDirectory ..."
  Push-Location $WorkingDirectory
  try {
    $arguments = @('ci')
    if ($IgnoreScripts) { $arguments += '--ignore-scripts' }
    & npm.cmd @arguments
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

function Wait-HubReady {
  param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
  $headers = @{ Authorization = "Bearer $PrivateLanToken" }
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if ($Process.HasExited) { throw "Hub exited during startup with code $($Process.ExitCode)." }
    try {
      $health = Invoke-RestMethod -Uri "$HubHttpUrl/health" -Headers $headers -TimeoutSec 1
      if ($health.ok) { return }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw 'Hub did not become ready within 10 seconds.'
}

function Start-PrivateServer {
  $hotspotAddress = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -eq $HubIp -and $_.AddressState -ne 'Duplicate' } |
    Select-Object -First 1
  if (-not $hotspotAddress) {
    throw "This computer does not have $HubIp. Turn on Windows Mobile Hotspot and run the launcher again."
  }

  Invoke-NpmCiIfMissing -WorkingDirectory $HubRoot -Marker 'node_modules\ws' -IgnoreScripts
  Invoke-NpmCiIfMissing -WorkingDirectory $WebRoot -Marker 'node_modules'
  Add-CodexToPathIfInstalled
  if (-not (Get-Command 'codex' -ErrorAction SilentlyContinue)) {
    throw 'Codex CLI was not found. Install/open the Codex desktop app and sign in on Device 1.'
  }

  $occupied = Get-NetTCPConnection -State Listen -LocalPort $HubPort, $WebPort -ErrorAction SilentlyContinue
  if ($occupied) {
    $ports = ($occupied | Select-Object -ExpandProperty LocalPort -Unique | Sort-Object) -join ', '
    throw "Port(s) $ports are already in use. Stop the previous A446 instance first."
  }

  $logRoot = Join-Path $HubRoot 'var\log'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $stdoutLog = Join-Path $logRoot "private-lan-hub-$stamp.out.log"
  $stderrLog = Join-Path $logRoot "private-lan-hub-$stamp.err.log"
  $hubProcess = Start-Process -FilePath (Get-Command node).Source `
    -ArgumentList @('src/mock-hub-cli.mjs', '--config', 'config/hub.private-lan.json') `
    -WorkingDirectory $HubRoot -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

  $codexProcesses = @()
  try {
    Wait-HubReady -Process $hubProcess
    $codexStartOutput = @(Start-CodexWorkersInBackground)
    $codexProcesses = @($codexStartOutput | Where-Object { $_ -is [System.Diagnostics.Process] })
    $codexStartOutput | Where-Object { $_ -isnot [System.Diagnostics.Process] } | ForEach-Object { Write-Host $_ }
    if ($codexProcesses.Count -ne 2) { throw 'Codex startup did not return both Agent processes.' }
    Write-Output ''
    Write-Output 'A446 private server and both Codex Agents are ready.'
    Write-Output "Console: http://${HubIp}:$WebPort"
    Write-Output "Worker:  ws://${HubIp}:$HubPort/worker"
    Write-Output 'If Windows Firewall asks, allow Private networks only.'
    Write-Output 'Press Ctrl+C to stop the web console and this Hub.'
    Write-Output ''
    Push-Location $WebRoot
    try {
      & node 'node_modules/vite/bin/vite.js' --host 0.0.0.0 --port $WebPort
      if ($LASTEXITCODE -ne 0) { throw "Web process exited with code $LASTEXITCODE." }
    } finally {
      Pop-Location
    }
  } catch {
    if (Test-Path -LiteralPath $stderrLog) {
      $lastError = Get-Content -LiteralPath $stderrLog -Tail 20 -ErrorAction SilentlyContinue
      if ($lastError) { Write-Error ($lastError -join [Environment]::NewLine) -ErrorAction Continue }
    }
    throw
  } finally {
    foreach ($process in $codexProcesses) {
      if ($process -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        $process.WaitForExit(5000) | Out-Null
      }
    }
    if ($hubProcess -and -not $hubProcess.HasExited) {
      Stop-Process -Id $hubProcess.Id -Force -ErrorAction SilentlyContinue
      $hubProcess.WaitForExit(5000) | Out-Null
    }
  }
}

function Start-PrivateWorker {
  param(
    [Parameter(Mandatory = $true)][string]$ConfigName,
    [Parameter(Mandatory = $true)][string]$ProviderName,
    [switch]$SkipPreflight
  )
  Invoke-NpmCiIfMissing -WorkingDirectory $HubRoot -Marker 'node_modules\ws' -IgnoreScripts
  $configPath = Join-Path $HubRoot "config\$ConfigName"
  if (-not $SkipPreflight) {
    Write-Output "Checking $ProviderName and the private LAN configuration ..."
    Push-Location $HubRoot
    try {
      & node 'scripts/check-env.mjs' --config $configPath
      if ($LASTEXITCODE -ne 0) { throw "$ProviderName environment check failed." }
    } finally {
      Pop-Location
    }
  }
  Push-Location $HubRoot
  try {
    Write-Output ''
    Write-Output "$ProviderName Worker is connecting to ws://${HubIp}:$HubPort/worker"
    Write-Output 'Press Ctrl+C to stop this Worker.'
    Write-Output ''
    & node 'src/worker-cli.mjs' --config $configPath
    if ($LASTEXITCODE -ne 0) { throw "$ProviderName Worker exited with code $LASTEXITCODE." }
  } finally {
    Pop-Location
  }
}

function Start-CodexWorkersInBackground {
  Invoke-NpmCiIfMissing -WorkingDirectory $HubRoot -Marker 'node_modules\ws' -IgnoreScripts
  $plannerName = 'worker.laptop-01-codex-planner.private-lan.json'
  $executorName = 'worker.laptop-01-codex-executor.private-lan.json'
  $plannerPath = Join-Path $HubRoot "config\$plannerName"
  $executorPath = Join-Path $HubRoot "config\$executorName"

  Write-Output 'Checking the Codex planner and executor ...'
  Push-Location $HubRoot
  try {
    foreach ($configPath in @($plannerPath, $executorPath)) {
      & node 'scripts/check-env.mjs' --config $configPath
      if ($LASTEXITCODE -ne 0) { throw "Codex environment check failed for $configPath." }
    }
  } finally {
    Pop-Location
  }

  $logRoot = Join-Path $HubRoot 'var\log'
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $definitions = @(
    @{ Name = $plannerName; AgentId = 'laptop-01-codex-planner-01'; LogName = 'planner' },
    @{ Name = $executorName; AgentId = 'laptop-01-codex-executor-01'; LogName = 'executor' }
  )
  $processes = @()
  foreach ($definition in $definitions) {
    $workerOut = Join-Path $logRoot "private-lan-codex-$($definition.LogName)-$stamp.out.log"
    $workerErr = Join-Path $logRoot "private-lan-codex-$($definition.LogName)-$stamp.err.log"
    $processes += Start-Process -FilePath (Get-Command node).Source `
      -ArgumentList @('src/worker-cli.mjs', '--config', "config/$($definition.Name)") `
      -WorkingDirectory $HubRoot -PassThru -WindowStyle Hidden `
      -RedirectStandardOutput $workerOut -RedirectStandardError $workerErr
  }

  try {
    $headers = @{ Authorization = "Bearer $PrivateLanToken" }
    $onlineIds = @()
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
      foreach ($process in $processes) {
        if ($process.HasExited) { throw "A Codex Agent exited with code $($process.ExitCode)." }
      }
      try {
        $agents = Invoke-RestMethod -Uri "$HubHttpUrl/v1/agents" -Headers $headers -TimeoutSec 1
        $onlineIds = @($agents.agents | Where-Object { $_.status -eq 'online' } | Select-Object -ExpandProperty agentId)
        if (@($definitions | Where-Object { $_.AgentId -notin $onlineIds }).Count -eq 0) { break }
      } catch {}
      Start-Sleep -Milliseconds 250
    }
    if (@($definitions | Where-Object { $_.AgentId -notin $onlineIds }).Count -ne 0) {
      throw 'The Codex planner and executor could not both connect to the Hub within 10 seconds.'
    }
    Write-Output 'Codex planner and executor are online.'
    return $processes
  } catch {
    foreach ($process in $processes) {
      if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    }
    throw
  }
}

Assert-Command -Name 'node'
Assert-Command -Name 'npm.cmd'
Add-CodexToPathIfInstalled
$nodeMajor = [int]((& node --version).TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js is too old. Current: $(& node --version); required: 20 or newer." }

$PrivateLanToken = Initialize-PrivateLanToken -RunMode $Mode.ToLowerInvariant()
$env:HUB_TOKEN = $PrivateLanToken
$env:HUB_HTTP_URL = $HubHttpUrl
if ($Mode -eq 'server') {
  Write-Output ''
  Write-Output 'Private LAN token for Device 2 (shown only on this computer):'
  Write-Output $PrivateLanToken
  Write-Output 'Device 2 stores it locally after the first entry; it is not included in this package.'
}

switch ($Mode.ToLowerInvariant()) {
  'server' { Start-PrivateServer }
  'gemini' { Start-PrivateWorker -ConfigName 'worker.laptop-02-gemini.private-lan.json' -ProviderName 'Gemini' }
}
