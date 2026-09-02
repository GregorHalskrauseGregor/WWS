// Baut aus den rohen Materialdaten eine ansehnliche, für Menschen gedachte Ansicht als
// eigenes Tabellenblatt ("Lagerbestand"). Die eigentlichen Daten liegen unverändert im
// versteckten "Daten"-Blatt – dieses Blatt hier wird bei jedem Speichern komplett neu
// aufgebaut und nie selbst gelesen, damit die Darstellung nie mit der Logik kollidiert.

const ANSICHT_SHEET = 'Lagerbestand';

const FARBE_TITEL = 'FF1F3864';
const FARBE_UNTERTITEL = 'FF5B6B87';
const FARBE_KATEGORIE_TEXT = 'FFFFFFFF';
const FARBE_KATEGORIE_HG = 'FF2E5395';
const FARBE_SPALTENKOPF_HG = 'FFE8EEF7';
const FARBE_SPALTENKOPF_TEXT = 'FF2E5395';
const FARBE_RAHMEN = 'FFB6C6E3';

function formatiertesDatum() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderKategorieBlock(sheet, kategorie, artikel, startZeile) {
  const SPALTEN = 5;
  let zeile = startZeile;

  sheet.mergeCells(zeile, 1, zeile, SPALTEN);
  const kategorieZelle = sheet.getCell(zeile, 1);
  kategorieZelle.value = kategorie;
  kategorieZelle.font = { size: 14, bold: true, color: { argb: FARBE_KATEGORIE_TEXT } };
  kategorieZelle.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FARBE_KATEGORIE_HG } };
  kategorieZelle.alignment = { vertical: 'middle', indent: 1 };
  sheet.getRow(zeile).height = 22;
  zeile++;

  const headerRow = sheet.getRow(zeile);
  headerRow.values = ['Bezeichnung', 'Menge Neu', 'Menge Gebraucht', 'Menge Verschmutzt', 'Einheit'];
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, size: 11, color: { argb: FARBE_SPALTENKOPF_TEXT } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: FARBE_SPALTENKOPF_HG } };
    cell.border = { bottom: { style: 'thin', color: { argb: FARBE_RAHMEN } } };
  });
  zeile++;

  for (const a of artikel) {
    const row = sheet.getRow(zeile);
    row.values = [a.bezeichnung, a.mengeNeu, a.mengeGebraucht, a.mengeVerschmutzt, a.einheit];
    row.font = { size: 11 };
    for (let c = 2; c <= 4; c++) {
      row.getCell(c).alignment = { horizontal: 'center' };
    }
    zeile++;
  }

  return zeile + 2; // 2 Leerzeilen Abstand zur nächsten Kategorie
}

// datenZeilen: [{ kategorie, bezeichnung, mengeNeu, mengeGebraucht, mengeVerschmutzt, einheit }]
// kategorienReihenfolge: feste Liste (aus kategorien.js) für eine stabile, vorhersagbare Reihenfolge
function baueAnsicht(workbook, datenZeilen, kategorienReihenfolge) {
  const bestehende = workbook.getWorksheet(ANSICHT_SHEET);
  if (bestehende) {
    workbook.removeWorksheet(bestehende.id);
  }

  const sheet = workbook.addWorksheet(ANSICHT_SHEET);
  sheet.columns = [{ width: 46 }, { width: 13 }, { width: 16 }, { width: 17 }, { width: 12 }];

  const SPALTEN = 5;

  sheet.mergeCells(1, 1, 1, SPALTEN);
  const titel = sheet.getCell(1, 1);
  titel.value = 'Lagerbestand · Horst Zienert GmbH';
  titel.font = { size: 20, bold: true, color: { argb: FARBE_TITEL } };
  sheet.getRow(1).height = 30;

  sheet.mergeCells(2, 1, 2, SPALTEN);
  const untertitel = sheet.getCell(2, 1);
  untertitel.value = 'Materialverwaltung – Anlagenmechaniker SHK';
  untertitel.font = { size: 12, italic: true, color: { argb: FARBE_UNTERTITEL } };

  sheet.mergeCells(3, 1, 3, SPALTEN);
  const stand = sheet.getCell(3, 1);
  stand.value = `Stand: ${formatiertesDatum()} Uhr`;
  stand.font = { size: 10, italic: true, color: { argb: FARBE_UNTERTITEL } };

  const vorhandeneKategorien = [...new Set(datenZeilen.map((d) => d.kategorie))];
  const geordnet = kategorienReihenfolge.filter((k) => vorhandeneKategorien.includes(k));
  const uebrige = vorhandeneKategorien.filter((k) => !kategorienReihenfolge.includes(k)).sort();
  const alleKategorien = [...geordnet, ...uebrige];

  let zeile = 5;
  for (const kategorie of alleKategorien) {
    const artikel = datenZeilen.filter((d) => d.kategorie === kategorie);
    if (artikel.length === 0) continue;
    zeile = renderKategorieBlock(sheet, kategorie, artikel, zeile);
  }

  return sheet;
}

module.exports = { ANSICHT_SHEET, baueAnsicht };
