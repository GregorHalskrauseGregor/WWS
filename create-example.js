const ExcelJS = require('exceljs');
const path = require('path');

async function main() {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Beispiel');

  sheet.getCell('A1').value = 'Bezeichnung';
  sheet.getCell('B1').value = 'Wert';

  sheet.getCell('A2').value = 'Speichervolumen';
  sheet.getCell('B2').value = 200;

  sheet.getCell('A3').value = 'Spitzenvolumenstrom';
  sheet.getCell('B3').value = 45;

  const outPath = path.join(__dirname, 'data', 'arbeitsdatei.xlsx');
  await workbook.xlsx.writeFile(outPath);
  console.log('Beispiel-Datei erstellt: ' + outPath);
}

main();
