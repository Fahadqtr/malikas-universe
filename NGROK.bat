@echo off
title Malika Ngrok Manager

REM Kill any stale ngrok
taskkill /F /FI "WINDOWTITLE eq Malika Ngrok*" >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Spawn ngrok directly in a keepalive cmd
start "Malika Ngrok" cmd /k "title Malika Ngrok && cd /d C:\Projects\malikas-universe && node NGROK.js"

echo Ngrok tunnel starting. URL will appear in:
echo   C:\Projects\malikas-universe\ngrok-url.txt
echo Wait ~10 seconds.
timeout /t 3 /nobreak >nul
exit
