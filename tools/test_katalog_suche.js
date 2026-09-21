// tools/test_katalog_suche.js — Demo + Smoke-Test der Katalog-Suche.
//
// Verwendung:
//   node tools/test_katalog_suche.js
//
// Erwartet: data/kataloge_index/*.json sind erzeugt.

'use strict';

const path = require('path');
const { findeSeiten, findeInAllenKatalogen } = require('../lib/katalog_suche');

const INDEX_DIR = path.join(__dirname, '..', 'data', 'kataloge_index');

// --- Test 1: findeSeiten mit einem einzelnen Katalog ---
async function testEinzel() {
  const fs = require('fs').promises;
  const path = require('path');
  const files = await fs.readdir(INDEX_DIR);
  const heizungFile = files.find(f => f.startsWith('GC_Heizung'));
  if (!heizungFile) {
    console.log('SKIP: GC_Heizung.json nicht gefunden');
    return;
  }
  const idx = JSON.parse(await fs.readFile(path.join(INDEX_DIR, heizungFile), 'utf-8'));

  // Test mit zwei Wortgruppen:
  //   - ["Kugelhahn"]   (sehr allgemein)
  //   - ["Wärmepumpe"]  (auch sehr allgemein)
  const ergebnisse = findeSeiten(idx, [['Kugelhahn'], ['Wärmepumpe']]);
  console.log(`Test 1 — GC_Heizung (${idx.seiten} Seiten)`);
  console.log(`  Wortgruppen: [['Kugelhahn'], ['Wärmepumpe']]`);
  console.log(`  Treffer: ${ergebnisse.length} Seiten`);
  if (ergebnisse.length > 0) {
    console.log('  Erste 3:');
    ergebnisse.slice(0, 3).forEach(t => {
      console.log(`    Seite ${t.seite} (matched: ${JSON.stringify(t.match)})`);
    });
  }
}

// --- Test 2: findeSeiten mit UND-Wortgruppe ---
async function testUnd() {
  const fs = require('fs').promises;
  const path = require('path');
  const files = await fs.readdir(INDEX_DIR);
  const instFile = files.find(f => f.startsWith('GC_Installation'));
  if (!instFile) {
    console.log('SKIP: GC_Installation.json nicht gefunden');
    return;
  }
  const idx = JSON.parse(await fs.readFile(path.join(INDEX_DIR, instFile), 'utf-8'));

  // UND: "Pressfitting" UND "DN20" müssen beide vorkommen
  const ergebnisse = findeSeiten(idx, [['Pressfitting', 'DN20']]);
  console.log(`\nTest 2 — GC_Installation (${idx.seiten} Seiten)`);
  console.log(`  Wortgruppe: ['Pressfitting', 'DN20'] (UND)`);
  console.log(`  Treffer: ${ergebnisse.length} Seiten`);
  if (ergebnisse.length > 0) {
    ergebnisse.slice(0, 3).forEach(t => {
      console.log(`    Seite ${t.seite} (matched: ${JSON.stringify(t.match)})`);
    });
  } else {
    console.log('  (keine Treffer — entweder keine Pressfittinge mit DN20 im Katalog, oder Wort-Schreibweise falsch)');
  }
}

// --- Test 3: findeInAllenKatalogen ---
async function testAlle() {
  // Synonyme/Schreibweisen für "Kugelhahn"
  const wortgruppen = [
    ['Kugelhahn'],     // Standard
    ['Kugelventil'],   // Synonym
    ['Kugelhahn', 'DN20'],   // mit Grösse
  ];
  console.log(`\nTest 3 — alle Kataloge`);
  console.log(`  Wortgruppen: ${JSON.stringify(wortgruppen)}`);
  const ergebnisse = await findeInAllenKatalogen(INDEX_DIR, wortgruppen);
  console.log(`  Kataloge mit Treffern: ${ergebnisse.length}`);
  ergebnisse.forEach(k => {
    console.log(`    ${k.katalog}: ${k.treffer.length} Seiten (von ${k.seiten_gesamt} total)`);
    if (k.treffer.length > 0) {
      console.log(`      Beispiele: Seiten ${k.treffer.slice(0, 5).map(t => t.seite).join(', ')}`);
    }
  });
}

// --- Test 4: Sonderzeichen / Wortgrenzen ---
async function testWortgrenzen() {
  const fs = require('fs').promises;
  const path = require('path');
  const files = await fs.readdir(INDEX_DIR);
  const target = files.find(f => f.startsWith('GC_Sanitaer'));
  if (!target) return;
  const idx = JSON.parse(await fs.readFile(path.join(INDEX_DIR, target), 'utf-8'));

  // "DN" sollte nicht in "DN20" matchen, "DN20" aber schon
  const nurDN = findeSeiten(idx, [['DN']]).length;
  const dn20 = findeSeiten(idx, [['DN20']]).length;
  console.log(`\nTest 4 — Wortgrenzen-Check in GC_Sanitaer`);
  console.log(`  "DN":   ${nurDN} Treffer (Wort muss alleine stehen)`);
  console.log(`  "DN20": ${dn20} Treffer`);
  console.log(`  (Wenn "DN" viel mehr Treffer hat als "DN20", greifen Wortgrenzen.)`);
}

async function main() {
  await testEinzel();
  await testUnd();
  await testAlle();
  await testWortgrenzen();
  console.log('\nFertig.');
}

main().catch(e => { console.error(e); process.exit(1); });
