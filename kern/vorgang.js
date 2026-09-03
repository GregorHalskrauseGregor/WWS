// Vorgänge — der Zustand einer laufenden, strukturierten Erfassung.
//
// Ein "Vorgang" ist ein angefangenes Aufmaß, eine angefangene Bestellung, eine
// angefangene Lagerbuchung: Daten, die über mehrere Nachrichten zusammenwachsen,
// bis sie vollständig sind und finalisiert werden können.
//
// ENTSCHEIDENDE ÄNDERUNG gegenüber vorher: Ein Vorgang hängt am THEMA, nicht am
// User. Vorher lag die Aufmaß-Session unter data/users/<chatId>/aufnahme_session.json
// — also genau eine pro Person. Zwei parallel laufende Aufmaße haben sich
// gegenseitig überschrieben. Jetzt:
//
//   data/users/<chatId>/themen/<themaId>/vorgang.json
//
// Damit kann jeder Gesprächsfaden seinen eigenen offenen Vorgang haben, und der
// Router sieht beim Zuordnen einer neuen Nachricht, welcher Faden worauf wartet.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('../config');
const themen = require('../themen');

const STATUS = {
  SAMMELT: 'sammelt',                 // es fehlen noch Pflichtangaben
  WARTET_BESTAETIGUNG: 'bestaetigen', // vollständig, wartet auf "passt"
  FERTIG: 'fertig'
};

function sichereId(wert, was) {
  const s = String(wert);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s)) {
    throw new Error(`Ungültige ${was}: ${s}`);
  }
  return s;
}

function pfad(chatId, themaId) {
  // chatId wird von themen.js validiert, themaId hier.
  sichereId(themaId, 'themaId');
  return PFADE.vorgangDatei(chatId, themaId);
}

function lade(chatId, themaId) {
  if (!themaId) return null;
  const p = pfad(chatId, themaId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null; // kaputte Vorgangsdatei blockiert den Chat nicht
  }
}

function speichere(chatId, themaId, vorgang) {
  const p = pfad(chatId, themaId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  vorgang.zuletztGeaendert = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(vorgang, null, 2), 'utf-8');
  return vorgang;
}

function loesche(chatId, themaId) {
  const p = pfad(chatId, themaId);
  if (fs.existsSync(p)) {
    try { fs.unlinkSync(p); } catch { /* egal */ }
    return true;
  }
  return false;
}

function starte(chatId, themaId, experteId) {
  return speichere(chatId, themaId, {
    experteId,
    daten: {},
    status: STATUS.SAMMELT,
    begonnen: new Date().toISOString()
  });
}

// Alle offenen Vorgänge eines Users, mit Thema-Namen — das ist der Kontext,
// den der Router braucht, um "ändere Position 2" dem richtigen Faden zuzuordnen.
function offeneVorgaenge(chatId) {
  let index;
  try {
    index = themen.ladeIndex(chatId);
  } catch {
    return [];
  }
  const raus = [];
  for (const eintrag of index) {
    const v = lade(chatId, eintrag.id);
    if (v && v.status !== STATUS.FERTIG) {
      raus.push({
        themaId: eintrag.id,
        themaName: eintrag.name,
        experteId: v.experteId,
        status: v.status,
        zuletztGeaendert: v.zuletztGeaendert
      });
    }
  }
  return raus;
}

module.exports = { STATUS, lade, speichere, loesche, starte, offeneVorgaenge, pfad };
