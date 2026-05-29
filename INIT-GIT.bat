@echo off
title Init Git Repo + First Commit
cd /d C:\Projects\malikas-universe

echo  === Initialize Git ===
git init
if errorlevel 1 (
    echo Git not installed. Install from https://git-scm.com/download/win
    pause
    exit /b 1
)

echo.
echo  === Set default branch to main ===
git branch -M main

echo.
echo  === Configure git identity (one-time) ===
git config user.email "clanqtr@gmail.com" 2>nul
git config user.name "Fahad" 2>nul

echo.
echo  === Stage all files ===
git add .

echo.
echo  === Files to be committed (preview) ===
git status --short | head -30

echo.
echo  === First commit ===
git commit -m "Initial commit: Malika's Universe admin platform (Phases 1-12 + WhatsApp Live)"

echo.
echo  === Done ===
echo Next steps:
echo   1. Create repo on github.com/new
echo      - Name: malikas-universe
echo      - Visibility: Private
echo      - DO NOT add README/gitignore/license (we have them)
echo   2. Then run PUSH-GITHUB.bat
echo.
pause
