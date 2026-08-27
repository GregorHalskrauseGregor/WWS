const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Material');

  sheet.getRow(1).values = ['Kategorie', 'Bezeichnung', 'Menge Neu', 'Menge Gebraucht', 'Menge Verschmutzt', 'Einheit'];
  sheet.addRow(['Armaturen & Ventile', 'Kugelhahn DN20', 5, 2, 1, 'Stück']);
  sheet.addRow(['Rohre & Leitungen', 'Kupferrohr 22mm', 12, 0, 0, 'Meter']);

  const outPath = path.join(__dirname, 'data', 'material.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('Beispiel-Materialliste erstellt: ' + outPath);
}

main();
