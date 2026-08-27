const ExcelJS = require('exceljs');
const path = require('path');
const { KATEGORIEN } = require('./kategorien');
const { ANSICHT_SHEET, baueAnsicht } = require('./ansicht');

async function main() {
  const workbook = new ExcelJS.Workbook();

  // Verstecktes Daten-Blatt (das der Bot tatsächlich liest/schreibt)
  const datenSheet = workbook.addWorksheet('Daten');
  datenSheet.getRow(1).values = ['Kategorie', 'Bezeichnung', 'Menge Neu', 'Menge Gebraucht', 'Menge Verschmutzt', 'Einheit'];
  datenSheet.addRow(['Armaturen & Ventile', 'Kugelhahn DN20', 5, 2, 1, 'Stück']);
  datenSheet.addRow(['Rohre & Leitungen', 'Kupferrohr 22mm', 12, 0, 0, 'Meter']);

  // Hübsche, sichtbare Ansicht daraus aufbauen
  const alle = [
    { kategorie: 'Armaturen & Ventile', bezeichnung: 'Kugelhahn DN20', mengeNeu: 5, mengeGebraucht: 2, mengeVerschmutzt: 1, einheit: 'Stück' },
    { kategorie: 'Rohre & Leitungen', bezeichnung: 'Kupferrohr 22mm', mengeNeu: 12, mengeGebraucht: 0, mengeVerschmutzt: 0, einheit: 'Meter' }
  ];
  baueAnsicht(workbook, alle, KATEGORIEN);
  datenSheet.state = 'hidden';

  const ansichtIndex = workbook.worksheets.findIndex((s) => s.name === ANSICHT_SHEET);
  workbook.views = [{ activeTab: ansichtIndex }];

  const outPath = path.join(__dirname, 'data', 'material.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('Beispiel-Materialliste erstellt: ' + outPath);
}

main();
