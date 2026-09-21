// Zugangs-Gate — vollstaendig deterministisch, keine KI.
//
// Vor dem Router: wer nicht freigeschaltet ist, kommt nicht durch. Weder Text
// noch Befehle noch Dateien. Der Code steht in der .env (ZUGANGS_CODE). Einmal
// korrekt eingegeben, landet die Chat-ID in data/zugang.json und wird nie
// wieder gefragt.
//
// Bewusste Entscheidung: Ist KEIN ZUGANGS_CODE gesetzt, bleibt der Bot offen
// (mit lauter Warnung beim Start). Ein Tippfehler in der .env soll nicht den
// ganzen Bot aussperren — das waere schlimmer als der offene Zustand, den es
// vorher ohnehin gab.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('./config');

const DATEI = path.join(PFADE.DATA, 'zugang.json');

function code() {
  return String(process.env.ZUGANGS_CODE || '').trim();
}

// Gate aktiv? Ohne Code in der .env gibt es nichts zu pruefen.
function aktiv() {
  return code().length > 0;
}

function ladeListe() {
  try {
    if (!fs.existsSync(DATEI)) return [];
    const roh = JSON.parse(fs.readFileSync(DATEI, 'utf-8'));
    return Array.isArray(roh) ? roh : (Array.isArray(roh.freigeschaltet) ? roh.freigeschaltet : []);
  } catch {
    return [];
  }
}

function speichereListe(liste) {
  try {
    fs.mkdirSync(path.dirname(DATEI), { recursive: true });
    fs.writeFileSync(DATEI, JSON.stringify(liste, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Zugangsliste nicht schreibbar:', err.message);
    return false;
  }
}

function istFreigeschaltet(chatId) {
  if (!aktiv()) return true;
  const id = String(chatId);
  return ladeListe().some((e) => String(e.chatId) === id);
}

function schalteFrei(chatId, info = {}) {
  const liste = ladeListe();
  const id = String(chatId);
  if (liste.some((e) => String(e.chatId) === id)) return false;
  liste.push({
    chatId: Number(id) || id,
    name: info.displayName || info.username || null,
    username: info.username || null,
    seit: new Date().toISOString()
  });
  speichereListe(liste);
  return true;
}

function entziehe(chatId) {
  const id = String(chatId);
  const liste = ladeListe();
  const neu = liste.filter((e) => String(e.chatId) !== id);
  if (neu.length === liste.length) return false;
  speichereListe(neu);
  return true;
}

function liste() {
  return ladeListe();
}

// Kern des Gates. Wird fuer JEDE Nachricht eines noch nicht freigeschalteten
// Chats aufgerufen. Gibt zurueck, was dem Nutzer geantwortet werden soll.
//
//   { durchlassen: true }                    -> Nachricht normal verarbeiten
//   { durchlassen: false, text, neu? }       -> nur diesen Text senden, sonst nichts
function pruefe(chatId, text, info = {}) {
  if (!aktiv()) return { durchlassen: true };
  if (istFreigeschaltet(chatId)) return { durchlassen: true };

  const eingabe = String(text || '').trim();

  // Code kann auch als "/start ABC123" oder "/code ABC123" kommen — wir nehmen
  // das letzte Wort, wenn die Nachricht mit einem Befehl beginnt.
  const kandidat = eingabe.startsWith('/')
    ? eingabe.split(/\s+/).slice(1).join(' ').trim()
    : eingabe;

  if (kandidat && kandidat === code()) {
    schalteFrei(chatId, info);
    return {
      durchlassen: false,
      neu: true,
      text: '✅ Zugang freigeschaltet. Du bist jetzt dauerhaft eingetragen und ' +
        'wirst nicht wieder nach dem Code gefragt.\n\nSchreib einfach los — oder /start für die Anleitung.'
    };
  }

  if (!kandidat) {
    return {
      durchlassen: false,
      text: '🔒 Dieser Bot ist geschützt.\n\nBitte gib den Zugangscode ein.'
    };
  }

  return {
    durchlassen: false,
    text: '🔒 Der Code stimmt nicht.\n\nBitte gib den Zugangscode ein.'
  };
}

// Beim Start einmal laut sagen, wie es um den Schutz steht.
function startHinweis() {
  if (!aktiv()) {
    return 'WARNUNG: ZUGANGS_CODE ist nicht gesetzt — der Bot ist fuer JEDEN offen. ' +
      'Setze ZUGANGS_CODE in der .env, um das Gate zu aktivieren.';
  }
  return `Zugangs-Gate aktiv. Freigeschaltet: ${ladeListe().length} Chat(s).`;
}

module.exports = {
  aktiv,
  istFreigeschaltet,
  schalteFrei,
  entziehe,
  liste,
  pruefe,
  startHinweis,
  DATEI
};
