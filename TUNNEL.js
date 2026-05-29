// Spawn localtunnel and capture URL → tunnel-url.txt
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const logFile = path.join(__dirname, 'tunnel-log.txt');
const urlFile = path.join(__dirname, 'tunnel-url.txt');

try { fs.unlinkSync(logFile); } catch {}
try { fs.unlinkSync(urlFile); } catch {}

console.log('Starting localtunnel --port 3001 --subdomain malika-wa...');

// On Windows, npx is a .cmd shim — must use shell: true
const proc = spawn('npx localtunnel --port 3001 --subdomain malika-wa', {
  cwd: __dirname,
  shell: true,
});

let captured = false;
function processOutput(s) {
  fs.appendFileSync(logFile, s);
  process.stdout.write(s);
  if (!captured) {
    const m = s.match(/https:\/\/[^\s]+\.loca\.lt/);
    if (m) {
      fs.writeFileSync(urlFile, m[0]);
      captured = true;
      console.log('\n>>> Tunnel URL captured:', m[0]);
    }
  }
}

proc.stdout.on('data', (c) => processOutput(c.toString()));
proc.stderr.on('data', (c) => processOutput(c.toString()));

proc.on('exit', (code) => {
  fs.appendFileSync(logFile, `\nTUNNEL EXITED with code ${code}\n`);
  console.log('Tunnel exited:', code);
});

setInterval(() => {}, 60000);
