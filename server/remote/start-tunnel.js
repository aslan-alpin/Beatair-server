#!/usr/bin/env node
/**
 * Beatair server: remote tunnel helper + QR (tiny!)
 *
 * Usage:
 *   cd server/remote && npm i
 *   node start-tunnel.js                                # tunnels to localhost:3001 (default)
 *   PORT=3002 node start-tunnel.js                      # choose target port
 *   node start-tunnel.js --sub beatair-bodrum           # suggest a subdomain
 *   node start-tunnel.js --name "Starbucks Bodrum"      # optional cafe name to embed in QR
 *
 * Env:
 *   TUNNEL_SUBDOMAIN, PORT, CAFE_NAME
 */

import { setTimeout as delay } from 'timers/promises';
import crypto from 'crypto';
import process from 'process';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let targetPort = Number(process.env.PORT || 3001);
let subdomain = process.env.TUNNEL_SUBDOMAIN || '';
let cafeName = process.env.CAFE_NAME || os.hostname();

for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--target-port' && process.argv[i + 1]) targetPort = Number(process.argv[++i]);
  else if (a === '--sub' && process.argv[i + 1]) subdomain = String(process.argv[++i]);
  else if (a === '--name' && process.argv[i + 1]) cafeName = String(process.argv[++i]);
}

const log  = (m) => console.log(`\x1b[36m[beatair-remote]\x1b[0m ${m}`);
const warn = (m) => console.warn(`\x1b[33m[beatair-remote]\x1b[0m ${m}`);
const bad  = (m) => console.error(`\x1b[31m[beatair-remote]\x1b[0m ${m}`);

function pairCode(url) {
  const h = crypto.createHash('sha256').update(String(url)).digest('hex');
  const n = parseInt(h.slice(0, 8), 16) % 1_000_000;
  return String(n).padStart(6, '0');
}
function makeQrText({ url, code, name }) {
  // App scheme: beatair://pair?v=1&u=<url>&c=<code>&n=<name>
  const u = encodeURIComponent(url);
  const c = encodeURIComponent(code);
  const n = encodeURIComponent(name || '');
  return `beatair://pair?v=1&u=${u}&c=${c}&n=${n}`;
}

function writeStatus({ url, code, name, qrText, qrPngPath }) {
  const out = { url, code, name, qrText, qrPngPath, createdAt: new Date().toISOString() };
  const file = path.join(__dirname, 'last-url.json');
  try { fs.writeFileSync(file, JSON.stringify(out, null, 2)); }
  catch (e) { warn('Could not write last-url.json: ' + e.message); }
  try { fs.writeFileSync(path.join(__dirname, 'qr.txt'), qrText + '\n'); }
  catch (e) { warn('Could not write qr.txt: ' + e.message); }
}

async function showQrInTerminal(qrText) {
  try {
    const { default: qrcodeTerminal } = await import('qrcode-terminal');
    // Go as small as the lib allows:
    qrcodeTerminal.generate(qrText, { small: true });
  } catch (e) {
    warn('qrcode-terminal not installed; skipping terminal QR. Run: npm i qrcode-terminal');
  }
}
async function saveQrPng(qrText, outPath) {
  try {
    const { default: QR } = await import('qrcode');
    // Minimal but still scannable; bump scale to 3 if some cameras struggle.
    await QR.toFile(outPath, qrText, {
      type: 'png',
      margin: 0,
      scale: 2,
      errorCorrectionLevel: 'L'
    });
    log(`Saved QR PNG → ${outPath}`);
  } catch (e) {
    warn('qrcode not installed; skipping PNG write. Run: npm i qrcode');
  }
}

async function startLocaltunnel() {
  const { default: localtunnel } = await import('localtunnel');
  const sub = subdomain || `beatair-${crypto.randomBytes(3).toString('hex')}`;

  log(`Attempting localtunnel → http://localhost:${targetPort} (subdomain: ${sub})`);
  const tunnel = await localtunnel({ port: targetPort, subdomain: sub });

  // Always prefer https for Android clients
  const httpsUrl = String(tunnel.url).replace(/^http:/i, 'https:');
  const code = pairCode(httpsUrl);
  const qrText = makeQrText({ url: httpsUrl, code, name: cafeName });
  const qrPngPath = path.join(__dirname, 'qr.png');

  writeStatus({ url: httpsUrl, code, name: cafeName, qrText, qrPngPath });

  log(`Remote URL: \x1b[1m${httpsUrl}\x1b[0m`);
  log(`Pair code:  \x1b[1m${code}\x1b[0m`);
  log(`Café name:  ${cafeName}`);
  log(`Scan this QR in the Android app (or use the code):\n`);
  await showQrInTerminal(qrText);
  await saveQrPng(qrText, qrPngPath);

  tunnel.on('close', () => warn('Tunnel closed. (Process will exit.)'));
  while (true) await delay(60_000); // keep alive
}

(async () => {
  log(`Node ${process.version} on ${os.platform()} ${os.arch()}`);
  log(`Target port: ${targetPort}`);
  try { await startLocaltunnel(); }
  catch (e) { bad('Failed to establish tunnel: ' + (e?.message || e)); process.exit(1); }
})();