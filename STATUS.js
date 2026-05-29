// STATUS.js — health probe + URL extractor
// Waits for dev server + ngrok to be ready, then prints a clean status.

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const STATUS_FILE = path.join(__dirname, 'STATUS.txt');
const NGROK_API = 'http://127.0.0.1:4040/api/tunnels';
const DEV_HEALTH = 'http://127.0.0.1:3001/api/health';

const COLOR = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m',
};

function log(line, color = '') {
  process.stdout.write((color || '') + line + COLOR.reset + '\n');
  fs.appendFileSync(STATUS_FILE, line.replace(/\x1b\[\d+m/g, '') + '\n');
}

function get(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { timeout }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function waitFor(name, url, maxWaitSec, validator) {
  const start = Date.now();
  const maxMs = maxWaitSec * 1000;
  let attempts = 0;
  while (Date.now() - start < maxMs) {
    attempts++;
    try {
      const res = await get(url);
      if (!validator || validator(res)) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        return { ok: true, response: res, elapsed, attempts };
      }
    } catch (e) {
      // ignore, retry
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, attempts, elapsed: maxWaitSec };
}

(async () => {
  // Reset status file
  fs.writeFileSync(STATUS_FILE, '');

  log('');
  log('============================================================', COLOR.cyan);
  log('  MALIKA UNIVERSE — Full Stack Launcher', COLOR.bold + COLOR.cyan);
  log('============================================================', COLOR.cyan);
  log('');

  // 1. Wait for dev server
  log('[1/3] Waiting for dev server on http://localhost:3001 ...', COLOR.yellow);
  const dev = await waitFor('dev', DEV_HEALTH, 90, (res) => res.status === 200 || res.status === 404);
  if (!dev.ok) {
    log(`      ❌ Dev server did not start within 90s (${dev.attempts} attempts).`, COLOR.red);
    log('         Check the "Malika Dev" cmd window for errors.', COLOR.red);
  } else {
    log(`      ✅ Dev server ready in ${dev.elapsed}s`, COLOR.green);
  }
  log('');

  // 2. Wait for ngrok local API
  log('[2/3] Waiting for ngrok tunnel ...', COLOR.yellow);
  const ngrok = await waitFor('ngrok', NGROK_API, 30, (res) => {
    try {
      const j = JSON.parse(res.body);
      return j.tunnels && j.tunnels.length > 0 && j.tunnels[0].public_url;
    } catch {
      return false;
    }
  });

  let ngrokUrl = null;
  if (ngrok.ok) {
    const j = JSON.parse(ngrok.response.body);
    ngrokUrl = j.tunnels[0].public_url;
    log(`      ✅ Ngrok ready in ${ngrok.elapsed}s`, COLOR.green);
    log(`         Public URL: ${ngrokUrl}`, COLOR.green);
  } else {
    log('      ❌ Ngrok did not connect within 30s.', COLOR.red);
    log('         Check the "Malika Ngrok" cmd window. You may need to log in:', COLOR.red);
    log('         ngrok config add-authtoken YOUR_TOKEN', COLOR.red);
  }
  log('');

  // 3. Verify webhook end-to-end via ngrok
  if (ngrokUrl) {
    log('[3/3] Testing webhook via ngrok ...', COLOR.yellow);
    const webhookUrl = `${ngrokUrl}/api/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=malikas_verify_2026&hub.challenge=READY_PING`;
    try {
      const res = await get(webhookUrl, 8000);
      if (res.status === 200 && res.body.trim() === 'READY_PING') {
        log('      ✅ Webhook responds correctly through ngrok', COLOR.green);
      } else {
        log(`      ⚠ Webhook returned status=${res.status} body=${res.body.slice(0, 80)}`, COLOR.yellow);
        log('         (Most likely the WHATSAPP_VERIFY_TOKEN env is missing or dev still compiling)', COLOR.yellow);
      }
    } catch (e) {
      log(`      ⚠ Could not test webhook: ${e.message}`, COLOR.yellow);
    }
  }

  log('');
  log('============================================================', COLOR.cyan);
  log('  STATUS', COLOR.bold + COLOR.cyan);
  log('============================================================', COLOR.cyan);
  log('');
  log(`  Local admin:   http://localhost:3001`, COLOR.green);
  log(`  /support:      http://localhost:3001/support`, COLOR.green);
  log(`  /whatsapp-live: http://localhost:3001/whatsapp-live`, COLOR.green);
  if (ngrokUrl) {
    log('');
    log(`  📡 Webhook URL for Meta (paste this in Meta dashboard):`, COLOR.bold);
    log(`     ${ngrokUrl}/api/whatsapp/webhook`, COLOR.bold + COLOR.green);
    log('');
    log(`     Verify token: malikas_verify_2026`, COLOR.green);
  }
  log('');
  log('============================================================', COLOR.cyan);
  log('');
  log('  ⚠ KEEP THIS WINDOW + "Malika Dev" + "Malika Ngrok" OPEN', COLOR.yellow);
  log('  ⚠ Closing any of them stops the service.', COLOR.yellow);
  log('');
  log('  To stop everything, run STOP-ALL.bat', COLOR.cyan);
  log('');

  // Keep alive
  setInterval(() => {}, 60000);
})();
