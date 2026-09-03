const experten = require('../experten');
const matExp = require('../experten/materialaufmass');
const fs = require('fs');
const path = require('path');

const TEST_CHAT = 77777;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });

console.log('--- Test 1: Keine Session ---');
const a1 = experten.aktiverExperte(TEST_CHAT);
console.log('Aktiver Experte:', a1 ? a1.id : '(keiner)  ERWARTET: keiner');
console.log('');

console.log('--- Test 2: Session mit nur Projektnummer ---');
fs.mkdirSync(TEST_DIR, { recursive: true });
matExp._internals.speichereSession(TEST_CHAT, {
  zuletztGeaendert: new Date().toISOString(),
  projekt: { nummer: 'PRJ-2026-001', bezeichnung: null },
  positionen: []
});
const a2 = experten.aktiverExperte(TEST_CHAT);
console.log('Aktiver Experte:', a2 ? a2.id : '(keiner)  ERWARTET: materialaufmass');
console.log('');

console.log('--- Test 3: Session geloescht ---');
matExp._internals.loescheSession(TEST_CHAT);
const a3 = experten.aktiverExperte(TEST_CHAT);
console.log('Aktiver Experte:', a3 ? a3.id : '(keiner)  ERWARTET: keiner');
console.log('');

console.log('--- Test 4: Session aktiv, Trigger "suche nach wetter" (Recherche-Trigger) ---');
matExp._internals.speichereSession(TEST_CHAT, {
  zuletztGeaendert: new Date().toISOString(),
  projekt: { nummer: 'PRJ-X', bezeichnung: 'Test' },
  positionen: [{ name: 'Test', menge: 1, einheit: 'Stk.' }]
});
const a4 = experten.aktiverExperte(TEST_CHAT);
const triggerMatch = experten.findeExperte('suche nach wetter');
console.log('Aktiver Experte:', a4 ? a4.id : '(keiner)  ERWARTET: materialaufmass');
console.log('Trigger-Match:', triggerMatch ? triggerMatch.id : '(keiner)  ERWARTET: recherche');
console.log('-> Bot-Logik priorisiert: aktiver Experte gewinnt');
console.log('');

if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
console.log('--- Test beendet ---');
