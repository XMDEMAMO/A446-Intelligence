@echo off
setlocal
chcp 65001 >nul
title A446 预发布 Worker 启动器

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-staging-workers.ps1"
set "A446_EXIT=%ERRORLEVEL%"

echo.
if not "%A446_EXIT%"=="0" echo 启动失败，请保留上方错误信息。
pause
exit /b %A446_EXIT%
