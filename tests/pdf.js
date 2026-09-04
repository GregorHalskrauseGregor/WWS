// PDF-Formulare: die farbigen Feldflächen müssen weg.
//
// Der Test baut sein eigenes Formular, statt die Zienert-Vorlage zu benutzen —
// die liegt unter data/ und ist damit nicht im Repo. Ein Test, der eine Datei
// braucht, die auf einem anderen Rechner fehlt, ist kein Test.
//
// Geprüft wird beides, was das Blau erzeugt: die Anweisung im Widget (MK/BG)
// UND der fertige Erscheinungsstrom, in dem der Malbefehl schon drinsteht.
// Nur das erste zu entfernen genügt nicht, und genau das war die Falle.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-pdf-'));
const filler = require('../lib/pdf_filler');

let ok = 0, fehler = 0;
async function pruefe(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
}

// Baut ein Formular mit demselben Fehler wie die Vorlage: hellblauer
// Feldhintergrund, in MK und im Erscheinungsstrom.
async function baueBlauesFormular(ziel) {
  const { PDFDocument, rgb } = require('pdf-lib');
  const doc = await PDFDocument.create();
  const seite = doc.addPage([595, 842]);
  const form = doc.getForm();

  for (const name of ['projekt_nr', 'bauvorhaben', 'pos_1', 'menge_1']) {
    const feld = form.createTextField(name);
    feld.addToPage(seite, {
      x: 60, y: 700 - 30 * form.getFields().length, width: 200, height: 18,
      backgroundColor: rgb(0.8, 0.843, 1),
      borderColor: rgb(0.4, 0.5, 0.8),
      borderWidth: 1
    });
  }
  // Ein Feld vorbelegen: sein Erscheinungsstrom entsteht damit sofort — genau
  // wie in der echten Vorlage, in der schon Werte standen.
  form.getTextField('projekt_nr').setText('26-0111');

  fs.writeFileSync(ziel, await doc.save());
  return ziel;
}

// Liest einen Erscheinungsstrom als Text — auch wenn er gepackt ist.
// pdf-lib packt beim Speichern; die Zienert-Vorlage lag zufällig ungepackt vor.
// Ein Test, der nur den ungepackten Fall kann, prüft am Ernstfall vorbei.
function stromText(stream) {
  const { PDFName } = require('pdf-lib');
  if (!stream) return '';
  let rohe;
  try { rohe = Buffer.from(stream.getContents()); } catch { return ''; }
  const filter = stream.dict && stream.dict.lookup(PDFName.of('Filter'));
  const name = filter ? String(filter) : '';
  if (/FlateDecode/.test(name)) {
    try { return require('zlib').inflateSync(rohe).toString('latin1'); }
    catch { return rohe.toString('latin1'); }
  }
  return rohe.toString('latin1');
}

// Malt dieser Erscheinungsstrom eine Fläche oder einen Rahmen?
//
// Nicht über die Farbwerte geprüft, sondern über die Struktur: alles VOR dem
// Marker "/Tx BMC" ist die Verzierung des Feldes — Hintergrund und Rahmen.
// Was danach kommt, ist der Text und darf Farbe haben. So greift die Prüfung
// unabhängig davon, ob ein Erzeuger die Fläche als Rechteck ("re ... f") oder
// als Pfad ("m ... l ... h ... B") schreibt. Genau daran ist die erste Fassung
// dieses Tests vorbeigelaufen.
function maltFlaeche(inhalt) {
  if (!inhalt) return false;
  const marker = inhalt.indexOf('/Tx BMC');
  const verzierung = marker >= 0 ? inhalt.slice(0, marker) : inhalt;
  const setztFarbe = /(^|\s)(rg|RG|g|G|k|K)(\s|$)/.test(verzierung);
  const maltAus = /(^|\s)(f|f\*|B|B\*|S)(\s|$)/.test(verzierung);
  return setztFarbe && maltAus;
}

// Zählt, wo überall noch Farbe steckt.
async function farbBefund(pfad) {
  const { PDFDocument, PDFName } = require('pdf-lib');
  const doc = await PDFDocument.load(fs.readFileSync(pfad));
  const felder = doc.getForm().getFields();
  let mkBG = 0, mkBC = 0, stromMitFlaeche = 0, ohneAP = 0;

  for (const f of felder) {
    for (const w of f.acroField.getWidgets()) {
      const mk = w.dict.lookup(PDFName.of('MK'));
      if (mk && typeof mk.has === 'function') {
        if (mk.has(PDFName.of('BG'))) mkBG++;
        if (mk.has(PDFName.of('BC'))) mkBC++;
      }
      const ap = w.dict.lookup(PDFName.of('AP'));
      if (!ap) { ohneAP++; continue; }
      if (maltFlaeche(stromText(ap.lookup(PDFName.of('N'))))) stromMitFlaeche++;
    }
  }
  return { felder: felder.length, mkBG, mkBC, stromMitFlaeche, ohneAP };
}

(async () => {
  const quelle = await baueBlauesFormular(path.join(TMP, 'vorlage.pdf'));

  console.log('\n── Ausgangslage: das Formular ist wirklich blau ──');

  await pruefe('die Vorlage trägt Hintergrund in MK und im Strom', async () => {
    const b = await farbBefund(quelle);
    assert.equal(b.felder, 4);
    assert.equal(b.mkBG, 4, 'kein MK.BG in der Testvorlage — der Test prüft nichts');
    assert.ok(b.stromMitFlaeche > 0, 'kein gefüllter Erscheinungsstrom — der Test prüft nichts');
  });

  console.log('\n── Nach dem Füllen ist die Farbe weg ──');

  const ziel = path.join(TMP, 'gefuellt.pdf');
  await filler.fuelleFelder(quelle, { bauvorhaben: 'Badsanierung Müller', pos_1: '1' }, ziel);

  await pruefe('kein MK.BG und kein MK.BC mehr', async () => {
    const b = await farbBefund(ziel);
    assert.equal(b.mkBG, 0, `${b.mkBG} Felder haben noch einen Hintergrund`);
    assert.equal(b.mkBC, 0, `${b.mkBC} Felder haben noch einen Rahmen`);
  });

  await pruefe('auch die Erscheinungsströme malen keine Fläche mehr', async () => {
    // Das ist der Punkt, an dem der naheliegende Fix scheitert: MK zu löschen
    // ändert nichts an einem Strom, der schon gezeichnet ist.
    const b = await farbBefund(ziel);
    assert.equal(b.stromMitFlaeche, 0, `${b.stromMitFlaeche} Ströme malen noch eine Fläche`);
  });

  await pruefe('auch NICHT ausgefüllte Felder verlieren ihren Kasten', async () => {
    // Der eigentliche Stolperstein: pdf-lib zeichnet nur veränderte Felder neu.
    // menge_1 wurde nie gesetzt und müsste ohne Zutun blau bleiben.
    const { PDFDocument, PDFName } = require('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(ziel));
    const w = doc.getForm().getField('menge_1').acroField.getWidgets()[0];
    const mk = w.dict.lookup(PDFName.of('MK'));
    assert.ok(!mk || !mk.has(PDFName.of('BG')), 'ein leeres Feld ist noch blau');
    const ap = w.dict.lookup(PDFName.of('AP'));
    assert.ok(!maltFlaeche(ap ? stromText(ap.lookup(PDFName.of('N'))) : ''),
      'der Strom eines leeren Feldes malt noch eine Fläche');
  });

  console.log('\n── Und die Werte stehen trotzdem drin ──');

  await pruefe('gesetzte Werte sind lesbar', async () => {
    const g = await filler.leseFeldWerte(ziel);
    const werte = Object.fromEntries(g.ausgefuellt.map((a) => [a.name, a.wert]));
    assert.equal(werte.bauvorhaben, 'Badsanierung Müller');
    assert.equal(werte.pos_1, '1');
  });

  await pruefe('vorbelegte Werte der Vorlage bleiben erhalten', async () => {
    const g = await filler.leseFeldWerte(ziel);
    const werte = Object.fromEntries(g.ausgefuellt.map((a) => [a.name, a.wert]));
    assert.equal(werte.projekt_nr, '26-0111', 'ein vorbelegter Wert ging verloren');
  });

  await pruefe('die Felder bleiben Formularfelder', async () => {
    // Sonst wäre das PDF flachgemacht und niemand könnte mehr nachtragen.
    const namen = await filler.ladeFeldNamen(ziel);
    assert.equal(namen.length, 4, 'Felder sind verschwunden');
  });

  console.log('\n── Abschaltbar, falls das PDF als Formular weiterlebt ──');

  await pruefe('mit hintergruendeEntfernen:false bleiben die Kästen', async () => {
    const zielB = path.join(TMP, 'mit_kaesten.pdf');
    await filler.fuelleFelder(quelle, { pos_1: '1' }, zielB, { hintergruendeEntfernen: false });
    const b = await farbBefund(zielB);
    assert.ok(b.mkBG > 0, 'die Kästen wurden trotz false entfernt');
  });

  console.log(`\n${'─'.repeat(46)}\nPDF: ${ok} bestanden, ${fehler} fehlgeschlagen\n`);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fehler > 0 ? 1 : 0);
})().catch((e) => { console.error('PDF-Test abgestürzt:', e); process.exit(1); });
