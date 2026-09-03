// Themen-Verwaltung mit Multi-User-Isolation.
//
// Pro Telegram-User (chat-id) eigene Verzeichnisse:
//   data/users/<chatId>/themen-index.json   — Liste der Themen mit Kurz-Metadaten
//   data/users/<chatId>/themen/<themaId>.json — Volle Historie + Rollzusammenfassung
//
// Schema eines Themas:
//   {
//     id:          'thema-<shortId>',
//     name:        'Anzeigename (vom User oder KI generiert)',
//     createdAt:   ISO-Zeitstempel,
//     lastActivity: ISO-Zeitstempel,
//     messageCount: <gesamt, inkl. komprimierter>,
//     summary:     'Rollzusammenfassung der bisherigen Konversation, oder ""',
//     messages:    [ { rolle: 'user'|'assistant', inhalt, zeit }, ... ]   // jüngste zuerst
//   }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = path.join(__dirname, 'data', 'users');
const INDEX_DATEINAME = 'themen-index.json';
const THEMA_ORDNER = 'themen';

// Sanitize: Telegram-IDs sind bei privaten Chats positive Zahlen, bei Gruppen negativ.
// Pfad-Injection verhindern — wir lassen nur Ziffern + Minus durch.
function sichereChatId(chatId) {
  const s = String(chatId);
  if (!/^-?\d{1,20}$/.test(s)) {
    throw new Error('Ungültige chat-id: ' + s);
  }
  return s;
}

function userVerzeichnis(chatId) {
  return path.join(DATA_ROOT, sichereChatId(chatId));
}

function indexPfad(chatId) {
  return path.join(userVerzeichnis(chatId), INDEX_DATEINAME);
}

function themaPfad(chatId, themaId) {
  return path.join(userVerzeichnis(chatId), THEMA_ORDNER, themaId + '.json');
}

function stelleVerzeichnisseSicher(chatId) {
  fs.mkdirSync(path.join(userVerzeichnis(chatId), THEMA_ORDNER), { recursive: true });
}

function neueThemaId() {
  return 'thema-' + crypto.randomBytes(4).toString('hex');
}

function jetzt() {
  return new Date().toISOString();
}

// Lädt den Themen-Index eines Users. Gibt [] zurück, wenn noch nichts da ist.
function ladeIndex(chatId) {
  const p = indexPfad(chatId);
  if (!fs.existsSync(p)) return [];
  try {
    const roh = fs.readFileSync(p, 'utf-8');
    const daten = JSON.parse(roh);
    return Array.isArray(daten) ? daten : [];
  } catch (err) {
    // Korrupte Index-Datei: nicht stillschweigend überschreiben — laut werden.
    throw new Error('Themen-Index ist beschädigt: ' + err.message);
  }
}

function speichereIndex(chatId, index) {
  stelleVerzeichnisseSicher(chatId);
  fs.writeFileSync(indexPfad(chatId), JSON.stringify(index, null, 2), 'utf-8');
}

// Lädt ein einzelnes Thema inkl. voller Historie. null, wenn nicht vorhanden.
function ladeThema(chatId, themaId) {
  const p = themaPfad(chatId, themaId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch (err) {
    throw new Error('Themendatei "' + themaId + '" ist beschädigt: ' + err.message);
  }
}

function speichereThema(chatId, thema) {
  stelleVerzeichnisseSicher(chatId);
  thema.lastActivity = jetzt();
  fs.writeFileSync(themaPfad(chatId, thema.id), JSON.stringify(thema, null, 2), 'utf-8');
}

// Synchronisiert einen Themen-Eintrag im Index (Kurz-Metadaten für Listen-Anzeige).
function aktualisiereIndexEintrag(chatId, thema) {
  const index = ladeIndex(chatId);
  const eintrag = {
    id: thema.id,
    name: thema.name,
    createdAt: thema.createdAt,
    lastActivity: thema.lastActivity,
    messageCount: thema.messageCount || 0
  };
  const vorhanden = index.findIndex((e) => e.id === thema.id);
  if (vorhanden >= 0) {
    index[vorhanden] = eintrag;
  } else {
    index.push(eintrag);
  }
  // Nach letzter Aktivität sortiert (jüngste zuerst) — das ist die nützlichste Default-Reihenfolge.
  index.sort((a, b) => (b.lastActivity || '').localeCompare(a.lastActivity || ''));
  speichereIndex(chatId, index);
}

function loescheThema(chatId, themaId) {
  const p = themaPfad(chatId, themaId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  const index = ladeIndex(chatId).filter((e) => e.id !== themaId);
  speichereIndex(chatId, index);
}

function benenneThemaUm(chatId, themaId, neuerName) {
  const thema = ladeThema(chatId, themaId);
  if (!thema) return null;
  thema.name = neuerName.trim() || thema.name;
  speichereThema(chatId, thema);
  aktualisiereIndexEintrag(chatId, thema);
  return thema;
}

function erstelleThema(chatId, name) {
  const id = neueThemaId();
  const thema = {
    id,
    name: name.trim() || 'Neues Thema',
    createdAt: jetzt(),
    lastActivity: jetzt(),
    messageCount: 0,
    summary: '',
    messages: []
  };
  speichereThema(chatId, thema);
  aktualisiereIndexEintrag(chatId, thema);
  return thema;
}

function findeThemaMitName(chatId, suchbegriff) {
  // Unscharfer Match: enthält-Vergleich, case-insensitive. Reicht für /thema <name>.
  const index = ladeIndex(chatId);
  const norm = (s) => (s || '').toLowerCase();
  const ziel = norm(suchbegriff);
  if (!ziel) return null;
  return index.find((t) => norm(t.name).includes(ziel)) || null;
}

// Liest die letzten N Nachrichten des aktivsten Themas (jüngste nach lastActivity).
// Wird von der KI-basierten Experten-Auswahl genutzt, um den Kontext zu verstehen.
function letzteNachrichten(chatId, anzahl = 4) {
  const index = ladeIndex(chatId);
  if (index.length === 0) return [];
  // Jüngstes Thema (Index ist nach lastActivity sortiert)
  const aktivstes = index[0];
  const thema = ladeThema(chatId, aktivstes.id);
  if (!thema || !Array.isArray(thema.messages)) return [];
  return thema.messages.slice(-anzahl);
}

// Hängt eine neue Nachricht ans Thema an und gibt das aktualisierte Thema zurück.
function haengeNachrichtAn(chatId, themaId, rolle, inhalt) {
  const thema = ladeThema(chatId, themaId);
  if (!thema) throw new Error('Thema "' + themaId + '" nicht gefunden.');
  if (!Array.isArray(thema.messages)) thema.messages = [];
  thema.messages.push({ rolle, inhalt, zeit: jetzt() });
  thema.messageCount = (thema.messageCount || 0) + 1;
  thema.lastActivity = jetzt();
  speichereThema(chatId, thema);
  aktualisiereIndexEintrag(chatId, thema);
  return thema;
}

module.exports = {
  DATA_ROOT,
  ladeIndex,
  ladeThema,
  letzteNachrichten,
  speichereThema,
  aktualisiereIndexEintrag,
  loescheThema,
  benenneThemaUm,
  erstelleThema,
  findeThemaMitName,
  haengeNachrichtAn,
  // gebraucht von Kompressor zum Persistieren nach einer Komprimierung
  neueThemaId
};
