// Laptop-Agent — holt Aufträge von der Hetzner-Box ab und lässt sie hier laufen.
//
// ══════════════════════════════════════════════════════════════════════════
// WARUM DIESE RICHTUNG
// ══════════════════════════════════════════════════════════════════════════
//
// Der Bot läuft auf der Box, der Browser muss hier laufen (GC sperrt
// Rechenzentrums-IPs). Die Box kann diesen Laptop aber nicht anrufen: kein
// fester Anschluss, Router davor, und zwischendurch schläft er.
//
// Also fragt der Laptop nach. Er hält eine Leitung offen und wartet bis zu
// 25 Sekunden auf einen Auftrag — das ist ein Long-Poll und spart hunderte
// leere Anfragen pro Stunde. Kommt einer, wird er hier ausgeführt und das
// Ergebnis zurückgemeldet.
//
//     Box                                 dieser Laptop
//     ───                                 ─────────────
//     [Auftrag wartet]  ◄── GET /agent/auftrag?warte=25  (hängt)
//              └──────────► Auftrag                       agent.js
//                                                            │
//                                   POST 127.0.0.1:8787/bestellung
//                                                            │
//                                                    Playwright + echtes Chrome
//                                                            │
//     [fertig]  ◄─────────── POST /agent/ergebnis/<id> ──────┘
//
// ══════════════════════════════════════════════════════════════════════════
// EINE REGEL, DIE WICHTIG IST
// ══════════════════════════════════════════════════════════════════════════
//
// Läuft der Playwright-Dienst hier nicht, holt der Agent GAR KEINEN Auftrag ab.
// Er meldet der Box nur, dass er da ist, der Dienst aber aus. Die Bestellung
// bleibt in der Warteschlange und läuft, sobald alles steht. Andernfalls würde
// jede Bestellung, die in eine Startlücke fällt, als "fehlgeschlagen" beim
// Monteur landen, obwohl niemand etwas falsch gemacht hat.
//
// Start:  node --env-file=.env agent.js
//
// .env (im selben Ordner wie server.js):
//   AUFTRAGSSTELLE_URL=http://<box-ip>:8788
//   AGENT_TOKEN=<identisch mit AGENT_TOKEN in der WWS-.env auf der Box>
//   AGENT_ID=felix                      (frei wählbar, erscheint in den Logs)
//   LOKALER_DIENST=http://127.0.0.1:8787
//   SERVICE_TOKEN=<wie bisher, für den lokalen Dienst>

import fs from 'node:fs';
import path from 'node:path';

const BOX = (process.env.AUFTRAGSSTELLE_URL || '').replace(/\/+$/, '');
const TOKEN = process.env.AGENT_TOKEN || '';
const AGENT_ID = process.env.AGENT_ID || 'laptop';
const DIENST = (process.env.LOKALER_DIENST || 'http://127.0.0.1:8787').replace(/\/+$/, '');
const DIENST_TOKEN = process.env.SERVICE_TOKEN || '';

const WARTE_S = 25;
const HEARTBEAT_MS = 20_000;
const LEBT_MS = 60_000;
const DIENST_PRUEFUNG_MS = 15_000;
const JOB_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DATEI_BYTES = 8 * 1024 * 1024;

if (!BOX || !TOKEN) {
  console.error('AUFTRAGSSTELLE_URL und AGENT_TOKEN müssen gesetzt sein.');
  console.error('Start:  node --env-file=.env agent.js');
  process.exit(1);
}

const zeit = () => new Date().toISOString().slice(11, 19);
const log = (...a) => console.log(`[${zeit()}]`, ...a);
const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

async function anBox(pfad, { method = 'GET', koerper = null, timeoutMs = 20_000 } = {}) {
  const r = await fetch(`${BOX}${pfad}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'X-Agent': AGENT_ID,
      ...(koerper ? { 'Content-Type': 'application/json' } : {})
    },
    body: koerper ? JSON.stringify(koerper) : undefined,
    signal: AbortSignal.timeout(timeoutMs)
  });
  return r;
}

// ────────────────────────────────────────────── Zustand des lokalen Dienstes

let dienstOk = false;
let dienstGeprueft = 0;
let dienstGrund = 'noch nicht geprüft';

async function pruefeDienst() {
  if (Date.now() - dienstGeprueft < DIENST_PRUEFUNG_MS) return dienstOk;
  dienstGeprueft = Date.now();
  try {
    const r = await fetch(`${DIENST}/health`, { signal: AbortSignal.timeout(4000) });
    dienstOk = r.ok;
    dienstGrund = r.ok ? 'ok' : `HTTP ${r.status}`;
  } catch (e) {
    dienstOk = false;
    dienstGrund = e.message;
  }
  return dienstOk;
}

// ────────────────────────────────────────────────────────────── Heartbeat

async function heartbeat() {
  try {
    await anBox('/agent/heartbeat', {
      method: 'POST',
      koerper: { info: { dienst: dienstOk ? 'an' : 'aus', grund: dienstGrund, version: 1 } },
      timeoutMs: 10_000
    });
  } catch { /* nächster Schlag reicht */ }
}

// ──────────────────────────────────────────────────────────── Dateien lesen

function leseDatei(pfad) {
  try {
    const st = fs.statSync(pfad);
    if (!st.isFile() || st.size === 0 || st.size > MAX_DATEI_BYTES) return null;
    return { name: path.basename(pfad), inhaltBase64: fs.readFileSync(pfad).toString('base64') };
  } catch { return null; }
}

// Bei Erfolg der Abschluss-Screenshot, bei einem Fehler der letzte vorhandene —
// darauf ist meist zu sehen, woran es hing.
function sammleBilder(body, jobId) {
  const raus = [];
  if (body && body.screenshot) {
    const d = leseDatei(body.screenshot);
    if (d) raus.push(d);
  }
  if (!raus.length && jobId) {
    const basis = process.env.SCREENSHOT_DIR || './screenshots';
    const dir = path.join(basis, jobId);
    try {
      const bilder = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
      const letztes = bilder[bilder.length - 1];
      if (letztes) {
        const d = leseDatei(path.join(dir, letztes));
        if (d) raus.push(d);
      }
    } catch { /* kein Ordner, kein Bild — kein Drama */ }
  }
  return raus;
}

// ───────────────────────────────────────────────────────── Auftrag ausführen

// ══════════════════════════════════════════════════════════════════════════
// "FEHLGESCHLAGEN" UND "UNKLAR" SIND NICHT DASSELBE
// ══════════════════════════════════════════════════════════════════════════
//
// Bei einer Bestellung ist der Unterschied teuer. Kam die Anfrage nie beim
// Browser-Dienst an, ist garantiert nichts passiert — der Monteur kann
// bedenkenlos nochmal bestellen. Brach die Verbindung ab, NACHDEM die Anfrage
// draussen war, kann der Warenkorb längst stehen; ein zweiter Anlauf liefert
// dann doppelt. Solche Fälle gehen als "unklar" zurück, und der Bot sagt: erst
// im Portal nachsehen.
async function fuehreAus(auftrag) {
  if (auftrag.art !== 'bestellung') {
    return { ok: false, unklar: false, fehler: `Unbekannte Auftragsart "${auftrag.art}". Agent zu alt?` };
  }

  // Unmittelbar davor noch einmal frisch prüfen, nicht aus dem Zwischenspeicher.
  dienstGeprueft = 0;
  if (!(await pruefeDienst())) {
    return {
      ok: false, unklar: false,
      fehler: `Der Browser-Dienst auf dem Laptop antwortet nicht (${dienstGrund}). Es wurde nichts bestellt.`
    };
  }

  let r;
  try {
    r = await fetch(`${DIENST}/bestellung`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${DIENST_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(auftrag.nutzlast),
      signal: AbortSignal.timeout(JOB_TIMEOUT_MS)
    });
  } catch (e) {
    return {
      ok: false, unklar: true,
      fehler: `Verbindung zum Browser-Dienst mitten im Auftrag verloren (${e.message}).`
    };
  }

  const text = await r.text().catch(() => '');
  let body;
  try { body = JSON.parse(text); } catch { body = { roh: String(text).slice(0, 500) }; }

  if (!r.ok) {
    // 4xx: der Dienst hat die Anfrage abgelehnt, bevor er etwas getan hat.
    // 5xx: er ist mittendrin gestolpert. Der Dienst sagt selbst, ob er den
    // Warenkorb-Dialog schon abgeschickt hatte — ein Login-Fehler ist damit
    // ein sauberer Fehlschlag und kein Grund, den Monteur ins Portal zu
    // schicken. Fehlt die Angabe (aelterer Dienst), bleiben wir vorsichtig.
    const sicherNichtsPassiert = r.status < 500 || body.warenkorbMoeglich === false;
    return {
      ok: false, unklar: !sicherNichtsPassiert,
      fehler: (body && (body.error || body.roh)) || `Der Browser-Dienst antwortete mit HTTP ${r.status}` +
        (body && body.phase ? ` (Phase: ${body.phase})` : ''),
      dateien: sammleBilder(body, body && body.jobId)
    };
  }
  return {
    ok: true,
    ergebnis: { bestellnummer: body.bestellnummer || null, jobId: body.jobId || null, log: body.log || '' },
    dateien: sammleBilder(body, body.jobId)
  };
}

async function bearbeite(auftrag) {
  log(`Auftrag ${auftrag.id}: ${auftrag.beschreibung} (Versuch ${auftrag.versuch})`);

  // Solange gearbeitet wird, der Box Bescheid geben — sonst hält sie den
  // Auftrag nach 8 Minuten für verschollen.
  const lebt = setInterval(() => {
    anBox(`/agent/lebt/${auftrag.id}`, { method: 'POST', timeoutMs: 10_000 })
      .catch(() => { /* die Box entscheidet, nicht wir */ });
  }, LEBT_MS);

  let ergebnis;
  try {
    ergebnis = await fuehreAus(auftrag);
  } catch (e) {
    // Abbruch im Agenten selbst: auch hier weiss niemand, wie weit der
    // Browser gekommen war.
    ergebnis = { ok: false, unklar: true, fehler: `Auf dem Laptop abgebrochen: ${e.message}` };
  } finally {
    clearInterval(lebt);
  }

  log(`Auftrag ${auftrag.id}: ${ergebnis.ok ? 'fertig' : (ergebnis.unklar ? 'UNKLAR — ' : 'Fehler — ') + ergebnis.fehler}`);

  // Zurückmelden, bis es klappt. Ein Ergebnis, das niemand erfährt, ist
  // schlimmer als eins, das spät kommt — der Monteur wartet darauf.
  for (let versuch = 1; versuch <= 10; versuch++) {
    try {
      const r = await anBox(`/agent/ergebnis/${auftrag.id}`, {
        method: 'POST', koerper: ergebnis, timeoutMs: 60_000
      });
      if (r.ok) return;
      log(`Rückmeldung abgelehnt (HTTP ${r.status}), Versuch ${versuch}`);
    } catch (e) {
      log(`Rückmeldung fehlgeschlagen (${e.message}), Versuch ${versuch}`);
    }
    await schlaf(Math.min(30_000, 2000 * versuch));
  }
  log(`Auftrag ${auftrag.id}: Rückmeldung endgültig fehlgeschlagen. Ergebnis geht verloren.`);
}

// ────────────────────────────────────────────────────────────── Hauptschleife

async function schleife() {
  let ruhe = 1000;
  for (;;) {
    try {
      if (!(await pruefeDienst())) {
        // Bewusst KEINEN Auftrag abholen — siehe Kopfkommentar.
        log(`Playwright-Dienst nicht erreichbar (${dienstGrund}) — hole nichts ab.`);
        await heartbeat();
        await schlaf(10_000);
        continue;
      }

      const r = await anBox(`/agent/auftrag?warte=${WARTE_S}&agent=${encodeURIComponent(AGENT_ID)}`,
        { timeoutMs: (WARTE_S + 15) * 1000 });

      if (r.status === 204) { ruhe = 1000; continue; }
      if (r.status === 401) {
        log('Token abgelehnt. AGENT_TOKEN hier und in der WWS-.env auf der Box müssen gleich sein.');
        await schlaf(60_000);
        continue;
      }
      if (!r.ok) throw new Error(`Auftragsstelle antwortete HTTP ${r.status}`);

      ruhe = 1000;
      await bearbeite(await r.json());
    } catch (e) {
      // Netz weg, Box neu gestartet, WLAN gewechselt — das ist der Normalfall
      // bei einem Laptop. Langsam hochzählen statt im Sekundentakt hämmern.
      log(`Keine Verbindung zur Box (${e.message}) — neuer Versuch in ${Math.round(ruhe / 1000)} s`);
      await schlaf(ruhe);
      ruhe = Math.min(60_000, Math.round(ruhe * 1.8));
    }
  }
}

log(`Agent "${AGENT_ID}" startet.`);
log(`  Box:            ${BOX}`);
log(`  lokaler Dienst: ${DIENST}`);
await pruefeDienst();
log(`  Dienst gerade:  ${dienstOk ? 'erreichbar' : 'NICHT erreichbar (' + dienstGrund + ')'}`);
await heartbeat();
setInterval(heartbeat, HEARTBEAT_MS).unref?.();
schleife();
