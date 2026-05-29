@echo off
title MALIKA - Stop Everything
color 0C

echo  ============================================================
echo    Stopping all Malika services...
echo  ============================================================
echo.

echo  Killing Node processes (dev server, status probe)...
taskkill /F /IM node.exe /T >nul 2>&1

echo  Killing ngrok...
taskkill /F /IM ngrok.exe /T >nul 2>&1

echo  Closing Malika cmd windows...
taskkill /F /FI "WINDOWTITLE eq Malika Dev*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Malika Ngrok*" >nul 2>&1
taskkill /F /FI "WINDOWTITLE eq Malika Status*" >nul 2>&1

echo.
echo  Cleared port 3001:
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3001"') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo.
echo  ============================================================
echo   All Malika services stopped.
echo  ============================================================
timeout /t 3 /nobreak >nul
exit
