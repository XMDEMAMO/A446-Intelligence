@echo off
setlocal EnableExtensions
chcp 65001 >nul
title Stop A446 Multi-Device LAN

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-lan-multidevice.ps1"
echo.
pause
