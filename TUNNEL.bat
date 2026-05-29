@echo off
title Malika Tunnel Manager

REM Kill any old tunnel
taskkill /F /FI "WINDOWTITLE eq Malika Localtunnel*" >nul 2>&1
timeout /t 1 /nobreak >nul

REM Spawn a new detached cmd that runs the tunnel
start "Malika Localtunnel" /MIN cmd /k "title Malika Localtunnel && cd /d C:\Projects\malikas-universe && node TUNNEL.js"

echo Tunnel window spawned (minimized). It will write URL to:
echo   C:\Projects\malikas-universe\tunnel-url.txt
echo.
echo Keep the "Malika Localtunnel" cmd window open. If you close it the tunnel dies.
timeout /t 3 /nobreak >nul
exit
