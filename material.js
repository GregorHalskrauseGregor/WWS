const ExcelJS = require('exceljs');
const path = require('path');

const EXCEL_PATH = path.join(__dirname, 'data', 'material.xlsx');
const SHEET_NAME = 'Material';

// Spalten: A = Kategorie, B = Bezeichnung, C = Menge Neu, D = Menge Gebraucht,
//          E = Menge Verschmutzt, F = Einheit
// Eine Zeile pro Artikel (nicht mehr pro Zustand) -> bleibt auch bei Hunderten/Tausenden
// Positionen übersichtlich und lässt sich in Excel leicht nach Kategorie filtern/sortieren.
const SPALTE = { kategorie: 1, bezeichnung: 2, neu: 3, gebraucht: 4, verschmutzt: 5, einheit: 6 };

// Absichtlich KEIN Self-Healing: fehlt die Datei, soll das laut auffallen (Fehlermeldung),
// statt stillschweigend eine leere Liste anzulegen und einen echten Datenverlust zu verschleiern.
async function loadWorkbook() {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(EXCEL_PATH);
  let sheet = workbook.getWorksheet(SHEET_NAME);
  if (!sheet) {
    sheet = workbook.addWorksheet(SHEET_NAME);
    sheet.getRow(1).values = ['Kategorie', 'Bezeichnung', 'Menge Neu', 'Menge Gebraucht', 'Menge Verschmutzt', 'Einheit'];
  }
  return { workbook, sheet };
}

function normZustand(zustand) {
  const erlaubt = ['neu', 'gebraucht', 'verschmutzt'];
  const z = String(zustand || 'neu').trim().toLowerCase();
  return erlaubt.includes(z) ? z : 'neu';
}

function findRow(sheet, bezeichnung) {
  const suche = bezeichnung.trim().toLowerCase();
  let treffer = null;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const wert = String(row.getCell(SPALTE.bezeichnung).value || '').trim().toLowerCase();
    if (wert === suche) {
      treffer = row;
    }
  });
  return treffer;
}

function zeileZuObjekt(row) {
  return {
    kategorie: row.getCell(SPALTE.kategorie).value || 'Sonstiges',
    bezeichnung: row.getCell(SPALTE.bezeichnung).value,
    mengeNeu: Number(row.getCell(SPALTE.neu).value) || 0,
    mengeGebraucht: Number(row.getCell(SPALTE.gebraucht).value) || 0,
    mengeVerschmutzt: Number(row.getCell(SPALTE.verschmutzt).value) || 0,
    einheit: row.getCell(SPALTE.einheit).value || ''
  };
}

// Fügt Positionen hinzu bzw. addiert die Menge in der passenden Zustandsspalte.
// Deckt Wareneingang UND Materialrückgabe durch Monteure ab.
// items: [{ bezeichnung, menge, einheit, zustand, kategorie }]
async function addierePositionen(items) {
  const { workbook, sheet } = await loadWorkbook();
  const ergebnisse = [];

  for (const item of items) {
    const zustand = normZustand(item.zustand);
    const spalte = SPALTE[zustand];
    const existierendeZeile = findRow(sheet, item.bezeichnung);

    if (existierendeZeile) {
      const alteMenge = Number(existierendeZeile.getCell(spalte).value) || 0;
      const neueMenge = alteMenge + Number(item.menge);
      existierendeZeile.getCell(spalte).value = neueMenge;
      if (item.einheit) existierendeZeile.getCell(SPALTE.einheit).value = item.einheit;
      // Kategorie nur setzen, wenn noch keine vorhanden ist -> bestehende Einordnung nicht überschreiben
      if (item.kategorie && !existierendeZeile.getCell(SPALTE.kategorie).value) {
        existierendeZeile.getCell(SPALTE.kategorie).value = item.kategorie;
      }
      ergebnisse.push({
        bezeichnung: item.bezeichnung,
        zustand,
        menge: neueMenge,
        einheit: item.einheit || existierendeZeile.getCell(SPALTE.einheit).value,
        kategorie: existierendeZeile.getCell(SPALTE.kategorie).value
      });
    } else {
      const kategorie = item.kategorie || 'Sonstiges';
      const zeile = [kategorie, item.bezeichnung, 0, 0, 0, item.einheit || ''];
      zeile[spalte - 1] = Number(item.menge);
      sheet.addRow(zeile);
      ergebnisse.push({
        bezeichnung: item.bezeichnung,
        zustand,
        menge: Number(item.menge),
        einheit: item.einheit || '',
        kategorie
      });
    }
  }

  await workbook.xlsx.writeFile(EXCEL_PATH);
  return ergebnisse;
}

// Zieht Menge in der passenden Zustandsspalte ab (Entnahme/Verbrauch). Geht NIE ins Minus:
// jede Zustandsspalte wird als eigener Bestand behandelt, es wird NICHT aus einer anderen
// Zustandsspalte "nachgezogen".
// items: [{ bezeichnung, menge, zustand }]
async function entnehmePositionen(items) {
  const { workbook, sheet } = await loadWorkbook();
  const ergebnisse = [];

  for (const item of items) {
    const zustand = normZustand(item.zustand);
    const spalte = SPALTE[zustand];
    const zeile = findRow(sheet, item.bezeichnung);
    const vorhandeneMenge = zeile ? (Number(zeile.getCell(spalte).value) || 0) : 0;
    const angefragteMenge = Number(item.menge);

    if (!zeile) {
      ergebnisse.push({
        bezeichnung: item.bezeichnung,
        zustand,
        entnommen: 0,
        fehlend: angefragteMenge,
        neueMenge: 0,
        unbekannt: true
      });
      continue;
    }

    if (angefragteMenge > vorhandeneMenge) {
      zeile.getCell(spalte).value = 0;
      ergebnisse.push({
        bezeichnung: item.bezeichnung,
        zustand,
        entnommen: vorhandeneMenge,
        fehlend: angefragteMenge - vorhandeneMenge,
        neueMenge: 0,
        einheit: zeile.getCell(SPALTE.einheit).value
      });
    } else {
      const neueMenge = vorhandeneMenge - angefragteMenge;
      zeile.getCell(spalte).value = neueMenge;
      ergebnisse.push({
        bezeichnung: item.bezeichnung,
        zustand,
        entnommen: angefragteMenge,
        fehlend: 0,
        neueMenge,
        einheit: zeile.getCell(SPALTE.einheit).value
      });
    }
  }

  await workbook.xlsx.writeFile(EXCEL_PATH);
  return ergebnisse;
}

// Reine Bedarfsprüfung, OHNE den Bestand zu verändern. Summiert alle drei Zustandsspalten.
// items: [{ bezeichnung, menge }]
async function pruefeBedarf(items) {
  const { sheet } = await loadWorkbook();
  const ergebnisse = [];

  for (const item of items) {
    const zeile = findRow(sheet, item.bezeichnung);
    const daten = zeile ? zeileZuObjekt(zeile) : { mengeNeu: 0, mengeGebraucht: 0, mengeVerschmutzt: 0, einheit: '' };
    const gesamtBestand = daten.mengeNeu + daten.mengeGebraucht + daten.mengeVerschmutzt;

    const angefragteMenge = Number(item.menge);
    const verfuegbar = Math.min(gesamtBestand, angefragteMenge);
    const fehlend = Math.max(0, angefragteMenge - gesamtBestand);

    ergebnisse.push({
      bezeichnung: item.bezeichnung,
      angefragt: angefragteMenge,
      verfuegbar,
      fehlend,
      gesamtBestand,
      einheit: daten.einheit
    });
  }

  return ergebnisse;
}

// Sucht Positionen, deren Bezeichnung den Suchbegriff enthält.
async function suchePositionen(suchbegriff) {
  const { sheet } = await loadWorkbook();
  const suche = suchbegriff.trim().toLowerCase();
  const treffer = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const bezeichnung = String(row.getCell(SPALTE.bezeichnung).value || '');
    if (bezeichnung.toLowerCase().includes(suche)) {
      treffer.push(zeileZuObjekt(row));
    }
  });

  return treffer;
}

async function gesamteListe() {
  const { sheet } = await loadWorkbook();
  const alle = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    alle.push(zeileZuObjekt(row));
  });
  return alle;
}

module.exports = {
  EXCEL_PATH,
  addierePositionen,
  entnehmePositionen,
  pruefeBedarf,
  suchePositionen,
  gesamteListe
};
