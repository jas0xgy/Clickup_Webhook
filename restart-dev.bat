@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev.ps1"
if errorlevel 1 (
    echo Restart cancelled or failed.
    pause
    exit /b 1
)

call npm.cmd run dev
if errorlevel 1 (
    pause
    exit /b 1
)
