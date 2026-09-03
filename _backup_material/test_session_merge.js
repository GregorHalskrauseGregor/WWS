// Testet Problem 1: Session-Merge-Logik.
// Verifiziert, dass die existierenden Positionen nicht verloren gehen, wenn
// die KI in einer Folgenachricht nur Teil-Extraktionen macht (z.B. nur Projektnummer).

const fs = require('fs');
const path = require('path');
for (const key of Object.keys(require.cache)) delete require.cache[key];

const matExp = require('../experten/materialaufmass');

const TEST_CHAT = 99999;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });

// Mock-KI gibt je nach Input unterschiedliche Extraktionen zurück
function mockKI(szenarien) {
  return async (systemPrompt, userText) => {
    for (const s of szenarien) {
      if (userText.includes(s.match)) {
        return JSON.stringify(s.response);
      }
    }
    return JSON.stringify({ projekt: { nummer: null, bezeichnung: null }, positionen: [], vollstaendig: false, fehlt: [] });
  };
}

const kontext = {
  mainChat: mockKI([
    // 1. Diktat: 9 Positionen, keine Stammdaten
    { match: 'Diktat', response: {
        projekt: { nummer: null, bezeichnung: null },
        positionen: [
          { name: 'Meblerbogen 16mm', menge: 10, einheit: 'Stk.', zustand: 'neu' },
          { name: 'Meblerbogen 16mm 45°', menge: 7, einheit: 'Stk.', zustand: 'neu' },
          { name: 'Mebla-Rohr vorisoliert 16mm', menge: 1, einheit: 'Rolle', zustand: 'neu' },
          { name: 'Grundfos Magna 3', menge: 1, einheit: 'Stk.', zustand: 'neu' },
          { name: 'Kronenklick 16mm', menge: 16, einheit: 'Stk.', zustand: 'neu' },
          { name: 'Schwarzrohr DN 100', menge: 8, einheit: 'm', zustand: 'neu' },
          { name: 'Schwarzrohr DN 80', menge: 7, einheit: 'm', zustand: 'neu' },
          { name: 'Rohrschelle DN 100', menge: 8, einheit: 'Stk.', zustand: 'neu' },
          { name: 'Rohrschelle DN 80', menge: 7, einheit: 'Stk.', zustand: 'neu' }
        ],
        vollstaendig: false,
        fehlt: ['Projektnummer', 'Bezeichnung']
      }
    },
    // 2. Stammdaten: nur Projektnummer + Bezeichnung
    { match: '26-0277', response: {
        projekt: { nummer: '26-0277', bezeichnung: 'Heizraum Müller' },
        positionen: [],
        vollstaendig: false,
        fehlt: ['mindestens 1 Position']
      }
    }
  ]),
  schreibeEintrag: () => {}
};

async function test(name, action) {
  console.log('\n=== ' + name + ' ===');
  const result = await action();
  if (result.pass) {
    console.log('  ✅ PASS');
  } else {
    console.log('  ❌ FAIL — ' + result.reason);
  }
}

async function run() {
  // Schritt 1: Diktat mit 9 Positionen
  await test('Schritt 1: Diktat mit 9 Positionen', async () => {
    await matExp.verarbeite({
      chatId: TEST_CHAT,
      text: 'Diktat: 10 Meblerbogen 16mm, 7 Meblerbogen 16mm 45°, 1 Mebla-Rohr vorisoliert 16mm, 1 Grundfos Magna 3, 16 Kronenklick 16mm, 8 Schwarzrohr DN 100, 7 Schwarzrohr DN 80, 8 Rohrschelle DN 100, 7 Rohrschelle DN 80'
    }, kontext);

    const session = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    if (session.positionen.length !== 9) {
      return { pass: false, reason: 'Erwartet 9 Positionen, gefunden ' + session.positionen.length };
    }
    return { pass: true };
  });

  // Schritt 2: User schickt nur Projektnummer + Bezeichnung — Positionen müssen bleiben
  await test('Schritt 2: Projektnummer hinzufügen → Positionen bleiben erhalten', async () => {
    await matExp.verarbeite({
      chatId: TEST_CHAT,
      text: '26-0277, Heizraum Müller'
    }, kontext);

    const session = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    if (session.positionen.length !== 9) {
      return { pass: false, reason: 'Erwartet 9 Positionen, gefunden ' + session.positionen.length + ' — DATENVERLUST!' };
    }
    if (session.projekt.nummer !== '26-0277') {
      return { pass: false, reason: 'Projektnummer nicht gesetzt' };
    }
    if (session.projekt.bezeichnung !== 'Heizraum Müller') {
      return { pass: false, reason: 'Bezeichnung nicht gesetzt' };
    }
    return { pass: true };
  });

  // Schritt 3: User schickt nur Bezeichnung (Projektnummer schon da) — beides soll bleiben
  await test('Schritt 3: Bezeichnung ändern — Projektnummer bleibt', async () => {
    await matExp.verarbeite({
      chatId: TEST_CHAT,
      text: 'Projektname geändert: Heizraum Müller-Süd'
    }, kontext);

    const session = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    if (session.positionen.length !== 9) {
      return { pass: false, reason: 'Erwartet 9 Positionen, gefunden ' + session.positionen.length };
    }
    // Die KI extrahiert hier nichts substantielles, alles sollte bleiben
    if (session.projekt.nummer !== '26-0277') {
      return { pass: false, reason: 'Projektnummer sollte unverändert sein' };
    }
    return { pass: true };
  });

  // Schritt 4: Leere Bestätigung (z.B. "passt") — nichts darf überschrieben werden
  await test('Schritt 4: "passt" / Bestätigung ohne Daten — Session bleibt intakt', async () => {
    const sessionVorher = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    await matExp.verarbeite({
      chatId: TEST_CHAT,
      text: 'passt'
    }, kontext);

    const sessionNachher = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    if (sessionNachher.positionen.length !== sessionVorher.positionen.length) {
      return { pass: false, reason: 'Positionen wurden verändert!' };
    }
    return { pass: true };
  });

  // Cleanup
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

run().catch(e => { console.error('FEHLER:', e); process.exit(1); });
