@echo off
title Malika Dev Restart (post env update)

echo Killing existing node processes...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 4 /nobreak >nul

echo Verifying port 3001 free...
:retry
netstat -ano | findstr ":3001" >nul
if not errorlevel 1 (
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    goto retry
)

echo Starting fresh Next.js dev server...
cd /d C:\Projects\malikas-universe\apps\web

REM Keep cmd open so we can read output
start "Malika Dev 3001" cmd /k "cd /d C:\Projects\malikas-universe\apps\web && npx next dev -p 3001"

echo.
echo  New "Malika Dev 3001" window opening. Wait 20s for "Ready"
timeout /t 3 /nobreak >nul
exit
