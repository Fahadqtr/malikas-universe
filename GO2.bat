@echo off
title Malika GO2
cd /d "%~dp0"
set LOG=%~dp0\go2.log

echo === GO2 starting at %DATE% %TIME% === > "%LOG%"
echo CWD: %CD% >> "%LOG%"

echo Step 1: killing node >> "%LOG%"
taskkill /F /IM node.exe >> "%LOG%" 2>&1
timeout /t 2 /nobreak >nul

echo Step 2: killing port 3001 >> "%LOG%"
netstat -aon ^| findstr ":3001" >> "%LOG%" 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":3001"') do (
    echo killing %%a >> "%LOG%"
    taskkill /F /PID %%a >> "%LOG%" 2>&1
)

echo Step 3: removing caches >> "%LOG%"
if exist "apps\web\.next" rmdir /S /Q "apps\web\.next" >> "%LOG%" 2>&1
if exist "apps\web\node_modules\.cache" rmdir /S /Q "apps\web\node_modules\.cache" >> "%LOG%" 2>&1

echo Step 4: where is pnpm >> "%LOG%"
where pnpm >> "%LOG%" 2>&1

echo Step 5: env check >> "%LOG%"
node --version >> "%LOG%" 2>&1

echo Step 6: starting dev server in detached window >> "%LOG%"
start "Malika dev" cmd /k "cd /d %~dp0 && pnpm --filter web dev > dev.log 2>&1"

echo Step 7: waiting 5s then checking >> "%LOG%"
timeout /t 5 /nobreak >nul

echo === GO2 done at %DATE% %TIME% === >> "%LOG%"
exit
