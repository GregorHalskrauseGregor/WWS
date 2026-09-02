// Dauerhaftes, thread-übergreifendes Gedächtnis pro User.
// Eine einfache Textdatei pro User: data/users/<chatId>/gedaechtnis.txt
// Ein Fakt pro Zeile. Wird bei jeder KI-Anfrage als Teil des System-Prompts mitgeschickt.
//
// Damit der globale Kontext klein bleibt, wird die Datei beim Überschreiten einer
// Schwelle (siehe MAX_ZEICHEN) per KI komprimiert — alte/weniger relevante Fakten
// werden zusammengefasst, redundante gestrichen. Das passiert in kompressor.js.

const fs = require('fs');
const path = require('path');

const DATEINAME = 'gedaechtnis.txt';
// Weicher Schwellwert: über dieser Größe wird der Bot dem Nutzer melden, dass
// das Gedächtnis voll ist und beim nächsten Lauf komprimiert wird. Etwas unter dem
// harten Token-Limit eines typischen Modells, damit es mit Rollzusammenfassungen
// der Themen zusammenpasst.
const MAX_ZEICHEN = 6000;

function userVerzeichnis(chatId) {
  return path.join(__dirname, 'data', 'users', String(chatId));
}

function pfad(chatId) {
  return path.join(userVerzeichnis(chatId), DATEINAME);
}

function ladeGedaechtnis(chatId) {
  const p = pfad(chatId);
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf-8').trim();
}

// Liefert die Fakten als Array, ohne leere Zeilen, getrimmt.
function ladeFakten(chatId) {
  const inhalt = ladeGedaechtnis(chatId);
  if (!inhalt) return [];
  return inhalt.split('\n').map((z) => z.trim()).filter(Boolean);
}

// Fügt einen Fakt hinzu, wenn er nicht schon (case-insensitive, normalisiert) enthalten ist.
// Gibt true zurück, wenn etwas hinzugefügt wurde.
function fuegeHinzu(chatId, fakt) {
  const text = (fakt || '').trim();
  if (!text) return false;

  fs.mkdirSync(userVerzeichnis(chatId), { recursive: true });
  const vorhanden = ladeFakten(chatId);
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ');
  const ziel = norm(text);
  if (vorhanden.some((f) => norm(f) === ziel)) return false;

  fs.appendFileSync(pfad(chatId), text + '\n', 'utf-8');
  return true;
}

// Schreibt die Faktenliste komplett neu (nach Komprimierung).
function ersetzeFakten(chatId, fakten) {
  fs.mkdirSync(userVerzeichnis(chatId), { recursive: true });
  const sauber = (fakten || []).map((f) => f.trim()).filter(Boolean);
  fs.writeFileSync(pfad(chatId), sauber.length ? sauber.join('\n') + '\n' : '', 'utf-8');
}

function entferneFakt(chatId, index) {
  const fakten = ladeFakten(chatId);
  if (index < 0 || index >= fakten.length) return false;
  fakten.splice(index, 1);
  ersetzeFakten(chatId, fakten);
  return true;
}

function zeichenLaenge(chatId) {
  return ladeGedaechtnis(chatId).length;
}

function istVoll(chatId) {
  return zeichenLaenge(chatId) > MAX_ZEICHEN;
}

module.exports = {
  MAX_ZEICHEN,
  ladeGedaechtnis,
  ladeFakten,
  fuegeHinzu,
  ersetzeFakten,
  entferneFakt,
  zeichenLaenge,
  istVoll,
  pfad
};
