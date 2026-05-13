@echo off
title Malika Restart

echo  ============================================
echo   MALIKA - Restart Dev Server
echo  ============================================
echo.

echo  [1/3] Stopping any running Node processes...
taskkill /F /IM node.exe /T >nul 2>&1
timeout /t 2 /nobreak >nul

echo  [2/3] Clearing Next.js cache...
if exist "C:\Projects\malikas-universe\apps\web\.next" (
    rmdir /s /q "C:\Projects\malikas-universe\apps\web\.next" >nul 2>&1
)

echo  [3/3] Starting fresh dev server...
cd /d C:\Projects\malikas-universe

REM Use cmd /k so the User PATH (with doppler) is inherited cleanly.
start "Malika Dev" cmd /k "cd /d C:\Projects\malikas-universe && doppler run -- pnpm dev"

echo.
echo  Done. New "Malika Dev" window opening.
echo  Wait 15-20 seconds for "Ready", then refresh http://localhost:3000/login
echo.
timeout /t 3 /nobreak >nul
exit
