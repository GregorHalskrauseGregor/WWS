// Direktes Auslesen von Excel- und Word-Dateien. Kein OCR nötig, da diese
// Formate bereits strukturierten Text enthalten (anders als Fotos/Screenshots).
//
// exceljs und mammoth werden LAZY geladen — erst beim tatsächlichen Aufruf.
// Beide sind große Pakete; eager geladen verzögern sie jeden Bot-Start, obwohl
// die meisten Nachrichten nie eine Excel- oder Word-Datei enthalten.
// (lib/excel.js und lib/pdf*.js machen das aus demselben Grund schon so.)

async function excelZuText(buffer) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  let text = '';
  workbook.eachSheet((sheet) => {
    text += `Tabellenblatt: ${sheet.name}\n`;
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const werte = row.values.slice(1).map((v) => (v === null || v === undefined ? '' : v));
      text += werte.join(' | ') + '\n';
    });
    text += '\n';
  });
  return text.trim();
}

async function wordZuText(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

module.exports = { excelZuText, wordZuText };
