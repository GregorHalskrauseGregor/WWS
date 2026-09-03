// End-zu-End: kompletter Nachrichtenweg durch den Orchestrator, mit einem
// Fake-Modell statt echter API. Prüft das, worauf es beim Umbau ankam —
// zwei Aufmaße im selben Chat, die sich NICHT gegenseitig überschreiben.

const os = require('os');
const path = require('path');
const fs = require('fs');
process.env.WWS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-e2e-'));

const assert = require('assert');
const orchestrator = require('../kern/orchestrator');
const vorgang = require('../kern/vorgang');
const themen = require('../themen');

const CHAT = 777001;
let ok = 0, fehler = 0;
const pruefe = (name, fn) => {
  try { fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
};

// ── Fake-Modell: der Router antwortet nach Stichwort, der Extraktor liefert Ops
let routerAntwort = null;
let extraktionAntwort = null;

const dienste = {
  routerChat: async () => routerAntwort,
  chat: async () => extraktionAntwort,
  antwortChat: async () => 'Standardantwort.',
  lightChat: async () => 'Zusammenfassung.',
  provider: { name: 'anthropic', supportsTools: true, chat: async () => ({ content: 'Standardantwort.', toolCalls: null }) },
  protokoll: () => {},
  melde: () => {},
  frageBestaetigung: async () => ({ erlaubt: false, grund: 'Test' })
};

async function schicke(text, routing, ops) {
  routerAntwort = JSON.stringify(routing);
  extraktionAntwort = JSON.stringify(ops || { ops: [], bestaetigt: false, abbruch: false });
  return orchestrator.verarbeiteNachricht({ chatId: CHAT, text }, dienste);
}

(async () => {
  console.log('\n── Faden 1: Aufmaß Müller anlegen ──');
  const a1 = await schicke(
    'Aufmaß 26-0111 Badsanierung Müller, 12m Kupferrohr 22mm',
    { thema: 'neu', themaName: 'Aufmaß Müller', aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.95 },
    { ops: [
      { op: 'setze', feld: 'projektnummer', wert: '26-0111' },
      { op: 'setze', feld: 'bauvorhaben', wert: 'Badsanierung Müller' },
      { op: 'liste_hinzu', feld: 'positionen', wert: { menge: 12, einheit: 'm', bezeichnung: 'Kupferrohr 22mm' } }
    ] });
  const thema1 = a1.themaId;
  pruefe('vollständig -> fragt nach Bestätigung', () => {
    assert.match(a1.text, /Soll ich das so ausführen/);
    assert.equal((a1.knoepfe || []).length, 2, 'Knöpfe fehlen');
  });
  pruefe('Vorgang liegt am Thema', () => {
    const v = vorgang.lade(CHAT, thema1);
    assert.equal(v.daten.projektnummer, '26-0111');
    assert.equal(v.status, 'bestaetigen');
  });

  console.log('\n── Faden 2: zweites Aufmaß PARALLEL ──');
  const a2 = await schicke(
    'Aufmaß 26-0222 Heizraum Schmidt, 5 Stk Umwälzpumpe',
    { thema: 'neu', themaName: 'Aufmaß Schmidt', aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.95 },
    { ops: [
      { op: 'setze', feld: 'projektnummer', wert: '26-0222' },
      { op: 'setze', feld: 'bauvorhaben', wert: 'Heizraum Schmidt' },
      { op: 'liste_hinzu', feld: 'positionen', wert: { menge: 5, einheit: 'Stk.', bezeichnung: 'Umwälzpumpe' } }
    ] });
  const thema2 = a2.themaId;
  pruefe('zwei getrennte Themen', () => assert.notEqual(thema1, thema2, 'beide Nachrichten landeten im selben Thema'));
  pruefe('Faden 1 wurde NICHT überschrieben', () => {
    assert.equal(vorgang.lade(CHAT, thema1).daten.projektnummer, '26-0111');
    assert.equal(vorgang.lade(CHAT, thema2).daten.projektnummer, '26-0222');
  });

  console.log('\n── Korrektur landet im richtigen Faden ──');
  await schicke('Position 1 auf 20 ändern',
    { thema: thema1, aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.9 },
    { ops: [{ op: 'liste_aendere', feld: 'positionen', index: 1, wert: { menge: 20 } }] });
  pruefe('Faden 1 geändert', () => assert.equal(vorgang.lade(CHAT, thema1).daten.positionen[0].menge, 20));
  pruefe('Faden 2 unberührt', () => assert.equal(vorgang.lade(CHAT, thema2).daten.positionen[0].menge, 5));

  console.log('\n── Ergänzung ohne Datenverlust ──');
  await schicke('noch 3 Wandscheiben DN20 dazu',
    { thema: thema1, aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.9 },
    { ops: [{ op: 'liste_hinzu', feld: 'positionen', wert: { menge: 3, einheit: 'Stk.', bezeichnung: 'Wandscheibe DN20' } }] });
  pruefe('erste Position bleibt erhalten', () => {
    const p = vorgang.lade(CHAT, thema1).daten.positionen;
    assert.equal(p.length, 2);
    assert.equal(p[0].bezeichnung, 'Kupferrohr 22mm');
    assert.equal(p[0].menge, 20, 'Menge aus der Korrektur ging verloren');
  });

  console.log('\n── Unvollständiger Vorgang fragt gezielt nach ──');
  const u = await schicke('Bestellung bei GC für die Baustelle Müller',
    { thema: 'neu', themaName: 'Bestellung GC', aktion: 'verarbeiten', experte: 'bestellung', confidence: 0.9 },
    { ops: [
      { op: 'setze', feld: 'lieferant', wert: 'GC-Gruppe' },
      { op: 'setze', feld: 'baustelle', wert: 'Müller' }
    ] });
  pruefe('fragt nach den Positionen, nicht nach schon Bekanntem', () => {
    assert.match(u.text, /Was soll bestellt werden/);
    assert.doesNotMatch(u.text, /Großhändler soll bestellt/, 'fragt nach bereits bekanntem Lieferanten');
  });

  console.log('\n── Bestätigung führt aus (echte PDF-Erzeugung) ──');
  const fertig = await orchestrator.bestaetigeVorgang({ chatId: CHAT, themaId: thema1 }, dienste);
  pruefe('PDF erzeugt und Vorgang geschlossen', () => {
    assert.equal((fertig.dateien || []).length, 1, 'keine Datei: ' + fertig.text);
    assert(fs.existsSync(fertig.dateien[0]), 'PDF liegt nicht auf der Platte');
    assert(fs.statSync(fertig.dateien[0]).size > 500, 'PDF ist verdächtig klein');
    assert.equal(vorgang.lade(CHAT, thema1), null, 'Vorgang wurde nicht geschlossen');
  });
  pruefe('anderer Faden läuft weiter', () => assert(vorgang.lade(CHAT, thema2), 'Faden 2 wurde mit geschlossen'));

  console.log('\n── Abbruch ──');
  await schicke('stop',
    { thema: thema2, aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.9 }, { ops: [] });
  pruefe('Vorgang verworfen', () => assert.equal(vorgang.lade(CHAT, thema2), null));

  console.log('\n── Router unsicher -> normaler Chat, kein Experte ──');
  const chat = await schicke('was meinst du dazu?',
    { thema: thema1, aktion: 'verarbeiten', experte: 'materialaufmass', confidence: 0.2 }, { ops: [] });
  pruefe('kein Vorgang angelegt', () => {
    assert.equal(chat.text, 'Standardantwort.');
    assert.equal(vorgang.lade(CHAT, thema1), null);
  });

  console.log('\n── Verlauf wurde geschrieben ──');
  pruefe('Themen und Nachrichten persistiert', () => {
    const index = themen.ladeIndex(CHAT);
    assert(index.length >= 3, `nur ${index.length} Themen`);
    const t1 = themen.ladeThema(CHAT, thema1);
    assert(t1.messages.length >= 2, 'Verlauf leer');
  });

  console.log(`\n${'─'.repeat(46)}\nE2E: ${ok} bestanden, ${fehler} fehlgeschlagen`);
  console.log(`Testdaten: ${process.env.WWS_DATA}\n`);
  process.exit(fehler > 0 ? 1 : 0);
})().catch((e) => { console.error('E2E abgestürzt:', e); process.exit(1); });
