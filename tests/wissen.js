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
pruefe('alle sechs Dateien sind lesbar', () => {
  const w = wissen.lade();
  for (const d of wissen.DATEIEN) assert(w[d], `${d}.yaml fehlt oder ist leer`);
});
pruefe('Artikelklassen vollständig deklariert', () => {
  for (const name of wissen.alleKlassen()) {
    const k = wissen.klasse(name);
    assert(Array.isArray(k.identitaet), `${name}: identitaet fehlt`);
    assert(Array.isArray(k.pflicht), `${name}: pflicht fehlt`);
    for (const feld of k.pflicht) {
      if (name === 'sonstiges') continue;
      assert(k.frage && k.frage[feld] || k.identitaet.includes(feld) || k.optional,
        `${name}: Pflichtfeld ${feld} ohne Rückfrage`);
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
pruefe('Kugelhahn ohne Zulassung wird erfragt', () => {
  const r = wissen.fehlendePflicht('kugelhahn', { dimension: 'DN15' });
  assert(r.fehlt.includes('zulassung'));
  assert.match(r.fragen.zulassung, /Heizung|Trinkwasser|Gas/);
});

console.log('\n── Kontext für die KI ──');
pruefe('kompakt und vollständig', () => {
  const k = wissen.promptKontext();
  assert(k.includes('ARTIKELARTEN'));
  assert(k.includes('messing=rotguss'));
  assert(k.includes('1 stange = 6 m'));
  assert(k.length < 2500, 'Kontext zu lang: ' + k.length + ' Zeichen');
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
