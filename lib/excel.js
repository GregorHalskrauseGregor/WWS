// Arbeitsdatei der Lagerverwaltung — data/material.xlsx.
//
// Diese Datei ist die BUCHUNGSGRUNDLAGE, nicht die Ansicht. Sie ist bewusst
// schlicht: ein Blatt, feste Spalten, keine Formatierung, die beim Schreiben
// kaputtgehen koennte. Die huebsche Liste mit Kategorie-Zwischenueberschriften
// wird bei Bedarf frisch aus dieser Datei erzeugt (lib/lager_export.js) und ist
// eine EIGENE Datei — so wandert beim Weitergeben nie die interne
// Reservierungsspalte mit.
//
// Spalten:
//   Kategorie | Bezeichnung | Menge Neu | Menge Gebraucht | Menge Verschmutzt |
//   Einheit | Reserviert
//
// Reserviert haelt fest, WER wie viel vorgemerkt hat, im Format
//   "342450413:5; 87654321:2"
// (Telegram-Chat-ID : Menge, mehrere durch Semikolon getrennt).
//
// ExcelJS wird LAZY geladen — das Paket ist gross und die meisten Nachrichten
// fassen die Lagerdatei nie an.

const fs = require('fs');
const path = require('path');

const MATERIAL_PFAD = require('../config').PFADE.MATERIAL_XLSX;
const BLATT = 'Lager';

const SPALTEN = [
  { key: 'kategorie', header: 'Kategorie', width: 30 },
  { key: 'bezeichnung', header: 'Bezeichnung', width: 44 },
  { key: 'mengeNeu', header: 'Menge Neu', width: 12 },
  { key: 'mengeGebraucht', header: 'Menge Gebraucht', width: 16 },
  { key: 'mengeVerschmutzt', header: 'Menge Verschmutzt', width: 18 },
  { key: 'einheit', header: 'Einheit', width: 10 },
  { key: 'reserviert', header: 'Reserviert (ChatID:Menge)', width: 34 }
];

// ───────────────────────────────────────────────── Reservierungen als Text

// "342450413:5; 87654321:2"  ->  [{ chatId: '342450413', menge: 5 }, ...]
function parseReservierungen(text) {
  if (!text) return [];
  return String(text).split(';')
    .map((teil) => teil.trim())
    .filter(Boolean)
    .map((teil) => {
      const [chatId, menge] = teil.split(':');
      const m = parseFloat(String(menge || '').replace(',', '.'));
      if (!chatId || !Number.isFinite(m) || m <= 0) return null;
      return { chatId: String(chatId).trim(), menge: m };
    })
    .filter(Boolean);
}

function serialisiereReservierungen(liste) {
  return (liste || [])
    .filter((r) => r && r.menge > 0)
    .map((r) => `${r.chatId}:${r.menge}`)
    .join('; ');
}

// ─────────────────────────────────────────────────────────── Datei-Zugriff

async function ladeWorkbook(pfad = MATERIAL_PFAD) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(pfad)) await wb.xlsx.readFile(pfad);

  let blatt = wb.getWorksheet(BLATT);

  // Migration aus frueheren Fassungen: 'Daten' war das versteckte Arbeitsblatt.
  if (!blatt) {
    const alt = wb.getWorksheet('Daten') || wb.getWorksheet('Material');
    if (alt) {
      alt.name = BLATT;
      alt.state = 'visible';
      blatt = alt;
    }
  }
  if (!blatt) {
    blatt = wb.addWorksheet(BLATT);
  }
  // Die frueher mitgefuehrte Schauansicht gehoert nicht mehr in die Arbeitsdatei.
  const ansicht = wb.getWorksheet('Lagerbestand');
  if (ansicht) wb.removeWorksheet(ansicht.id);

  return { workbook: wb, blatt };
}

function kopfzeileSetzen(blatt) {
  blatt.getRow(1).values = SPALTEN.map((s) => s.header);
  blatt.getRow(1).font = { bold: true };
  blatt.views = [{ state: 'frozen', ySplit: 1 }];
  SPALTEN.forEach((s, i) => { blatt.getColumn(i + 1).width = s.width; });
}

// Legt eine leere Arbeitsdatei an. Bewusst nur auf ausdrueckliche Anforderung —
// im Normalbetrieb soll eine fehlende Datei auffallen, nicht stillschweigend
// durch eine leere ersetzt werden.
async function erstelleLeer(pfad = MATERIAL_PFAD) {
  if (fs.existsSync(pfad)) return { erstellt: false, pfad };
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const blatt = wb.addWorksheet(BLATT);
  kopfzeileSetzen(blatt);
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  await wb.xlsx.writeFile(pfad);
  return { erstellt: true, pfad };
}

function zahl(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v === 'object' && 'result' in v) return parseFloat(v.result) || 0;
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function text(v) {
  if (v == null) return '';
  if (typeof v === 'object' && 'text' in v) return String(v.text).trim();
  if (typeof v === 'object' && 'result' in v) return String(v.result).trim();
  return String(v).trim();
}

async function lesePositionen(pfad = MATERIAL_PFAD) {
  if (!fs.existsSync(pfad)) {
    throw new Error(
      `Die Lagerdatei fehlt (${pfad}). Sie wird bewusst nicht automatisch angelegt, ` +
      `damit ein versehentlich geloeschter Bestand auffaellt. Mit /lager_anlegen ` +
      `kannst du eine leere Datei erzeugen.`
    );
  }
  const { blatt } = await ladeWorkbook(pfad);
  const positionen = [];
  blatt.eachRow({ includeEmpty: false }, (row, nr) => {
    if (nr === 1) return;
    const bezeichnung = text(row.getCell(2).value);
    if (!bezeichnung) return;
    positionen.push({
      kategorie: text(row.getCell(1).value) || 'Sonstiges',
      bezeichnung,
      mengeNeu: zahl(row.getCell(3).value),
      mengeGebraucht: zahl(row.getCell(4).value),
      mengeVerschmutzt: zahl(row.getCell(5).value),
      einheit: text(row.getCell(6).value) || 'Stk.',
      reservierungen: parseReservierungen(text(row.getCell(7).value)),
      _row: nr
    });
  });
  return positionen;
}

// Schreibt die Liste vollstaendig zurueck. Zeilen werden nie geloescht —
// eine Position mit Bestand 0 bleibt stehen, damit auf Nachfrage gesagt werden
// kann, dass davon gerade nichts da ist.
async function schreibePositionen(pfad, positionen) {
  const { workbook, blatt } = await ladeWorkbook(pfad);
  for (let i = blatt.rowCount; i >= 2; i--) blatt.spliceRows(i, 1);
  kopfzeileSetzen(blatt);
  for (const p of positionen) {
    blatt.addRow([
      p.kategorie || 'Sonstiges',
      p.bezeichnung || p.name || '',
      zahl(p.mengeNeu),
      zahl(p.mengeGebraucht),
      zahl(p.mengeVerschmutzt),
      p.einheit || 'Stk.',
      serialisiereReservierungen(p.reservierungen)
    ]);
  }
  await workbook.xlsx.writeFile(pfad);
}

module.exports = {
  MATERIAL_PFAD, SPALTEN, BLATT,
  ladeWorkbook, lesePositionen, schreibePositionen, erstelleLeer,
  parseReservierungen, serialisiereReservierungen
};
