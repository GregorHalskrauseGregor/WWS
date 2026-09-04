// Tests der Wissensbasis.
//
// Die Wissensbasis ist seit dem Umbau kein Regelwerk mehr, sondern Text, den die
// KI liest. Getestet wird deshalb nicht mehr, ob der Code richtig rechnet,
// sondern ob der MECHANISMUS traegt: Karten lesbar, Ladehinweise vorhanden,
// Auswahl sauber, Wissensbank beschreibbar.
//
// Dazu ein paar wenige INHALTS-Tests. Die sind bewusst sparsam gehalten — je
// mehr Inhalt festgenagelt wird, desto unangenehmer wird das Pflegen, und genau
// das sollte der Umbau ja erleichtern. Festgenagelt ist nur, was
// sicherheitsrelevant ist oder schon einmal einen Fehler verursacht hat.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Wegwerf-Wissensordner: notiere() und legeKarteAn() schreiben echte Dateien.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-wissen-'));
fs.mkdirSync(path.join(TMP, 'karten'), { recursive: true });
for (const d of fs.readdirSync(path.join(__dirname, '..', 'wissen', 'karten'))) {
  fs.copyFileSync(path.join(__dirname, '..', 'wissen', 'karten', d), path.join(TMP, 'karten', d));
}
fs.copyFileSync(path.join(__dirname, '..', 'wissen', 'Wissensbank.md'), path.join(TMP, 'Wissensbank.md'));
process.env.WWS_WISSEN = TMP;

const wissen = require('../lib/wissen');

let ok = 0, fehler = 0;
function pruefe(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); ok++; }
  catch (err) { console.log(`  ❌ ${name}\n     ${err.message}`); fehler++; }
}
function assert(bed, txt) { if (!bed) throw new Error(txt || 'Erwartung nicht erfüllt'); }

console.log('\n── Karten sind lesbar und vollständig ──');

pruefe('mindestens fünf Karten vorhanden', () => {
  assert(wissen.karten().length >= 5, `nur ${wissen.karten().length} Karten gefunden`);
});

pruefe('jede Karte hat Titel und Ladehinweis', () => {
  for (const k of wissen.karten()) {
    assert(k.titel && k.titel.length > 3, `Karte ${k.id} hat keinen Titel`);
    // Ohne "Laden wenn" kann der Router die Karte nicht auswählen — sie wäre
    // totes Gewicht auf der Platte und würde nie in einen Prompt kommen.
    assert(k.wann && k.wann.length > 20, `Karte ${k.id} hat keinen brauchbaren Ladehinweis`);
  }
});

pruefe('Karten-IDs sind kleingeschrieben und dateisystemsicher', () => {
  for (const k of wissen.karten()) {
    assert(/^[a-z0-9_]+$/.test(k.id), `unzulässige Karten-ID: ${k.id}`);
  }
});

console.log('\n── Der Katalog bleibt klein ──');

pruefe('Katalog für den Router unter 1500 Zeichen', () => {
  // Der Katalog geht in JEDEN Router-Aufruf. Wächst er, zahlt jede Nachricht
  // mit — auch reiner Smalltalk. Wird eine Ladehinweis-Zeile zum Aufsatz,
  // soll das hier auffallen und nicht erst auf der Rechnung.
  const laenge = wissen.katalog().length;
  assert(laenge < 1500, `Katalog ist ${laenge} Zeichen groß`);
});

pruefe('jede Karte steht im Katalog', () => {
  const kat = wissen.katalog();
  for (const k of wissen.karten()) assert(kat.includes(k.id), `${k.id} fehlt im Katalog`);
});

console.log('\n── Auswahl liefert genau das Gewählte ──');

pruefe('eine Karte kommt zurück, die anderen nicht', () => {
  const t = wissen.text(['einheiten']);
  assert(t.includes('Gebinde'), 'Inhalt der Einheiten-Karte fehlt');
  assert(!t.includes('Prüfzeichen'), 'Zulassungs-Karte wurde ungefragt mitgeliefert');
});

pruefe('erfundene Karten-IDs werden still ignoriert', () => {
  // Ein Modell, das sich eine Karte ausdenkt, darf den Vorgang nicht abbrechen.
  const t = wissen.text(['einheiten', 'gibtesnicht']);
  assert(t.includes('Gebinde'), 'gültige Karte ging verloren');
});

pruefe('leere Auswahl liefert leeren Text', () => {
  assert(wissen.text([]) === '', 'leere Auswahl liefert Text');
  assert(wissen.text(['nurmuell']) === '', 'nur ungültige IDs liefern Text');
});

pruefe('alles() enthält jede Karte und die Wissensbank', () => {
  const a = wissen.alles();
  for (const k of wissen.karten()) assert(a.includes(k.titel), `${k.id} fehlt in alles()`);
  assert(a.includes('WISSENSBANK'), 'Wissensbank fehlt in alles()');
});

console.log('\n── Kategorien: das feste Vokabular der Lagerdatei ──');

pruefe('Kategorien kommen aus den Überschriften der Warengruppenkarte', () => {
  const k = wissen.kategorien();
  assert(k.length >= 10, `nur ${k.length} Kategorien`);
  assert(k.includes('Sonstiges'), 'Auffangkategorie "Sonstiges" fehlt');
});

pruefe('keine Kategorie ist leer oder trägt Rauten', () => {
  for (const k of wissen.kategorien()) {
    assert(k.trim().length > 2 && !k.includes('#'), `unsaubere Kategorie: "${k}"`);
  }
});

console.log('\n── Wissensbank: notieren, finden, abhaken ──');

pruefe('eine Notiz landet als offener Eintrag in der Bank', () => {
  const vorher = wissen.offeneEintraege().length;
  wissen.notiere('Eine Rolle Kupfer weich sind bei uns 25 m.', 'Test');
  const nachher = wissen.offeneEintraege();
  assert(nachher.length === vorher + 1, `${vorher} → ${nachher.length} statt +1`);
  assert(nachher.some((e) => e.satz.includes('25 m')), 'Notiz nicht wiedergefunden');
});

pruefe('Quellenangabe steht in der Datei, nicht im Satz', () => {
  // Sonst schleppt jeder eingeordnete Absatz "(Chat 12345)" mit in die Karte.
  const eintrag = wissen.offeneEintraege().find((e) => e.satz.includes('25 m'));
  assert(!eintrag.satz.includes('Test'), 'Herkunft klebt am Satz');
  assert(wissen.leseBank().includes('_(Test)_'), 'Herkunft fehlt in der Datei');
});

pruefe('abhaken macht aus [ ] ein [x] und lässt die Zeile stehen', () => {
  const offen = wissen.offeneEintraege();
  const ziel = offen.find((e) => e.satz.includes('25 m'));
  const n = wissen.hakeAb([{ nr: ziel.nr, karte: 'einheiten' }]);
  assert(n === 1, `${n} Zeilen abgehakt statt 1`);
  const bank = wissen.leseBank();
  assert(bank.includes('25 m'), 'die Zeile wurde gelöscht statt abgehakt');
  assert(bank.includes('→ einheiten'), 'Zielkarte nicht vermerkt');
  assert(!wissen.offeneEintraege().some((e) => e.satz.includes('25 m')), 'Eintrag gilt noch als offen');
});

pruefe('leere Notizen werden nicht angehängt', () => {
  assert(wissen.notiere('   ') === false, 'Leerzeichen wurden notiert');
});

console.log('\n── Karten pflegen ──');

pruefe('ergaenzeKarte hängt an und lässt Bestehendes stehen', () => {
  const vorher = wissen.karte('einheiten').text;
  assert(wissen.ergaenzeKarte('einheiten', 'Ein Kanister Dichtmittel sind 5 l.'), 'Ergänzen schlug fehl');
  const nachher = wissen.karte('einheiten').text;
  assert(nachher.includes('Kanister'), 'Ergänzung fehlt');
  assert(nachher.includes(vorher.split('\n')[0]), 'Titel ging verloren');
});

pruefe('neue Karte ohne Ladehinweis wird abgelehnt', () => {
  // Eine Karte ohne "wann" kann der Router nie auswählen.
  assert(wissen.legeKarteAn('test_leer', 'Test', '', 'Inhalt') === null, 'Karte ohne Hinweis angelegt');
});

pruefe('neue Karte wird angelegt und ist sofort wählbar', () => {
  const id = wissen.legeKarteAn('Werkzeug Test!', 'Werkzeuge', 'nach Werkzeug gefragt wird', 'Pressbacken.');
  assert(id === 'werkzeug_test', `ID wurde zu "${id}" statt "werkzeug_test"`);
  assert(wissen.text([id]).includes('Pressbacken'), 'neue Karte nicht ladbar');
  assert(wissen.katalog().includes(id), 'neue Karte fehlt im Katalog');
});

pruefe('eine bestehende Karte wird nicht überschrieben', () => {
  assert(wissen.legeKarteAn('einheiten', 'X', 'irgendwann', 'Y') === null, 'bestehende Karte überschrieben');
  assert(wissen.karte('einheiten').text.includes('Gebinde'), 'Inhalt der Einheiten-Karte zerstört');
});

console.log('\n── Fachliche Festlegungen, die nicht verlorengehen dürfen ──');

const alleTexte = wissen.karten().map((k) => k.text).join('\n');

pruefe('Gebindegrößen stehen drin: Stange 6 m, Kupfer 5 m', () => {
  // Ohne diese Zahlen im Prompt rät die KI, und eine geratene Umrechnung
  // landet ungeprüft in der Lagerdatei.
  assert(/Stange/.test(alleTexte) && /\b6\b/.test(alleTexte), 'Stange = 6 m fehlt');
  assert(/Kupfer/.test(alleTexte) && /\b5\b/.test(alleTexte), 'Kupferstange = 5 m fehlt');
});

pruefe('die Presskontur wird ausdrücklich nicht geraten', () => {
  // Eine falsche Kontur presst nicht dicht — das ist der einzige Punkt in der
  // ganzen Wissensbasis, an dem Raten gefährlich statt nur ärgerlich ist.
  assert(/[Kk]ontur/.test(alleTexte), 'Presskontur kommt nicht vor');
  assert(/nicht geraten|nicht raten|frag nach|nachfragen/i.test(alleTexte),
    'kein Hinweis, dass bei unklarer Kontur nachgefragt wird');
});

pruefe('Kupfer-Außendurchmesser ist nicht gleich DN', () => {
  // 15 mm Kupfer ist NICHT DN15. Wer das gleichsetzt, bucht auf die falsche Zeile.
  assert(/nicht\s+DN15|\*\*nicht\*\*\s+DN15/i.test(alleTexte), 'Warnung zu Kupfer/DN fehlt');
});

pruefe('"schwarz" gilt nur bei Rohr und Fitting als Stahl', () => {
  assert(/schwarz/i.test(alleTexte), '"schwarz" fehlt');
  assert(/Farbe/i.test(alleTexte), 'kein Hinweis, dass "schwarz" anderswo die Farbe meint');
});

pruefe('Oberfläche und Werkstoff sind getrennt', () => {
  assert(/[Oo]berfläche ist nicht [Ww]erkstoff|Oberfläche/.test(alleTexte), 'Oberfläche fehlt');
  assert(/verzinkt/.test(alleTexte), 'verzinkt fehlt');
});

pruefe('Zulassungs-Rangfolge steht drin', () => {
  assert(/Heizung.*Trinkwasser.*Gas/s.test(alleTexte), 'Rangfolge fehlt');
});

console.log('\n──────────────────────────────────────────────');
console.log(`Wissen: ${ok} bestanden, ${fehler} fehlgeschlagen`);
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(fehler ? 1 : 0);
