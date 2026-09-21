// Auftragsstelle — die Warteschlange zwischen Hetzner und dem Laptop.
//
// ══════════════════════════════════════════════════════════════════════════
// WARUM ES DIESE SCHICHT GIBT
// ══════════════════════════════════════════════════════════════════════════
//
// Der Bot läuft auf der Hetzner-Box. Die Browser-Navigation im Großhändler-
// Portal MUSS auf dem Laptop laufen: GC sperrt Rechenzentrums-IPs schon auf
// Netzwerkebene, bevor überhaupt eine Seite ausgeliefert wird. Das ist keine
// Einstellungssache, das ist Imperva vor dem Portal.
//
// Hetzner kann den Laptop aber nicht anrufen: der sitzt hinter einem Router,
// hat keine feste Adresse und schläft zwischendurch. Deshalb dreht sich die
// Richtung um — der Laptop FRAGT NACH:
//
//     Hetzner                              Laptop
//     ───────                              ──────
//     stelleEin(auftrag)  ──► [wartet]
//                                  ▲
//                                  │  GET /agent/auftrag   (Long-Poll)
//                                  └──────────────────────  holeNaechsten()
//                             [laeuft]
//                                  ▲
//                                  │  POST /agent/ergebnis/:id
//                             [fertig]  ◄──────────────────  melde()
//                                  │
//                                  └──► Telegram-Nachricht an den Monteur
//
// Das hat drei Folgen, die man kennen muss:
//
//   1. Bestellen geht vom Handy aus, auch wenn der Laptop zugeklappt ist.
//      Der Auftrag wartet und läuft, sobald der Laptop wieder da ist.
//   2. Die Antwort im Chat kommt in ZWEI Teilen: erst die Bestätigung, dass
//      der Auftrag steht, später das Ergebnis. Der Bot sagt beim ersten Teil
//      ehrlich, ob der Laptop gerade erreichbar ist oder nicht.
//   3. Nichts geht verloren, wenn die Box neu startet — die Warteschlange
//      liegt auf der Platte, nicht im Speicher.
//
// ══════════════════════════════════════════════════════════════════════════
// KEINE AUTOMATISCHE WIEDERHOLUNG BEI BESTELLUNGEN
// ══════════════════════════════════════════════════════════════════════════
//
// Bricht der Laptop mitten in einem Auftrag ab, weiß niemand, wie weit er
// gekommen ist — der Warenkorb kann längst angelegt sein. Ein automatischer
// zweiter Versuch würde dann doppelt bestellen. Solche Aufträge landen
// deshalb im Zustand "unklar" statt wieder in der Schlange, und der Monteur
// bekommt gesagt, dass er im Portal nachsehen soll. Aufträge, bei denen ein
// zweiter Versuch harmlos ist, können `wiederholbar: true` setzen.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('../config');

const ORDNER = path.join(PFADE.DATA, 'auftraege');

// Wie lange ein Auftrag beim Agenten liegen darf, bevor die Auftragsstelle
// ihn als verschollen betrachtet. Großzügig: eine GC-Bestellung mit Login,
// Cookie-Banner und mehreren Positionen braucht gut und gerne zwei Minuten.
// Ueber die .env verstellbar, damit sich das Verhalten testen laesst, ohne
// acht Minuten zu warten — und damit ein sehr langsamer Anschluss nachjustiert
// werden kann, ohne den Code anzufassen.
const LEASE_MS = Number(process.env.AUFTRAG_LEASE_MS || 8 * 60 * 1000);

// Ab wann gilt der Laptop als offline. Der Agent meldet sich alle 20 s.
const AGENT_STILL_MS = Number(process.env.AGENT_STILL_MS || 90 * 1000);

// Aufräumen: erledigte Aufträge verfallen nach 30 Tagen, höchstens 500 Stück.
const AUFHEBEN_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_AUFTRAEGE = 500;

const ZUSTAENDE = ['wartet', 'laeuft', 'fertig', 'fehler', 'unklar', 'abgebrochen'];
const OFFEN = new Set(['wartet', 'laeuft']);

// ──────────────────────────────────────────────────────────────── Ablage

function sorgeFuerOrdner() {
  fs.mkdirSync(ORDNER, { recursive: true });
}

function pfad(id) { return path.join(ORDNER, `${id}.json`); }

function schreibe(auftrag) {
  sorgeFuerOrdner();
  // Erst daneben schreiben, dann umbenennen: ein Absturz mitten im Schreiben
  // hinterlässt so keine halbe JSON-Datei, die beim Start nicht mehr lesbar ist.
  const ziel = pfad(auftrag.id);
  const temp = ziel + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(auftrag, null, 2), 'utf-8');
  fs.renameSync(temp, ziel);
  return auftrag;
}

function lies(id) {
  try { return JSON.parse(fs.readFileSync(pfad(id), 'utf-8')); }
  catch { return null; }
}

function alle() {
  sorgeFuerOrdner();
  let dateien = [];
  try { dateien = fs.readdirSync(ORDNER).filter((f) => f.endsWith('.json')); }
  catch { return []; }
  const raus = [];
  for (const f of dateien) {
    const a = lies(f.slice(0, -5));
    if (a && a.id) raus.push(a);
  }
  raus.sort((a, b) => String(a.eingestellt).localeCompare(String(b.eingestellt)));
  return raus;
}

function neueId() {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

// ────────────────────────────────────────────── Wartende Long-Poll-Anfragen

// Der Agent hängt in GET /agent/auftrag und wartet. Kommt ein Auftrag herein,
// wird er sofort geweckt — kein Warten auf den nächsten Poll-Takt.
const _wartende = [];

function weckeEinen() {
  const w = _wartende.shift();
  if (w) w();
}

// ─────────────────────────────────────────────────────── Agent-Lebenszeichen

let _agent = { id: null, zuletzt: 0, info: null };

function heartbeat(agentId, info) {
  _agent = { id: agentId || _agent.id || 'agent', zuletzt: Date.now(), info: info || null };
  return agentZustand();
}

function agentZustand() {
  const stille = _agent.zuletzt ? Date.now() - _agent.zuletzt : null;
  return {
    bekannt: !!_agent.zuletzt,
    online: stille !== null && stille < AGENT_STILL_MS,
    agentId: _agent.id,
    zuletzt: _agent.zuletzt ? new Date(_agent.zuletzt).toISOString() : null,
    stilleSekunden: stille === null ? null : Math.round(stille / 1000),
    info: _agent.info
  };
}

// ──────────────────────────────────────────────────── Ergebnis-Benachrichtigung

// Transport-neutral: die Auftragsstelle kennt kein Telegram. bot.js hängt sich
// hier ein und schickt die Nachricht über benachrichtigung.js raus.
const _hoerer = [];
function beiErgebnis(fn) { if (typeof fn === 'function') _hoerer.push(fn); }

async function melde_(auftrag) {
  for (const h of _hoerer) {
    try { await h(auftrag); }
    catch (err) { console.error('Auftragsstelle: Hörer fehlgeschlagen:', err.message); }
  }
}

// ──────────────────────────────────────────────────────────────── Einstellen

// auftrag = {
//   art:           'bestellung' | ... (bestimmt, was der Agent tut)
//   chatId:        wer benachrichtigt werden will
//   beschreibung:  eine Zeile Klartext für Listen und Meldungen
//   nutzlast:      was der Agent an den lokalen Dienst weiterreicht
//   ziel:          wohin die spaetere Meldung soll (Adapter-Sache, hier opak)
//   wiederholbar:  darf nach einem Abbruch neu versucht werden (Default: nein)
// }
function stelleEin({ art, chatId, ziel = null, beschreibung, nutzlast, wiederholbar = false }) {
  if (!art) throw new Error('Auftrag ohne art');
  const auftrag = {
    id: neueId(),
    art,
    chatId: chatId == null ? null : String(chatId),
    // Zustellziel fuer die spaetere Meldung (z. B. Forum-Thema). Rein
    // transportbezogen — die Auftragsstelle deutet es nicht, sie hebt es auf.
    ziel: (ziel && Object.keys(ziel).length) ? ziel : null,
    beschreibung: String(beschreibung || art),
    nutzlast: nutzlast || {},
    wiederholbar: !!wiederholbar,
    zustand: 'wartet',
    versuche: 0,
    eingestellt: new Date().toISOString(),
    begonnen: null,
    beendet: null,
    leaseBis: null,
    agentId: null,
    ergebnis: null,
    fehler: null
  };
  schreibe(auftrag);
  weckeEinen();
  return auftrag;
}

// ──────────────────────────────────────────────────────────────── Abholen

function holeNaechsten(agentId) {
  pruefeLeases();
  const wartend = alle().filter((a) => a.zustand === 'wartet');
  if (!wartend.length) return null;
  const a = wartend[0];
  a.zustand = 'laeuft';
  a.versuche += 1;
  a.begonnen = new Date().toISOString();
  a.leaseBis = new Date(Date.now() + LEASE_MS).toISOString();
  a.agentId = agentId || 'agent';
  schreibe(a);
  heartbeat(agentId, { holt: a.id });
  return a;
}

// Long-Poll: bis zu msWarten auf einen Auftrag warten, statt sofort leer
// zurückzukommen. Spart dem Laptop hunderte sinnlose Anfragen pro Stunde.
function warteAufAuftrag(agentId, msWarten = 25_000) {
  const sofort = holeNaechsten(agentId);
  if (sofort) return Promise.resolve(sofort);

  return new Promise((resolve) => {
    let erledigt = false;
    const fertig = () => {
      if (erledigt) return;
      erledigt = true;
      clearTimeout(timer);
      const i = _wartende.indexOf(wecker);
      if (i >= 0) _wartende.splice(i, 1);
      resolve(holeNaechsten(agentId));
    };
    const wecker = () => fertig();
    const timer = setTimeout(fertig, Math.max(1000, msWarten));
    _wartende.push(wecker);
  });
}

// Der Agent verlängert die Frist, solange er an einem Auftrag arbeitet.
function verlaengere(id, agentId) {
  const a = lies(id);
  if (!a || a.zustand !== 'laeuft') return null;
  a.leaseBis = new Date(Date.now() + LEASE_MS).toISOString();
  schreibe(a);
  heartbeat(agentId, { arbeitet: id });
  return a;
}

// ──────────────────────────────────────────────────────────────── Ergebnis

// unklar = die Arbeit wurde angestossen, aber niemand weiss, wie weit sie kam.
// Bei Bestellungen ist das ein eigener Zustand und kein Fehlschlag: der
// Unterschied entscheidet, ob der Monteur einfach neu bestellen darf.
async function melde(id, { ok, unklar = false, ergebnis, fehler }) {
  const a = lies(id);
  if (!a) return null;
  if (a.zustand !== 'laeuft') {
    // Spätes Ergebnis zu einem Auftrag, den wir schon abgeschrieben hatten.
    // Wir nehmen es trotzdem an — es ist die bessere Information.
    console.warn(`Auftragsstelle: Ergebnis fuer ${id} im Zustand ${a.zustand} angenommen`);
  }
  a.zustand = ok ? 'fertig' : (unklar ? 'unklar' : 'fehler');
  a.beendet = new Date().toISOString();
  a.leaseBis = null;
  a.ergebnis = ok ? (ergebnis || {}) : null;
  a.fehler = ok ? null : String(fehler || 'unbekannter Fehler');
  schreibe(a);
  await melde_(a);
  return a;
}

// ─────────────────────────────────────────────────────────── Verschollenes

// Aufträge, deren Frist abgelaufen ist. Siehe Kopfkommentar: wiederholt wird
// nur, was ausdrücklich als wiederholbar eingestellt wurde.
function pruefeLeases() {
  const jetzt = Date.now();
  const betroffen = [];
  for (const a of alle()) {
    if (a.zustand !== 'laeuft' || !a.leaseBis) continue;
    if (new Date(a.leaseBis).getTime() > jetzt) continue;

    if (a.wiederholbar && a.versuche < 2) {
      a.zustand = 'wartet';
      a.leaseBis = null;
      a.begonnen = null;
      a.agentId = null;
    } else {
      a.zustand = 'unklar';
      a.beendet = new Date().toISOString();
      a.leaseBis = null;
      a.fehler = 'Der Laptop hat sich während der Ausführung nicht mehr gemeldet. ' +
        'Ob der Auftrag durchgelaufen ist, lässt sich von hier aus nicht sagen.';
    }
    schreibe(a);
    betroffen.push(a);
  }
  return betroffen;
}

// Wird vom Timer in bot.js gerufen: abgelaufene Aufträge erkennen UND melden.
async function pruefeUndMelde() {
  const betroffen = pruefeLeases();
  for (const a of betroffen) {
    if (a.zustand === 'unklar') await melde_(a);
  }
  return betroffen;
}

function brichAb(id, grund) {
  const a = lies(id);
  if (!a || !OFFEN.has(a.zustand)) return null;
  a.zustand = 'abgebrochen';
  a.beendet = new Date().toISOString();
  a.leaseBis = null;
  a.fehler = String(grund || 'von Hand abgebrochen');
  schreibe(a);
  return a;
}

// ────────────────────────────────────────────────────────────── Auskunft

function finde(id) { return lies(id); }

function liste({ chatId = null, nurOffen = false, max = 25 } = {}) {
  let l = alle();
  if (chatId != null) l = l.filter((a) => a.chatId === String(chatId));
  if (nurOffen) l = l.filter((a) => OFFEN.has(a.zustand));
  return l.reverse().slice(0, max);
}

function zustand() {
  const l = alle();
  const zaehlung = {};
  for (const z of ZUSTAENDE) zaehlung[z] = 0;
  for (const a of l) zaehlung[a.zustand] = (zaehlung[a.zustand] || 0) + 1;
  return { gesamt: l.length, ...zaehlung, agent: agentZustand() };
}

function raeumeAuf() {
  const grenze = Date.now() - AUFHEBEN_MS;
  const l = alle();
  let weg = 0;
  for (const a of l) {
    if (OFFEN.has(a.zustand)) continue;
    const zeit = new Date(a.beendet || a.eingestellt).getTime();
    if (zeit < grenze) { try { fs.unlinkSync(pfad(a.id)); weg++; } catch { /* egal */ } }
  }
  // Notbremse gegen unbegrenztes Wachstum, falls jemand die Uhr verstellt.
  const rest = alle().filter((a) => !OFFEN.has(a.zustand));
  if (rest.length > MAX_AUFTRAEGE) {
    for (const a of rest.slice(0, rest.length - MAX_AUFTRAEGE)) {
      try { fs.unlinkSync(pfad(a.id)); weg++; } catch { /* egal */ }
    }
  }
  return weg;
}

// Beim Start: Aufträge, die beim letzten Herunterfahren "laeuft" waren, haben
// keinen Agenten mehr. Ihre Frist läuft normal ab und pruefeLeases greift —
// wir setzen sie NICHT einfach zurück, aus demselben Grund wie oben.
function starte({ intervallMs = 30_000 } = {}) {
  sorgeFuerOrdner();
  raeumeAuf();
  const timer = setInterval(() => {
    pruefeUndMelde().catch((e) => console.error('Auftragsstelle:', e.message));
  }, intervallMs);
  if (timer.unref) timer.unref();
  const z = zustand();
  return { ordner: ORDNER, offen: z.wartet + z.laeuft, gesamt: z.gesamt };
}

module.exports = {
  ORDNER, LEASE_MS, AGENT_STILL_MS, ZUSTAENDE,
  stelleEin, holeNaechsten, warteAufAuftrag, verlaengere, melde,
  pruefeLeases, pruefeUndMelde, brichAb,
  heartbeat, agentZustand, beiErgebnis,
  finde, liste, zustand, raeumeAuf, starte,
  _intern: { alle, lies, schreibe, pfad }
};
