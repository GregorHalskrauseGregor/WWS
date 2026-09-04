// Erzeugt Aufmaß-PDFs auf dem Zienert-Vordruck.
//
// Ein Aufmaß ist der Vordruck (ein 300-dpi-Bild) plus Formularfelder an
// gemessenen Stellen (lib/aufmass_layout.js). Beides wird hier zusammengesetzt.
//
// MEHRSEITIG: Passen die Positionen nicht auf 31 Zeilen, entstehen weitere
// Blätter. Die Zeilennummern laufen durch — Position 32 ist die erste Zeile auf
// Seite 2, damit "Pos. 47" im ganzen Aufmaß genau einmal vorkommt.
//
// GETEILTE FELDER: projekt_nr, bauvorhaben und datum sind je EIN Feld mit einem
// Sichtfenster auf jeder Seite. Im PDF-Formular teilen gleichnamige Felder ihren
// Wert — wer auf Seite 3 das Bauvorhaben korrigiert, korrigiert es überall.
// Genau das will man hier; bei den Seitenzahlen genau nicht, deshalb tragen die
// ihre Seitennummer im Namen.
//
// UNTERSCHRIFTEN sind keine Felder, sondern ein Bild. Ein Formularfeld an
// dieser Stelle ließe sich nachträglich beschreiben — bei einer Unterschrift
// ist das der eine Fall, in dem das nicht passieren darf.

const fs = require('fs');
const path = require('path');
const L = require('./aufmass_layout');
const pdfFiller = require('./pdf_filler');

const VORDRUCK = path.join(__dirname, '..', 'data', 'aufnahme_vorlage', 'Aufmass_Zienert_vordruck.pdf');

function text(wert) {
  if (wert === null || wert === undefined) return '';
  return String(wert);
}

// Setzt ein Textfeld an die angegebene Stelle. Ohne Hintergrund und ohne
// Rahmen — die farbigen Kästen der alten Vorlage waren beim Drucken sichtbar.
function setzeFeld(form, seiten, name, rect, { wert, groesse, ausrichtung } = {}) {
  const { rgb, TextAlignment } = require('pdf-lib');
  let feld;
  try { feld = form.getTextField(name); } catch { feld = form.createTextField(name); }
  for (const seite of [].concat(seiten)) {
    feld.addToPage(seite, {
      x: rect.x, y: rect.y, width: rect.breite, height: rect.hoehe,
      textColor: rgb(0.05, 0.12, 0.3),
      borderWidth: 0
    });
  }
  feld.setFontSize(groesse || L.SCHRIFT.normal);
  if (ausrichtung === 'rechts' && TextAlignment) feld.setAlignment(TextAlignment.Right);
  if (wert !== undefined && wert !== null && String(wert) !== '') feld.setText(String(wert));
  return feld;
}

// daten:
//   projektnummer, bauvorhaben, datum   — Kopf- und Fußangaben
//   positionen: [{ pos, menge, me, artikelnr, bezeichnung, ep, gp }]
//   unterschrift: Buffer (PNG oder JPG) — kommt auf die LETZTE Seite
async function erstelle(daten = {}, zielPfad, optionen = {}) {
  const { PDFDocument } = require('pdf-lib');
  const vordruckPfad = optionen.vordruck || VORDRUCK;
  if (!fs.existsSync(vordruckPfad)) {
    throw new Error(`Vordruck fehlt: ${vordruckPfad}`);
  }

  const doc = await PDFDocument.create();
  const [vordruck] = await doc.embedPdf(fs.readFileSync(vordruckPfad), [0]);
  const form = doc.getForm();

  const positionen = daten.positionen || [];
  const seitenZahl = L.seitenAnzahl(positionen.length);
  const seiten = [];

  for (let s = 0; s < seitenZahl; s++) {
    const seite = doc.addPage([L.SEITE.breite, L.SEITE.hoehe]);
    seite.drawPage(vordruck, { x: 0, y: 0, width: L.SEITE.breite, height: L.SEITE.hoehe });
    seiten.push(seite);
  }

  // Kopf: eine Angabe, auf allen Seiten sichtbar.
  const kopfFeld = (name, wert) => {
    const k = L.KOPF[name];
    setzeFeld(form, seiten, name,
      { x: k.x, y: k.linie + 1.6, breite: k.bis - k.x, hoehe: L.SCHRIFT.feldHoehe },
      { wert });
  };
  kopfFeld('projekt_nr', daten.projektnummer);
  kopfFeld('bauvorhaben', daten.bauvorhaben);

  setzeFeld(form, seiten, 'datum',
    { x: L.FUSS.datum.x, y: L.FUSS.linie + 1.6,
      breite: L.FUSS.datum.bis - L.FUSS.datum.x, hoehe: L.SCHRIFT.feldHoehe },
    { wert: daten.datum });

  // Seitenzahlen: je Seite ein eigenes Feld, sonst stünde überall dieselbe Zahl.
  for (let s = 0; s < seitenZahl; s++) {
    const nr = s + 1;
    for (const [name, wert] of [['seite', nr], ['seite_von', seitenZahl]]) {
      const k = L.KOPF[name];
      setzeFeld(form, seiten[s], `${name}_${nr}`,
        { x: k.x, y: k.linie + 1.6, breite: k.bis - k.x, hoehe: L.SCHRIFT.feldHoehe },
        { wert });
    }
  }

  // Tabelle: durchlaufende Zeilennummern über alle Seiten.
  for (let s = 0; s < seitenZahl; s++) {
    for (let z = 1; z <= L.TABELLE.zeilen; z++) {
      const laufend = s * L.TABELLE.zeilen + z;
      const eintrag = positionen[laufend - 1] || {};
      for (const spalte of L.SPALTEN) {
        const wert = spalte.feld === 'pos'
          ? (eintrag.pos !== undefined ? eintrag.pos : (positionen[laufend - 1] ? laufend : ''))
          : eintrag[spalte.feld];
        setzeFeld(form, seiten[s], `${spalte.feld}_${laufend}`, L.zelle(spalte.feld, z),
          { wert: text(wert), ausrichtung: spalte.ausrichtung });
      }
    }
  }

  // pdf-lib legt jedem neuen Feld einen WEISSEN Hintergrund unter (die
  // Voreinstellung von addToPage). Auf weissem Papier faellt das nicht auf —
  // aber es ist eine Flaeche, die den Vordruck darunter verdeckt, und beim
  // naechsten Vorlagenwechsel waere es wieder ein farbiger Kasten. Also weg
  // damit, mit derselben Funktion, die auch die alte Vorlage saeubert.
  pdfFiller.entferneFeldFlaechen(form);
  try { form.updateFieldAppearances(); } catch { /* Schrift fehlt: Felder bleiben leer sichtbar */ }

  // Unterschrift als Bild, nur auf der letzten Seite.
  if (daten.unterschrift) {
    await zeichneUnterschrift(doc, seiten[seitenZahl - 1], daten.unterschrift);
  }

  const bytes = await doc.save();
  fs.writeFileSync(zielPfad, bytes);
  return { pfad: zielPfad, seiten: seitenZahl, zeilenJeSeite: L.TABELLE.zeilen };
}

async function zeichneUnterschrift(doc, seite, buffer) {
  let bild;
  try { bild = await doc.embedPng(buffer); }
  catch { bild = await doc.embedJpg(buffer); }

  const feld = L.FUSS.unterschrift_monteur;
  const maxBreite = feld.bis - feld.x;
  const maxHoehe = feld.hoehe;
  // Seitenverhältnis behalten: eine verzerrte Unterschrift sieht gefälscht aus.
  const faktor = Math.min(maxBreite / bild.width, maxHoehe / bild.height);
  const breite = bild.width * faktor;
  const hoehe = bild.height * faktor;
  seite.drawImage(bild, {
    x: feld.x + (maxBreite - breite) / 2,
    y: L.FUSS.linie + 2,
    width: breite,
    height: hoehe
  });
}

// Das leere Muster: dasselbe Blatt, nur ohne Werte. Damit ist ausgeschlossen,
// dass Muster und erzeugtes Aufmaß auseinanderlaufen — es ist derselbe Code.
async function erstelleMuster(zielPfad, optionen = {}) {
  return erstelle({ positionen: [] }, zielPfad, optionen);
}

module.exports = { erstelle, erstelleMuster, VORDRUCK };
