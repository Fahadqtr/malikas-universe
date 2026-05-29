@echo off
title Vercel CLI Deploy

echo  ============================================
echo   Malika's Universe - Vercel CLI Deploy
echo  ============================================
echo.
echo  This will:
echo    1. Install Vercel CLI globally (one-time)
echo    2. Login to Vercel via browser (one-time)
echo    3. Link this folder to a Vercel project
echo    4. Deploy to a preview URL
echo.
echo  After this finishes, you'll have a stable URL like:
echo    https://malikas-universe-abc123.vercel.app
echo.
pause

echo.
echo  === Step 1: Install Vercel CLI ===
call npm install -g vercel
if errorlevel 1 (
    echo Vercel install failed. Check internet connection.
    pause
    exit /b 1
)

echo.
echo  === Step 2: Login to Vercel ===
echo Browser will open. Sign in with your Vercel account.
cd /d C:\Projects\malikas-universe\apps\web
call vercel login

echo.
echo  === Step 3: Link + Deploy ===
echo When prompted:
echo   - Set up and deploy? Y
echo   - Which scope? pick your account
echo   - Link to existing project? N (it's new)
echo   - What's your project's name? malikas-universe
echo   - In which directory is your code located? . (just press Enter)
echo.
echo Vercel will auto-detect Next.js and start building.
call vercel

echo.
echo  === Done ===
echo.
echo Next:
echo   1. Open https://vercel.com/dashboard
echo   2. Find "malikas-universe" project
echo   3. Settings - Environment Variables - add all keys from .env.local
echo      (Production + Preview + Development for each)
echo   4. Deployments - Redeploy (uncheck "use existing cache")
echo   5. Get production URL and paste in Meta webhook
echo.
pause
