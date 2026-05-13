@echo off
set LOG=%~dp0\status.log
echo === STATUS at %TIME% === > "%LOG%"
echo. >> "%LOG%"
echo NODE PROCESSES: >> "%LOG%"
tasklist /FI "IMAGENAME eq node.exe" /FO LIST >> "%LOG%" 2>&1
echo. >> "%LOG%"
echo PORT 3001: >> "%LOG%"
netstat -ano | findstr :3001 >> "%LOG%" 2>&1
echo. >> "%LOG%"
echo DEV.LOG TAIL: >> "%LOG%"
powershell -Command "Get-Content '%~dp0\dev.log' -Tail 20" >> "%LOG%" 2>&1
exit
