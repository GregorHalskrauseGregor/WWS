// Minimal-Test: nur die material.addierePositionen
const fs = require('fs');
const path = require('path');
const material = require('../material');

const TEST_PFAD = path.join(__dirname, '..', 'data', 'material.xlsx');
if (fs.existsSync(TEST_PFAD)) fs.unlinkSync(TEST_PFAD);

async function run() {
  console.log('Datei existiert vorher?', fs.existsSync(TEST_PFAD));
  const result = await material.addierePositionen([
    { bezeichnung: 'Kugelhähne DN20', menge: 3, einheit: 'Stk.', zustand: 'gebraucht' },
    { bezeichnung: 'Kupferrohr 22mm', menge: 12, einheit: 'm', zustand: 'neu' }
  ], TEST_PFAD);
  console.log('Result:', JSON.stringify(result, null, 2));
  console.log('Datei existiert nachher?', fs.existsSync(TEST_PFAD));
  if (fs.existsSync(TEST_PFAD)) fs.unlinkSync(TEST_PFAD);
}

run().catch(e => console.error('FEHLER:', e));
