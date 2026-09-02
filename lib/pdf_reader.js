// PDF-Lesen mit pdf-parse.
// Extrahiert Text und Metadaten aus PDF-Dateien. Wird vom Materialaufmaß-Experten
// genutzt, um:
//   - das Muster-PDF zu analysieren (Struktur, Felder, Layout)
//   - das Style-Sheet zu lesen (Formatierungswünsche)
//   - AcroForm-Felder zu erkennen (für automatisches Ausfüllen)
//
// WICHTIG: pdf-parse wird LAZY geladen — erst beim Funktionsaufruf.
// Vermeidet Modul-Load-Fehler, wenn die native Binding-Initialisierung
// auf der Zielumgebung (z.B. Railway) Probleme macht.

const fs = require('fs');

async function lesePdf(pfad) {
  const pdfParse = require('pdf-parse');
  const buffer = fs.readFileSync(pfad);
  const data = await pdfParse(buffer);
  return {
    text: data.text || '',
    seiten: data.numpages || 0,
    info: data.info || {},
    metadaten: data.metadata || null
  };
}

// Extrahiert erkennbare Felder aus dem Text (heuristisch).
// Nützlich, wenn das Muster-PDF kein AcroForm hat, aber Felder als
// "Feldname: ___" oder "[Feldname]" markiert sind.
function extrahiereFeldPlatzhalter(text) {
  const feldnamen = new Set();
  // Muster 1: "Feldname: ___" oder "Feldname: ____"
  const regex1 = /\b([A-ZÄÖÜ][\w\s]{2,40}?)\s*:\s*_+\b/g;
  let m;
  while ((m = regex1.exec(text)) !== null) {
    feldnamen.add(m[1].trim());
  }
  // Muster 2: [Feldname] oder <Feldname>
  const regex2 = /[\[<]([A-ZÄÖÜ][\w\s]{2,40}?)[\]>]/g;
  while ((m = regex2.exec(text)) !== null) {
    feldnamen.add(m[1].trim());
  }
  return Array.from(feldnamen);
}

// Erkennt, ob das PDF AcroForm-Felder hat (für pdf-lib-Filler).
// Wir laden das PDF mit pdf-lib und prüfen, ob es Form-Felder hat —
// das ist die zuverlässige Methode. Heuristik über Textsuche ("/AcroForm")
// reicht nicht, weil das Token bei großen PDFs mit eingebettetem Background
// oder Bildern weit hinten im Stream stehen kann.
async function hatAcroFormFelder(pfad) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const buffer = fs.readFileSync(pfad);
    const pdfDoc = await PDFDocument.load(buffer, { ignoreEncryption: true });
    const form = pdfDoc.getForm();
    return form.getFields().length > 0;
  } catch (err) {
    // PDF konnte nicht geladen werden (z.B. beschädigt oder kein PDF)
    return false;
  }
}

module.exports = { lesePdf, extrahiereFeldPlatzhalter, hatAcroFormFelder };
