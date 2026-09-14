$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$PidFile = Join-Path $ProjectRoot 'var/demo-pids.json'
if (-not (Test-Path -LiteralPath $PidFile)) {
  Write-Output 'No demo PID file found.'
  exit 0
}

$State = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json
foreach ($Entry in $State.processes) {
  $ProcessInfo = Get-Process -Id $Entry.pid -ErrorAction SilentlyContinue
  if (-not $ProcessInfo) { continue }
  if ($ProcessInfo.ProcessName -ne 'node') {
    Write-Warning "Skipped PID $($Entry.pid): it is not a Node process."
    continue
  }
  if (-not $Entry.startedAt) {
    Write-Warning "Skipped PID $($Entry.pid): the PID record has no start time."
    continue
  }
  $ExpectedStart = if ($Entry.startedAt -is [DateTime]) {
    $Entry.startedAt.ToUniversalTime()
  } else {
    [DateTimeOffset]::Parse([string]$Entry.startedAt).UtcDateTime
  }
  $ActualStart = $ProcessInfo.StartTime.ToUniversalTime()
  if ([Math]::Abs(($ActualStart - $ExpectedStart).TotalSeconds) -gt 2) {
    Write-Warning "Skipped PID $($Entry.pid): the process start time does not match the PID record."
    continue
  }
  Stop-Process -Id $Entry.pid -ErrorAction Stop
  Write-Output "Stopped $($Entry.name) (PID $($Entry.pid))."
}
Remove-Item -LiteralPath $PidFile
