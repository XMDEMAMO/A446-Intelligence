@echo off
setlocal
chcp 65001 >nul
title A446 Private LAN Launcher

set "A446_MODE=%~1"
if /I "%A446_MODE%"=="server" goto run
if /I "%A446_MODE%"=="gemini" goto run

echo.
echo A446 Private LAN Launcher
echo Fixed server: 192.168.137.1
echo.
echo   1. Device 1: Server + Codex planner/executor
echo   2. Device 2: Gemini reviewer
echo.
choice /C 12 /N /M "Select [1/2]: "
if errorlevel 2 set "A446_MODE=gemini"
if errorlevel 1 if not errorlevel 2 set "A446_MODE=server"

:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-private-lan.ps1" -Mode "%A446_MODE%"
set "A446_EXIT=%ERRORLEVEL%"
if not "%A446_EXIT%"=="0" (
  echo.
  echo Startup failed. Exit code: %A446_EXIT%
  pause
)
exit /B %A446_EXIT%
