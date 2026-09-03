// End-to-End: material.xlsx wird angelegt, Rückgabe addiert, Entnahme reduziert, Ansicht wird aufgebaut.

const fs = require('fs');
const path = require('path');

// Module-Cache löschen (alle .js-Dateien aus dem Projekt), damit kein
// gecachtes/altes Modul geladen wird.
for (const key of Object.keys(require.cache)) {
  if (key.includes('experten/') || key.includes('/lib/') || key.endsWith('material.js') || key.endsWith('kategorien.js')) {
    delete require.cache[key];
  }
}
const material = require('../material');
const rueckgabe = require('../experten/material_rueckgabe');
const entnahme = require('../experten/material_entnahme');

const TEST_PFAD = path.join(__dirname, '..', 'data', 'material.xlsx');
if (fs.existsSync(TEST_PFAD)) fs.unlinkSync(TEST_PFAD);

const kontext = {
  mainChat: () => Promise.resolve('{"positionen": []}'),
  schreibeEintrag: () => {}
};

async function run() {
  console.log('=== Schritt 1: Erste Rückgabe ===');
  // Markdown-Parser nutzen, keine KI nötig
  const text1 = `Material aus dem Auftrag Müller zurück:
3 Kugelhähne DN20 gebraucht
12m Kupferrohr 22mm neu
2 Pressfittinge 18mm neu`;
  const r1 = await rueckgabe.verarbeite({ chatId: 99999, text: text1 }, kontext);
  console.log(r1.antwort);
  console.log();

  console.log('=== Schritt 2: Bestand nach Rückgabe ===');
  const nach1 = await material.leseAlle(TEST_PFAD);
  console.log('Positionen:', nach1.length);
  nach1.forEach(p => {
    const total = (p.mengeNeu || 0) + (p.mengeGebraucht || 0) + (p.mengeVerschmutzt || 0);
    console.log(`  - ${p.bezeichnung} [${p.kategorie}]: ${p.mengeNeu} neu, ${p.mengeGebraucht} gebr., ${p.mengeVerschmutzt} verschm. = ${total} ${p.einheit}`);
  });
  console.log();

  console.log('=== Schritt 3: Mehr Ware zurück (Kupferrohr erhöhen, neues Material) ===');
  const text2 = `5m Kupferrohr 22mm neu dazu. 1 Stopfbuchse DN50 neu.`;
  const r2 = await rueckgabe.verarbeite({ chatId: 99999, text: text2 }, kontext);
  console.log(r2.antwort);
  console.log();

  console.log('=== Schritt 4: Entnahme ===');
  const text3 = `Entnommen für Auftrag Schmidt:
2 Kugelhähne DN20 gebraucht
3m Kupferrohr 22mm neu`;
  const r3 = await entnahme.verarbeite({ chatId: 99999, text: text3 }, kontext);
  console.log(r3.antwort);
  console.log();

  console.log('=== Schritt 5: Bestand nach allen Operationen ===');
  const nach5 = await material.leseAlle(TEST_PFAD);
  nach5.forEach(p => {
    const total = (p.mengeNeu || 0) + (p.mengeGebraucht || 0) + (p.mengeVerschmutzt || 0);
    console.log(`  - ${p.bezeichnung} [${p.kategorie}]: ${p.mengeNeu}/${p.mengeGebraucht}/${p.mengeVerschmutzt} = ${total} ${p.einheit}`);
  });
  console.log();

  console.log('=== Schritt 6: Suche ===');
  const treffer = await material.suchePositionen('Kupferrohr', nach5);
  console.log('Suche "Kupferrohr" findet:', treffer.length, 'Position(en)');
  treffer.forEach(p => console.log('  -', p.bezeichnung));
  console.log();

  console.log('=== Schritt 7: Bedarf prüfen ===');
  const bedarf = material.pruefeBedarf([
    { bezeichnung: 'Kupferrohr 22mm', menge: 50 },
    { bezeichnung: 'Kugelhähne DN20', menge: 5 }
  ], nach5);
  console.log('Bedarf:');
  bedarf.forEach(b => console.log(`  - ${b.bezeichnung}: ${b.verfuegbar} ${b.einheit} verfügbar (angefragt ${b.angefragt})`));
  console.log();

  console.log('=== Schritt 8: Excel-Datei prüfen ===');
  const stat = fs.statSync(TEST_PFAD);
  console.log('Datei:', TEST_PFAD, '(', stat.size, 'Bytes)');

  // Cleanup
  if (fs.existsSync(TEST_PFAD)) fs.unlinkSync(TEST_PFAD);
  console.log('=== Cleanup erledigt ===');
}

run().catch(e => { console.error('FEHLER:', e); process.exit(1); });
