@echo off
title NUKE and START

echo Killing all node processes...
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM next.exe /T >nul 2>&1
timeout /t 5 /nobreak >nul

echo Verifying port 3001 is free...
:retry
netstat -ano | findstr ":3001" >nul
if not errorlevel 1 (
    echo Port still in use, killing PIDs...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001"') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    goto retry
)

echo Clearing .next and .turbo caches...
if exist "C:\Projects\malikas-universe\apps\web\.next" rmdir /s /q "C:\Projects\malikas-universe\apps\web\.next" >nul 2>&1
if exist "C:\Projects\malikas-universe\apps\web\.turbo" rmdir /s /q "C:\Projects\malikas-universe\apps\web\.turbo" >nul 2>&1
if exist "C:\Projects\malikas-universe\.turbo" rmdir /s /q "C:\Projects\malikas-universe\.turbo" >nul 2>&1

echo Starting fresh Next.js dev server...
cd /d C:\Projects\malikas-universe\apps\web

echo ============================================
echo Logs streaming to C:\Projects\malikas-universe\dev-log.txt
echo Wait 30-60 seconds for Tailwind compile to finish
echo ============================================
echo.

REM Use pnpm so workspace dependencies resolve correctly
call pnpm exec next dev -p 3001 > C:\Projects\malikas-universe\dev-log.txt 2>&1

echo.
echo Dev server exited
pause
