@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo.
echo =====================================================
echo   BULK AI FIX - One Click Diagnostic + Restart
echo =====================================================
echo.

echo [1/5] Killing any node process on port 3001...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001" ^| findstr "LISTENING"') do (
    taskkill /F /PID %%a >nul 2>&1
)
echo       Done.
echo.

echo [2/5] Clearing Next.js build cache (apps\web\.next)...
if exist "apps\web\.next" (
    rmdir /S /Q "apps\web\.next"
    echo       Cache cleared.
) else (
    echo       No cache to clear.
)
echo.

echo [3/5] Running Bulk AI Doctor (checks DB schema, brands, probe insert)...
echo.
node scripts\bulk-ai-doctor.mjs
set DOCTOR_EXIT=%ERRORLEVEL%
echo.

if %DOCTOR_EXIT% NEQ 0 (
    echo =====================================================
    echo   DOCTOR DETECTED A PROBLEM - see message above
    echo =====================================================
    echo.
    if exist "scripts\fix-it.sql" (
        echo The SQL you need to run is in: scripts\fix-it.sql
        echo.
        echo I am opening it now AND the Supabase SQL Editor.
        echo Steps:
        echo   1. Ctrl+A then Ctrl+C in Notepad
        echo   2. Switch to Supabase tab
        echo   3. Ctrl+V into the editor
        echo   4. Click Run
        echo.
        start notepad "scripts\fix-it.sql"
        start "" "https://supabase.com/dashboard/project/awlevukqqsaxvifrfteb/sql/new"
        echo.
        echo After running the SQL, double-click this .bat again.
        pause
        exit /b
    )
)

echo [4/5] Starting dev server in a new window...
start "Malika dev" cmd /k "cd /d %~dp0 && pnpm --filter web dev"
echo       Server starting. Wait ~10 seconds.
timeout /t 10 /nobreak >nul
echo.

echo [5/5] Opening browser to /bulk-ai ...
start "" "http://localhost:3001/bulk-ai"
echo.

echo =====================================================
echo   DONE! If everything is green above, the pipeline
echo   is healthy. Hard-reload the browser (Ctrl+Shift+R)
echo   and drop your images.
echo =====================================================
echo.
pause
