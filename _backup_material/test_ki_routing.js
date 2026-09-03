// Testet die KI-basierte Experten-Auswahl mit gemocktem Provider.

const fs = require('fs');
const path = require('path');

// Cache leeren
for (const key of Object.keys(require.cache)) delete require.cache[key];

const experten = require('../experten');

// Mock-KI: gibt je nach Input unterschiedliche Experten-Empfehlungen zurück
function mockKI({ text, returnValue, shouldThrow = false }) {
  return async (systemPrompt, userMessage) => {
    console.log('  [KI-Aufruf] user:', userMessage.slice(0, 60));
    if (shouldThrow) throw new Error('KI-Fehler simuliert');
    if (returnValue) return JSON.stringify(returnValue);
    return 'null'; // Fallback
  };
}

async function test(name, nachricht, kiReturn, expectedExperteId) {
  console.log('\\n=== ' + name + ' ===');
  console.log('  User:', nachricht);
  const experte = await experten.waehleExpertenMitKI({
    text: nachricht,
    chatId: 99999,
    kontext: { mainChat: mockKI({ returnValue: kiReturn }) }
  });
  if (experte) {
    console.log('  → Experte gewählt:', experte.id, '(' + experte.name + ')');
    console.log('  Erwartet:', expectedExperteId);
    if (experte.id === expectedExperteId) {
      console.log('  ✅ PASS');
    } else {
      console.log('  ❌ FAIL');
    }
  } else {
    console.log('  → Kein Experte (Standard-Chat)');
    if (expectedExperteId === null) {
      console.log('  ✅ PASS');
    } else {
      console.log('  ❌ FAIL — erwartet:', expectedExperteId);
    }
  }
}

async function run() {
  // Test 1: Recherche-Trigger
  await test(
    'Test 1: "suche im netz nach Anleitung für ECL310"',
    'suche im netz nach einer anleitung für ECL310 regler',
    { experte: 'recherche', confidence: 0.95, grund: 'Web-Suche nach Anleitung' },
    'recherche'
  );

  // Test 2: "höchste Leistung in Kategorie" - sollte NICHT Leistungserfassung triggern
  await test(
    'Test 2: "logablend mit höchster Leistung in Kategorie"',
    'logablend mit der höchsten leistung in seiner kategorie',
    { experte: 'recherche', confidence: 0.85, grund: 'Brenner-Eigenschaft, keine Rechnung' },
    'recherche'
  );

  // Test 3: Materialaufmaß-Trigger
  await test(
    'Test 3: "Aufmaß mit 3m Kupferrohr"',
    'Materialaufmaß PRJ-001, 12m Kupferrohr 22mm',
    { experte: 'materialaufmass', confidence: 0.95, grund: 'Aufmaß-Erfassung' },
    'materialaufmass'
  );

  // Test 4: Niedrige Confidence → kein Experte
  await test(
    'Test 4: Confidence 0.5 → kein Experte',
    'Hallo, wie geht es dir?',
    { experte: 'recherche', confidence: 0.5, grund: 'Unsicher' },
    null
  );

  // Test 5: KI antwortet null → kein Experte
  await test(
    'Test 5: KI sagt null → kein Experte',
    'Guten Morgen!',
    { experte: null, confidence: 1.0, grund: 'Normale Konversation' },
    null
  );

  // Test 6: KI gibt ungültiges JSON → Fallback
  console.log('\\n=== Test 6: KI gibt ungültiges JSON → Fallback ===');
  console.log('  User: "Hallo"');
  const experte = await experten.waehleExpertenMitKI({
    text: 'Hallo',
    chatId: 99999,
    kontext: { mainChat: async () => 'Das ist kein JSON, nur Text' }
  });
  console.log('  →', experte ? experte.id : 'kein Experte (richtig)');

  // Test 7: KI wirft Error → Fallback
  console.log('\\n=== Test 7: KI wirft Error → Fallback ===');
  const experte7 = await experten.waehleExpertenMitKI({
    text: 'Hallo',
    chatId: 99999,
    kontext: { mainChat: mockKI({ shouldThrow: true }) }
  });
  console.log('  →', experte7 ? experte7.id : 'kein Experte (richtig)');

  // Test 8: Stubs werden gar nicht erst angeboten
  console.log('\\n=== Test 8: Stubs (Leistungserfassung, Bestellung) sind nicht implementiert ===');
  const stubAufruf = await experten.waehleExpertenMitKI({
    text: 'Ich brauche eine Rechnung',
    chatId: 99999,
    kontext: { mainChat: async () => JSON.stringify({
      experte: 'leistungserfassung', confidence: 0.99
    }) }
  });
  console.log('  →', stubAufruf ? stubAufruf.id : 'kein Experte (richtig — Stub wird gefiltert)');

  // Test 9: implementierteExperten() filtert Stubs
  console.log('\\n=== Test 9: implementierteExperten() ===');
  const alle = experten.listeStatus();
  const impl = experten.implementierteExperten();
  console.log('  Alle Experten:', alle.map(e => e.id + (e.implementiert ? '' : ' (Stub)')).join(', '));
  console.log('  Implementierte:', impl.map(e => e.id).join(', '));
}

run().catch(e => { console.error('FEHLER:', e); process.exit(1); });
