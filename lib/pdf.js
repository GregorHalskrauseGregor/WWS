// PDF-Erstellung mit pdfkit.
// Wird vom Materialaufmaß-Experten (und später von anderen, die PDFs generieren)
// genutzt, um Dokumente wie Aufmaß, Rechnungen, Bestellungen zu erstellen.
//
// Layout: A4, Hochformat. Koordinaten sind in "points" (1pt = 1/72 Zoll).
//   - Standard-Seite: 595 x 842 pt (A4)
//   - linke/rechte Seitenränder typisch 50pt
//
// Die Funktion erstellt() baut ein einfaches Aufmaß-PDF aus übergebenen Daten.
// Falls ein Muster-PDF mit AcroForm-Feldern vorhanden ist, nutzt der Aufmaß-
// Experte stattdessen lib/pdf_filler.js zum direkten Ausfüllen.

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const PAGE = { width: 595, height: 842 };
const MARGIN = { top: 50, bottom: 50, left: 50, right: 50 };
const CONTENT_WIDTH = PAGE.width - MARGIN.left - MARGIN.right;

// Default-Style (kann vom Style-Sheet überschrieben werden)
const DEFAULT_STYLE = {
  font: 'Helvetica',
  fontSize: 11,
  titleSize: 18,
  headingSize: 13,
  lineGap: 4,
  accentColor: '#1F3864', // dunkelblau
  textColor: '#000000'
};

// Erstellt ein Aufmaß-PDF und gibt den Pfad zur Datei zurück.
//   daten = {
//     titel:        string (z.B. "Materialaufmaß")
//     untertitel:   string (z.B. "Badsanierung Müller")
//     projekt:      { nummer, bezeichnung }
//     positionen:   [ { name, menge, einheit?, artikelnummer? }, ... ]
//     unterschrift:  string|null  (Pfad zum PNG/JPG der Unterschrift)
//     meta:         { erstelltAm, erstelltVon }
//   }
//   outputPath: string (wo das PDF gespeichert wird)
async function erstelleAufmass(daten, outputPath) {
  const style = { ...DEFAULT_STYLE, ...(daten.style || {}) };
  const doc = new PDFDocument({
    size: 'A4',
    margins: MARGIN,
    info: {
      Title: daten.titel || 'Materialaufmaß',
      Author: daten.meta && daten.meta.erstelltVon || 'Bot',
      CreationDate: new Date()
    }
  });

  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);

  // --- Kopfzeile ---
  doc.fillColor(style.accentColor)
     .fontSize(style.titleSize)
     .font(style.font + '-Bold')
     .text(daten.titel || 'Materialaufmaß', MARGIN.left, MARGIN.top);

  doc.moveDown(0.3);
  if (daten.untertitel) {
    doc.fontSize(style.headingSize)
       .font(style.font)
       .fillColor(style.textColor)
       .text(daten.untertitel);
    doc.moveDown(0.5);
  }

  // Trennlinie
  doc.strokeColor(style.accentColor)
     .lineWidth(1.5)
     .moveTo(MARGIN.left, doc.y)
     .lineTo(PAGE.width - MARGIN.right, doc.y)
     .stroke();
  doc.moveDown(0.7);

  // --- Projekt-Block ---
  if (daten.projekt && (daten.projekt.nummer || daten.projekt.bezeichnung)) {
    doc.fillColor(style.textColor).fontSize(style.headingSize).font(style.font + '-Bold');
    if (daten.projekt.nummer) {
      doc.text('Projekt: ' + daten.projekt.nummer);
    }
    if (daten.projekt.bezeichnung) {
      doc.font(style.font).fontSize(style.fontSize).text('Bezeichnung: ' + daten.projekt.bezeichnung);
    }
    doc.moveDown(0.8);
  }

  // --- Positionen-Tabelle ---
  if (Array.isArray(daten.positionen) && daten.positionen.length > 0) {
    doc.fontSize(style.headingSize).font(style.font + '-Bold').fillColor(style.textColor);
    doc.text('Positionen');
    doc.moveDown(0.3);

    // Tabellenkopf
    const tableTop = doc.y;
    const colPos = MARGIN.left;
    const colName = colPos + 30;
    const colMenge = colPos + 360;
    const colEinheit = colPos + 420;
    const colArt = colPos + 470;

    doc.fontSize(style.fontSize).font(style.font + '-Bold');
    doc.text('Nr.', colPos, tableTop, { width: 25 });
    doc.text('Bezeichnung', colName, tableTop, { width: 320 });
    doc.text('Menge', colMenge, tableTop, { width: 55, align: 'right' });
    doc.text('Einheit', colEinheit, tableTop, { width: 45 });
    doc.text('Art-Nr', colArt, tableTop, { width: 80 });

    doc.moveDown(0.2);
    doc.strokeColor('#888888').lineWidth(0.5)
       .moveTo(MARGIN.left, doc.y)
       .lineTo(PAGE.width - MARGIN.right, doc.y)
       .stroke();
    doc.moveDown(0.3);

    // Zeilen
    doc.font(style.font).fontSize(style.fontSize).fillColor(style.textColor);
    daten.positionen.forEach((p, i) => {
      // Prüfen, ob auf der Seite noch Platz ist (ca. 30pt pro Zeile)
      if (doc.y > PAGE.height - MARGIN.bottom - 50) {
        doc.addPage();
        doc.fontSize(style.fontSize).font(style.font);
        doc.fillColor(style.textColor);
      }
      const y = doc.y;
      doc.text(String(i + 1), colPos, y, { width: 25 });
      doc.text(String(p.name || ''), colName, y, { width: 320 });
      doc.text(String(p.menge || ''), colMenge, y, { width: 55, align: 'right' });
      doc.text(String(p.einheit || 'Stk.'), colEinheit, y, { width: 45 });
      doc.text(String(p.artikelnummer || ''), colArt, y, { width: 80 });
      doc.moveDown(0.7);
    });
  }

  // --- Unterschrift ---
  if (daten.unterschrift) {
    // Genug Platz am Ende
    if (doc.y > PAGE.height - MARGIN.bottom - 100) {
      doc.addPage();
    }
    doc.moveDown(2);
    const sigX = MARGIN.left;
    const sigY = doc.y;
    try {
      // Unterschrift einbinden — max 200pt breit
      doc.image(daten.unterschrift, sigX, sigY, { width: 200 });
      doc.moveDown(0.2);
    } catch (err) {
      // Bild konnte nicht eingebunden werden (z.B. falsches Format)
      console.error('Unterschrift konnte nicht eingebunden werden:', err.message);
    }
    doc.fontSize(9).fillColor('#666666')
       .text('Erstellt: ' + new Date().toLocaleDateString('de-DE'), sigX, doc.y + 5);
  }

  doc.end();

  return new Promise((resolve, reject) => {
    stream.on('finish', () => resolve(outputPath));
    stream.on('error', reject);
  });
}

module.exports = { erstelleAufmass, DEFAULT_STYLE, PAGE, MARGIN };
