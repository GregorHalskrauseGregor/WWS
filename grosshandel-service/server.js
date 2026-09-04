// Playwright-Service für Großhandel-Bestellungen (GC, RNF).
//
// Ablauf pro Job:
//   1. Login-Session laden (Playwright storageState), sonst Login via Username/Pass.
//   2. Schnellerfassung aufrufen.
//   3. Positionen in den Warenkorb legen.
//   4. Warenkorb abschicken.
//   5. Screenshots + Job-Log persistieren.
//
// Die eigentliche Seiten-Logik (Selektoren, Reihenfolge der Klicks) liegt NICHT
// hier, sondern in selectors/<grosshaendler>.yaml — pro Großhändler ein eigenes
// File. So bleibt der Code hier sauber und ein Großhändler-Wechsel ist eine
// YAML-Änderung, keine Code-Änderung.
//
// Voraussetzungen (per .env, siehe .env.example):
//   SERVICE_TOKEN            Bearer-Token, identisch mit WWS-Seite
//   GC_USER, GC_PASS         (oder RNF_USER, RNF_PASS)
//   PORT                     default 8787

import Fastify from 'fastify';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import crypto from 'node:crypto';

const PORT = parseInt(process.env.PORT || '8787', 10);
const SERVICE_TOKEN = process.env.SERVICE_TOKEN;
if (!SERVICE_TOKEN) {
  console.error('FEHLER: SERVICE_TOKEN nicht gesetzt. Siehe .env.example.');
  process.exit(1);
}

const SELECTORS_DIR = process.env.SELECTORS_DIR || '/app/selectors';
const DATA_DIR = process.env.DATA_DIR || '/app/data';
const STORAGE_DIR = path.join(DATA_DIR, 'storage');
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/app/screenshots';
const LOG_DIR = process.env.LOG_DIR || '/app/logs';
const HEADLESS = (process.env.HEADLESS || 'true') !== 'false';

for (const d of [DATA_DIR, STORAGE_DIR, SCREENSHOT_DIR, LOG_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

const fastify = Fastify({
  logger: { level: process.env.LOG_LEVEL || 'info' }
});

// ---------------------------------------------------------------- Auth
fastify.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${SERVICE_TOKEN}`) {
    reply.code(401).send({ error: 'unauthorized' });
  }
});

// ---------------------------------------------------------------- Browser-Pool
let browser = null;
const contexts = new Map();  // grosshaendler -> BrowserContext

async function getBrowser() {
  if (browser) return browser;
  browser = await chromium.launch({ headless: HEADLESS });
  console.log('Browser gestartet (headless=' + HEADLESS + ')');
  return browser;
}

async function getContext(grosshaendler) {
  const key = grosshaendler.toUpperCase();
  if (contexts.has(key)) return contexts.get(key);

  const b = await getBrowser();
  const storageFile = path.join(STORAGE_DIR, `${key.toLowerCase()}.json`);
  let storageState = null;
  if (fs.existsSync(storageFile)) {
    try { storageState = JSON.parse(fs.readFileSync(storageFile, 'utf-8')); }
    catch (e) { console.warn(`Storage-State für ${key} nicht lesbar: ${e.message}`); }
  }
  const context = await b.newContext({ storageState });
  contexts.set(key, context);
  return context;
}

// ---------------------------------------------------------------- Helpers
function ladeSelektoren(grosshaendler) {
  const file = path.join(SELECTORS_DIR, `${grosshaendler.toLowerCase()}.yaml`);
  if (!fs.existsSync(file)) {
    throw new Error(`Keine Selektoren für ${grosshaendler} (erwartet: ${file})`);
  }
  return yaml.parse(fs.readFileSync(file, 'utf-8'));
}

function credentials(grosshaendler) {
  const k = grosshaendler.toUpperCase();
  const user = process.env[`${k}_USER`];
  const pass = process.env[`${k}_PASS`];
  if (!user || !pass) {
    throw new Error(`${k}_USER / ${k}_PASS nicht in .env gesetzt`);
  }
  return { user, pass };
}

async function loginWennNoetig(context, grosshaendler, sel) {
  const page = await context.newPage();
  try {
    await page.goto(sel.loginUrl, { waitUntil: 'domcontentloaded' });
    // Wenn wir schon eingeloggt sind, leitet uns die Seite typischerweise ins
    // Portal weiter. Check: sind wir auf einer URL, die NICHT die Login-Seite ist?
    if (!page.url().toLowerCase().includes('login')) {
      console.log(`${grosshaendler}: bereits eingeloggt (URL ${page.url()})`);
      return page;
    }
    const { user, pass } = credentials(grosshaendler);
    await page.fill(sel.selectors.usernameInput, user);
    await page.fill(sel.selectors.passwordInput, pass);
    await Promise.all([
      page.waitForURL((url) => !url.toString().toLowerCase().includes('login'), { timeout: 30000 }),
      page.click(sel.selectors.loginButton)
    ]);
    // Session speichern
    const state = await context.storageState();
    fs.writeFileSync(
      path.join(STORAGE_DIR, `${grosshaendler.toLowerCase()}.json`),
      JSON.stringify(state, null, 2)
    );
    console.log(`${grosshaendler}: Login erfolgreich, Session gespeichert.`);
    return page;
  } catch (e) {
    await page.screenshot({ path: path.join(LOG_DIR, `login-fail-${Date.now()}.png`) }).catch(() => {});
    throw new Error(`Login fehlgeschlagen für ${grosshaendler}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- Endpoints

fastify.get('/health', async () => ({
  status: 'ok',
  browser: browser ? 'running' : 'not_started',
  contexts: Array.from(contexts.keys())
}));

fastify.post('/login/:grosshaendler', async (req, reply) => {
  const { grosshaendler } = req.params;
  const sel = ladeSelektoren(grosshaendler);
  const ctx = await getContext(grosshaendler);
  const page = await loginWennNoetig(ctx, grosshaendler, sel);
  await page.close();
  return { ok: true, grosshaendler };
});

fastify.post('/bestellung', async (req, reply) => {
  const job = req.body;
  if (!job || !job.grosshaendler || !Array.isArray(job.positionen) || job.positionen.length === 0) {
    return reply.code(400).send({ error: 'grosshaendler und mind. 1 position erforderlich' });
  }

  const grosshaendler = String(job.grosshaendler).toUpperCase();
  const jobId = `${grosshaendler.toLowerCase()}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(SCREENSHOT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  const logFile = path.join(jobDir, 'log.txt');
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(msg);
  };

  let page = null;
  try {
    const sel = ladeSelektoren(grosshaendler);
    const ctx = await getContext(grosshaendler);
    page = await loginWennNoetig(ctx, grosshaendler, sel);
    log(`Login ok, in ${page.url()}`);

    // SCHNELLAUFNAHME: hier kommt der großhändler-spezifische Flow rein.
    // Bis die Selektoren sauber definiert sind, machen wir einen klaren
    // "noch nicht implementiert"-Pfad, damit das Gerüst lauffähig bleibt.
    //
    // Erwartete Sektionen in selectors/<grosshaendler>.yaml:
    //   - schnellErfassungUrl
    //   - selectors.artikelInput
    //   - selectors.mengeInput
    //   - selectors.hinzufuegenButton
    //   - selectors.warenkorbButton
    //   - selectors.abschickenButton
    //   - selectors.bestellnummerSelector (zum Auslesen der Auftragsnr)
    if (!sel.schnellErfassungUrl || !sel.selectors?.artikelInput) {
      return reply.code(501).send({
        error: `Selektoren für ${grosshaendler} sind noch nicht vollständig. ` +
               `Trag schnellErfassungUrl und selectors.* in ${grosshaendler.toLowerCase()}.yaml ein.`,
        jobId
      });
    }

    await page.goto(sel.schnellErfassungUrl, { waitUntil: 'domcontentloaded' });
    await page.screenshot({ path: path.join(jobDir, '1-schnellerfassung.png') });
    log(`Schnellerfassung aufgerufen`);

    for (const [i, p] of job.positionen.entries()) {
      if (!p.artikelnr) {
        log(`Position ${i + 1} (${p.bezeichnung}): keine Artikelnummer, uebersprungen`);
        continue;
      }
      await page.fill(sel.selectors.artikelInput, String(p.artikelnr));
      await page.fill(sel.selectors.mengeInput, String(p.menge));
      await page.click(sel.selectors.hinzufuegenButton);
      await page.waitForTimeout(500);
      log(`Position ${i + 1}: ${p.artikelnr} x ${p.menge}`);
    }
    await page.screenshot({ path: path.join(jobDir, '2-warenkorb-befuellt.png') });

    await page.click(sel.selectors.warenkorbButton);
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(jobDir, '3-warenkorb.png') });

    await page.click(sel.selectors.abschickenButton);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(jobDir, '4-bestaetigung.png'), fullPage: true });

    let bestellnummer = null;
    try {
      bestellnummer = (await page.textContent(sel.selectors.bestellnummerSelector)).trim();
    } catch { /* nicht immer vorhanden */ }
    log(`Abgeschickt, Bestellnummer: ${bestellnummer || 'nicht lesbar'}`);

    return {
      ok: true,
      jobId,
      bestellnummer,
      screenshot: path.join(SCREENSHOT_DIR, jobId, '4-bestaetigung.png'),
      log: `${job.positionen.length} Positionen verarbeitet`
    };
  } catch (e) {
    if (page) await page.screenshot({ path: path.join(jobDir, 'error.png') }).catch(() => {});
    log(`FEHLER: ${e.message}`);
    return reply.code(500).send({ error: e.message, jobId });
  } finally {
    if (page) await page.close();
  }
});

fastify.get('/job/:id', async (req, reply) => {
  const { id } = req.params;
  const dir = path.join(SCREENSHOT_DIR, id);
  if (!fs.existsSync(dir)) return reply.code(404).send({ error: 'unknown jobId' });
  const files = fs.readdirSync(dir);
  return { jobId: id, files };
});

// ---------------------------------------------------------------- Start
fastify.listen({ port: PORT, host: '0.0.0.0' })
  .then(() => console.log(`Grosshandel-Service auf Port ${PORT} (headless=${HEADLESS})`))
  .catch((e) => { console.error('Start fehlgeschlagen:', e); process.exit(1); });
