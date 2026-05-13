@echo off
title Malika dev - GO
color 0A
cd /d "%~dp0"

echo.
echo [STEP 1] Killing all node processes
taskkill /F /IM node.exe 1>nul 2>&1
timeout /t 2 /nobreak >nul

echo [STEP 2] Force-clearing port 3001
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001"') do (
    echo   killing PID %%a
    taskkill /F /PID %%a 1>nul 2>&1
)

echo [STEP 3] Removing .next cache
if exist "apps\web\.next" rmdir /S /Q "apps\web\.next"
if exist "apps\web\node_modules\.cache" rmdir /S /Q "apps\web\node_modules\.cache"
echo   done

echo [STEP 4] Checking pnpm
where pnpm
if errorlevel 1 (
    echo   pnpm not in PATH - trying npx
    npx pnpm --filter web dev
    goto :end
)

echo [STEP 5] Starting dev server (Ctrl+C to stop)
echo =====================================================
pnpm --filter web dev

:end
echo.
echo [DONE OR ERROR - check above]
pause
