// Einfaches Ereignisprotokoll: hält fest, was der Bot zuletzt getan hat und wo es
// Probleme gab (z. B. übersprungene Abschnitte bei einem großen Import). Damit kann
// der Bot auf Nachfragen wie "warum wurde X nicht hinzugefügt?" ehrlich antworten,
// statt die Frage in eine falsche Aktion zu pressen.

const fs = require('fs');
const path = require('path');

const PROTOKOLL_PATH = require('./config').PFADE.PROTOKOLL;
const MAX_EINTRAEGE = 200; // Datei nicht unbegrenzt wachsen lassen, älteste Einträge fallen raus

function zeitstempel() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function kuerzeBeiBedarf() {
  if (!fs.existsSync(PROTOKOLL_PATH)) return;
  const zeilen = fs.readFileSync(PROTOKOLL_PATH, 'utf-8').split('\n').filter(Boolean);
  if (zeilen.length > MAX_EINTRAEGE) {
    const gekuerzt = zeilen.slice(zeilen.length - MAX_EINTRAEGE);
    fs.writeFileSync(PROTOKOLL_PATH, gekuerzt.join('\n') + '\n');
  }
}

function schreibeEintrag(typ, nachricht) {
  fs.mkdirSync(path.dirname(PROTOKOLL_PATH), { recursive: true });
  const zeile = `[${zeitstempel()}] ${typ}: ${nachricht}\n`;
  fs.appendFileSync(PROTOKOLL_PATH, zeile);
  kuerzeBeiBedarf();
}

function leseLetzte(anzahl = 20) {
  if (!fs.existsSync(PROTOKOLL_PATH)) return '';
  const zeilen = fs.readFileSync(PROTOKOLL_PATH, 'utf-8').split('\n').filter(Boolean);
  return zeilen.slice(-anzahl).join('\n');
}

module.exports = { PROTOKOLL_PATH, schreibeEintrag, leseLetzte };
