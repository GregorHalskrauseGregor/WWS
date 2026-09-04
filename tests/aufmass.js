// Aufmaß-Layout und Mehrseitigkeit.
//
// Die Zahlen in lib/aufmass_layout.js sind am Vordruck gemessen. Dieser Test
// prüft, dass sie in sich stimmen und dass der Generator sie einhält — nicht,
// ob sie "schön" sind. Das entscheidet ein Blick aufs gerenderte Blatt.
//
// Braucht den Vordruck unter data/. Fehlt er (frischer Klon, leeres Volume),
// werden die Generator-Tests übersprungen statt rot zu werden: eine fehlende
// Bilddatei ist kein Programmfehler.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const L = require('../lib/aufmass_layout');
const aufmass = require('../lib/aufmass_pdf');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-aufmass-'));
const HAT_VORDRUCK = fs.existsSync(aufmass.VORDRUCK);

let ok = 0, fehler = 0, uebersprungen = 0;
async function pruefe(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) {
    if (e && e.ueberspringen) { console.log('  ⏭  ' + name + ' (kein Vordruck)'); uebersprungen++; return; }
    console.log('  ❌ ' + name + '\n     ' + e.message); fehler++;
  }
}
function brauchtVordruck() { if (!HAT_VORDRUCK) { const e = new Error('kein Vordruck'); e.ueberspringen = true; throw e; } }

(async () => {
  console.log('\n── Das Layout ist in sich stimmig ──');

  await pruefe('die Zeilen füllen die Tabelle genau aus', () => {
    // Wenn die letzte Zeile nicht auf der Unterkante endet, stimmt entweder die
    // Zeilenhöhe oder die Zeilenzahl nicht — und dann sitzt jede Zeile daneben.
    const untenBerechnet = L.zeileUnten(L.TABELLE.zeilen);
    const abweichung = Math.abs(untenBerechnet - L.TABELLE.unten);
    assert.ok(abweichung < 0.5,
      `letzte Zeile endet bei ${untenBerechnet.toFixed(2)}, Tabelle bei ${L.TABELLE.unten} (${abweichung.toFixed(2)} pt daneben)`);
  });

  await pruefe('die erste Zeile beginnt UNTER der Kopfzeile', () => {
    // Genau das war der Fehler der alten Vorlage: die erste Datenzeile saß auf
    // den Spaltenüberschriften und hat sie überschrieben.
    assert.ok(L.zeileOben(1) <= L.TABELLE.kopfzeileBis,
      `Zeile 1 beginnt bei ${L.zeileOben(1)}, Kopfzeile endet erst bei ${L.TABELLE.kopfzeileBis}`);
  });

  await pruefe('jede Zelle bleibt in ihrer Spalte', () => {
    for (const s of L.SPALTEN) {
      const z = L.zelle(s.feld, 1);
      assert.ok(z.x >= L.SPALTEN_X[s.von], `${s.feld} ragt links raus`);
      assert.ok(z.x + z.breite <= L.SPALTEN_X[s.von + 1], `${s.feld} ragt rechts raus`);
      assert.ok(z.breite > 15, `${s.feld} ist nur ${z.breite.toFixed(1)} pt breit`);
    }
  });

  await pruefe('jede Zelle bleibt in ihrer Zeile', () => {
    for (const n of [1, 2, L.TABELLE.zeilen]) {
      const z = L.zelle('bezeichnung', n);
      assert.ok(z.y >= L.zeileUnten(n) - 0.01, `Zeile ${n} rutscht nach unten raus`);
      assert.ok(z.y + z.hoehe <= L.zeileOben(n) + 0.01, `Zeile ${n} ragt in die Zeile darüber`);
    }
  });

  await pruefe('Kopffelder liegen rechts ihrer Beschriftung', () => {
    // Der zweite Fehler der alten Vorlage: die Felder lagen ÜBER den
    // Beschriftungen und haben "Seite:" und "von:" verdeckt.
    assert.ok(L.KOPF.seite.bis <= L.KOPF.seite_von.x, 'Seite und von überlappen sich');
    for (const [name, k] of Object.entries(L.KOPF)) {
      assert.ok(k.bis > k.x, `${name} hat keine Breite`);
      assert.ok(k.bis <= L.SEITE.breite - 40, `${name} ragt in den Rand`);
    }
  });

  await pruefe('die Seitenrechnung stimmt an den Rändern', () => {
    const z = L.TABELLE.zeilen;
    assert.equal(L.seitenAnzahl(0), 1, 'ein leeres Aufmaß ist trotzdem ein Blatt');
    assert.equal(L.seitenAnzahl(1), 1);
    assert.equal(L.seitenAnzahl(z), 1, 'genau volle Seite darf keine zweite anfangen');
    assert.equal(L.seitenAnzahl(z + 1), 2);
    assert.equal(L.seitenAnzahl(z * 3), 3);
  });

  console.log('\n── Der Generator hält sich daran ──');

  await pruefe('ein leeres Muster hat eine Seite und keine Werte', async () => {
    brauchtVordruck();
    const ziel = path.join(TMP, 'muster.pdf');
    const r = await aufmass.erstelleMuster(ziel);
    assert.equal(r.seiten, 1);
    const { leseFeldWerte } = require('../lib/pdf_filler');
    const g = await leseFeldWerte(ziel);
    const gefuellt = g.ausgefuellt.filter((a) => !/^seite/.test(a.name));
    assert.equal(gefuellt.length, 0, `Muster enthält Werte: ${gefuellt.map((x) => x.name).join(', ')}`);
  });

  await pruefe('mehr Positionen als Zeilen ergeben mehr Blätter', async () => {
    brauchtVordruck();
    const pos = Array.from({ length: L.TABELLE.zeilen + 5 },
      (_, i) => ({ menge: i + 1, me: 'Stk.', bezeichnung: 'Kugelhahn DN25' }));
    const ziel = path.join(TMP, 'zwei.pdf');
    const r = await aufmass.erstelle({ projektnummer: '26-0111', positionen: pos }, ziel);
    assert.equal(r.seiten, 2);
  });

  await pruefe('die Seitenzahlen werden eingetragen', async () => {
    brauchtVordruck();
    const { leseFeldWerte } = require('../lib/pdf_filler');
    const g = await leseFeldWerte(path.join(TMP, 'zwei.pdf'));
    const w = Object.fromEntries(g.ausgefuellt.map((a) => [a.name, a.wert]));
    assert.equal(w.seite_1, '1');
    assert.equal(w.seite_von_1, '2');
    assert.equal(w.seite_2, '2');
    assert.equal(w.seite_von_2, '2');
  });

  await pruefe('die Positionsnummern laufen über die Seiten durch', async () => {
    brauchtVordruck();
    const { leseFeldWerte } = require('../lib/pdf_filler');
    const g = await leseFeldWerte(path.join(TMP, 'zwei.pdf'));
    const w = Object.fromEntries(g.ausgefuellt.map((a) => [a.name, a.wert]));
    // Zeile 32 ist die erste auf Seite 2 und muss "32" heißen, nicht "1".
    assert.equal(w[`pos_${L.TABELLE.zeilen + 1}`], String(L.TABELLE.zeilen + 1));
  });

  await pruefe('Projektnummer steht auf jedem Blatt', async () => {
    brauchtVordruck();
    const { PDFDocument } = require('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(path.join(TMP, 'zwei.pdf')));
    const feld = doc.getForm().getField('projekt_nr');
    assert.equal(feld.acroField.getWidgets().length, 2,
      'die Projektnummer ist nicht auf beiden Seiten sichtbar');
  });

  await pruefe('es gibt KEIN Feld für die Unterschriften', async () => {
    brauchtVordruck();
    const { ladeFeldNamen } = require('../lib/pdf_filler');
    const namen = await ladeFeldNamen(path.join(TMP, 'zwei.pdf'));
    const treffer = namen.filter((n) => /unterschrift|signat/i.test(n));
    assert.equal(treffer.length, 0,
      `Unterschriftsfeld vorhanden: ${treffer.join(', ')} — dort gehört ein Bild hin, ` +
      'und ein Feld ließe sich nachträglich beschreiben');
  });

  await pruefe('kein Feld trägt einen farbigen Hintergrund', async () => {
    brauchtVordruck();
    const { PDFDocument, PDFName } = require('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(path.join(TMP, 'zwei.pdf')));
    let mitBG = 0;
    for (const f of doc.getForm().getFields()) {
      for (const w of f.acroField.getWidgets()) {
        const mk = w.dict.lookup(PDFName.of('MK'));
        if (mk && typeof mk.has === 'function' && mk.has(PDFName.of('BG'))) mitBG++;
      }
    }
    assert.equal(mitBG, 0, `${mitBG} Felder haben wieder einen Kasten`);
  });

  const summe = ok + fehler + uebersprungen;
  console.log(`\n${'─'.repeat(46)}`);
  console.log(`Aufmaß: ${ok} bestanden, ${fehler} fehlgeschlagen` +
    (uebersprungen ? `, ${uebersprungen} übersprungen (kein Vordruck unter data/)` : ''));
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fehler > 0 ? 1 : 0);
})().catch((e) => { console.error('Aufmaß-Test abgestürzt:', e); process.exit(1); });
