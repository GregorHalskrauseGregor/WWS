// Excel-Wrapper für die Materialverwaltung.
// Liest und schreibt material.xlsx mit dem ORIGINAL-Schema:
//   6 Spalten: Kategorie, Bezeichnung, Menge Neu, Menge Gebraucht, Menge Verschmutzt, Einheit
//   2 Blätter: 'Daten' (versteckt, die einzige Schreibquelle)
//             'Lagerbestand' (sichtbar, hübsch gruppiert nach Kategorie)
//
// WICHTIG: ExcelJS wird LAZY geladen — erst beim Funktionsaufruf.
// Hintergrund: manche Umgebungen (z.B. Railway) werfen beim pdfkit/ExcelJS-
// Modul-Load DOMMatrix-Fehler. Lazy-Loading hält das Modul selbst sauber.

const fs = require('fs');
const path = require('path');
const { KATEGORIEN } = require('../kategorien');

const MATERIAL_PFAD = require('../config').PFADE.MATERIAL_XLSX;

// Schema der Spalten (Reihenfolge ist wichtig — passt zum alten Code)
const COLUMNS = [
  { key: 'kategorie', header: 'Kategorie', width: 28 },
  { key: 'bezeichnung', header: 'Bezeichnung', width: 42 },
  { key: 'mengeNeu', header: 'Menge Neu', width: 11 },
  { key: 'mengeGebraucht', header: 'Menge Gebraucht', width: 16 },
  { key: 'mengeVerschmutzt', header: 'Menge Verschmutzt', width: 18 },
  { key: 'einheit', header: 'Einheit', width: 9 }
];

// Verschiedene Styles für die Excel-Blätter
const FARBE_TITEL = 'FF1F3864';
const FARBE_ZWISCHENTITEL = 'FF5B6B87';
const FARBE_HEADER = 'FFE7E6E6';

async function getExcelJS() {
  return require('exceljs');
}

// Lädt die Excel-Datei oder erstellt sie leer.
// Stellt sicher, dass BEIDE Blätter ('Daten' + 'Lagerbestand') existieren.
// Migriert automatisch vom alten "Material"-Blatt falls vorhanden.
async function ladeWorkbook(pfad) {
  const ExcelJS = await getExcelJS();
  const wb = new ExcelJS.Workbook();
  if (fs.existsSync(pfad)) {
    await wb.xlsx.readFile(pfad);
    // Migration: altes einspaltiges "Material"-Blatt
    const altes = wb.getWorksheet('Material');
    if (altes && !wb.getWorksheet('Daten')) {
      const daten = wb.addWorksheet('Daten', { state: 'hidden' });
      daten.columns = COLUMNS;
      altes.eachRow({ includeEmpty: false }, (row) => {
        daten.addRow(row.values.slice(1, 7));
      });
      // Bestandsschutz: keine Selbstheilung, aber Migrations-Fallback.
    }
  }
  let daten = wb.getWorksheet('Daten');
  if (!daten) {
    daten = wb.addWorksheet('Daten', { state: 'hidden' });
    daten.columns = COLUMNS;
    daten.getRow(1).font = { bold: true };
  }
  let ansicht = wb.getWorksheet('Lagerbestand');
  if (!ansicht) {
    ansicht = wb.addWorksheet('Lagerbestand', { views: [{ state: 'normal' }] });
  }
  // "Daten" als Default-Versteckt, "Lagerbestand" als Default-Sichtbar
  if (wb.views && wb.views.length > 0) {
    wb.views[0].activeTab = wb.getWorksheet('Lagerbestand') ? 'Lagerbestand' : 'Daten';
  }
  return { workbook: wb, daten, ansicht };
}

// Liest alle Materialpositionen aus dem 'Daten'-Blatt.
// Pro Zeile: { kategorie, bezeichnung, mengeNeu, mengeGebraucht, mengeVerschmutzt, einheit, _row }
async function lesePositionen(pfad = MATERIAL_PFAD) {
  const { daten } = await ladeWorkbook(pfad);
  const positionen = [];
  daten.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return; // Header
    const bezeichnung = (row.getCell(2).value || '').toString().trim();
    if (!bezeichnung) return; // leere Zeilen überspringen
    positionen.push({
      kategorie: (row.getCell(1).value || '').toString().trim() || 'Sonstiges',
      bezeichnung,
      mengeNeu: parseFloat(row.getCell(3).value) || 0,
      mengeGebraucht: parseFloat(row.getCell(4).value) || 0,
      mengeVerschmutzt: parseFloat(row.getCell(5).value) || 0,
      einheit: (row.getCell(6).value || '').toString().trim() || 'Stk.',
      _row: rowNumber
    });
  });
  return positionen;
}

// Schreibt die übergebene Liste zurück (Komplett-Replace, nicht append).
async function schreibePositionen(pfad, positionen) {
  const { workbook, daten } = await ladeWorkbook(pfad);
  // Alle Datenzeilen (außer Header) entfernen
  const letzte = daten.rowCount;
  for (let i = letzte; i >= 2; i--) {
    daten.spliceRows(i, 1);
  }
  // Neue Datenzeilen schreiben.
  // addRow mit Array funktioniert in ExcelJS, wenn man 1-Index beachtet
  // (Index 0 im Array ist das "leer vor Spalte A"-Marker, Index 1 = Spalte A, etc.)
  for (const p of positionen) {
    const bezeichnung = p.bezeichnung || p.name || '';
    daten.addRow([
      p.kategorie || 'Sonstiges',   // Array-Index 1 → Spalte A (kategorie)
      bezeichnung,                    // Array-Index 2 → Spalte B (bezeichnung)
      p.mengeNeu || 0,               // Array-Index 3 → Spalte C
      p.mengeGebraucht || 0,         // Array-Index 4 → Spalte D
      p.mengeVerschmutzt || 0,       // Array-Index 5 → Spalte E
      p.einheit || 'Stk.'            // Array-Index 6 → Spalte F
    ]);
  }
  // Spaltenbreiten
  COLUMNS.forEach((col, idx) => {
    daten.getColumn(idx + 1).width = col.width;
  });
  // Header fett
  daten.getRow(1).font = { bold: true };
  await workbook.xlsx.writeFile(pfad);
}

// Baut die hübsche "Lagerbestand"-Ansicht neu auf.
// Gruppiert nach Kategorie, mit Zwischenüberschriften und Gesamtsummen pro Kategorie.
//
// Strategie: Wir löschen das 'Lagerbestand'-Blatt komplett und erstellen es
// neu. Das vermeidet alle Probleme mit merged cells, die beim inkrementellen
// "nur Zellen leeren" auftreten.
async function baueAnsicht(pfad = MATERIAL_PFAD) {
  const { workbook, daten, ansicht: alteAnsicht } = await ladeWorkbook(pfad);
  if (!daten) {
    return; // Es gibt noch keine Daten — nichts zu tun
  }

  // Positionen aus dem Datenblatt lesen
  const positionen = [];
  daten.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const bezeichnung = (row.getCell(2).value || '').toString().trim();
    if (!bezeichnung) return;
    positionen.push({
      kategorie: (row.getCell(1).value || '').toString().trim() || 'Sonstiges',
      bezeichnung,
      mengeNeu: parseFloat(row.getCell(3).value) || 0,
      mengeGebraucht: parseFloat(row.getCell(4).value) || 0,
      mengeVerschmutzt: parseFloat(row.getCell(5).value) || 0,
      einheit: (row.getCell(6).value || '').toString().trim() || 'Stk.'
    });
  });

  // 'Lagerbestand'-Blatt komplett löschen und neu erstellen
  if (alteAnsicht) {
    workbook.removeWorksheet(alteAnsicht.id);
  }
  const ansicht = workbook.addWorksheet('Lagerbestand', { views: [{ state: 'normal' }] });

  // Titel-Zeile
  ansicht.mergeCells('A1:F1');
  const titel = ansicht.getCell('A1');
  titel.value = 'Lagerbestand – Horst Zienert GmbH';
  titel.font = { size: 18, bold: true, color: { argb: FARBE_TITEL } };
  titel.alignment = { horizontal: 'left' };
  ansicht.getRow(1).height = 28;

  // Aktualisierungs-Datum
  ansicht.mergeCells('A2:F2');
  const datum = ansicht.getCell('A2');
  datum.value = 'Stand: ' + new Date().toLocaleDateString('de-DE');
  datum.font = { size: 9, italic: true, color: { argb: 'FF666666' } };

  let zeile = 4;
  const headerZeile = () => {
    const r = ansicht.getRow(zeile);
    r.values = ['Nr.', 'Bezeichnung', 'Menge Neu', 'Menge Gebraucht', 'Menge Verschmutzt', 'Einheit'];
    r.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    r.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FARBE_HEADER } };
    ansicht.getRow(zeile).height = 18;
    zeile++;
  };
  const trenner = () => {
    ansicht.getRow(zeile).eachCell((c) => {
      c.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
    });
    zeile++;
  };

  // Nach Kategorie gruppieren (bekannte Reihenfolge, dann unbekannte alphabetisch)
  const gruppen = {};
  const unbekannte = new Set();
  for (const p of positionen) {
    if (KATEGORIEN.includes(p.kategorie)) {
      (gruppen[p.kategorie] = gruppen[p.kategorie] || []).push(p);
    } else {
      unbekannte.add(p.kategorie);
      (gruppen[p.kategorie] = gruppen[p.kategorie] || []).push(p);
    }
  }

  let nr = 0;
  const kategorienReihenfolge = [
    ...KATEGORIEN.filter((k) => gruppen[k]),
    ...[...unbekannte].sort()
  ];

  for (const kat of kategorienReihenfolge) {
    // Kategorie-Zwischenüberschrift
    ansicht.mergeCells('A' + zeile + ':F' + zeile);
    const zellen = ansicht.getCell('A' + zeile);
    zellen.value = kat;
    zellen.font = { size: 13, bold: true, color: { argb: 'FFFFFFFF' } };
    zellen.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FARBE_ZWISCHENTITEL } };
    zellen.alignment = { horizontal: 'left', indent: 1 };
    ansicht.getRow(zeile).height = 22;
    zeile++;
    headerZeile();
    // Positionen
    const sorted = gruppen[kat].slice().sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung));
    for (const p of sorted) {
      nr++;
      ansicht.getRow(zeile).values = [
        nr,
        p.bezeichnung,
        p.mengeNeu,
        p.mengeGebraucht,
        p.mengeVerschmutzt,
        p.einheit
      ];
      zeile++;
    }
    trenner();
  }

  // Spaltenbreiten
  COLUMNS.forEach((col, idx) => {
    ansicht.getColumn(idx + 1).width = col.width;
  });

  await workbook.xlsx.writeFile(pfad);
}

module.exports = {
  MATERIAL_PFAD,
  COLUMNS,
  KATEGORIEN,
  ladeWorkbook,
  lesePositionen,
  schreibePositionen,
  baueAnsicht
};
