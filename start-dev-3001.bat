@echo off
title Malika Dev 3001
echo Killing existing node processes...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo Clearing .next cache...
if exist "C:\Projects\malikas-universe\apps\web\.next" (
    rmdir /s /q "C:\Projects\malikas-universe\apps\web\.next" >nul 2>&1
)

echo Starting Next.js dev server on port 3001...
cd /d C:\Projects\malikas-universe\apps\web
echo ============================================
echo  Logs streaming below + writing to C:\Projects\malikas-universe\dev-log.txt
echo ============================================
npx next dev -p 3001 > C:\Projects\malikas-universe\dev-log.txt 2>&1
pause
