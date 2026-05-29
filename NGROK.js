// Spawn ngrok directly (installed globally via winget) + capture URL via API
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const logFile = path.join(__dirname, 'ngrok-log.txt');
const urlFile = path.join(__dirname, 'ngrok-url.txt');

try { fs.unlinkSync(logFile); } catch {}
try { fs.unlinkSync(urlFile); } catch {}

function log(s) {
  fs.appendFileSync(logFile, s);
  process.stdout.write(s);
}

log('Starting: ngrok http 3001 (direct binary)\n');

// ngrok was installed via winget; it's on PATH. Use shell:true for Windows .exe resolution.
const proc = spawn('ngrok http 3001', {
  cwd: __dirname,
  shell: true,
});

proc.stdout.on('data', (c) => log(c.toString()));
proc.stderr.on('data', (c) => log(c.toString()));
proc.on('exit', (code) => log(`\nNGROK EXITED with code ${code}\n`));

// Poll the local ngrok web API (port 4040) every 2s for up to 30s
let attempts = 0;
const maxAttempts = 15;
const poll = setInterval(() => {
  attempts++;
  http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
    let body = '';
    res.on('data', (chunk) => (body += chunk));
    res.on('end', () => {
      try {
        const json = JSON.parse(body);
        const url = json.tunnels?.[0]?.public_url;
        if (url) {
          fs.writeFileSync(urlFile, url);
          log(`\n>>> Tunnel URL: ${url}\n`);
          clearInterval(poll);
        }
      } catch (e) {
        log(`\nparse err: ${e.message}\n`);
      }
    });
  }).on('error', (e) => {
    if (attempts >= maxAttempts) {
      log(`\nGave up waiting for ngrok API: ${e.message}\n`);
      clearInterval(poll);
    }
  });
}, 2000);

// Keep alive
setInterval(() => {}, 60000);
