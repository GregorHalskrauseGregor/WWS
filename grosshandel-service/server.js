// Playwright-Service für Großhandel-Bestellungen (GC, RNF).
//
// Flow pro Job:
//   1. Login (gespeicherte Session, sonst Username+Pass)
//   2. Cart-Liste -> "Warenkorb hinzufügen" -> Auftragsnummer + Auftragstext
//   3. Pro Position: "Artikel hinzufügen" + Art-Nr + Menge
//   4. Hamburger -> "Weiterleiten" -> Empfaenger eintippen -> Submit
//
// Wichtig: Die numerischen Suffixe in den GC-Selektoren (a792, a784, ...)
// wechseln pro Warenkorb. Deshalb matchen wir auf stabile Sub-String-Anteile
// mit CSS-Attribut-Selektoren [id*='...'] in selectors/gc.yaml.

import Fastify from 'fastify';
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';
import crypto from 'node:crypto';
import { act } from './lib/smart.js';

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
// Variante B: sichtbares echtes Chrome ist am wenigsten von Akamai/Imperva
// erkennbar. Deshalb Default headless=false (nicht mehr true).
const HEADLESS = (process.env.HEADLESS || 'false') !== 'false';
// 'chrome' = echtes System-Chrome (echter TLS/HTTP2-Fingerprint, empfohlen).
// 'chromium' = Playwright-eigener Build (wird von GC geblockt). Default: chrome.
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chrome';
// Wenn gesetzt (z. B. CDP_ENDPOINT=http://localhost:9222): verbindet sich zu
// einem bereits laufenden Chrome statt einen eigenen zu starten. Dann nutzt
// der Service den User-Profil-Context des Users (= echte Cookies/Session, kein
// Bot-Detection-Risiko). Chrome muss dann mit --remote-debugging-port=9222
// gestartet sein, bevor der Service hochfaehrt.
const CDP_ENDPOINT = process.env.CDP_ENDPOINT || null;
// Login-Modus: 'auto' (Standard) = Bot loggt sich selbst ein, mit ECHTEN
// Tastatureingaben (nicht .fill(), sonst ignoriert GCs Framework das Passwort
// -> Fehler 11221777). 'session' = kein Tippen, nutzt eine von Hand im Profil
// angemeldete Session (nur sinnvoll, wenn GC die Session speichert).
const LOGIN_MODE = (process.env.GC_LOGIN_MODE || 'auto').toLowerCase();
// Realistischer Chrome-UA (aktuell v131, Sep 2026). Akamai checkt das.
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// KI-Fallback mit austauschbarem Anbieter (MiniMax/Mistral/OpenAI = 'openai'-
// Schema, oder 'anthropic'). Nur aktiv, wenn Key + Modell (+ bei 'openai' die
// Base-URL) gesetzt sind — sonst laeuft der Bot rein deterministisch.
const AI = {
  provider:    (process.env.AI_PROVIDER || 'openai').toLowerCase(),
  baseUrl:     process.env.AI_BASE_URL || null,   // volle Chat-Completions-URL (openai-Schema)
  key:         process.env.AI_API_KEY || null,
  model:       process.env.AI_MODEL || null,       // Modell fuer die DOM-Stufe (Text)
  visionModel: process.env.AI_VISION_MODEL || process.env.AI_MODEL || null, // fuer die Vision-Stufe
  vision:      (process.env.AI_VISION || 'true') !== 'false',
  budget:      parseInt(process.env.AI_MAX_STEPS || '8', 10)
};
AI.enabled = !!(AI.key && AI.model && (AI.provider === 'anthropic' || AI.baseUrl));

for (const d of [DATA_DIR, STORAGE_DIR, SCREENSHOT_DIR, LOG_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

// Selbstheilung: von der KI gefundene, funktionierende Selektoren werden hier
// gespeichert (NICHT in die handgepflegte gc.yaml geschrieben -> Kommentare
// bleiben erhalten). Der Resolver probiert Gelerntes zuerst.
const LEARNED_FILE = path.join(DATA_DIR, 'gc.learned.json');
function ladeGelernt() {
  try { return fs.existsSync(LEARNED_FILE) ? JSON.parse(fs.readFileSync(LEARNED_FILE, 'utf-8')) : {}; }
  catch { return {}; }
}
function macheHeal(gelernt, log) {
  return async (key, selector) => {
    if (!selector) return;
    gelernt[key] = gelernt[key] || [];
    if (!gelernt[key].includes(selector)) {
      gelernt[key].unshift(selector); // zuerst probieren beim naechsten Mal
      try {
        fs.writeFileSync(LEARNED_FILE, JSON.stringify(gelernt, null, 2));
        log(`SELBSTHEILUNG: "${selector}" fuer ${key} gelernt und gespeichert.`);
      } catch (e) { log(`Selbstheilung-Schreibfehler: ${e.message}`); }
    }
  };
}
// Baut die Aktions-Spezifikation: Gelerntes zuerst, dann die Kandidaten aus gc.yaml.
function specFor(sel, gelernt, key, over = {}) {
  const a = (sel.aktionen && sel.aktionen[key]) || {};
  return {
    key,
    ziel: a.ziel || key,
    kandidaten: [...(gelernt[key] || []), ...(a.kandidaten || [])],
    erwarteDanach: a.erwarteDanach || null,
    icon: !!a.icon,
    ...over
  };
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
// Ein Kontext pro Großhändler. Standard (Variante B): echtes Chrome mit
// dauerhaftem Profil, das der Service selbst startet und steuert.
// Optional (Variante A): CDP_ENDPOINT gesetzt -> an bereits laufendes Chrome andocken.
const contexts = new Map();
let cdpBrowser = null;

async function getContext(grosshaendler) {
  const key = grosshaendler.toUpperCase();
  if (contexts.has(key)) return contexts.get(key);

  const timeout = parseInt(process.env.PLAYWRIGHT_TIMEOUT || '60000', 10);

  // ---- Variante A: an ein bereits laufendes Chrome andocken (CDP) ----
  if (CDP_ENDPOINT) {
    if (!cdpBrowser) {
      console.log('Verbinde zu bestehendem Chrome via CDP: ' + CDP_ENDPOINT);
      cdpBrowser = await chromium.connectOverCDP(CDP_ENDPOINT);
      console.log('CDP-Verbindung steht. Chrome-Version: ' + (await cdpBrowser.version()));
    }
    const existing = cdpBrowser.contexts();
    const ctx = existing.length > 0 ? existing[0] : await cdpBrowser.newContext();
    ctx.setDefaultTimeout(timeout);
    contexts.set(key, ctx);
    console.log(`${key}: nutze CDP-Context (${existing.length} vorhanden).`);
    return ctx;
  }

  // ---- Variante B (Standard): echtes Chrome mit persistentem Profil ----
  //   channel:'chrome'       -> echtes Google-Chrome-Binary, echter TLS/HTTP2-Fingerprint
  //   launchPersistentContext-> Profil bleibt auf der Platte, Login ueberlebt Neustarts
  //   headless:false         -> sichtbares Fenster, am wenigsten von Akamai/Imperva erkennbar
  // Eigener Profil-Ordner pro Großhändler (NICHT das Standard-Chrome-Profil des Users) ->
  // keine Konflikte mit dem normalen Browser, kein Chrome-136-Debug-Port-Problem.
  const userDataDir = path.join(DATA_DIR, `chrome-profil-${key.toLowerCase()}`);
  fs.mkdirSync(userDataDir, { recursive: true });
  console.log(`${key}: starte echtes Chrome (channel=${BROWSER_CHANNEL}, headless=${HEADLESS}) mit Profil ${userDataDir}`);

  const launchOpts = {
    channel: BROWSER_CHANNEL,      // 'chrome'
    headless: HEADLESS,            // false empfohlen
    viewport: null,                // echtes Fensterformat statt erzwungenem Viewport
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
    chromiumSandbox: true,         // verhindert das --no-sandbox-Flag (gelbe Warnleiste)
    // Bewusst KEINE Automatisierungs-Flags: echtes Chrome + echtes Tippen reicht
    // GC voellig; --disable-blink-features=AutomationControlled erzeugte nur eine
    // Warnleiste (schiebt das Layout, verzieht Vision-Klicks) ohne Nutzen.
    args: [
      '--start-maximized'
    ]
  };
  // Proxy nur falls gesetzt (z. B. spaeter fuer Hetzner + Residential-Proxy).
  const proxyUrl = process.env.PROXY_URL || null;
  if (proxyUrl) {
    launchOpts.proxy = { server: proxyUrl };
    if (process.env.PROXY_USER) launchOpts.proxy.username = process.env.PROXY_USER;
    if (process.env.PROXY_PASS) launchOpts.proxy.password = process.env.PROXY_PASS;
    console.log(`${key}: Proxy aktiv: ${proxyUrl}`);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, launchOpts);
  } catch (e) {
    if (BROWSER_CHANNEL === 'chrome' &&
        /channel|executable|not.*found|installiert|ENOENT/i.test(e.message)) {
      throw new Error(
        `Echtes Chrome (channel:'chrome') konnte nicht gestartet werden: ${e.message}. ` +
        `Ist Google Chrome installiert? Alternativ BROWSER_CHANNEL=msedge probieren.`
      );
    }
    throw e;
  }
  context.setDefaultTimeout(timeout);
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

function empfaengerFuer(job) {
  // Pro-Job-Empfänger > ENV-Fallback
  return job.empfaenger || process.env.GC_FORWARD_TO || null;
}

// Sequenziell nummerierte Screenshots pro Playwright-Schritt.
// So sieht man bei Fehlern genau, bei welchem Klick/Fill was schiefging
// und was die Seite zu dem Zeitpunkt zeigte ("webpage blocked" o.ae.).
// Aktiviert per ENV DEBUG_SHOTS=1 (default an, wenn nicht gesetzt).
const DEBUG_SHOTS = (process.env.DEBUG_SHOTS || '1') !== '0';
function makeShoter(page, jobDir, log) {
  let n = 0;
  return async (label) => {
    if (!DEBUG_SHOTS) return;
    n++;
    const safe = String(label || 'step')
      .replace(/[^a-zA-Z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80) || 'step';
    const fname = `${String(n).padStart(3, '0')}-${safe}.png`;
    const fullPath = path.join(jobDir, fname);
    try {
      await page.screenshot({ path: fullPath, fullPage: true });
      log(`SHOT ${String(n).padStart(3, '0')} [${label}] -> ${fname}`);
    } catch (e) {
      log(`SHOT FEHLER bei [${label}]: ${e.message}`);
    }
  };
}

async function clickWhenVisible(page, sel, label) {
  await page.locator(sel).first().waitFor({ state: 'visible', timeout: 15000 });
  await page.click(sel);
}

// Cookie-/Consent-Banner akzeptieren. GC zeigt beim ersten Besuch (frisches
// Profil) ein Overlay, das das Login-Formular verdeckt. Nach dem Klick wird die
// Zustimmung im Profil gespeichert -> erscheint bei kuenftigen Laeufen nicht mehr.
async function akzeptiereCookies(page, shot, log) {
  const labels = ['Alles akzeptieren', 'Alle akzeptieren', 'Akzeptieren', 'Zustimmen', 'Einverstanden', 'Accept all'];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    for (const root of [page, ...page.frames()]) {
      for (const label of labels) {
        const kandidaten = [
          root.getByRole('button', { name: label, exact: false }).first(),
          root.getByText(label, { exact: false }).first()
        ];
        for (const btn of kandidaten) {
          if (await btn.isVisible().catch(() => false)) {
            await btn.click().catch(() => {});
            await page.waitForTimeout(700);
            log(`Cookie-Banner akzeptiert: "${label}"`);
            try { await shot('01a-cookies-akzeptiert'); } catch {}
            return true;
          }
        }
      }
    }
    await page.waitForTimeout(400);
  }
  log('Kein Cookie-Banner gefunden (evtl. schon akzeptiert).');
  return false;
}

async function loginWennNoetig(context, grosshaendler, sel, jobDir, log) {
  const page = await context.newPage();
  // Default-Timeout pro Aktion: bei Proxy via Heimnetz sind 30s oft zu kurz
  page.setDefaultTimeout(parseInt(process.env.PLAYWRIGHT_TIMEOUT || '60000', 10));
  const shot = makeShoter(page, jobDir, log);
  try {
    await page.goto(sel.loginUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await shot('01-seite-geladen');

    // 0) Cookie-Consent-Banner wegklicken. Beim frischen Profil legt es sich als
    //    Overlay ueber die ANMELDUNG-Box -> ohne Klick ist das Login-Feld nicht
    //    bedienbar. Muss VOR allem anderen passieren.
    await akzeptiereCookies(page, shot, log);

    // 1) Lauten WAF-Block abfangen (Imperva "Web Page Blocked!" mit Client-IP).
    const blocked = await page.getByText('Web Page Blocked', { exact: false }).first()
      .isVisible({ timeout: 1500 }).catch(() => false);
    if (blocked) {
      const ipText = await page.locator('text=Client IP:').first()
        .textContent({ timeout: 1000 }).catch(() => '');
      await shot('00-WAF-BLOCK-erkannt');
      throw new Error(
        `WAF-Block erkannt auf ${sel.loginUrl}. GC hat die Anfrage abgewiesen. ` +
        `Sichtbare Client-IP auf der Block-Seite: ${(ipText || 'nicht lesbar').trim()}. ` +
        `Wenn das eine Data-Center-IP (Hetzner, OVH, AWS, ...) ist, muss der Service vom Heimnetz laufen.`
      );
    }

    // 2) Aktiv warten bis die Seite WIRKLICH gerendert ist: entweder das
    //    Login-Formular ODER der eingeloggt-Marker taucht auf. A3-Commerce ist
    //    eine SPA — direkt nach domcontentloaded ist der Body noch leer. Deshalb
    //    hier warten statt sofort auf "leer" zu pruefen (das war der Fehlalarm).
    const loginFormDa = await page.locator(sel.selectors.usernameInput).first()
      .waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false);

    if (!loginFormDa) {
      // Kein Login-Formular. Unterscheiden: (a) schon eingeloggt, (b) stiller Block.
      const eingeloggt = await page.locator(sel.selectors.loggedInSelector).first()
        .isVisible({ timeout: 2000 }).catch(() => false);
      if (eingeloggt) {
        await shot('02-bereits-eingeloggt');
        console.log(`${grosshaendler}: bereits eingeloggt`);
        return { page, shot };
      }
      const bodyLen = await page.evaluate(
        () => (document.body ? document.body.innerText.trim().length : 0)
      ).catch(() => 0);
      const bedienelemente = await page.locator('a, button, input').count().catch(() => 0);
      if (bodyLen < 20 && bedienelemente === 0) {
        await shot('00b-leere-seite-stiller-block');
        throw new Error(
          `Leere Seite von ${sel.loginUrl} erhalten (kein Text, keine Bedienelemente). ` +
          `Stiller Bot-Block auf Fingerprint-Ebene. Pruefen: echtes Chrome ` +
          `(BROWSER_CHANNEL=chrome, HEADLESS=false)? IP eine Heim-/Buero-Leitung (kein Datacenter/VPN)?`
        );
      }
      // Seite hat Inhalt, aber kein Login-Formular -> vermutlich schon eingeloggt.
      await shot('02b-kein-login-formular-seite-hat-inhalt');
      console.log(`${grosshaendler}: kein Login-Formular, Seite hat Inhalt — nehme "eingeloggt" an.`);
      return { page, shot };
    }
    // Login-Formular ist da => nicht eingeloggt.
    if (LOGIN_MODE !== 'auto') {
      // Session-Seed-Modus (Standard): KEINE Zugangsdaten tippen. GC lehnt den
      // automatischen Login ab (Fehler 11221777). Die Session muss einmal von
      // Hand im Bot-Profil angemeldet werden; danach nutzt der Bot sie.
      await shot('02c-nicht-eingeloggt-session-seed-noetig');
      const profil = path.join(DATA_DIR, `chrome-profil-${grosshaendler.toLowerCase()}`);
      throw new Error(
        `${grosshaendler} nicht eingeloggt (GC_LOGIN_MODE=session). Session einmal von Hand anmelden: ` +
        `1) Service stoppen  2) Chrome mit Profil "${profil}" oeffnen und bei gconlineplus.de einloggen  ` +
        `3) Chrome schliessen  4) Service starten. Danach nutzt der Bot diese Session automatisch weiter.`
      );
    }

    // --- GC_LOGIN_MODE=auto: Login mit ECHTEN Tastatureingaben ---
    // page.fill() setzt nur .value + ein 'input'-Event. GCs altes A3-Commerce-
    // Framework liest das Passwort aber ueber echte Tastatur-Events -> .fill()
    // wird ignoriert, der Login geht mit leerem Passwort raus (Fehler 11221777).
    // Deshalb: Zeichen fuer Zeichen tippen (pressSequentially), dann Tab fuer das
    // change-Event, dann Login klicken — wie ein Mensch.
    const { user, pass } = credentials(grosshaendler);
    const userFeld = page.locator(sel.selectors.usernameInput).first();
    await userFeld.click();
    await userFeld.fill('');                          // evtl. Autofill/Alt-Wert leeren
    await userFeld.pressSequentially(user, { delay: 45 });
    await shot('03-username-getippt');
    const passFeld = page.locator(sel.selectors.passwordInput).first();
    await passFeld.click();
    await passFeld.fill('');
    await passFeld.pressSequentially(pass, { delay: 45 });
    await passFeld.press('Tab');                      // Blur -> change-Event ausloesen
    await shot('04-passwort-getippt');
    await page.click(sel.selectors.loginButton);
    await shot('05-login-submit-geklickt');
    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch { /* egal */ }
    await shot('06-nach-networkidle');
    // Erfolg robust pruefen: nach dem Submit braucht die SPA einen Moment, bis
    // sie das Konto-Panel rendert. Deshalb bis zu 20s warten auf ein positives
    // Signal: LOGOUT-Button sichtbar ODER Login-Feld verschwunden. (Der fruehere
    // Sofort-Check meldete faelschlich "nicht eingeloggt", obwohl der Login lief.)
    let eingeloggt = false;
    const bis = Date.now() + 20000;
    while (Date.now() < bis) {
      const marker = await page.getByText('LOGOUT', { exact: false }).first().isVisible().catch(() => false);
      const formWeg = !(await page.locator(sel.selectors.usernameInput).first().isVisible().catch(() => false));
      if (marker || formWeg) { eingeloggt = true; break; }
      await page.waitForTimeout(500);
    }
    if (!eingeloggt) {
      // GC-Fehlerdialog abfangen (z. B. "Es ist ein Fehler mit der Nummer 11221777 ...")
      const gcFehler = await page.getByText('Fehler mit der Nummer', { exact: false }).first()
        .textContent().catch(() => null);
      await shot('07-login-fail');
      throw new Error(
        `Login abgeschickt, aber noch nicht eingeloggt` +
        `${gcFehler ? ` — GC meldet: "${gcFehler.trim()}"` : ''}.`
      );
    }
    await shot('08-login-erfolgreich');
    console.log(`${grosshaendler}: Login erfolgreich.`);
    return { page, shot };
  } catch (e) {
    try { await shot(`error-${e.message.slice(0, 30).replace(/\W+/g, '_')}`); } catch {}
    await page.screenshot({ path: path.join(LOG_DIR, `login-fail-${Date.now()}.png`) }).catch(() => {});
    throw new Error(`Login fehlgeschlagen für ${grosshaendler}: ${e.message}`);
  }
}

// ---------------------------------------------------------------- Bestell-Flow

// "stand" ist die ehrliche Antwort auf die Frage, die nach einem Abbruch zaehlt:
// kann im Portal schon etwas entstanden sein? Vor dem Absenden des Dialogs
// sicher nicht, danach sehr wohl. Der Bot entscheidet daran, ob er dem Monteur
// sagt "einfach nochmal" oder "erst nachsehen".
async function neuerWarenkorb(page, job, sel, gelernt, ctx, stand) {
  const { log, shot } = ctx;
  // Direkter Aufruf von /carts liefert bei GC eine 404 (IIS-Server-Fehler).
  // Die Warenkorb-Liste wird ueber den Menuepunkt "Warenkörbe" geoeffnet.
  log('Öffne Warenkörbe über das Menü...');
  await act(page, specFor(sel, gelernt, 'warenkoerbeOeffnen'), ctx);
  await page.waitForTimeout(2500);   // Liste rendern lassen, bevor das +-Icon gesucht wird
  await shot('10-warenkoerbe-liste-offen');

  await act(page, specFor(sel, gelernt, 'warenkorbHinzufuegen'), ctx);
  await shot('12-warenkorb-dialog-offen');
  await act(page, specFor(sel, gelernt, 'auftragsnummer', { aktion: 'fill', wert: job.kundennummer || '1' }), ctx);
  await act(page, specFor(sel, gelernt, 'auftragstext',   { aktion: 'fill', wert: job.kundentext || '' }), ctx);
  await shot('15-dialog-ausgefuellt');
  // Ab hier ist der Warenkorb moeglicherweise angelegt.
  if (stand) stand.warenkorbMoeglich = true;
  await act(page, specFor(sel, gelernt, 'warenkorbDialogHinzufuegen'), ctx);
  await page.waitForTimeout(500);
  await shot('17-warenkorb-position-seite-offen');
  log('Warenkorb ist offen.');
}

async function positionHinzufuegen(page, sel, gelernt, position, ctx, idx) {
  const { log, shot } = ctx;
  const prefix = `2${idx + 1}`;
  log(`Position ${idx + 1}: ${position.artikelnr} x ${position.menge}`);
  await act(page, specFor(sel, gelernt, 'artikelAdd'), ctx);
  await act(page, specFor(sel, gelernt, 'artikelNummer', { aktion: 'fill', wert: String(position.artikelnr) }), ctx);
  await act(page, specFor(sel, gelernt, 'artikelMenge',  { aktion: 'fill', wert: String(position.menge) }), ctx);
  await act(page, specFor(sel, gelernt, 'artikelSubmit'), ctx);
  await page.waitForTimeout(800);
  await shot(`${prefix}-position-${idx + 1}-hinzugefuegt`);
}

async function weiterleiten(page, job, sel, gelernt, ctx) {
  const { log, shot } = ctx;
  const empfaenger = empfaengerFuer(job);
  if (!empfaenger) {
    await shot('30-error-kein-empfaenger-konfiguriert');
    throw new Error('Kein Empfaenger konfiguriert. Setze job.empfaenger oder ENV GC_FORWARD_TO.');
  }
  log(`Weiterleiten an: ${empfaenger}`);
  await act(page, specFor(sel, gelernt, 'hamburger'), ctx);          // Icon -> KI-Vision-faehig
  await page.waitForTimeout(400);
  await shot('31-hamburger-offen');
  await act(page, specFor(sel, gelernt, 'weiterleitenItem'), ctx);
  await page.waitForTimeout(600);
  await shot('32-weiterleiten-dialog-offen');
  await act(page, specFor(sel, gelernt, 'empfaenger', { aktion: 'fill', wert: empfaenger }), ctx);
  await shot('33-empfaenger-eingefuellt');
  await act(page, specFor(sel, gelernt, 'weiterleitenSubmit'), ctx);
  try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* egal */ }
  await page.waitForTimeout(1000);
  await shot('35-weiterleitung-abgeschlossen');
}

async function fuegeBestellungEin(context, job, sel, jobDir, log, stand) {
  const { page, shot } = await loginWennNoetig(context, job.grosshaendler, sel, jobDir, log);
  const gelernt = ladeGelernt();
  // KI-Budget pro Job frisch (used-Zaehler nicht ueber Jobs hinweg teilen).
  const ai = {
    provider: AI.provider, baseUrl: AI.baseUrl, key: AI.key,
    model: AI.model, visionModel: AI.visionModel,
    vision: AI.vision, budget: AI.budget, enabled: AI.enabled, used: 0
  };
  const heal = macheHeal(gelernt, log);
  const ctx = { log, shot, ai, heal };
  if (!ai.enabled) log('Hinweis: KI-Fallback aus (AI_API_KEY / AI_MODEL / AI_BASE_URL nicht gesetzt) — nur deterministisch.');
  try {
    if (stand) stand.phase = 'warenkorb';
    await neuerWarenkorb(page, job, sel, gelernt, ctx, stand);
    if (stand) { stand.phase = 'positionen'; stand.warenkorbMoeglich = true; }
    let hinzugefuegt = 0;
    for (const [i, p] of job.positionen.entries()) {
      if (!p.artikelnr) {
        log(`Position ${i + 1} (${p.bezeichnung}): keine Artikelnummer, uebersprungen`);
        continue;
      }
      await positionHinzufuegen(page, sel, gelernt, p, ctx, i);
      hinzugefuegt++;
    }
    log(`${hinzugefuegt} Positionen hinzugefuegt.`);
    if (stand) stand.phase = 'weiterleiten';
    await weiterleiten(page, job, sel, gelernt, ctx);

    await shot('99-FERTIG-erfolg');
    return {
      ok: true,
      jobId: path.basename(jobDir),
      bestellnummer: null,
      screenshot: path.join(SCREENSHOT_DIR, path.basename(jobDir), '99-FERTIG-erfolg.png'),
      log: `Warenkorb mit ${hinzugefuegt} Positionen an ${empfaengerFuer(job)} weitergeleitet.`,
      kiSchritte: ai.used
    };
  } catch (e) {
    try { await shot(`error-${e.message.slice(0, 30).replace(/\W+/g, '_')}`); } catch {}
    throw e;
  } finally {
    await page.close().catch(() => {});
  }
}

// ---------------------------------------------------------------- Endpoints

fastify.get('/health', async () => ({
  status: 'ok',
  browser: contexts.size > 0 ? 'running' : 'not_started',
  channel: CDP_ENDPOINT ? 'cdp' : BROWSER_CHANNEL,
  headless: HEADLESS,
  ki: AI.enabled ? { provider: AI.provider, model: AI.model, vision: AI.vision, budget: AI.budget } : 'aus',
  contexts: Array.from(contexts.keys())
}));

fastify.post('/login/:grosshaendler', async (req, reply) => {
  const { grosshaendler } = req.params;
  const sel = ladeSelektoren(grosshaendler);
  const ctx = await getContext(grosshaendler);
  const jobId = `login-${grosshaendler.toLowerCase()}-${Date.now()}`;
  const jobDir = path.join(SCREENSHOT_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });
  const logFile = path.join(jobDir, 'log.txt');
  const log = (msg) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(logFile, line);
    console.log(`[${jobId}] ${msg}`);
  };
  const { page } = await loginWennNoetig(ctx, grosshaendler, sel, jobDir, log);
  await page.close();
  return { ok: true, grosshaendler, jobId, screenshotDir: jobDir };
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
    console.log(`[${jobId}] ${msg}`);
  };

  // Vor dem ersten Klick ist garantiert nichts passiert.
  const stand = { phase: 'login', warenkorbMoeglich: false };
  try {
    const sel = ladeSelektoren(grosshaendler);
    const ctx = await getContext(grosshaendler);
    return await fuegeBestellungEin(ctx, job, sel, jobDir, log, stand);
  } catch (e) {
    log(`FEHLER in Phase "${stand.phase}": ${e.message}`);
    // Den letzten Screenshot mitgeben — darauf ist meistens zu sehen, woran es hing.
    let letztes = null;
    try {
      const bilder = fs.readdirSync(jobDir).filter((f) => f.endsWith('.png')).sort();
      if (bilder.length) letztes = path.join(jobDir, bilder[bilder.length - 1]);
    } catch { /* kein Bild, kein Drama */ }
    return reply.code(500).send({
      error: e.message,
      jobId,
      phase: stand.phase,
      // Entscheidend fuer den Bot: darf der Monteur bedenkenlos neu bestellen?
      warenkorbMoeglich: stand.warenkorbMoeglich === true,
      screenshot: letztes
    });
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
