// Rollen — wer im Betrieb was darf.
//
// Die Rolle haengt am Telegram-Nutzer und steckt in seinem Profil
// (data/users/<chatId>/user.json). Vergeben wird sie im Admin-Bereich unter
// /options <kennwort>, nicht per Chat: eine Rolle, die man sich im Gespraech
// selbst zusprechen kann, ist keine.
//
// Es gibt bewusst keine Rechtematrix. Rollen steuern hier, WAS jemand
// angeboten bekommt, nicht was technisch moeglich ist — der Bot ist ein
// Werkzeug fuer einen Betrieb, kein Mehrmandantensystem.

const benutzer = require('./benutzer');

const ROLLEN = {
  monteur: {
    name: 'Monteur',
    emoji: '🔧',
    beschreibung: 'Reserviert und entnimmt Material, erstellt Aufmaße.'
  },
  lagerist: {
    name: 'Lagerist',
    emoji: '📦',
    beschreibung: 'Bekommt jede Reservierung zur Bestätigung und pflegt den Bestand.'
  },
  projektleiter: {
    name: 'Projektleiter',
    emoji: '📐',
    beschreibung: 'Überblick über Projekte, Aufmaße und Bestellungen.'
  },
  projektassistenz: {
    name: 'Projektassistenz',
    emoji: '🗂',
    beschreibung: 'Unterstützt bei Bestellungen, Aufmaßen und Abrechnung.'
  }
};

const STANDARD = 'monteur';

function rolleVon(chatId) {
  const profil = benutzer.ladeProfil(chatId);
  const r = profil && profil.rolle;
  return ROLLEN[r] ? r : STANDARD;
}

function setzeRolle(chatId, rolle) {
  if (!ROLLEN[rolle]) return false;
  const profil = benutzer.ladeProfil(chatId) || {};
  profil.rolle = rolle;
  profil.rolleSeit = new Date().toISOString();
  benutzer.speichereProfil(chatId, profil);
  return true;
}

function beschreibe(rolle) {
  const r = ROLLEN[rolle] || ROLLEN[STANDARD];
  return `${r.emoji} ${r.name} — ${r.beschreibung}`;
}

// Alle Nutzer mit einer bestimmten Rolle. Wird gebraucht, um eine neue
// Reservierung an JEDEN Lageristen zu schicken — in einem Betrieb mit
// Schichtbetrieb gibt es mehr als einen.
function mitRolle(rolle) {
  return benutzer.listeAlle()
    .map((u) => (typeof u === 'object' ? u.chatId || u.id : u))
    .filter(Boolean)
    .filter((chatId) => rolleVon(chatId) === rolle);
}

module.exports = { ROLLEN, STANDARD, rolleVon, setzeRolle, beschreibe, mitRolle };
