// Testet das echte Zienert-AcroForm-PDF: Felder laden, befüllen, speichern, wieder auslesen.

const fs = require('fs');
const path = require('path');
const libPdfFiller = require('../lib/pdf_filler');
const matExp = require('../experten/materialaufmass');

const VORLAGE = path.join(__dirname, '..', 'data', 'aufnahme_vorlage', 'Aufmass_Zienert_ausfuellbar.pdf');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'users', '99999', 'aufnahmen');

(async () => {
  // 1) Felder aus dem PDF lesen
  console.log('=== 1) Felder aus PDF lesen ===');
  const felder = await libPdfFiller.ladeFeldNamen(VORLAGE);
  console.log('Anzahl Felder:', felder.length);
  console.log();

  // 2) Testdaten, die das Schema abdecken
  console.log('=== 2) Beispieldaten mappen ===');
  const daten = {
    projekt: { nummer: 'PRJ-2026-001', bezeichnung: 'Badsanierung Müller' },
    positionen: [
      { name: 'Kupferrohr 22mm', menge: 12, einheit: 'm', artikelnummer: null, einzelpreis: 8.50 },
      { name: 'Wandscheibe DN20', menge: 3, einheit: 'Stk.', artikelnummer: 'WS-12345', einzelpreis: 12.50 },
      { name: 'Lötfitting 18mm', menge: 8, einheit: 'Stk.', artikelnummer: 'LF-18', einzelpreis: 1.20 }
    ]
  };
  const feldwerte = matExp._internals.bauenFeldwerte ? matExp._internals.bauenFeldwerte(daten) : null;
  // Falls die Funktion nicht exportiert ist, manuell aufrufen
  const mapperAufruf = matExp._internals.mappeDatenAufFelder || ((f, d) => {
    // identische Logik, hier via manuellem Aufruf
    const map = {};
    for (const name of f) {
      if (name === 'projekt_nr') map[name] = d.projekt.nummer;
      else if (name === 'bauvorhaben') map[name] = d.projekt.bezeichnung;
      // ...
    }
    return map;
  });

  // Direkt die exportierte Funktion aus _internals nutzen
  const result = matExp._internals.mappeDatenAufFelder(felder, daten);
  console.log('Gesetzte Felder:', Object.keys(result).length);
  console.log('Beispiele:');
  ['projekt_nr', 'bauvorhaben', 'datum', 'pos_1', 'menge_1', 'me_1', 'artikelnr_1', 'bezeichnung_1', 'ep_1', 'gp_1',
   'pos_2', 'menge_2', 'me_2', 'artikelnr_2', 'bezeichnung_2', 'ep_2', 'gp_2',
   'pos_3', 'menge_3', 'me_3', 'artikelnr_3', 'bezeichnung_3', 'ep_3', 'gp_3'].forEach(f => {
    console.log('  ' + f + ' = ' + JSON.stringify(result[f]));
  });
  console.log();

  // 3) PDF befüllen und speichern
  console.log('=== 3) PDF befüllen + speichern ===');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const outputPfad = path.join(OUTPUT_DIR, 'test_ausgefuellt.pdf');
  await libPdfFiller.fuelleFelder(VORLAGE, result, outputPfad);
  const stat = fs.statSync(outputPfad);
  console.log('PDF gespeichert:', outputPfad, '(' + stat.size + ' Bytes)');
  console.log();

  // 4) Zur Verifikation: gespeichertes PDF nochmal laden und Felder lesen
  console.log('=== 4) Verifikation: gespeichertes PDF erneut laden ===');
  const { PDFDocument } = require('pdf-lib');
  const buffer = fs.readFileSync(outputPfad);
  const pdfDoc = await PDFDocument.load(buffer);
  const form = pdfDoc.getForm();
  const felderNachher = form.getFields();
  console.log('Felder im gespeicherten PDF: ' + felderNachher.length);
  // Zeige ein paar Werte
  for (const name of ['projekt_nr', 'bauvorhaben', 'datum', 'pos_1', 'menge_1', 'bezeichnung_1', 'gp_1', 'pos_3', 'gp_3']) {
    try {
      const f = form.getField(name);
      console.log('  ' + name + ' = ' + JSON.stringify(f.getText()));
    } catch (e) {
      console.log('  ' + name + ' = (FEHLER: ' + e.message + ')');
    }
  }
  console.log();

  // 5) Aufräumen
  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  console.log('Test-Verzeichnis entfernt.');
  console.log();
  console.log('=== FERTIG ===');
})().catch((e) => {
  console.error('FEHLER:', e);
  process.exit(1);
});
