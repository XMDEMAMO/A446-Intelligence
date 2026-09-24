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
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )
  try {
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

function Test-CodexReadiness {
  # Prefer the native Windows shims over codex.ps1. The npm PowerShell shim can
  # print a successful login status without setting $LASTEXITCODE reliably.
  $command = $null
  foreach ($name in @('codex.cmd', 'codex.exe', 'codex')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { break }
  }
  if (-not $command) {
    return [pscustomobject]@{ Ready = $false; Detail = '未找到 codex 命令'; ModelsOutput = '' }
  }
  if ($SkipReadiness) {
    return [pscustomobject]@{ Ready = $true; Detail = '已跳过登录检查'; ModelsOutput = '' }
  }
  $version = Invoke-ReadinessCommand -Command $command.Source -Arguments @('--version')
  $login = Invoke-ReadinessCommand -Command $command.Source -Arguments @('login', 'status')
  $detail = if ($version.Ok -and $login.Ok) {
    $login.Output
  } else {
    (($version.Output, $login.Output | Where-Object { $_ }) -join '; ')
  }
  return [pscustomobject]@{
    Ready = ($version.Ok -and $login.Ok)
    Detail = $detail
    ModelsOutput = ''
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
    return [pscustomobject]@{ Ready = $false; Detail = '未找到 agy 命令'; ModelsOutput = '' }
  }
  if ($SkipReadiness) {
    return [pscustomobject]@{ Ready = $true; Detail = '已跳过登录检查'; ModelsOutput = 'gemini-3.8-flash-low' }
  }
  $version = Invoke-ReadinessCommand -Command $command -Arguments @('--version')
  $models = Invoke-ReadinessCommand -Command $command -Arguments @('models')
  $detail = if ($version.Ok -and $models.Ok) {
    $version.Output.Split("`n")[0]
  } else {
    (($version.Output, $models.Output | Where-Object { $_ }) -join '; ')
  }
  return [pscustomobject]@{
    Ready = ($version.Ok -and $models.Ok)
    Detail = $detail
    ModelsOutput = $models.Output
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
    [Parameter(Mandatory = $true)][string]$Model
  )

  $roleCapabilities = switch ($Profile.Role) {
    'planner' { @('task.execute', 'planning', 'coding', 'document_editing', 'pause', 'resume', 'cancel') }
    'executor' { @('task.execute', 'coding', 'document_editing', 'pause', 'resume', 'cancel') }
    'reviewer' { @('task.execute', 'reasoning', 'review', 'document_editing', 'pause', 'resume', 'cancel') }
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
      command = 'codex'
      globalArgs = @()
      execArgs = @()
      sandbox = 'workspace-write'
      approvalPolicy = 'never'
      maxOutputChars = 200000
    }
  } else {
    [ordered]@{
      type = 'antigravity'
      command = 'agy'
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
    models = @(
      [ordered]@{
        id = $Model
        capabilities = $modelCapabilities
        quota = [ordered]@{ state = 'Unknown'; source = 'unavailable'; windows = @() }
      }
    )
    hubUrl = $HubUrl
    authTokenEnv = $Profile.TokenEnvironment
    authRequired = $true
    heartbeatMs = 5000
    stateFile = "../state/$($Profile.AgentId).json"
    workspace = "../workspaces/$($Profile.AgentId)"
    capabilities = $roleCapabilities
    policy = [ordered]@{
      requireTaskSpec = $false
      defaultDenyUnknownPermissions = $true
      allowedPermissions = @('project_workspace', 'terminal')
      deniedPermissions = @('browser', 'system_settings')
    }
    checkpoints = [ordered]@{ includeOutput = $true; maxOutputChars = 200000 }
    artifacts = [ordered]@{
      centralStore = $true
      apiUrl = $ArtifactApiUrl
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
    $records = @(Get-Content -LiteralPath $ProcessFile -Raw | ConvertFrom-Json)
  } catch {
    return @()
  }
return @($records | Where-Object {
    $pidValue = [int]$_.processId
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    if (-not $process) { return $false }
    if ($_.processStartedAt) {
      try {
        $recordedStart = [DateTime]::Parse([string]$_.processStartedAt).ToUniversalTime()
        $actualStart = $process.StartTime.ToUniversalTime()
        if ([Math]::Abs(($recordedStart - $actualStart).TotalSeconds) -gt 2) { return $false }
      } catch {
        return $false
      }
    }
    return $true
  })
}

Write-Step '检查本机运行环境'
if (-not (Test-Path -LiteralPath $HubRoot -PathType Container)) {
  throw "Agent Hub directory is missing: $HubRoot"
}
if (-not (Test-Path -LiteralPath $ChildScript -PathType Leaf)) {
  throw "Worker child launcher is missing: $ChildScript"
}
if ($HubUrl -notmatch '^wss://') { throw 'HubUrl 必须使用 wss://。' }
if ($ArtifactApiUrl -notmatch '^https://') { throw 'ArtifactApiUrl 必须使用 https://。' }
$nodeCommand = Get-Command 'node' -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw '未找到 Node.js；需要 Node.js 20 或更高版本。' }
$nodeVersion = (& $nodeCommand.Source --version).Trim()
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 20) { throw "Node.js 版本过低：$nodeVersion；需要 20 或更高版本。" }

$codexStatus = Test-CodexReadiness
$antigravityStatus = Test-AntigravityReadiness
Write-Host "Codex:       $(if ($codexStatus.Ready) { '可用' } else { '不可用' }) - $($codexStatus.Detail)"
Write-Host "Antigravity: $(if ($antigravityStatus.Ready) { '可用' } else { '不可用' }) - $($antigravityStatus.Detail)"

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

$codexModel = Get-EnvironmentOrDefault -Name 'A446_CODEX_MODEL' -Default 'gpt-5.6-sol'
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
  $npmCommand = Get-Command 'npm.cmd' -ErrorAction SilentlyContinue
  if (-not $npmCommand) { $npmCommand = Get-Command 'npm' -ErrorAction SilentlyContinue }
  if (-not $npmCommand) { throw '未找到 npm，无法安装 Agent Hub 依赖。' }
  Push-Location $HubRoot
  try {
    & $npmCommand.Source ci --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm ci 失败，退出码 $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

$configPaths = @{}
foreach ($profile in $profiles) {
  $configPath = Join-Path $ConfigRoot "$($profile.AgentId).json"
  Save-JsonNoBom -Path $configPath -Value (New-WorkerConfiguration -Profile $profile -Model $profile.Model)
  $configPaths[$profile.AgentId] = $configPath
  Write-Host "已生成：$($profile.AgentId) [$($profile.Model)]"
}

if ($ValidateOnly) {
  Write-Host "`n配置验证模式完成；没有读取 Token，也没有启动 Worker。" -ForegroundColor Green
  exit 0
}

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
      '-TokenEnvironment', $profile.TokenEnvironment
    )
    $process = Start-Process -FilePath $powerShellCommand.Source `
      -ArgumentList $childArguments `
      -WorkingDirectory $HubRoot `
      -PassThru
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
Write-Host "控制台：$ArtifactApiUrl" -ForegroundColor Green
Write-Host '每个 Worker 都在独立窗口运行；关闭对应窗口即可停止该 Worker。'
Write-Host 'Token 只传给对应子进程，没有写入配置、日志或进程参数。'
