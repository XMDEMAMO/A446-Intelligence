@echo off
setlocal
chcp 65001 >nul
title A446 多设备局域网启动器

set "A446_MODE=%~1"
if /I "%A446_MODE%"=="coordinator" goto run
if /I "%A446_MODE%"=="worker" goto run
if /I "%A446_MODE%"=="preflight" goto run

echo.
echo A446 多设备局域网启动器
echo.
echo   1. 协调设备（Hub + 网页 + 本机 Agent）
echo   2. 执行设备（连接协调设备）
echo   3. 仅检查账号、模型、额度和本机环境
echo.
choice /C 123 /N /M "请选择 [1/2/3]: "
if errorlevel 3 set "A446_MODE=preflight"
if errorlevel 2 if not errorlevel 3 set "A446_MODE=worker"
if errorlevel 1 if not errorlevel 2 set "A446_MODE=coordinator"

:run
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-lan-multidevice.ps1" -Mode "%A446_MODE%"
set "A446_EXIT=%ERRORLEVEL%"
if not "%A446_EXIT%"=="0" (
  echo.
  echo 启动失败，退出代码：%A446_EXIT%
  pause
)
exit /B %A446_EXIT%
