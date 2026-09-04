// Smoke-Test fuer den Grosshandel-Service.
// Startet den Service in einem Test-Modus, ruft /health, stoppt wieder.
//
// Aufruf:  node test/smoke.js

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PORT = 18787;  // separater Port, damit nichts kollidiert
const TOKEN = 'smoke-test-token-1234567890';

const child = spawn('node', ['server.js'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    SERVICE_TOKEN: TOKEN,
    DATA_DIR: './test/data',
    SCREENSHOT_DIR: './test/screenshots',
    LOG_DIR: './test/logs',
    SELECTORS_DIR: './selectors',
    HEADLESS: 'true',
    LOG_LEVEL: 'error'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let failed = false;
async function check(label, fn) {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (e) {
    console.log(`  FAIL ${label}: ${e.message}`);
    failed = true;
  }
}

async function req(path, opts = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, opts);
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}

await sleep(2000);  // Server-Start abwarten

await check('GET /health (kein Auth noetig)', async () => {
  const r = await req('/health');
  if (r.status !== 200) throw new Error(`status ${r.status}`);
  if (r.body.status !== 'ok') throw new Error('status nicht ok');
});

await check('GET /health via fetch mit Auth-Header geht trotzdem', async () => {
  const r = await req('/health', { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (r.status !== 200) throw new Error(`status ${r.status}`);
});

await check('POST /bestellung ohne Auth -> 401', async () => {
  const r = await req('/bestellung', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grosshaendler: 'GC', positionen: [] })
  });
  if (r.status !== 401) throw new Error(`status ${r.status}, erwarte 401`);
});

await check('POST /bestellung mit Auth, leere Positionen -> 400', async () => {
  const r = await req('/bestellung', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ grosshaendler: 'GC', positionen: [] })
  });
  if (r.status !== 400) throw new Error(`status ${r.status}, erwarte 400`);
});

await check('POST /bestellung mit Auth, GC, unvollstaendige Selektoren -> 501', async () => {
  // gc.yaml hat Platzhalter, also wird der 501-Pfad getroffen (kein Login-Versuch)
  const r = await req('/bestellung', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grosshaendler: 'GC',
      positionen: [{ artikelnr: '12345', menge: 1, bezeichnung: 'Test' }]
    })
  });
  if (r.status !== 501 && r.status !== 500) {
    throw new Error(`status ${r.status}, erwarte 501 (Selektoren unvollstaendig)`);
  }
});

await check('POST /bestellung mit Auth, unbekannter Grosshaendler -> 500/400', async () => {
  const r = await req('/bestellung', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grosshaendler: 'UNBEKANNT',
      positionen: [{ artikelnr: '12345', menge: 1, bezeichnung: 'Test' }]
    })
  });
  // FileNotFoundError beim Laden der Selektoren -> 500
  if (r.status !== 500 && r.status !== 400) {
    throw new Error(`status ${r.status}`);
  }
});

child.kill('SIGTERM');
await sleep(500);

if (failed) {
  console.log('\nSMOKE FAILED');
  process.exit(1);
} else {
  console.log('\nSMOKE OK');
}
