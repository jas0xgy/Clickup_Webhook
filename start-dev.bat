@echo off
setlocal
cd /d "%~dp0"
if errorlevel 1 exit /b 1

where.exe cloudflared >nul 2>nul
if errorlevel 1 (
    echo cloudflared was not found on PATH.
    echo Install cloudflared or add it to PATH, then run this launcher again.
    pause
    exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-dev.ps1"
if errorlevel 1 (
    echo Start cancelled or failed.
    pause
    exit /b 1
)

echo Starting the temporary Cloudflare Tunnel and ClickUp webhook sync in a separate window...
start "ClickUp Cloudflare Tunnel" cmd.exe /k "node scripts\sync-dev-webhook.js"
if errorlevel 1 (
    echo Could not open the Cloudflare Tunnel window.
    pause
    exit /b 1
)

call npm.cmd run dev
if errorlevel 1 (
    pause
    exit /b 1
)
