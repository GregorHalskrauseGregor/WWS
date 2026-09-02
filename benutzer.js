// Benutzer-Verwaltung. Pro Telegram-User ein eigenes Verzeichnis unter
// data/users/<chatId>/ mit klarer Struktur:
//
//   data/users/<chatId>/
//     user.json          <- Profil + Metadaten (wer, wann erster/letzter Kontakt)
//     gedaechtnis.txt    <- Langzeit-Fakten
//     themen-index.json  <- Themen-Liste
//     rate.json          <- Rate-Limit-Zähler
//     begruessung.txt    <- (optional) persönliche Begrüßung, editierbar
//     themen/            <- Volle Themen-Historien
//       <themaId>.json
//
// Wird beim ersten Kontakt automatisch angelegt. Daten eines Users löschen =
// seinen Ordner löschen.

const fs = require('fs');
const path = require('path');

const DATA_ROOT = path.join(__dirname, 'data', 'users');

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

function userProfilPfad(chatId) {
  return path.join(userVerzeichnis(chatId), 'user.json');
}

function userThemenOrdner(chatId) {
  return path.join(userVerzeichnis(chatId), 'themen');
}

function jetzt() {
  return new Date().toISOString();
}

// Lädt das User-Profil, oder null wenn noch keins da ist.
function ladeProfil(chatId) {
  const p = userProfilPfad(chatId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function speichereProfil(chatId, profil) {
  fs.mkdirSync(userVerzeichnis(chatId), { recursive: true });
  fs.writeFileSync(userProfilPfad(chatId), JSON.stringify(profil, null, 2), 'utf-8');
}

// Legt die komplette User-Verzeichnisstruktur an, falls noch nicht vorhanden.
// Gibt {warNeu, profil} zurück, damit der Bot entscheiden kann, ob er einen
// Willkommens-Ping schicken will.
function initialisiere(chatId, telegramInfo = {}) {
  const id = sichereChatId(chatId);
  const dir = userVerzeichnis(id);
  const existierte = fs.existsSync(userProfilPfad(id));

  // Verzeichnisse anlegen (idempotent — mkdir mit recursive:true ist safe)
  fs.mkdirSync(userThemenOrdner(id), { recursive: true });

  // Profil nur anlegen/aktualisieren, wenn es noch nicht existiert oder Felder fehlen.
  // Bei jedem Kontakt aktualisieren wir last_seen, aber NICHT first_seen und
  // NICHT die Telegram-Profil-Daten (die können sich zwar ändern, aber wir
  // tracken die initiale Identität).
  let profil = ladeProfil(id);
  if (!profil) {
    profil = {
      chatId: Number(id),
      firstSeen: jetzt(),
      lastSeen: jetzt(),
      // Was Telegram uns mitgeteilt hat — kann sich später ändern, ist aber
      // ein guter Anhaltspunkt für die "Wer ist das eigentlich"-Anzeige.
      displayName: telegramInfo.displayName || null,
      username: telegramInfo.username || null,
      firstName: telegramInfo.firstName || null,
      lastName: telegramInfo.lastName || null,
      // Freie Notizen, die der Admin hier reinpacken kann (z.B. "Kunde A")
      notiz: null
    };
    speichereProfil(id, profil);
  } else {
    // Letzten Kontakt aktualisieren; Stammdaten nur, wenn vorher leer.
    profil.lastSeen = jetzt();
    if (!profil.displayName && telegramInfo.displayName) profil.displayName = telegramInfo.displayName;
    if (!profil.username && telegramInfo.username) profil.username = telegramInfo.username;
    if (!profil.firstName && telegramInfo.firstName) profil.firstName = telegramInfo.firstName;
    if (!profil.lastName && telegramInfo.lastName) profil.lastName = telegramInfo.lastName;
    speichereProfil(id, profil);
  }

  // Existenz der anderen Dateien sicherstellen, damit der User eine
  // vorhersehbare Struktur vorfindet (auch wenn die Module aktuell mit
  // "Datei fehlt = leer" klarkommen).
  const gedaechtnisP = path.join(dir, 'gedaechtnis.txt');
  if (!fs.existsSync(gedaechtnisP)) fs.writeFileSync(gedaechtnisP, '', 'utf-8');

  const indexP = path.join(dir, 'themen-index.json');
  if (!fs.existsSync(indexP)) fs.writeFileSync(indexP, '[]', 'utf-8');

  const rateP = path.join(dir, 'rate.json');
  if (!fs.existsSync(rateP)) {
    fs.writeFileSync(rateP, JSON.stringify({
      hourStart: 0, hourCount: 0,
      dayStart: 0, dayCount: 0,
      toolCount: 0
    }, null, 2), 'utf-8');
  }

  // Persönliche Begrüßung als editierbare Datei — Standard nur beim ersten Mal.
  const begruessungP = path.join(dir, 'begruessung.txt');
  if (!fs.existsSync(begruessungP)) {
    try {
      const { STANDARD_BEGRUESSUNG } = require('./begruessung');
      fs.writeFileSync(begruessungP, STANDARD_BEGRUESSUNG, 'utf-8');
    } catch {
      fs.writeFileSync(begruessungP, 'Willkommen!\n', 'utf-8');
    }
  }

  return { warNeu: !existierte, profil };
}

// Löscht den kompletten User-Ordner. Vorsicht: nicht wiederherstellbar.
function loescheAlles(chatId) {
  const dir = userVerzeichnis(chatId);
  if (!fs.existsSync(dir)) return false;
  // Rekursiv löschen — wir benutzen rmSync mit recursive, das ist die saubere
  // Variante. Falls der User-Ordner das Letzte ist, was wir tun, ist das OK.
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

// Listet alle bekannten User auf (für Admin-Übersicht). Gibt eine Array
// von {chatId, displayName, username, firstSeen, lastSeen, themenAnzahl} zurück.
function listeAlle() {
  if (!fs.existsSync(DATA_ROOT)) return [];
  const dirs = fs.readdirSync(DATA_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const result = [];
  for (const id of dirs) {
    const profil = ladeProfil(id);
    if (!profil) continue;
    const indexP = path.join(DATA_ROOT, id, 'themen-index.json');
    let themenAnzahl = 0;
    if (fs.existsSync(indexP)) {
      try {
        const idx = JSON.parse(fs.readFileSync(indexP, 'utf-8'));
        themenAnzahl = Array.isArray(idx) ? idx.length : 0;
      } catch { /* ignorieren */ }
    }
    result.push({
      chatId: profil.chatId,
      displayName: profil.displayName,
      username: profil.username,
      firstSeen: profil.firstSeen,
      lastSeen: profil.lastSeen,
      themenAnzahl
    });
  }
  // Nach letztem Kontakt sortiert (jüngste zuerst) — die aktivsten User oben.
  result.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  return result;
}

function notizSetzen(chatId, text) {
  const profil = ladeProfil(chatId);
  if (!profil) return null;
  profil.notiz = (text || '').trim() || null;
  speichereProfil(chatId, profil);
  return profil;
}

// Convenience-Wrapper: nimmt ein Telegram-Message-Objekt (mit .from) entgegen
// und leitet die relevanten Felder an initialisiere() weiter. Wird vom Bot in
// jedem Message-Handler aufgerufen, damit die User-Struktur beim ersten
// Kontakt automatisch angelegt wird.
function initialisiereAusMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (chatId == null) {
    throw new Error('Message hat keine chat.id');
  }
  const from = msg.from || {};
  const info = {
    displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null,
    username: from.username || null,
    firstName: from.first_name || null,
    lastName: from.last_name || null
  };
  return initialisiere(chatId, info);
}

module.exports = {
  DATA_ROOT,
  userVerzeichnis,
  userThemenOrdner,
  ladeProfil,
  speichereProfil,
  initialisiere,
  initialisiereAusMessage,
  loescheAlles,
  listeAlle,
  notizSetzen
};
