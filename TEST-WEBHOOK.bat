@echo off
title Test Webhook
cd /d C:\Projects\malikas-universe
node test-webhook.js > webhook-test-output.txt 2>&1
echo Done. Output:
type webhook-test-output.txt
pause
