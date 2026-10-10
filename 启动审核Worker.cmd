@echo off
setlocal
chcp 65001 >nul
title A446 Antigravity Reviewer
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-staging-workers.ps1" -Provider Antigravity
set "A446_EXIT=%ERRORLEVEL%"
echo(
if not "%A446_EXIT%"=="0" echo Launcher failed. Keep this window open and share the error without credentials.
pause
exit /b %A446_EXIT%
