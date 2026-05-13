@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Nuke and Restart

echo.
echo =====================================================
echo   FULL RESET - Kills everything, clears all caches
echo =====================================================
echo.

echo [1/5] Killing ALL node processes (not just port 3001)...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM node.exe >nul 2>&1
timeout /t 1 /nobreak >nul
echo       Done.
echo.

echo [2/5] Force-killing anything on port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done.
echo.

echo [3/5] Deleting Next.js build cache (.next)...
if exist "apps\web\.next" (
    rmdir /S /Q "apps\web\.next"
    echo       .next removed.
)
echo.

echo [4/5] Deleting node_modules\.cache (webpack/swc cache)...
if exist "apps\web\node_modules\.cache" (
    rmdir /S /Q "apps\web\node_modules\.cache"
    echo       node_modules\.cache removed.
) else (
    echo       Nothing to remove.
)
if exist "node_modules\.cache" (
    rmdir /S /Q "node_modules\.cache"
    echo       Root .cache also removed.
)
echo.

echo [5/5] Starting dev server in foreground...
echo       (Watch this window for errors. Ctrl+C to stop later.)
echo.
echo =====================================================
echo   After "Ready in X seconds" appears:
echo   1. Open browser
echo   2. Go to http://localhost:3001/bulk-ai/review
echo   3. Hard-reload with Ctrl+Shift+R
echo =====================================================
echo.

call pnpm --filter web dev
