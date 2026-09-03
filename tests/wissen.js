// Wissensbasis: Übersetzung von Umgangssprache, Maßsystemen und Gebinden.
// Alles hier hat eine richtige Antwort und läuft deshalb ohne KI.

const assert = require('assert');
const os = require('os'), path = require('path'), fs = require('fs');
const wissen = require('../lib/wissen');

let ok = 0, fehler = 0;
const pruefe = (name, fn) => {
  try { fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
};

console.log('\n── Dateien laden ──');
pruefe('alle Wissens-Dateien sind lesbar', () => {
  const w = wissen.lade();
  for (const d of wissen.DATEIEN) assert(w[d], `${d}.yaml fehlt oder ist leer`);
});
pruefe('Artikelklassen vollständig deklariert', () => {
  for (const name of wissen.alleKlassen()) {
    const k = wissen.klasse(name);
    assert(Array.isArray(k.identitaet), `${name}: identitaet fehlt`);
    assert(k.warengruppe, `${name}: warengruppe fehlt`);
    assert(wissen.warengruppe(k.warengruppe), `${name}: warengruppe "${k.warengruppe}" gibt es im Baum nicht`);
  }
});
pruefe('jede Pflichtangabe hat eine Rückfrage', () => {
  for (const name of wissen.alleKlassen()) {
    if (name === 'sonstiges') continue;
    const r = wissen.fehlendePflicht(name, {});
    for (const feld of [...r.fehlt, ...r.offen]) {
      assert(r.fragen[feld] && r.fragen[feld].length > 10,
        `${name}: "${feld}" wird erfragt, aber ohne brauchbaren Text`);
    }
  }
});

console.log('\n── Artikelart erkennen ──');
pruefe('längster Treffer gewinnt', () => {
  assert.equal(wissen.klasseFuer('T-Stück DN20 Kupfer'), 't_stueck');
  assert.equal(wissen.klasseFuer('Schwarzrohr Stange'), 'rohr');
  assert.equal(wissen.klasseFuer('Kugelhahn 1/2 Zoll'), 'kugelhahn');
  assert.equal(wissen.klasseFuer('Umwälzpumpe Magna3'), 'pumpe');
});
pruefe('Unbekanntes fällt auf sonstiges', () => {
  assert.equal(wissen.klasseFuer('Kaffeemaschine'), 'sonstiges');
});

console.log('\n── Umgangssprache ──');
pruefe('"schwarz" heißt nur beim Rohr Stahl', () => {
  assert.equal(wissen.synonym('schwarz', 'rohr').wert, 'stahl');
  assert.equal(wissen.synonym('schwarz', 'kabel'), null, 'Geltungsbereich ignoriert');
});
pruefe('"Messing" wird zu Rotguss', () => {
  assert.equal(wissen.synonym('messing', 'muffe').wert, 'rotguss');
});
pruefe('Material in Zusammensetzungen', () => {
  assert.equal(wissen.materialErkennen('Kupferrohr 22mm', 'rohr'), 'kupfer');
  assert.equal(wissen.materialErkennen('Schwarzrohr DN50', 'rohr'), 'stahl');
  assert.equal(wissen.materialErkennen('Verbundrohr 16x2', 'rohr'), 'verbundrohr');
});
pruefe('längeres Material schlägt kürzeres', () => {
  assert.equal(wissen.materialErkennen('Edelstahlrohr 28', 'rohr'), 'edelstahl',
    '"stahl" hat "edelstahl" verdrängt');
});

console.log('\n── Maßsysteme ──');
pruefe('Zoll wird zu DN', () => {
  assert.equal(wissen.dimension('halb zoll').dn, 15);
  assert.equal(wissen.dimension('1/2').dn, 15);
  assert.equal(wissen.dimension('dreiviertel').dn, 20);
});
pruefe('DN bleibt DN und kennt sein Zoll', () => {
  const d = wissen.dimension('DN 25');
  assert.equal(d.dn, 25);
  assert.equal(d.zoll, '1');
});
pruefe('Kupfer wird als Außendurchmesser gelesen, nicht als DN', () => {
  const d = wissen.dimension('22', 'kupfer');
  assert.equal(d.ad, 22);
  assert.equal(d.tabelle, 'kupfer');
  assert.notEqual(d.dn, 22, 'Kupfer 22 als DN22 gelesen');
});
pruefe('unbekanntes Maß liefert kein erfundenes DN', () => {
  assert.equal(wissen.dimension('irgendwas').dn, null);
});

console.log('\n── Gebinde ──');
pruefe('eine Stange Stahlrohr sind 6 Meter', () => {
  const g = wissen.gebinde(1, 'Stange', 'rohr', 'stahl');
  assert.equal(g.menge, 6);
  assert.equal(g.einheit, 'm');
  assert.equal(g.umgerechnet, true);
});
pruefe('eine Stange Kupfer sind 5 Meter', () => {
  assert.equal(wissen.gebinde(1, 'Stange', 'rohr', 'kupfer').menge, 5,
    'materialabhängige Abweichung ignoriert');
});
pruefe('eine Rolle Verbundrohr sind 50 Meter', () => {
  assert.equal(wissen.gebinde(1, 'Rolle', 'rohr', 'verbundrohr').menge, 50);
});
pruefe('Gebinde greift nur bei der passenden Artikelart', () => {
  const g = wissen.gebinde(1, 'Stange', 'kugelhahn', null);
  assert.equal(g.umgerechnet, false, 'Kugelhahn in Stangen umgerechnet');
});
pruefe('Schreibweisen der Einheit werden vereinheitlicht', () => {
  assert.equal(wissen.einheitNormalisieren('stk'), 'Stk.');
  assert.equal(wissen.einheitNormalisieren('lfm'), 'm');
  assert.equal(wissen.einheitNormalisieren('Stück'), 'Stk.');
});

console.log('\n── Zulassungen ──');
pruefe('höhere Zulassung erfüllt niedrigeren Bedarf', () => {
  assert.equal(wissen.zulassungErfuellt('gas', 'heizung'), true);
  assert.equal(wissen.zulassungErfuellt('trinkwasser', 'heizung'), true);
});
pruefe('niedrigere erfüllt höheren Bedarf NICHT', () => {
  assert.equal(wissen.zulassungErfuellt('heizung', 'gas'), false);
  assert.equal(wissen.zulassungErfuellt('heizung', 'trinkwasser'), false);
});
pruefe('Zulassung aus dem Text erkennen', () => {
  assert.equal(wissen.zulassungErkennen('Kugelhahn DVGW Trinkwasser'), 'trinkwasser');
  assert.equal(wissen.zulassungErkennen('Gaskugelhahn G260'), 'gas');
  assert.equal(wissen.zulassungErkennen('Kugelhahn ohne alles'), null);
});

console.log('\n── Regeln je Artikelklasse ──');
pruefe('T-Stück: eine Dimension heißt alle drei gleich', () => {
  const r = wissen.regelnAnwenden('t_stueck', { dn1: 20 });
  assert.equal(r.merkmale.dn2, 20);
  assert.equal(r.merkmale.dn3, 20);
});
pruefe('reduziertes T-Stück behält seine Abweichung', () => {
  const r = wissen.regelnAnwenden('t_stueck', { dn1: 32, dn2: 20 });
  assert.equal(r.merkmale.dn2, 20, 'ausdrückliche Angabe überschrieben');
  assert.equal(r.merkmale.dn3, 32);
});
pruefe('Bogen ist ohne Angabe 90 Grad', () => {
  assert.equal(wissen.regelnAnwenden('bogen', { dimension: 22 }).merkmale.winkel, '90');
});
pruefe('Pressfitting ohne Kontur löst eine Rückfrage aus', () => {
  const r = wissen.regelnAnwenden('bogen', { dimension: 22, verbindung: 'pressen' });
  assert(r.nachfragen.includes('kontur'), 'Kontur wird nicht erfragt');
});

console.log('\n── Pflichtangaben ──');
pruefe('T-Stück DN20 gilt als vollständig', () => {
  const r = wissen.fehlendePflicht('t_stueck', { dn1: 20, material: 'kupfer', verbindung: 'pressen' });
  assert.deepEqual(r.fehlt, [], 'fragt nach dn2/dn3, obwohl die Regel sie setzt');
});
pruefe('Rohr ohne Länge ist unvollständig', () => {
  const r = wissen.fehlendePflicht('rohr', { material: 'stahl', dimension: 'DN50' });
  assert.deepEqual(r.fehlt, ['laenge']);
  assert.match(r.fragen.laenge, /lang/i);
});
pruefe('Kugelhahn ohne Zulassung blockiert', () => {
  const r = wissen.fehlendePflicht('kugelhahn', { dimension: 'DN15' });
  assert(r.fehlt.includes('zulassung'), 'Zulassung nicht als Pflicht erkannt');
  assert.match(r.fragen.zulassung, /Heizung|Trinkwasser|Gas/);
});
pruefe('Pressbogen ohne Kontur blockiert (Sicherheit)', () => {
  const r = wissen.fehlendePflicht('bogen', { dimension: 22, material: 'kupfer', verbindung: 'pressen' });
  assert(r.fehlt.includes('kontur'), 'Kontur wird nur erfragt, nicht verlangt');
});
pruefe('erwartet blockiert nicht', () => {
  const r = wissen.fehlendePflicht('rohr', { material: 'stahl', dimension: 'DN50', laenge: 6 });
  assert.deepEqual(r.fehlt, [], 'blockiert trotz vollständiger Pflichtangaben');
  assert(r.offen.includes('wandstaerke'), 'erwartetes Merkmal fehlt in offen');
});

console.log('\n── Warengruppen-Baum ──');
pruefe('zwölf Oberkategorien, aus dem Baum abgeleitet', () => {
  assert.equal(wissen.oberkategorien().length, 12);
  const { KATEGORIEN } = require('../kategorien');
  assert.deepEqual(KATEGORIEN, wissen.oberkategorien(), 'kategorien.js weicht vom Baum ab');
});
pruefe('Abfrage auf jeder Ebene', () => {
  assert.deepEqual(wissen.klassenUnter('armaturen'), ['kugelhahn']);
  const fittinge = wissen.klassenUnter('fittinge').sort();
  assert.deepEqual(fittinge, ['bogen', 'muffe', 'reduktion', 't_stueck']);
  assert.deepEqual(wissen.klassenUnter('fittinge.verbinder'), ['muffe']);
});
pruefe('Pfad einer Artikelart', () => {
  assert.deepEqual(wissen.pfadVon('kugelhahn'), ['Armaturen & Ventile', 'Absperrarmaturen']);
  assert.equal(wissen.kategorieVon('kugelhahn'), 'Armaturen & Ventile');
});
pruefe('Gewerk ist mehrwertig und steht NICHT im Baum', () => {
  // Ein Kugelhahn gehört je nach Zulassung zu mehreren Gewerken — ein Baum
  // kann das nicht abbilden, deshalb ist einsatzbereiche ein eigenes Merkmal.
  const heizung = wissen.klassenFuerEinsatzbereich('heizung');
  assert(heizung.includes('kugelhahn'), 'Kugelhahn fehlt bei Heizung');
  assert(heizung.includes('rohr'));
  assert(wissen.klassenFuerEinsatzbereich('gas').includes('kugelhahn'));
  assert(!wissen.klassenFuerEinsatzbereich('gas').includes('pumpe'));
});

console.log('\n── Merkmalsstufen ──');
pruefe('globale Pflichtmerkmale werden vererbt', () => {
  const m = wissen.merkmaleFuer('rohr');
  assert(m.pflicht.includes('dimension'), 'dimension nicht geerbt');
  assert(m.pflicht.includes('material'), 'material nicht geerbt');
});
pruefe('Anwendbarkeit: Pumpe hat keine Dimension, sondern eine Baulänge', () => {
  const m = wissen.merkmaleFuer('pumpe');
  assert(!m.pflicht.includes('dimension'), 'Pumpe wird nach Dimension gefragt');
  assert(m.pflicht.includes('baulaenge'), 'Ersatzmerkmal greift nicht');
  const a = wissen.merkmalAnwendbar('dimension', 'pumpe');
  assert.equal(a.feld, 'baulaenge');
});
pruefe('Klasse darf ein globales Pflichtmerkmal herabstufen', () => {
  // Beim Kugelhahn trennt die Zulassung, nicht das Material.
  const m = wissen.merkmaleFuer('kugelhahn');
  assert(m.optional.includes('material'), 'material blockiert beim Kugelhahn');
  assert(m.pflicht.includes('zulassung'), 'zulassung nicht auf Pflicht gehoben');
});
pruefe('T-Stück: Dimension heißt dn1', () => {
  assert.equal(wissen.merkmalAnwendbar('dimension', 't_stueck').feld, 'dn1');
  assert(wissen.merkmaleFuer('t_stueck').pflicht.includes('dn1'));
});

console.log('\n── Lernende Attributerwartung ──');
pruefe('erstmals genannte Merkmale werden zur Anhebung vorgeschlagen', () => {
  const vor = wissen.pruefeAnhebung('kugelhahn',
    { dimension: 'DN20', zulassung: 'heizung', marke: 'Bonfix', artnr: 'BX-1120' });
  const felder = vor.map((v) => v.feld).sort();
  assert.deepEqual(felder, ['artnr', 'marke'], 'Vorschlag stimmt nicht: ' + JSON.stringify(vor));
  assert(vor.every((v) => v.nach === 'erwartet'), 'Gelerntes darf nicht sofort Pflicht werden');
});
pruefe('bereits erwartete Merkmale lösen keinen Vorschlag aus', () => {
  const vor = wissen.pruefeAnhebung('kugelhahn', { dimension: 'DN20', zulassung: 'gas', anschluss: 'ig/ig' });
  assert.deepEqual(vor, [], 'schlägt Bekanntes erneut vor');
});
pruefe('völlig neues Merkmal wird erkannt', () => {
  // medium (Wasser/Luft/Gas/Öl) steht in keinem Schema — wenn der Bot es sieht,
  // schlägt er es als neues Attribut für kugelhahn vor.
  const vor = wissen.pruefeAnhebung('kugelhahn', { medium: 'wasser' });
  assert.equal(vor[0].feld, 'medium');
  assert.equal(vor[0].von, 'unbekannt');
});
pruefe('bestätigte Anhebung wirkt sofort', () => {
  const echt = path.join(wissen.ORDNER, 'gelernt.yaml');
  const sicherung = fs.readFileSync(echt, 'utf-8');
  try {
    wissen.lerne({ art: 'attribut', klasse: 'kugelhahn', merkmal: 'marke',
      stufe: 'erwartet', bestaetigt_von: '999' });
    assert(wissen.merkmaleFuer('kugelhahn').erwartet.includes('marke'),
      'gelerntes Merkmal wird nicht erwartet');
    assert.deepEqual(wissen.pruefeAnhebung('kugelhahn', { marke: 'Bonfix' }), [],
      'schlägt weiter vor, obwohl schon gelernt');
  } finally {
    fs.writeFileSync(echt, sicherung, 'utf-8');
    wissen.neuLaden();
  }
});

console.log('\n── Kontext für die KI ──');
pruefe('kompakt und vollständig', () => {
  const k = wissen.promptKontext();
  assert(k.includes('ARTIKELARTEN'));
  assert(k.includes('messing=rotguss'));
  assert(k.includes('1 stange = 6 m'));
  // Mit Umgangssprache-Tabelle und Hinweistext wird der Kontext groesser.
  // Wird nur fuer Lager-/Vorgangs-Extraktion aufgerufen, kein Chat-Prompt.
  assert(k.length < 6000, 'Kontext zu lang: ' + k.length + ' Zeichen');
});
pruefe('Umgangssprache ist im KI-Kontext', () => {
  const k = wissen.promptKontext();
  assert(k.includes('HANDWERKER-UMGANGSSPRACHE'), 'Strukturblock fehlt');
  assert(k.includes('HINWEISE ZUR INTERPRETATION'), 'Hinweistext fehlt');
  assert(k.includes('Schwarzrohr'), 'Standard-Synonym fehlt');
  assert(k.includes('BEE KSL'), 'Marken-Synonym fehlt');
});

console.log('\n── Umgangssprache: Code-Helfer ──');
pruefe('Synonym-Liste ist geladen', () => {
  const liste = wissen.umgangsspracheSynonyme();
  assert(liste.length > 10, 'zu wenig Einträge: ' + liste.length);
  assert(liste.some((s) => s.von === 'Schwarzrohr' && s.nach === 'Stahlrohr'));
  assert(liste.some((s) => s.von === 'BEE' && s.nach === 'Kugelhahn BEE'));
  assert(liste.some((s) => s.von === 'Prestabo' && s.nach === 'Pressfitting C-Stahl'));
});
pruefe('Hinweistext ist geladen', () => {
  const h = wissen.umgangsspracheHinweis();
  assert(h.length > 50, 'zu kurz: ' + h.length);
  assert(h.toLowerCase().includes('v2a'), 'V2A-Hinweis fehlt');
});
pruefe('Synonym wird im Text ersetzt (case-insensitive, Wortgrenze)', () => {
  assert.equal(wissen.wendeUmgangsspracheAn('Schwarzrohr DN50'), 'Stahlrohr DN50');
  assert.equal(wissen.wendeUmgangsspracheAn('schwarzes Rohr 22mm'), 'Stahlrohr 22mm');
  assert.equal(wissen.wendeUmgangsspracheAn('SCHWARZROHR 1 ZOLL'), 'Stahlrohr 1 ZOLL');
});
pruefe('Wortgrenzen verhindern Teiltreffer', () => {
  // "Cu" darf NICHT in "Cupfer" oder "Cur" ersetzt werden
  // (regex \\b verhindert das — "Cu" muss eigene Wortgrenze haben)
  assert.equal(wissen.wendeUmgangsspracheAn('Cur Rohr'), 'Cur Rohr',
    '"Cu" darf nicht in "Cur" matchen');
  // "Ms" darf nicht in "Mist" matchen
  assert.equal(wissen.wendeUmgangsspracheAn('Mist'), 'Mist');
  // "HT" muss eigenständiges Wort sein, "Hitze" bleibt
  assert.equal(wissen.wendeUmgangsspracheAn('Hitze'), 'Hitze');
});
pruefe('mehrere Synonyme hintereinander', () => {
  assert.equal(wissen.wendeUmgangsspracheAn('Prestabo V2A 22mm'),
    'Pressfitting C-Stahl Edelstahl 1.4301 22mm');
});

console.log('\n── Dazulernen ──');
pruefe('Eintrag landet mit Datum in gelernt.yaml', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wissen-'));
  const echt = path.join(wissen.ORDNER, 'gelernt.yaml');
  const sicherung = fs.readFileSync(echt, 'utf-8');
  try {
    const anzahl = wissen.lerne({ art: 'synonym', von: 'testbegriff_xyz', nach: 'testwert',
      bestaetigt_von: '999' });
    assert(anzahl >= 1);
    const jetzt = wissen.gelernte();
    const neu = jetzt.find((e) => e.von === 'testbegriff_xyz');
    assert(neu, 'Eintrag fehlt');
    assert.match(neu.am, /^\d{4}-\d{2}-\d{2}$/, 'kein Datum');
    assert.equal(wissen.synonym('testbegriff_xyz').wert, 'testwert', 'Gelerntes wird nicht genutzt');
    assert(fs.readFileSync(echt, 'utf-8').startsWith('#'), 'Kommentarkopf ging verloren');
  } finally {
    fs.writeFileSync(echt, sicherung, 'utf-8');
    wissen.neuLaden();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
pruefe('nach dem Zurücksetzen ist der Testeintrag weg', () => {
  assert.equal(wissen.synonym('testbegriff_xyz'), null);
});

console.log(`\n${'─'.repeat(46)}\nWissen: ${ok} bestanden, ${fehler} fehlgeschlagen\n`);
process.exit(fehler > 0 ? 1 : 0);
