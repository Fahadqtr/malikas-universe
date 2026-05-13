@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Phase 8 — Marketplace Sync Setup

echo.
echo =====================================================
echo   PHASE 8 SETUP - Auto-everything
echo =====================================================
echo.

echo [1/6] Killing any node process on port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done.
echo.

echo [2/6] Clearing Next.js build cache...
if exist "apps\web\.next" (
    rmdir /S /Q "apps\web\.next"
    echo       Cache cleared.
) else (
    echo       Nothing to clear.
)
echo.

echo [3/6] Copying migration SQL to your clipboard...
powershell -NoProfile -Command "Get-Content -Raw -Encoding UTF8 'scripts\migration-0006.sql' | Set-Clipboard"
echo       Migration is now in your clipboard.
echo.

echo [4/6] Opening Supabase SQL Editor in your browser...
start "" "https://supabase.com/dashboard/project/awlevukqqsaxvifrfteb/sql/new"
echo.

echo [5/6] Opening .env.local in Notepad (to add Shopify credentials)...
start notepad "apps\web\.env.local"
echo.

echo =====================================================
echo   WHAT TO DO NOW:
echo =====================================================
echo.
echo   A. In the SUPABASE TAB that just opened:
echo      1. Click inside the SQL editor
echo      2. Press Ctrl+V        (SQL is in clipboard)
echo      3. Click Run           (or Ctrl+Enter)
echo      4. Confirm 5 rows show in the result
echo.
echo   B. In the NOTEPAD that just opened:
echo      1. Find SHOPIFY_STORE_DOMAIN= and put your domain
echo         (e.g. malikas-universe.myshopify.com)
echo      2. Find SHOPIFY_ADMIN_ACCESS_TOKEN= and paste your shpat_ token
echo      3. Ctrl+S to save, then close Notepad
echo.
echo   C. Then press any key here to restart the dev server.
echo.
echo   (If you don't have Shopify credentials yet — that's OK,
echo    leave them blank. Everything else still works.)
echo.
pause

echo.
echo [6/6] Starting dev server in a new window...
start "Malika dev server" cmd /k "cd /d %~dp0 && pnpm --filter web dev"
echo.

echo Waiting 12 seconds for Next.js to compile...
timeout /t 12 /nobreak >nul

echo Opening Review Dashboard in your browser...
start "" "http://localhost:3001/bulk-ai/review"
echo.

echo =====================================================
echo   DONE!
echo =====================================================
echo.
echo Hard-reload the browser tab (Ctrl+Shift+R).
echo.
echo Test flow:
echo   1. Open any draft from the Review Dashboard
echo   2. Press E to edit
echo   3. Set price (e.g. 35) and stock (e.g. 10)
echo   4. Click "Save and Approve"
echo   5. Watch the Shopify readiness bar go green
echo   6. Click "Push to Shopify"
echo   7. After success, click "View in Shopify Admin"
echo.
pause
