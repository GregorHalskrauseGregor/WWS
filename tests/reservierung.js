// Der Weg einer Reservierung vom Monteur zum Lageristen und zurueck.
//
// Hier wird echtes Material bewegt, deshalb liegt der Schwerpunkt auf den
// Stellen, an denen ein Fehler den Bestand verfaelscht: die Korrektur nach
// unten, das Ausbuchen des bereitgestellten Materials und das Freigeben dessen,
// was gar nicht da war.

const fs = require('fs');
const os = require('os');
const path = require('path');
process.env.WWS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-res-'));

const assert = require('assert');
const { PFADE } = require('../config');
const libExcel = require('../lib/excel');
const material = require('../material');
const reservierungen = require('../reservierungen');
const modus = require('../kern/modus');
const rollen = require('../rollen');
const optionen = require('../optionen');
const nachricht = require('../lib/lager_nachricht');

let ok = 0, fehler = 0;
async function pruefe(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
}
const assertOk = (b, t) => { if (!b) throw new Error(t || 'Erwartung nicht erfüllt'); };

const MONTEUR = 900001;
const LAGERIST = 900002;

(async () => {
  await libExcel.erstelleLeer(PFADE.MATERIAL_XLSX);
  await material.addierePositionen([
    { bezeichnung: 'Kugelhahn DN25 Trinkwasser', menge: 10, einheit: 'Stk.', kategorie: 'Armaturen & Ventile' },
    { bezeichnung: 'Schwarzrohr DN50', menge: 24, einheit: 'm', kategorie: 'Rohre & Leitungen' }
  ], PFADE.MATERIAL_XLSX);

  console.log('\n── Rollen und der Admin-Zugang ──');

  await pruefe('ohne Rolle ist jeder Monteur', () => {
    assert.equal(rollen.rolleVon(MONTEUR), 'monteur');
  });

  await pruefe('ohne gesetztes Kennwort gibt es keinen Admin-Zugang', () => {
    delete process.env.ADMIN_KENNWORT;
    assert.equal(optionen.kennwortStimmt('irgendwas'), false);
    assert.equal(optionen.kennwortStimmt(''), false);
  });

  await pruefe('mit Kennwort öffnet sich der Admin-Bereich', () => {
    process.env.ADMIN_KENNWORT = 'test-kennwort';
    assert.equal(optionen.kennwortStimmt('test-kennwort'), true);
    assert.equal(optionen.kennwortStimmt('falsch'), false);
    const { daten } = optionen.oeffne(LAGERIST, 'test-kennwort');
    assert.equal(daten.admin, true);
  });

  await pruefe('ohne Admin lässt sich keine Rolle vergeben', () => {
    const { daten } = optionen.oeffne(LAGERIST, null);
    const r = optionen.verarbeite(LAGERIST, '/zuLagerist', daten);
    assert.match(r.text, /nur der Admin/);
    assert.equal(rollen.rolleVon(LAGERIST), 'monteur', 'Rolle wurde trotzdem gesetzt');
  });

  await pruefe('Rolle wird erst bei /options end geschrieben', () => {
    const { daten } = optionen.oeffne(LAGERIST, 'test-kennwort');
    const vorgemerkt = optionen.verarbeite(LAGERIST, '/zuLagerist', daten);
    assert.equal(rollen.rolleVon(LAGERIST), 'monteur', 'zu früh gespeichert');
    const ende = optionen.verarbeite(LAGERIST, '/options end', vorgemerkt.daten);
    assert.equal(ende.beenden, true);
    assert.equal(rollen.rolleVon(LAGERIST), 'lagerist');
  });

  await pruefe('aus den Einstellungen kommt man immer wieder raus', () => {
    // Ein Modus, den man nur mit dem exakt richtigen Befehl verlassen kann,
    // sperrt beim ersten Vertipper den ganzen Bot.
    const { daten } = optionen.oeffne(MONTEUR, null);
    for (const wort of ['fertig', 'ende', 'abbrechen', 'exit', '/options end']) {
      assert.equal(optionen.verarbeite(MONTEUR, wort, daten).beenden, true, `"${wort}" schließt nicht`);
    }
  });

  console.log('\n── Der Modus hält den Rest an ──');

  await pruefe('ein aktiver Modus wird erkannt und wieder freigegeben', () => {
    modus.starte(MONTEUR, 'options', { admin: false });
    assertOk(modus.aktiv(MONTEUR), 'Modus nicht aktiv');
    modus.beende(MONTEUR);
    assert.equal(modus.aktiv(MONTEUR), null);
  });

  await pruefe('ein vergessener Modus läuft von selbst ab', () => {
    // Wer mitten im Workflow das Handy weglegt, darf den Bot nicht dauerhaft
    // blockieren.
    const m = modus.starte(MONTEUR, 'reservierung', {});
    m.seit = Date.now() - modus.MAX_ALTER_MS - 1000;
    assert.equal(modus.aktiv(MONTEUR), null, 'abgelaufener Modus blockiert weiter');
  });

  console.log('\n── Reservierung anlegen ──');

  await material.reservierePositionen(
    [{ bezeichnung: 'Kugelhahn DN25 Trinkwasser', menge: 4 }, { bezeichnung: 'Schwarzrohr DN50', menge: 12 }],
    PFADE.MATERIAL_XLSX, MONTEUR);

  const vorgang = reservierungen.anlegen({
    monteurChatId: MONTEUR, monteurName: 'Torsten',
    positionen: [
      { bezeichnung: 'Kugelhahn DN25 Trinkwasser', menge: 4, einheit: 'Stk.' },
      { bezeichnung: 'Schwarzrohr DN50', menge: 12, einheit: 'm' }
    ]
  });

  await pruefe('die Nummer ist als Telegram-Befehl brauchbar', () => {
    // Telegram erlaubt in Befehlen nur Buchstaben, Ziffern und Unterstrich.
    assert.match(vorgang.id, /^r[a-z0-9]{8}$/, `Nummer "${vorgang.id}" taugt nicht als Befehl`);
    assertOk(!/[o0l1]/.test(vorgang.id.slice(1)), 'verwechselbare Zeichen in der Nummer');
  });

  await pruefe('sie steht offen beim Lageristen', () => {
    assert.equal(reservierungen.offene().length, 1);
    assert.equal(reservierungen.vonMonteur(MONTEUR).length, 1);
  });

  await pruefe('die Liste nennt Nummer, Alter und Positionen', () => {
    const t = nachricht.offeneListe(reservierungen.offene());
    assertOk(t.includes('/' + vorgang.id), 'Nummer fehlt');
    assertOk(t.includes('Torsten'), 'Monteur fehlt');
    assertOk(/gerade eben|vor \d+ Min/.test(t), 'Alter fehlt');
  });

  await pruefe('eine leere Liste sagt das auch', () => {
    assert.match(nachricht.offeneListe([]), /alles abgearbeitet/i);
  });

  console.log('\n── Der Lagerist geht sie durch ──');

  await pruefe('Teilmengen und Nullmengen werden festgehalten', () => {
    reservierungen.setzeBestaetigung(vorgang.id, 0, 4);
    reservierungen.setzeBestaetigung(vorgang.id, 1, 5);
    const r = reservierungen.lade(vorgang.id);
    assert.equal(r.positionen[0].bestaetigt, 4);
    assert.equal(r.positionen[1].bestaetigt, 5);
  });

  await pruefe('die Bilanz erkennt "teilweise"', () => {
    const b = reservierungen.bilanz(reservierungen.lade(vorgang.id));
    assert.equal(b.vollstaendig, 1);
    assert.equal(b.teilweise, 1);
    assert.equal(b.allesDa, false);
    assert.equal(b.nichtsDa, false);
  });

  await pruefe('negative Mengen sind nicht möglich', () => {
    reservierungen.setzeBestaetigung(vorgang.id, 1, -3);
    assert.equal(reservierungen.lade(vorgang.id).positionen[1].bestaetigt, 0);
    reservierungen.setzeBestaetigung(vorgang.id, 1, 5);
  });

  console.log('\n── Zurechtgelegt: abschliessen() macht beides in der richtigen Reihenfolge ──');

  await pruefe('Fehlbestand wird übernommen, dann ausgebucht', async () => {
    // Der Lagerist hat 5 m gefunden, die Liste sagt 24. Erst korrigieren,
    // dann abziehen — andersherum bliebe ein Rest stehen, den es nie gab.
    const e = await reservierungen.abschliessen(vorgang.id,
      { zurechtgelegt: true, material, pfad: PFADE.MATERIAL_XLSX });
    assertOk(e, 'kein Ergebnis');
    assert.equal(e.reservierung.status, 'bereitgestellt');
    assertOk(e.korrekturen.some((k) => /Schwarzrohr/.test(k)), 'die Korrektur wurde nicht gemeldet');

    const b = await material.leseAlle(PFADE.MATERIAL_XLSX);
    assert.equal(material.gesamtbestand(material.findePosition(b, 'Kugelhahn DN25 Trinkwasser')), 6);
    assert.equal(material.gesamtbestand(material.findePosition(b, 'Schwarzrohr DN50')), 0);
  });

  await pruefe('die Vormerkung ist danach aufgezehrt', async () => {
    const b = await material.leseAlle(PFADE.MATERIAL_XLSX);
    const p = material.findePosition(b, 'Kugelhahn DN25 Trinkwasser');
    assert.equal(material.reserviertVon(p, MONTEUR), 0, 'Reservierung besteht weiter');
  });

  await pruefe('keine Position wurde gelöscht', async () => {
    const b = await material.leseAlle(PFADE.MATERIAL_XLSX);
    assert.equal(b.length, 2, 'eine Zeile ist verschwunden');
  });

  await pruefe('sie steht nicht mehr in der offenen Liste', () => {
    assert.equal(reservierungen.offene().length, 0);
  });

  console.log('\n── Nicht zurechtgelegt: was fehlt, wird freigegeben ──');

  await pruefe('nur der Fehlbetrag wird freigegeben, der Rest bleibt vorgemerkt', async () => {
    await material.addierePositionen(
      [{ bezeichnung: 'Rohrschelle M8 DN50', menge: 20, einheit: 'Stk.', kategorie: 'Befestigung, Montage & Elektro' }],
      PFADE.MATERIAL_XLSX);
    await material.reservierePositionen([{ bezeichnung: 'Rohrschelle M8 DN50', menge: 10 }],
      PFADE.MATERIAL_XLSX, MONTEUR);

    const v = reservierungen.anlegen({
      monteurChatId: MONTEUR,
      positionen: [{ bezeichnung: 'Rohrschelle M8 DN50', menge: 10, einheit: 'Stk.' }]
    });
    reservierungen.setzeBestaetigung(v.id, 0, 6);

    const e = await reservierungen.abschliessen(v.id,
      { zurechtgelegt: false, material, pfad: PFADE.MATERIAL_XLSX });
    assert.equal(e.reservierung.status, 'reserviert');

    const b = await material.leseAlle(PFADE.MATERIAL_XLSX);
    const p = material.findePosition(b, 'Rohrschelle M8 DN50');
    assert.equal(material.reserviertVon(p, MONTEUR), 6, 'die Vormerkung stimmt nicht');
    assert.equal(material.gesamtbestand(p), 6, 'der Bestand wurde nicht auf die gezählte Menge korrigiert');
  });

  await pruefe('nichts gefunden -> abgelehnt, nichts bleibt gesperrt', async () => {
    await material.addierePositionen(
      [{ bezeichnung: 'T-Stück DN50', menge: 4, einheit: 'Stk.', kategorie: 'Fittinge & Verbindungstechnik' }],
      PFADE.MATERIAL_XLSX);
    await material.reservierePositionen([{ bezeichnung: 'T-Stück DN50', menge: 4 }],
      PFADE.MATERIAL_XLSX, MONTEUR);

    const v = reservierungen.anlegen({
      monteurChatId: MONTEUR,
      positionen: [{ bezeichnung: 'T-Stück DN50', menge: 4, einheit: 'Stk.' }]
    });
    reservierungen.setzeBestaetigung(v.id, 0, 0);
    const e = await reservierungen.abschliessen(v.id,
      { zurechtgelegt: false, material, pfad: PFADE.MATERIAL_XLSX });
    assert.equal(e.reservierung.status, 'abgelehnt');
    assert.equal(e.bilanz.nichtsDa, true);

    const b = await material.leseAlle(PFADE.MATERIAL_XLSX);
    const p = material.findePosition(b, 'T-Stück DN50');
    assert.equal(material.reserviertVon(p, MONTEUR), 0, 'es bleibt Material gesperrt, das nicht da ist');
  });

  console.log('\n── Alte Einzelschritte (Grundlage des Abschlusses) ──');

  await pruefe('Zeitstempel und Bearbeiter sind festgehalten', () => {
    const r = reservierungen.lade(vorgang.id);
    assertOk(r.bearbeitetAm, 'Zeitstempel fehlt');
    assert.equal(r.status, 'bereitgestellt');
  });

  console.log('\n── Der Bescheid an den Monteur ──');

  await pruefe('bei Teilmengen steht "teilweise" und was fehlt', () => {
    const r = reservierungen.lade(vorgang.id);
    const t = nachricht.monteurBescheid(r, reservierungen.bilanz(r));
    assert.match(t, /teilweise best/i);
    assertOk(t.includes('5 statt 12'), 'die Abweichung wird nicht benannt');
    assert.match(t, /liegt für dich bereit/i);
  });

  await pruefe('bei nichts gefunden heißt es abgelehnt', () => {
    const leer = reservierungen.anlegen({
      monteurChatId: MONTEUR,
      positionen: [{ bezeichnung: 'Pumpe Magna3 25-60', menge: 1, einheit: 'Stk.' }]
    });
    reservierungen.setzeBestaetigung(leer.id, 0, 0);
    reservierungen.setzeStatus(leer.id, reservierungen.STATUS.abgelehnt);
    const r = reservierungen.lade(leer.id);
    const b = reservierungen.bilanz(r);
    assert.equal(b.nichtsDa, true);
    assert.match(nachricht.monteurBescheid(r, b), /abgelehnt/i);
  });

  await pruefe('bei allem da heißt es bestätigt', () => {
    const voll = reservierungen.anlegen({
      monteurChatId: MONTEUR,
      positionen: [{ bezeichnung: 'Kugelhahn DN25 Trinkwasser', menge: 2, einheit: 'Stk.' }]
    });
    reservierungen.setzeBestaetigung(voll.id, 0, 2);
    reservierungen.setzeStatus(voll.id, reservierungen.STATUS.reserviert);
    const r = reservierungen.lade(voll.id);
    const t = nachricht.monteurBescheid(r, reservierungen.bilanz(r));
    assert.match(t, /best(ä|ae)tigt/i);
    assert.match(t, /bleibt für dich reserviert/i);
  });

  console.log('\n── Die Liste wird nur bei echter Änderung neu geschickt ──');

  await pruefe('gleiche Lage = gleiche Signatur', () => {
    const lagerBot = require('../adapter/telegram_lager');
    const a = lagerBot.signaturVon(reservierungen.offene());
    const b = lagerBot.signaturVon(reservierungen.offene());
    assert.equal(a, b, 'die Liste würde ohne Grund neu geschickt');
  });

  await pruefe('neue Reservierung = neue Signatur', () => {
    const lagerBot = require('../adapter/telegram_lager');
    const vorher = lagerBot.signaturVon(reservierungen.offene());
    reservierungen.anlegen({
      monteurChatId: MONTEUR,
      positionen: [{ bezeichnung: 'Schwarzrohr DN50', menge: 3, einheit: 'm' }]
    });
    assert.notEqual(lagerBot.signaturVon(reservierungen.offene()), vorher);
  });

  console.log(`\n${'─'.repeat(46)}\nReservierung: ${ok} bestanden, ${fehler} fehlgeschlagen`);
  console.log(`Testdaten: ${process.env.WWS_DATA}\n`);
  process.exit(fehler > 0 ? 1 : 0);
})().catch((e) => { console.error('Reservierungs-Test abgestürzt:', e); process.exit(1); });
