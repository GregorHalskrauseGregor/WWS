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

// Entfernt die farbigen Feldflaechen aus einem Formular.
//
// WARUM: Die Zienert-Vorlage traegt an jedem der 231 Felder einen hellblauen
// Hintergrund. Der ist KEIN Bildschirm-Effekt — anders als der Fokus-Rahmen,
// den ein Viewer beim Hineinklicken zeichnet, gehoert er zur Erscheinungsform
// des Feldes und wird mitgedruckt. Ein Aufmass, das der Kunde unterschreiben
// soll, sieht damit aus wie ein Bildschirmfoto.
//
// ZWEI STELLEN, und genau daran scheitert der naheliegende Fix:
//   1. MK/BG im Widget — die Anweisung "male den Hintergrund so".
//   2. Der bereits erzeugte Erscheinungsstrom (AP/N) — dort steht das Blau
//      als fertiger Malbefehl drin: ".8 .843 1 rg / 0 0 61.2 15 re / f".
//
// Nur MK zu loeschen genuegt deshalb nicht: pdf-lib erzeugt einen Strom neu,
// wenn das Feld als veraendert markiert ist. Ausgefuellte Felder sind das
// automatisch — alle uebrigen behielten ihren alten, blauen Strom. Deshalb
// werden hier ALLE Felder als veraendert markiert.
function entferneFeldFlaechen(form) {
  const { PDFName } = require('pdf-lib');
  const BG = PDFName.of('BG');
  const BC = PDFName.of('BC');
  const MK = PDFName.of('MK');
  let bereinigt = 0;

  for (const field of form.getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      const mk = widget.dict.lookup(MK);
      if (mk && typeof mk.delete === 'function') {
        const hatteFarbe = mk.has(BG) || mk.has(BC);
        mk.delete(BG);
        mk.delete(BC);
        // Ein leergeraeumtes MK ganz entfernen, statt ein leeres Dict zu lassen.
        if (mk.keys().length === 0) widget.dict.delete(MK);
        if (hatteFarbe) bereinigt++;
      }
    }
    if (typeof field.markAsDirty === 'function') field.markAsDirty();
  }
  return bereinigt;
}

// Füllt die AcroForm-Felder eines PDFs und speichert das Ergebnis.
// hintergruendeEntfernen: die farbigen Feldflaechen der Vorlage wegnehmen.
// Standard an — ein Aufmass wird gedruckt und unterschrieben, nicht am
// Bildschirm ausgefuellt. Wer die Kaesten behalten will (weil das PDF als
// Formular weiterverwendet wird), setzt es auf false.
async function fuelleFelder(pdfPfad, feldwerte, outputPfad, { hintergruendeEntfernen = true } = {}) {
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

  // Farbige Feldflaechen weg, danach die Erscheinungsstroeme neu erzeugen.
  // Reihenfolge ist wichtig: erst MK entfernen, dann neu zeichnen lassen —
  // andersherum malt pdf-lib das Blau nochmal mit hinein.
  if (hintergruendeEntfernen) {
    const bereinigt = entferneFeldFlaechen(form);
    try {
      form.updateFieldAppearances();
    } catch (err) {
      // Schlaegt das Neuzeichnen fehl (fehlende Schrift in den Ressourcen),
      // ist das kein Grund, das ganze Aufmass zu verlieren. Dann bleiben die
      // Kaesten eben drin — sichtbar, aber vollstaendig.
      console.warn('Erscheinungsformen nicht neu erzeugt: ' + err.message);
    }
    if (bereinigt) console.log(`PDF: ${bereinigt} farbige Feldflächen entfernt.`);
  }

  // Formular kann "flach" gemacht werden (nicht mehr editierbar)
  // Optional, je nach Wunsch. Default: editierbar lassen.
  // form.flatten();

  const bytes = await pdfDoc.save();
  fs.writeFileSync(outputPfad, bytes);
  return outputPfad;
}

// Liest die AUSGEFUELLTEN Werte eines Formular-PDFs.
//
// Warum nicht per Textextraktion: pdf-parse braucht in manchen Umgebungen
// native Canvas-Bindings und faellt dort mit "DOMMatrix is not defined" aus.
// pdf-lib laeuft ueberall und liefert bei einem AcroForm-PDF ohnehin die
// besseren Daten — die Feldwerte selbst statt eines Textabzugs davon.
async function leseFeldWerte(pdfPfad) {
  const { PDFDocument } = require('pdf-lib');
  const pdfDoc = await PDFDocument.load(fs.readFileSync(pdfPfad));
  const felder = pdfDoc.getForm().getFields();
  const raus = [];
  for (const f of felder) {
    let wert = null;
    try {
      if (typeof f.getText === 'function') wert = f.getText();
      else if (typeof f.isChecked === 'function') wert = f.isChecked() ? 'x' : null;
      else if (typeof f.getSelected === 'function') wert = (f.getSelected() || []).join(', ') || null;
    } catch { /* Feldtyp ohne lesbaren Wert */ }
    // undefined MUSS mit abgefangen werden: pdf-lib liefert bei einem Feld ohne
    // Wert kein '', sondern undefined — und String(undefined) ist "undefined",
    // also nicht leer. Ohne diese Zeile gilt JEDES leere Feld als ausgefüllt.
    // Das ist nicht kosmetisch: der Router entscheidet über genau diesen Anteil,
    // ob ein PDF ein Blankoformular oder ein ausgefülltes Aufmaß ist.
    if (wert !== undefined && wert !== null && String(wert).trim() !== '') {
      raus.push({ name: f.getName(), wert: String(wert).trim() });
    }
  }
  return { gesamt: felder.length, ausgefuellt: raus };
}

module.exports = { ladeFeldNamen, fuelleFelder, leseFeldWerte, entferneFeldFlaechen };
