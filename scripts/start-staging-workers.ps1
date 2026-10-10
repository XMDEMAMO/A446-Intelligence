[CmdletBinding()]
param(
  [ValidateSet('Auto', 'Codex', 'Antigravity', 'Both')]
  [string]$Provider = 'Auto',

  [string]$HubUrl = 'wss://staging.a446intelligence.party/worker',

  [string]$ArtifactApiUrl = 'https://staging.a446intelligence.party',

  [switch]$SkipReadiness,

  [switch]$ValidateOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$HubRoot = Join-Path $RepoRoot 'apps\agent-hub'
$RuntimeRoot = Join-Path $HubRoot 'var\staging-launcher'
$ConfigRoot = Join-Path $RuntimeRoot 'config'
$ProcessFile = Join-Path $RuntimeRoot 'processes.json'
$ChildScript = Join-Path $PSScriptRoot 'run-staging-worker.ps1'
$BootstrapScript = Join-Path $PSScriptRoot 'bootstrap-worker-node.ps1'
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Step {
  param([string]$Message)
  Write-Host "`n== $Message ==" -ForegroundColor Cyan
}

function Get-EnvironmentOrDefault {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Default
  )
  $value = [Environment]::GetEnvironmentVariable($Name, 'Process')
  if ($value -and $value.Trim()) { return $value.Trim() }
  return $Default
}

function Assert-Identifier {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Value
  )
  if ($Value -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    throw "$Name contains unsupported characters: $Value"
  }
}

function Invoke-ReadinessCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [switch]$PassThrough
  )
  try {
    if ($PassThrough) {
      $process = Start-Process -FilePath $Command -ArgumentList $Arguments -NoNewWindow -Wait -PassThru
      $exitCode = $process.ExitCode
      return [pscustomobject]@{
        Ok = ($exitCode -eq 0)
        Output = ''
        ExitCode = $exitCode
      }
    }
    $output = @(& $Command @Arguments 2>&1)
    $exitCode = $LASTEXITCODE
    return [pscustomobject]@{
      Ok = ($exitCode -eq 0)
      Output = (($output | ForEach-Object { [string]$_ }) -join "`n").Trim()
      ExitCode = $exitCode
    }
  } catch {
    return [pscustomobject]@{
      Ok = $false
      Output = $_.Exception.Message
      ExitCode = -1
    }
  }
}

function Get-CodexLaunchCandidates {
  $candidates = [System.Collections.Generic.List[object]]::new()
  $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  $node = Get-Command 'node.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { $node = Get-Command 'node' -ErrorAction SilentlyContinue | Select-Object -First 1 }

  # npm installs Codex as a .cmd shim. Resolve its JS entry point and launch it
  # through the already detected Node executable so Worker can use shell:false.
  if ($node) {
    foreach ($shim in (Get-Command 'codex.cmd' -All -ErrorAction SilentlyContinue)) {
      $entry = Join-Path (Split-Path -Parent $shim.Source) 'node_modules\@openai\codex\bin\codex.js'
      if (Test-Path -LiteralPath $entry -PathType Leaf) {
        $key = "$($node.Source)|$entry"
        if ($seen.Add($key)) {
          $candidates.Add([pscustomobject]@{
            Command = $node.Source
            GlobalArgs = @($entry)
            Display = "$($shim.Source) via Node.js"
          })
        }
      }
    }
  }

  foreach ($binary in (Get-Command 'codex.exe' -All -ErrorAction SilentlyContinue)) {
    $key = "$($binary.Source)|"
    if ($seen.Add($key)) {
      $candidates.Add([pscustomobject]@{ Command = $binary.Source; GlobalArgs = @(); Display = $binary.Source })
    }
  }

  if ($env:LOCALAPPDATA) {
    $codexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
    if (Test-Path -LiteralPath $codexBinRoot -PathType Container) {
      $binaries = Get-ChildItem -LiteralPath $codexBinRoot -Filter 'codex.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending
      foreach ($binary in $binaries) {
        $key = "$($binary.FullName)|"
        if ($seen.Add($key)) {
          $candidates.Add([pscustomobject]@{ Command = $binary.FullName; GlobalArgs = @(); Display = $binary.FullName })
        }
      }
    }
  }

  return $candidates.ToArray()
}

function Test-CodexReadiness {
  $candidates = @(Get-CodexLaunchCandidates)
  if ($candidates.Count -eq 0) {
    return [pscustomobject]@{ Ready = $false; Detail = '未找到可由 Worker 直接运行的 Codex CLI'; ModelsOutput = ''; Command = $null; GlobalArgs = @() }
  }

  $failures = @()
  foreach ($candidate in $candidates) {
    if ($SkipReadiness) {
      return [pscustomobject]@{
        Ready = $true
        Detail = '已跳过登录检查'
        ModelsOutput = ''
        Command = $candidate.Command
        GlobalArgs = @($candidate.GlobalArgs)
      }
    }
    $versionArgs = @($candidate.GlobalArgs) + @('--version')
    $loginArgs = @($candidate.GlobalArgs) + @('login', 'status')
    $version = Invoke-ReadinessCommand -Command $candidate.Command -Arguments $versionArgs
    $login = Invoke-ReadinessCommand -Command $candidate.Command -Arguments $loginArgs
    $versionConfirmed = $version.Ok -or $version.Output -match '(?i)\bcodex-cli\s+v?\d+\.\d+\.\d+\b'
    $loginConfirmed = $login.Output -match '(?i)\bLogged in using\b'
    $loginRejected = $login.Output -match '(?i)\bNot logged in\b'
    $loginReady = $loginConfirmed -or ($login.Ok -and $login.Output -and -not $loginRejected)
    if ($versionConfirmed -and $loginReady) {
      return [pscustomobject]@{
        Ready = $true
        Detail = $login.Output
        ModelsOutput = ''
        Command = $candidate.Command
        GlobalArgs = @($candidate.GlobalArgs)
      }
    }
    $failures += "command=$($candidate.Display); version exit=$($version.ExitCode); login exit=$($login.ExitCode); $(($version.Output, $login.Output | Where-Object { $_ }) -join '; ')"
  }

  return [pscustomobject]@{
    Ready = $false
    Detail = $failures -join ' | '
    ModelsOutput = ''
    Command = $null
    GlobalArgs = @()
  }
}

function Find-AgyCommand {
  if ($env:LOCALAPPDATA) {
    $candidate = Join-Path $env:LOCALAPPDATA 'agy\bin\agy.exe'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $command = Get-Command 'agy.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  $command = Get-Command 'agy' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  return $null
}

function Test-AntigravityReadiness {
  $command = Find-AgyCommand
  if (-not $command) {
    return [pscustomobject]@{ Ready = $false; Detail = '未找到 agy 命令'; ModelsOutput = ''; Command = $null }
  }
  if ($SkipReadiness) {
    return [pscustomobject]@{ Ready = $true; Detail = '已跳过登录检查'; ModelsOutput = 'gemini-3.8-flash-low'; Command = $command }
  }
  $version = Invoke-ReadinessCommand -Command $command -Arguments @('--version')
  # agy models behaves differently when stdout is captured: some builds only
  # print its progress line. Let the authenticated CLI own the console like a
  # manual invocation, and use its process status for readiness.
  $models = Invoke-ReadinessCommand -Command $command -Arguments @('models') -PassThrough
  $versionConfirmed = $version.Ok -or $version.Output -match '(?i)\bv?\d+\.\d+\.\d+\b'
  $ready = $versionConfirmed -and $models.Ok
  $detail = if ($ready) {
    if ($version.Output) { $version.Output.Split("`n")[0] } else { 'Version check passed' }
  } else {
    "command=$command; version exit=$($version.ExitCode); models exit=$($models.ExitCode); $(($version.Output, $models.Output | Where-Object { $_ }) -join '; ')"
  }
  return [pscustomobject]@{
    Ready = $ready
    Detail = $detail
    ModelsOutput = if ($models.Ok) { 'gemini-3.8-flash-low' } else { '' }
    Command = $command
  }
}

function Select-AntigravityModel {
  param([string]$ModelsOutput)
  $override = [Environment]::GetEnvironmentVariable('A446_ANTIGRAVITY_MODEL', 'Process')
  if ($override -and $override.Trim()) { return $override.Trim() }

  $matches = @(
    [regex]::Matches(
      [string]$ModelsOutput,
      '(?i)\b(?:gemini|claude)-[a-z0-9][a-z0-9._-]*\b'
    ) | ForEach-Object { $_.Value } | Select-Object -Unique
  )

  foreach ($preferred in @(
    'gemini-3.8-flash-low',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.1-pro-high',
    'claude-sonnet-4-6'
  )) {
    if ($matches -contains $preferred) { return $preferred }
  }
  if ($matches.Count -gt 0) { return [string]$matches[0] }
  return 'gemini-3.8-flash-low'
}

function New-WorkerConfiguration {
  param(
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Model,
    [string]$CodexCommand = 'codex',
    [string[]]$CodexGlobalArgs = @(),
    [string]$AntigravityCommand = 'agy'
  )

  $roleCapabilities = switch ($Profile.Role) {
    'planner' { @('task.execute', 'planning', 'coding', 'document_editing', 'artifact-upload', 'artifact-download', 'pause', 'resume', 'cancel') }
    'executor' { @('task.execute', 'coding', 'document_editing', 'artifact-upload', 'artifact-download', 'pause', 'resume', 'cancel') }
    'reviewer' { @('task.execute', 'reasoning', 'review', 'document_editing', 'artifact-upload', 'artifact-download', 'pause', 'resume', 'cancel') }
    default { throw "Unsupported role: $($Profile.Role)" }
  }
  $modelCapabilities = switch ($Profile.Role) {
    'planner' { @('planning', 'coding', 'reasoning', 'document_editing') }
    'executor' { @('coding', 'reasoning', 'document_editing') }
    'reviewer' { @('reasoning', 'review', 'document_editing') }
  }

  $providerName = if ($Profile.Provider -eq 'Codex') { 'openai' } else { 'google' }
  $probeTimeoutMs = if ($Profile.Provider -eq 'Codex') { 5000 } else { 15000 }
  $adapter = if ($Profile.Provider -eq 'Codex') {
    [ordered]@{
      type = 'codex'
      command = $CodexCommand
      globalArgs = @($CodexGlobalArgs)
      execArgs = @()
      sandbox = 'workspace-write'
      approvalPolicy = 'never'
      maxOutputChars = 200000
    }
  } else {
    [ordered]@{
      type = 'antigravity'
      command = $AntigravityCommand
      args = @('--mode', 'accept-edits')
      stripProxyEnv = $false
      resumeOnStart = $true
      shutdownTimeoutMs = 5000
    }
  }

  return [ordered]@{
    agentId = $Profile.AgentId
    deviceId = $Profile.DeviceId
    account = [ordered]@{
      id = "$($Profile.Provider.ToLowerInvariant())-cli"
      provider = $providerName
      plan = 'Unknown'
      label = "$($Profile.Provider) CLI"
    }
    roles = @($Profile.Role)
    models = @(if ($Model) {
      [ordered]@{
        id = $Model
        capabilities = $modelCapabilities
        quota = [ordered]@{ state = 'Unknown'; source = 'unavailable'; windows = @() }
      }
    })
    hubUrl = $HubUrl
    authTokenEnv = $Profile.TokenEnvironment
    authRequired = $true
    heartbeatMs = 5000
    stateFile = "../state/$($Profile.AgentId).json"
    workspace = "../workspaces/$($Profile.AgentId)"
    capabilities = $roleCapabilities
    policy = [ordered]@{
      requireTaskSpec = $true
      defaultDenyUnknownPermissions = $true
      allowedPermissions = @('project_workspace', 'terminal')
      deniedPermissions = @('browser', 'system_settings')
    }
    checkpoints = [ordered]@{ includeOutput = $true; maxOutputChars = 200000 }
    artifacts = [ordered]@{
      centralStore = $true
      apiUrl = $artifactBaseUrl
      maxFileBytes = 104857600
    }
    capabilityProbe = [ordered]@{
      intervalMs = 60000
      timeoutMs = $probeTimeoutMs
      stripProxyEnv = $false
      tools = @(
        [ordered]@{ name = 'git'; command = 'git'; args = @('--version'); capabilities = @('git') }
      )
      services = @()
    }
    reconnect = [ordered]@{ baseMs = 1000; maxMs = 30000 }
    tls = [ordered]@{ rejectUnauthorized = $true }
    adapter = $adapter
  }
}

function Save-JsonNoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)]$Value
  )
  $json = $Value | ConvertTo-Json -Depth 20
  [IO.File]::WriteAllText($Path, $json, $Utf8NoBom)
}

function Read-OptionalToken {
  param([Parameter(Mandatory = $true)]$Profile)
  Write-Host "`n$($Profile.AgentId) / $($Profile.DeviceId)" -ForegroundColor Yellow
  Write-Host '粘贴该身份的一次性 Worker Token；没有这个 Token 就直接按 Enter 跳过。'
  $secure = Read-Host 'Token（输入不会显示）' -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)).Trim()
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Get-LiveManagedProcesses {
  if (-not (Test-Path -LiteralPath $ProcessFile -PathType Leaf)) { return @() }
  try {
    $parsed = Get-Content -LiteralPath $ProcessFile -Raw | ConvertFrom-Json
  } catch {
    return @()
  }

  # Windows PowerShell 5.1 returns a top-level JSON array as one nested
  # System.Object[] pipeline item. Flatten it explicitly before inspecting PIDs.
  $records = New-Object 'System.Collections.Generic.List[object]'
  foreach ($item in $parsed) {
    if ($item -is [System.Array]) {
      foreach ($record in $item) {
        if ($null -ne $record) { $records.Add($record) }
      }
    } elseif ($null -ne $item) {
      $records.Add($item)
    }
  }

  $liveRecords = New-Object 'System.Collections.Generic.List[object]'
  foreach ($record in $records) {
    $processIdValue = @($record.processId)
    if ($processIdValue.Count -ne 1) { continue }
    $pidValue = 0
    if (-not [int]::TryParse([string]$processIdValue[0], [ref]$pidValue)) { continue }
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    if ($record.processStartedAt) {
      try {
        $recordedStart = [DateTime]::Parse([string]$record.processStartedAt).ToUniversalTime()
        $actualStart = $process.StartTime.ToUniversalTime()
        if ([Math]::Abs(($recordedStart - $actualStart).TotalSeconds) -gt 2) { continue }
      } catch {
        continue
      }
    }
    $liveRecords.Add($record)
  }

  return $liveRecords.ToArray()
}

Write-Step '检查本机运行环境'
if (-not (Test-Path -LiteralPath $HubRoot -PathType Container)) {
  throw "Agent Hub directory is missing: $HubRoot"
}
if (-not (Test-Path -LiteralPath $ChildScript -PathType Leaf)) {
  throw "Worker child launcher is missing: $ChildScript"
}
$hubUri = [uri]$HubUrl
$artifactUri = [uri]$ArtifactApiUrl
if (-not $hubUri.IsAbsoluteUri -or $hubUri.Scheme -ne 'wss' -or $hubUri.AbsolutePath -ne '/worker') { throw 'HubUrl 必须是 wss://服务器/worker。' }
if (-not $artifactUri.IsAbsoluteUri -or $artifactUri.Scheme -ne 'https') { throw 'ArtifactApiUrl 必须使用 https://。' }
if ($hubUri.UserInfo -or $artifactUri.UserInfo -or $hubUri.Query -or $artifactUri.Query -or $hubUri.Fragment -or $artifactUri.Fragment) { throw '服务器地址不能包含凭据、查询参数或片段。' }
if ($hubUri.DnsSafeHost -ne $artifactUri.DnsSafeHost -or $hubUri.Port -ne $artifactUri.Port) { throw 'Worker 与文件 API 必须连接同一个 HTTPS/WSS 服务器。' }
if ($artifactUri.AbsolutePath -notin @('', '/', '/api', '/api/')) { throw '文件 API 地址应为服务器 HTTPS 地址或其 /api 路径。' }
$webOrigin = $artifactUri.GetLeftPart([UriPartial]::Authority)
$artifactBaseUrl = "$webOrigin/api"
if (-not (Test-Path -LiteralPath $BootstrapScript -PathType Leaf)) { throw 'Portable Node bootstrap script is missing.' }
. $BootstrapScript
$nodePath = Resolve-WorkerNode -HubRoot $HubRoot -ValidateOnly:$ValidateOnly
$env:PATH = (Split-Path -Parent $nodePath) + ';' + $env:PATH
Write-Host "Node.js: $([string](& $nodePath --version))"

$codexStatus = [pscustomobject]@{ Ready = $false; Detail = '本次未选择 Codex'; ModelsOutput = ''; Command = $null; GlobalArgs = @() }
$antigravityStatus = [pscustomobject]@{ Ready = $false; Detail = '本次未选择 Antigravity'; ModelsOutput = ''; Command = $null }
if ($Provider -in @('Auto', 'Codex', 'Both')) { $codexStatus = Test-CodexReadiness }
if ($Provider -in @('Auto', 'Antigravity', 'Both')) { $antigravityStatus = Test-AntigravityReadiness }
if ($Provider -ne 'Antigravity') { Write-Host "Codex:       $(if ($codexStatus.Ready) { '可用' } else { '不可用' }) - $($codexStatus.Detail)" }
if ($Provider -ne 'Codex') { Write-Host "Antigravity: $(if ($antigravityStatus.Ready) { '可用' } else { '不可用' }) - $($antigravityStatus.Detail)" }

$useCodex = $false
$useAntigravity = $false
switch ($Provider) {
  'Auto' {
    $useCodex = $codexStatus.Ready
    $useAntigravity = $antigravityStatus.Ready
  }
  'Codex' {
    if (-not $codexStatus.Ready) { throw "Codex 未就绪：$($codexStatus.Detail)" }
    $useCodex = $true
  }
  'Antigravity' {
    if (-not $antigravityStatus.Ready) { throw "Antigravity 未就绪：$($antigravityStatus.Detail)" }
    $useAntigravity = $true
  }
  'Both' {
    if (-not $codexStatus.Ready) { throw "Codex 未就绪：$($codexStatus.Detail)" }
    if (-not $antigravityStatus.Ready) { throw "Antigravity 未就绪：$($antigravityStatus.Detail)" }
    $useCodex = $true
    $useAntigravity = $true
  }
}
if (-not $useCodex -and -not $useAntigravity) {
  throw '本机没有已登录且可用的 Codex 或 Antigravity CLI。'
}

$codexModel = [string][Environment]::GetEnvironmentVariable('A446_CODEX_MODEL', 'Process')
$codexModel = $codexModel.Trim()
$antigravityModel = Select-AntigravityModel -ModelsOutput $antigravityStatus.ModelsOutput
$codexDeviceId = Get-EnvironmentOrDefault -Name 'A446_CODEX_DEVICE_ID' -Default 'device-01'
$antigravityDeviceId = Get-EnvironmentOrDefault -Name 'A446_ANTIGRAVITY_DEVICE_ID' -Default 'device-02'

$profiles = @()
if ($useCodex) {
  $profiles += [pscustomobject]@{
    Provider = 'Codex'
    Role = 'planner'
    AgentId = Get-EnvironmentOrDefault -Name 'A446_CODEX_PLANNER_AGENT_ID' -Default 'codex-planner-01'
    DeviceId = $codexDeviceId
    TokenEnvironment = 'A446_CODEX_PLANNER_TOKEN'
    Model = $codexModel
  }
  $profiles += [pscustomobject]@{
    Provider = 'Codex'
    Role = 'executor'
    AgentId = Get-EnvironmentOrDefault -Name 'A446_CODEX_EXECUTOR_AGENT_ID' -Default 'codex-executor-01'
    DeviceId = $codexDeviceId
    TokenEnvironment = 'A446_CODEX_EXECUTOR_TOKEN'
    Model = $codexModel
  }
}
if ($useAntigravity) {
  $profiles += [pscustomobject]@{
    Provider = 'Antigravity'
    Role = 'reviewer'
    AgentId = Get-EnvironmentOrDefault -Name 'A446_ANTIGRAVITY_REVIEWER_AGENT_ID' -Default 'antigravity-reviewer-01'
    DeviceId = $antigravityDeviceId
    TokenEnvironment = 'A446_ANTIGRAVITY_REVIEWER_TOKEN'
    Model = $antigravityModel
  }
}

foreach ($profile in $profiles) {
  Assert-Identifier -Name 'agentId' -Value $profile.AgentId
  Assert-Identifier -Name 'deviceId' -Value $profile.DeviceId
}
$duplicateAgentIds = @($profiles | Group-Object AgentId | Where-Object Count -gt 1 | Select-Object -ExpandProperty Name)
if ($duplicateAgentIds.Count -gt 0) {
  throw "Each Worker needs a distinct agentId. Duplicate: $($duplicateAgentIds -join ', ')"
}

Write-Step '准备 Worker 运行文件'
New-Item -ItemType Directory -Path $ConfigRoot -Force | Out-Null
if (-not $ValidateOnly -and -not (Test-Path -LiteralPath (Join-Path $HubRoot 'node_modules\ws'))) {
  $bundledNpm = Join-Path (Split-Path -Parent $nodePath) 'npm.cmd'
  $npmCommand = if (Test-Path -LiteralPath $bundledNpm) { Get-Item -LiteralPath $bundledNpm } else { Get-Command 'npm.cmd' -ErrorAction SilentlyContinue }
  if (-not $npmCommand) { $npmCommand = Get-Command 'npm' -ErrorAction SilentlyContinue }
  if (-not $npmCommand) { throw '未找到 npm，无法安装 Agent Hub 依赖。' }
  Push-Location $HubRoot
  try {
    $npmPath = if ($npmCommand -is [IO.FileInfo]) { $npmCommand.FullName } else { $npmCommand.Source }
    & $npmPath ci --ignore-scripts --omit=dev --no-audit --no-fund --cache (Join-Path $RuntimeRoot 'npm-cache')
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

$configPaths = @{}
$codexAdapterCommand = if ($codexStatus.Command) { [string]$codexStatus.Command } else { 'codex' }
$codexAdapterGlobalArgs = @($codexStatus.GlobalArgs | ForEach-Object { [string]$_ })
$antigravityAdapterCommand = if ($antigravityStatus.Command) { [string]$antigravityStatus.Command } else { 'agy' }
foreach ($profile in $profiles) {
  $configPath = Join-Path $ConfigRoot "$($profile.AgentId).json"
  $workerConfiguration = New-WorkerConfiguration `
    -Profile $profile `
    -Model $profile.Model `
    -CodexCommand $codexAdapterCommand `
    -CodexGlobalArgs $codexAdapterGlobalArgs `
    -AntigravityCommand $antigravityAdapterCommand
  Save-JsonNoBom -Path $configPath -Value $workerConfiguration
  $configPaths[$profile.AgentId] = $configPath
  $modelLabel = if ($profile.Model) { $profile.Model } else { '使用本机 Codex CLI 默认模型' }
  Write-Host "已生成：$($profile.AgentId) [$modelLabel]"
}

$registrationFile = Join-Path $RuntimeRoot 'registration.json'
Save-JsonNoBom -Path $registrationFile -Value @($profiles | Select-Object AgentId, DeviceId, Provider, Role)
Write-Host "`n请让管理员在 $webOrigin 的 Worker 管理中按以下身份创建独立凭据：" -ForegroundColor Yellow
$profiles | Select-Object AgentId, DeviceId, Role | Format-Table -AutoSize | Out-Host
Write-Host "设备身份文件（不含凭据，可发给管理员）：$registrationFile"

if ($ValidateOnly) {
  Write-Host "`n配置验证模式完成；没有读取 Token，也没有启动 Worker。" -ForegroundColor Green
  exit 0
}

Write-Step '检查预发布服务器'
$health = Invoke-RestMethod -Uri "$artifactBaseUrl/health" -TimeoutSec 30
if ($health.ok -ne $true) { throw '服务器健康检查没有返回 ok=true。' }
Write-Host 'HTTPS 服务器可达。登录凭据由设备所有者在本机输入；任务执行会消耗对应账号额度。'

$powerShellCommand = Get-Command 'powershell.exe' -ErrorAction SilentlyContinue
if (-not $powerShellCommand) { $powerShellCommand = Get-Command 'pwsh' -ErrorAction SilentlyContinue }
if (-not $powerShellCommand) { throw '未找到可用于启动 Worker 窗口的 PowerShell。' }

$liveRecords = @(Get-LiveManagedProcesses)
$processRecords = @($liveRecords)
$startedCount = 0

# A child must inherit only the credential named by its own configuration.
# The double-click wrapper starts this script in a disposable PowerShell process,
# so clearing inherited Worker variables here does not change the user's shell.
foreach ($tokenName in @(
  'A446_WORKER_TOKEN',
  'HUB_TOKEN',
  'A446_CODEX_PLANNER_TOKEN',
  'A446_CODEX_EXECUTOR_TOKEN',
  'A446_ANTIGRAVITY_REVIEWER_TOKEN'
)) {
  Remove-Item "Env:$tokenName" -ErrorAction SilentlyContinue
}

foreach ($profile in $profiles) {
  $existing = $liveRecords | Where-Object { $_.agentId -eq $profile.AgentId } | Select-Object -First 1
  if ($existing) {
    Write-Host "跳过已运行的 $($profile.AgentId)，PID=$($existing.processId)。" -ForegroundColor DarkYellow
    continue
  }

  Remove-Item "Env:$($profile.TokenEnvironment)" -ErrorAction SilentlyContinue
  $token = Read-OptionalToken -Profile $profile
  if (-not $token) {
    Write-Host "已跳过 $($profile.AgentId)。" -ForegroundColor DarkYellow
    continue
  }

  try {
    Set-Item -Path "Env:$($profile.TokenEnvironment)" -Value $token
    $label = "$($profile.AgentId) ($($profile.Provider))"
    $childArguments = @(
      '-NoLogo',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', "`"$ChildScript`"",
      '-ConfigPath', "`"$($configPaths[$profile.AgentId])`"",
      '-Label', "`"$label`"",
      '-NodePath', "`"$nodePath`"",
      '-TokenEnvironment', $profile.TokenEnvironment
    )
    $process = Start-Process -FilePath $powerShellCommand.Source `
      -ArgumentList $childArguments `
      -WorkingDirectory $HubRoot `
      -WindowStyle Normal -PassThru
  } finally {
    Remove-Item "Env:$($profile.TokenEnvironment)" -ErrorAction SilentlyContinue
    $token = $null
  }

  Start-Sleep -Milliseconds 500
  if ($process.HasExited) {
    throw "$($profile.AgentId) 启动窗口立即退出，退出码 $($process.ExitCode)。"
  }
  $record = [pscustomobject]@{
    agentId = $profile.AgentId
    deviceId = $profile.DeviceId
    provider = $profile.Provider
    role = $profile.Role
    model = $profile.Model
    processId = $process.Id
    processStartedAt = (Get-Process -Id $process.Id).StartTime.ToUniversalTime().ToString('o')
    startedAt = (Get-Date).ToUniversalTime().ToString('o')
    configPath = $configPaths[$profile.AgentId]
  }
  $processRecords += $record
  $startedCount += 1
  Save-JsonNoBom -Path $ProcessFile -Value @($processRecords)
  Write-Host "已启动 $($profile.AgentId)，PID=$($process.Id)。" -ForegroundColor Green
}

Save-JsonNoBom -Path $ProcessFile -Value @($processRecords)

if ($startedCount -eq 0 -and $liveRecords.Count -eq 0) {
  throw '没有启动任何 Worker：所有 Token 都被跳过。'
}

Write-Step '启动完成'
Write-Host "控制台：$webOrigin" -ForegroundColor Green
Write-Host '每个 Worker 都在独立窗口运行；关闭对应窗口即可停止该 Worker。'
Write-Host 'Token 只传给对应子进程，没有写入配置、日志或进程参数。'
