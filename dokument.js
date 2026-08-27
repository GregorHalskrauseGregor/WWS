// Direktes Auslesen von Excel- und Word-Dateien. Kein OCR nötig, da diese Formate
// bereits strukturierten Text enthalten (im Gegensatz zu Fotos/Screenshots/PDFs).

const ExcelJS = require('exceljs');
const mammoth = require('mammoth');

async function excelZuText(buffer) {
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
  const result = await mammoth.extractRawText({ buffer });
  return result.value.trim();
}

module.exports = { excelZuText, wordZuText };
