// PDF-Ausfüllen mit pdf-lib.
// Wenn das Muster-PDF AcroForm-Felder hat (ausfüllbare Formularfelder),
// können wir es direkt ausfüllen — gleiches Layout, gleiche Schriftarten,
// nur die Feldwerte ändern sich.
//
// Wenn das Muster-PDF KEINE AcroForm-Felder hat, kann es nicht direkt
// ausgefüllt werden — dann greift lib/pdf.js, das ein neues PDF mit
// der analysierten Struktur erstellt.
//
// WICHTIG: pdf-lib wird LAZY geladen — erst beim Funktionsaufruf. Grund:
// Manche Umgebungen (z.B. Railway) haben Inkompatibilitäten mit dem pdf-lib-
// Initialisierungscode, der top-level ausgeführt wird. Lazy-Loading
// verhindert, dass schon das Modul-Importieren scheitert.

const fs = require('fs');

async function ladeFeldNamen(pdfPfad) {
  const { PDFDocument } = require('pdf-lib');
  const buffer = fs.readFileSync(pdfPfad);
  const pdfDoc = await PDFDocument.load(buffer);
  const form = pdfDoc.getForm();
  return form.getFields().map((f) => f.getName());
}

// Füllt die AcroForm-Felder eines PDFs und speichert das Ergebnis.
async function fuelleFelder(pdfPfad, feldwerte, outputPfad) {
  const { PDFDocument } = require('pdf-lib');
  const buffer = fs.readFileSync(pdfPfad);
  const pdfDoc = await PDFDocument.load(buffer);
  const form = pdfDoc.getForm();

  for (const [name, wert] of Object.entries(feldwerte || {})) {
    try {
      const field = form.getField(name);
      if (!field) continue;
      // pdf-lib unterstützt verschiedene Feldtypen — Text/String ist der häufigste
      if (typeof field.setText === 'function') {
        field.setText(String(wert));
      } else if (typeof field.setValue === 'function') {
        field.setValue(String(wert));
      } else if (typeof field.check === 'function' && typeof field.uncheck === 'function') {
        // Checkbox
        if (wert === true || wert === 'true' || wert === '1' || wert === 'x') {
          field.check();
        } else {
          field.uncheck();
        }
      } else if (Array.isArray(field.getOptions) && typeof field.select === 'function') {
        // Dropdown
        if (field.getOptions().includes(String(wert))) {
          field.select(String(wert));
        }
      }
    } catch (err) {
      console.warn(`Feld "${name}" konnte nicht gesetzt werden: ${err.message}`);
    }
  }

  // Formular kann "flach" gemacht werden (nicht mehr editierbar)
  // Optional, je nach Wunsch. Default: editierbar lassen.
  // form.flatten();

  const bytes = await pdfDoc.save();
  fs.writeFileSync(outputPfad, bytes);
  return outputPfad;
}

module.exports = { ladeFeldNamen, fuelleFelder };
