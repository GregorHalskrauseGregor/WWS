// Erzeugt die vorzeigbare Lagerliste als EIGENE Excel-Datei.
//
// Die Arbeitsdatei (data/material.xlsx) bleibt davon unberührt: sie ist die
// Buchungsgrundlage und soll schlicht bleiben. Hier entsteht bei Bedarf eine
// frische Datei mit Kategorien als Zwischenüberschriften, Summen und einem
// Stand-Datum — die kann man weitergeben, ohne dass interne Spalten wie die
// Reservierungen mitwandern.

const fs = require('fs');
const path = require('path');
const material = require('../material');
const { KATEGORIEN } = require('../kategorien');

const TITELFARBE = 'FF1F3864';
const KATEGORIEFARBE = 'FF5B6B87';
const KOPFFARBE = 'FFE7E6E6';
const LEERFARBE = 'FF999999';

function datumStempel() {
  return new Date().toISOString().slice(0, 10);
}

// positionen: bereits gelesen (spart einen Dateizugriff, wenn der Aufrufer sie hat)
async function erzeuge(zielPfad, positionen, optionen = {}) {
  const mitReservierungen = optionen.mitReservierungen === true;
  const titel = optionen.titel || 'Lagerbestand';

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const blatt = wb.addWorksheet('Lagerbestand', {
    views: [{ state: 'frozen', ySplit: 3 }],
    pageSetup: { paperSize: 9, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
  });

  const spalten = [
    { header: 'Bezeichnung', width: 46 },
    { header: 'Neu', width: 10 },
    { header: 'Gebraucht', width: 12 },
    { header: 'Verschmutzt', width: 13 },
    { header: 'Gesamt', width: 11 },
    { header: 'Einheit', width: 10 }
  ];
  if (mitReservierungen) spalten.push({ header: 'davon reserviert', width: 16 });
  const breite = spalten.length;
  const letzteSpalte = String.fromCharCode(64 + breite); // A..G

  spalten.forEach((s, i) => { blatt.getColumn(i + 1).width = s.width; });

  // Titel
  blatt.mergeCells(`A1:${letzteSpalte}1`);
  const t = blatt.getCell('A1');
  t.value = titel;
  t.font = { size: 18, bold: true, color: { argb: TITELFARBE } };
  blatt.getRow(1).height = 26;

  blatt.mergeCells(`A2:${letzteSpalte}2`);
  const d = blatt.getCell('A2');
  const gesamtPositionen = positionen.length;
  const leerePositionen = positionen.filter((p) => material.gesamtbestand(p) === 0).length;
  d.value = `Stand: ${new Date().toLocaleDateString('de-DE')} · ${gesamtPositionen} Positionen` +
    (leerePositionen ? ` · davon ${leerePositionen} derzeit nicht vorrätig` : '');
  d.font = { size: 9, italic: true, color: { argb: 'FF666666' } };

  let zeile = 4;
  const gruppen = material.ganzeListe(positionen);

  for (const [kategorie, eintraege] of Object.entries(gruppen)) {
    // Zwischenüberschrift
    blatt.mergeCells(`A${zeile}:${letzteSpalte}${zeile}`);
    const k = blatt.getCell(`A${zeile}`);
    k.value = kategorie;
    k.font = { size: 12, bold: true, color: { argb: 'FFFFFFFF' } };
    k.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KATEGORIEFARBE } };
    k.alignment = { vertical: 'middle', indent: 1 };
    blatt.getRow(zeile).height = 20;
    zeile++;

    // Spaltenköpfe je Kategorie — die Liste wird gedruckt und blattweise gelesen
    const kopf = blatt.getRow(zeile);
    kopf.values = spalten.map((s) => s.header);
    kopf.font = { bold: true, size: 10 };
    kopf.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: KOPFFARBE } };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFAAAAAA' } } };
    });
    zeile++;

    const sortiert = eintraege.slice()
      .sort((a, b) => a.bezeichnung.localeCompare(b.bezeichnung, 'de'));

    let summe = 0;
    for (const p of sortiert) {
      const gesamt = material.gesamtbestand(p);
      summe += gesamt;
      const werte = [
        p.bezeichnung,
        p.mengeNeu || 0,
        p.mengeGebraucht || 0,
        p.mengeVerschmutzt || 0,
        gesamt,
        p.einheit || 'Stk.'
      ];
      if (mitReservierungen) werte.push(material.reserviertGesamt(p) || 0);
      const r = blatt.getRow(zeile);
      r.values = werte;
      // Nicht vorrätige Positionen bleiben stehen, werden aber zurückgenommen
      // dargestellt — sie sind die Antwort auf "haben wir das noch?".
      if (gesamt === 0) {
        r.font = { color: { argb: LEERFARBE }, italic: true };
      }
      for (let i = 2; i <= 5; i++) r.getCell(i).alignment = { horizontal: 'right' };
      zeile++;
    }

    // Kategoriesumme
    const s = blatt.getRow(zeile);
    s.getCell(1).value = `Summe ${kategorie}`;
    s.getCell(5).value = summe;
    s.font = { bold: true };
    s.getCell(5).alignment = { horizontal: 'right' };
    s.eachCell((c) => { c.border = { top: { style: 'thin', color: { argb: 'FFAAAAAA' } } }; });
    zeile += 2;
  }

  if (gesamtPositionen === 0) {
    blatt.getCell('A4').value = 'Das Lager ist noch leer.';
    blatt.getCell('A4').font = { italic: true, color: { argb: 'FF666666' } };
  }

  fs.mkdirSync(path.dirname(zielPfad), { recursive: true });
  await wb.xlsx.writeFile(zielPfad);
  return zielPfad;
}

// Bequemer Aufruf: liest selbst und legt die Datei in einen Ordner.
async function erzeugeIn(ordner, optionen = {}) {
  const positionen = await material.leseAlle();
  const name = `Lagerbestand_${datumStempel()}.xlsx`;
  return erzeuge(path.join(ordner, name), positionen, optionen);
}

module.exports = { erzeuge, erzeugeIn, datumStempel };
