@echo off
title MALIKA - Start Everything
color 0B

echo  ============================================================
echo    MALIKA UNIVERSE - One-Click Launcher
echo  ============================================================
echo.
echo  This will start:
echo    1. Next.js dev server (port 3001)
echo    2. ngrok tunnel
echo    3. Health check + status report
echo    4. Open browser to /whatsapp-live
echo.
echo  Press any key to continue (or Ctrl+C to cancel).
pause >nul

echo.
echo  === Step 1: Clean up old processes ===
taskkill /F /IM node.exe /T >nul 2>&1
taskkill /F /IM ngrok.exe /T >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Malika Dev*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Malika Ngrok*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Malika Status*" >nul 2>&1
echo  Done.

timeout /t 3 /nobreak >nul

echo.
echo  === Step 2: Clear Next.js cache ===
if exist "C:\Projects\malikas-universe\apps\web\.next" (
    rmdir /s /q "C:\Projects\malikas-universe\apps\web\.next" >nul 2>&1
    echo  Cleared .next cache.
)

echo.
echo  === Step 3: Start Next.js dev server (port 3001) ===
start "Malika Dev" /MIN cmd /k "title Malika Dev && cd /d C:\Projects\malikas-universe\apps\web && npx next dev -p 3001"
echo  Spawned "Malika Dev" cmd window (minimized).

echo.
echo  === Step 4: Start ngrok tunnel ===
start "Malika Ngrok" /MIN cmd /k "title Malika Ngrok && ngrok http 3001"
echo  Spawned "Malika Ngrok" cmd window (minimized).

echo.
echo  === Step 5: Wait + Health probe ===
timeout /t 5 /nobreak >nul
start "Malika Status" cmd /k "title Malika Status && cd /d C:\Projects\malikas-universe && node STATUS.js"
echo  Spawned "Malika Status" cmd window (in front).

echo.
echo  === Step 6: Open browser ===
timeout /t 20 /nobreak >nul
start "" "http://localhost:3001/whatsapp-live"
echo  Opened http://localhost:3001/whatsapp-live in default browser.

echo.
echo  ============================================================
echo   DONE. Three windows are now running:
echo     1. "Malika Dev"    - Next.js dev server
echo     2. "Malika Ngrok"  - Public tunnel
echo     3. "Malika Status" - Health probe + URLs
echo.
echo   Look at "Malika Status" window for the ngrok webhook URL.
echo.
echo   To stop everything: run STOP-ALL.bat
echo  ============================================================
echo.
timeout /t 5 /nobreak >nul
exit
