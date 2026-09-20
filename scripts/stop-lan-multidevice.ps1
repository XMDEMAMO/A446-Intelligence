param(
  [int]$HubPort = 8787,
  [int]$WebPort = 5173
)

$ErrorActionPreference = 'SilentlyContinue'

Write-Host ''
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host '   Stopping A446 Multi-Device LAN        ' -ForegroundColor Cyan
Write-Host '=========================================' -ForegroundColor Cyan
Write-Host ''

$stoppedCount = 0
$stoppedPids = @()

# 1. Stop processes listening on Hub / Web ports
$connections = Get-NetTCPConnection -LocalPort $HubPort, $WebPort -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $connections) {
  $p = Get-Process -Id $conn.OwningProcess -ErrorAction SilentlyContinue
  if ($p -and ($stoppedPids -notcontains $p.Id)) {
    Write-Host "Stopping process on port $($conn.LocalPort): PID $($p.Id) ($($p.ProcessName))..." -ForegroundColor Yellow
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $stoppedPids += $p.Id
    $stoppedCount += 1
  }
}

# 2. Stop any remaining A446 node processes (Hub, Workers, Vite)
$nodeProcesses = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue
foreach ($np in $nodeProcesses) {
  if ($stoppedPids -contains $np.ProcessId) { continue }
  $cmd = [string]$np.CommandLine
  if ($cmd -match 'mock-hub-cli\.mjs' -or $cmd -match 'worker-cli\.mjs' -or ($cmd -match 'vite\.js' -and $cmd -match '5173')) {
    Write-Host "Stopping A446 background process: PID $($np.ProcessId)..." -ForegroundColor Yellow
    Stop-Process -Id $np.ProcessId -Force -ErrorAction SilentlyContinue
    $stoppedPids += $np.ProcessId
    $stoppedCount += 1
  }
}

Write-Host ''
if ($stoppedCount -gt 0) {
  Write-Host "Successfully stopped $stoppedCount A446 LAN process(es)." -ForegroundColor Green
} else {
  Write-Host "No active A446 LAN processes or port bindings were detected." -ForegroundColor Green
}
Write-Host ''
