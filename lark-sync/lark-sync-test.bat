@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0lark-sync.ps1" -Test
echo.
pause
