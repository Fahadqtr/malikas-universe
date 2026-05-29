@echo off
title Malika Ngrok Setup

REM Kill any old cmd waiting for input
taskkill /F /FI "WINDOWTITLE eq Malika Ngrok*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq npm exec*" >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

REM Save authtoken (npx --yes auto-installs without prompt)
echo Saving ngrok authtoken (will auto-install if needed)...
call npx --yes ngrok config add-authtoken 1fOMqW0cQsj9iPc9PHNOsYG98ie_2zu4ZCaN5SBjRokGHmjPz
echo.
echo Authtoken saved.
echo.

REM Spawn ngrok tunnel in keepalive window
start "Malika Ngrok" cmd /k "title Malika Ngrok && cd /d C:\Projects\malikas-universe && node NGROK.js"

echo Ngrok tunnel starting. URL will appear in:
echo   C:\Projects\malikas-universe\ngrok-url.txt
echo.
timeout /t 5 /nobreak >nul
exit
