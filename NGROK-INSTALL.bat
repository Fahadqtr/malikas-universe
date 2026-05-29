@echo off
title Ngrok Install + Run

REM Kill any old
taskkill /F /FI "WINDOWTITLE eq Malika Ngrok*" >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo Installing ngrok globally via npm...
call npm install -g ngrok
echo.

echo Saving authtoken...
call ngrok config add-authtoken 1fOMqW0cQsj9iPc9PHNOsYG98ie_2zu4ZCaN5SBjRokGHmjPz
echo.

echo Starting ngrok http 3001 in keepalive window...
start "Malika Ngrok" cmd /k "title Malika Ngrok && cd /d C:\Projects\malikas-universe && ngrok http 3001 --log stdout > C:\Projects\malikas-universe\ngrok-log.txt 2>&1"

echo.
echo Tunnel starting. Wait 10 sec.
timeout /t 10 /nobreak >nul

REM Try to read the URL from the ngrok local API (port 4040)
echo Fetching URL from local ngrok API...
powershell -Command "$r = Invoke-WebRequest -Uri 'http://127.0.0.1:4040/api/tunnels' -UseBasicParsing; $j = $r.Content | ConvertFrom-Json; $u = $j.tunnels[0].public_url; $u | Out-File -Encoding utf8 C:\Projects\malikas-universe\ngrok-url.txt; Write-Host ('Ngrok URL: ' + $u)"

pause
