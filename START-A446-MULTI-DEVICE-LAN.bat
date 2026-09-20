@echo off
setlocal EnableExtensions
chcp 65001 >nul
title A446 Multi-Device LAN Launcher

set "A446_MODE=%~1"
if /I "%A446_MODE%"=="coordinator" goto run
if /I "%A446_MODE%"=="worker" goto run
if /I "%A446_MODE%"=="preflight" goto run
if /I "%A446_MODE%"=="stop" goto stop

echo.
echo A446 Multi-Device LAN Launcher
echo.
echo   1. Coordinator device (Hub + Web + local Agents)
echo   2. Worker device (connect to coordinator)
echo   3. Environment preflight only
echo   4. Stop running A446 LAN instances
echo.
choice /C 1234 /N /M "Select [1/2/3/4]: "
if errorlevel 4 goto stop
if errorlevel 3 set "A446_MODE=preflight"
if errorlevel 2 if not errorlevel 3 set "A446_MODE=worker"
if errorlevel 1 if not errorlevel 2 set "A446_MODE=coordinator"

:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-lan-multidevice.ps1" -Mode "%A446_MODE%"
set "A446_EXIT=%ERRORLEVEL%"
if not "%A446_EXIT%"=="0" (
  echo.
  echo Startup failed. Exit code: %A446_EXIT%
  pause
)
exit /B %A446_EXIT%

:stop
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-lan-multidevice.ps1"
pause
exit /B 0
