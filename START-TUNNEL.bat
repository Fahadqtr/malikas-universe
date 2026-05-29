@echo off
title Malika Tunnel (port 3001)

REM Kill any existing tunnel
taskkill /F /IM lt.cmd /T >nul 2>&1

REM Clear old log
del /Q C:\Projects\malikas-universe\tunnel-log.txt >nul 2>&1

REM Start localtunnel in a new keepalive window, redirect output to log
start "Malika Tunnel" cmd /k "npx localtunnel --port 3001 ^> C:\Projects\malikas-universe\tunnel-log.txt 2^>^&1"

echo  Tunnel starting...
echo  Output streaming to: C:\Projects\malikas-universe\tunnel-log.txt
echo  Wait ~10 seconds then read that file for the URL.
timeout /t 3 /nobreak >nul
exit
