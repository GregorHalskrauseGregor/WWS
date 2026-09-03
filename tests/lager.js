// Lagerlogik: Ein- und Auslagern, Bestandsschutz, Reservierungen, Export.
// Läuft gegen eine echte Excel-Datei in einem Wegwerf-Verzeichnis.

const os = require('os'), path = require('path'), fs = require('fs');
process.env.WWS_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wws-lager-'));

const assert = require('assert');
const libExcel = require('../lib/excel');
const material = require('../material');
const exportModul = require('../lib/lager_export');
const { PFADE } = require('../config');

const PFAD = PFADE.MATERIAL_XLSX;
const ICH = '111', ANDERE = '222';

let ok = 0, fehler = 0;
async function pruefe(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); ok++; }
  catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); fehler++; }
}
const bestandVon = async (bez) => {
  const p = material.findePosition(await material.leseAlle(PFAD), bez);
  return p ? material.gesamtbestand(p) : null;
};

(async () => {
  console.log('\n── Datei-Verhalten ──');
  await pruefe('fehlende Datei wird NICHT stillschweigend angelegt', async () => {
    await assert.rejects(() => material.leseAlle(PFAD), /Lagerdatei fehlt/);
  });
  await pruefe('leere Datei auf ausdrückliche Anforderung', async () => {
    const r = await libExcel.erstelleLeer(PFAD);
    assert.equal(r.erstellt, true);
    assert.deepEqual(await material.leseAlle(PFAD), []);
  });
  await pruefe('vorhandene Datei wird nicht überschrieben', async () => {
    assert.equal((await libExcel.erstelleLeer(PFAD)).erstellt, false);
  });

  console.log('\n── Einlagern ──');
  await pruefe('neue Position wird angelegt', async () => {
    const r = await material.addierePositionen(
      [{ bezeichnung: 'Stahlbogen DN50', menge: 5, einheit: 'Stk.', kategorie: 'Fittinge & Verbindungstechnik' }], PFAD);
    assert.equal(r[0].neu, true);
    assert.equal(await bestandVon('Stahlbogen DN50'), 5);
  });
  await pruefe('bestehende Position wird erhöht, nicht dupliziert', async () => {
    await material.addierePositionen([{ bezeichnung: 'Stahlbogen DN50', menge: 3 }], PFAD);
    assert.equal(await bestandVon('Stahlbogen DN50'), 8);
    const alle = await material.leseAlle(PFAD);
    assert.equal(alle.filter((p) => /Stahlbogen/i.test(p.bezeichnung)).length, 1, 'doppelte Zeile angelegt');
  });
  await pruefe('DN-Schreibweise trifft dieselbe Zeile', async () => {
    await material.addierePositionen([{ bezeichnung: 'Stahlbogen DN 50', menge: 2 }], PFAD);
    assert.equal(await bestandVon('Stahlbogen DN50'), 10);
  });
  await pruefe('Zustände werden getrennt geführt', async () => {
    await material.addierePositionen([{ bezeichnung: 'Stahlbogen DN50', menge: 4, zustand: 'gebraucht' }], PFAD);
    const p = material.findePosition(await material.leseAlle(PFAD), 'Stahlbogen DN50');
    assert.equal(p.mengeNeu, 10);
    assert.equal(p.mengeGebraucht, 4);
    assert.equal(material.gesamtbestand(p), 14);
  });

  console.log('\n── Entnehmen mit Bestandsschutz ──');
  await pruefe('normale Entnahme', async () => {
    const r = await material.entnehmePositionen([{ bezeichnung: 'Stahlbogen DN50', menge: 4 }], PFAD, ICH);
    assert.equal(r[0].entnommen, 4);
    assert.equal(await bestandVon('Stahlbogen DN50'), 10);
  });
  await pruefe('Bestand fällt NIE unter null', async () => {
    const r = await material.entnehmePositionen([{ bezeichnung: 'Stahlbogen DN50', menge: 999 }], PFAD, ICH);
    assert.equal(r[0].entnommen, 10);
    assert.equal(r[0].fehlend, 989);
    assert.equal(await bestandVon('Stahlbogen DN50'), 0);
  });
  await pruefe('Position mit Bestand 0 bleibt in der Liste', async () => {
    const alle = await material.leseAlle(PFAD);
    const p = material.findePosition(alle, 'Stahlbogen DN50');
    assert(p, 'Zeile wurde gelöscht');
    assert.equal(material.gesamtbestand(p), 0);
  });
  await pruefe('unbekannte Position wird gemeldet, nicht angelegt', async () => {
    const vorher = (await material.leseAlle(PFAD)).length;
    const r = await material.entnehmePositionen([{ bezeichnung: 'Gibtsnicht XY', menge: 1 }], PFAD, ICH);
    assert.equal(r[0].unbekannt, true);
    assert.equal((await material.leseAlle(PFAD)).length, vorher, 'Zeile wurde angelegt');
  });
  await pruefe('Entnahme greift über Zustände hinweg', async () => {
    await material.addierePositionen([
      { bezeichnung: 'Kugelhahn DN20', menge: 2, zustand: 'neu' },
      { bezeichnung: 'Kugelhahn DN20', menge: 5, zustand: 'gebraucht' }
    ], PFAD);
    const r = await material.entnehmePositionen([{ bezeichnung: 'Kugelhahn DN20', menge: 6 }], PFAD, ICH);
    assert.equal(r[0].entnommen, 6, 'nur aus einer Zustandsspalte genommen');
    assert.equal(await bestandVon('Kugelhahn DN20'), 1);
  });

  console.log('\n── Reservierungen ──');
  await pruefe('reservieren vermerkt Chat-ID und Menge', async () => {
    await material.addierePositionen([{ bezeichnung: 'Pumpe Magna3', menge: 10 }], PFAD);
    const r = await material.reservierePositionen([{ bezeichnung: 'Pumpe Magna3', menge: 4 }], PFAD, ANDERE);
    assert.equal(r[0].reserviert, 4);
    const p = material.findePosition(await material.leseAlle(PFAD), 'Pumpe Magna3');
    assert.equal(material.reserviertVon(p, ANDERE), 4);
  });
  await pruefe('Reservierung überlebt das Speichern in der Excel', async () => {
    const p = material.findePosition(await material.leseAlle(PFAD), 'Pumpe Magna3');
    assert.deepEqual(p.reservierungen, [{ chatId: ANDERE, menge: 4 }]);
  });
  await pruefe('fremde Reservierung sperrt die Entnahme', async () => {
    const r = await material.entnehmePositionen([{ bezeichnung: 'Pumpe Magna3', menge: 10 }], PFAD, ICH);
    assert.equal(r[0].entnommen, 6, 'hat reserviertes Material mitgenommen');
    assert.equal(r[0].gesperrtDurchReservierung, 4);
    assert.equal(await bestandVon('Pumpe Magna3'), 4);
  });
  await pruefe('eigene Reservierung wird bei Entnahme aufgezehrt', async () => {
    await material.addierePositionen([{ bezeichnung: 'Rohrschelle M8', menge: 20 }], PFAD);
    await material.reservierePositionen([{ bezeichnung: 'Rohrschelle M8', menge: 8 }], PFAD, ICH);
    await material.entnehmePositionen([{ bezeichnung: 'Rohrschelle M8', menge: 5 }], PFAD, ICH);
    const p = material.findePosition(await material.leseAlle(PFAD), 'Rohrschelle M8');
    assert.equal(material.reserviertVon(p, ICH), 3, 'Vormerkung nicht verrechnet');
    assert.equal(material.gesamtbestand(p), 15);
  });
  await pruefe('mehr reservieren als frei ist, geht nicht', async () => {
    const r = await material.reservierePositionen([{ bezeichnung: 'Rohrschelle M8', menge: 99 }], PFAD, ANDERE);
    assert.equal(r[0].reserviert, 12, 'freie Menge falsch berechnet');
    assert.equal(r[0].nichtMoeglich, 87);
  });
  await pruefe('Freigabe gibt nur die eigene Vormerkung frei', async () => {
    const r = await material.gibReservierungFrei([{ bezeichnung: 'Rohrschelle M8', menge: 3 }], PFAD, ICH);
    assert.equal(r[0].freigegeben, 3);
    const p = material.findePosition(await material.leseAlle(PFAD), 'Rohrschelle M8');
    assert.equal(material.reserviertVon(p, ICH), 0);
    assert.equal(material.reserviertVon(p, ANDERE), 12, 'fremde Vormerkung angetastet');
  });
  await pruefe('eigene Reservierungen auflisten', async () => {
    const meine = material.reservierungenVon(await material.leseAlle(PFAD), ANDERE);
    const namen = meine.map((m) => m.bezeichnung).sort();
    assert.deepEqual(namen, ['Pumpe Magna3', 'Rohrschelle M8']);
  });

  console.log('\n── Suchen und Bedarf (ohne Buchung) ──');
  await pruefe('Suche verändert nichts', async () => {
    const vorher = await bestandVon('Pumpe Magna3');
    const treffer = material.suchePositionen('magna', await material.leseAlle(PFAD));
    assert.equal(treffer.length, 1);
    assert.equal(await bestandVon('Pumpe Magna3'), vorher);
  });
  await pruefe('Bedarf berücksichtigt fremde Reservierungen', async () => {
    const r = material.pruefeBedarf([{ bezeichnung: 'Pumpe Magna3', menge: 4 }], await material.leseAlle(PFAD), ICH);
    assert.equal(r[0].bestand, 4);
    assert.equal(r[0].verfuegbar, 0, 'reserviertes Material als verfügbar gezählt');
    assert.equal(r[0].reicht, false);
  });

  console.log('\n── Export ──');
  await pruefe('Export erzeugt eine eigene Datei', async () => {
    const ziel = path.join(process.env.WWS_DATA, 'Lagerbestand_test.xlsx');
    await exportModul.erzeuge(ziel, await material.leseAlle(PFAD), {});
    assert(fs.existsSync(ziel), 'Datei fehlt');
    assert(fs.statSync(ziel).size > 3000, 'Datei verdächtig klein');
  });
  await pruefe('Export enthält Kategorien als Zwischenüberschriften', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path.join(process.env.WWS_DATA, 'Lagerbestand_test.xlsx'));
    const blatt = wb.getWorksheet('Lagerbestand');
    const texte = [];
    blatt.eachRow((r) => texte.push(String(r.getCell(1).value || '')));
    assert(texte.some((t) => t === 'Fittinge & Verbindungstechnik'), 'Kategorie-Überschrift fehlt');
    assert(texte.some((t) => t.startsWith('Summe ')), 'Kategoriesumme fehlt');
    assert(texte.some((t) => t === 'Stahlbogen DN50'), 'Position mit Bestand 0 fehlt in der Liste');
  });
  await pruefe('Arbeitsdatei bleibt vom Export unberührt', async () => {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(PFAD);
    assert.deepEqual(wb.worksheets.map((w) => w.name), ['Lager'], 'Arbeitsdatei hat fremde Blätter');
  });
  await pruefe('Export ohne Reservierungsspalte, außer auf Wunsch', async () => {
    const ExcelJS = require('exceljs');
    const ohne = path.join(process.env.WWS_DATA, 'ohne.xlsx');
    const mit = path.join(process.env.WWS_DATA, 'mit.xlsx');
    const pos = await material.leseAlle(PFAD);
    await exportModul.erzeuge(ohne, pos, {});
    await exportModul.erzeuge(mit, pos, { mitReservierungen: true });
    const kopf = async (f) => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.readFile(f);
      const b = wb.getWorksheet('Lagerbestand');
      let z = null;
      b.eachRow((r) => { if (!z && String(r.getCell(1).value) === 'Bezeichnung') z = r.values.map(String); });
      return (z || []).join('|');
    };
    assert(!(await kopf(ohne)).includes('reserviert'), 'interne Spalte im Weitergabe-Export');
    assert((await kopf(mit)).includes('reserviert'), 'Spalte fehlt trotz Wunsch');
  });

  console.log(`\n${'─'.repeat(46)}\nLager: ${ok} bestanden, ${fehler} fehlgeschlagen`);
  console.log(`Testdaten: ${process.env.WWS_DATA}\n`);
  process.exit(fehler > 0 ? 1 : 0);
})().catch((e) => { console.error('Lager-Test abgestürzt:', e); process.exit(1); });
