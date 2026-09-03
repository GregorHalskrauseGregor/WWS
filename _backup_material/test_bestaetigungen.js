// Testet Problem 5: Router-KI erkennt User-Bestätigungen bei aktiver Session.

const fs = require('fs');
const path = require('path');
for (const key of Object.keys(require.cache)) delete require.cache[key];

const router = require('../lib/router');
const matExp = require('../experten/materialaufmass');

const TEST_CHAT = 99999;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });

// Setup: eine aktive Materialaufmaß-Session mit 9 Positionen simulieren
fs.mkdirSync(TEST_DIR, { recursive: true });
const aktiveSession = {
  zuletztGeaendert: new Date().toISOString(),
  projekt: { nummer: '26-0277', bezeichnung: 'Heizraum Müller' },
  positionen: [
    { name: 'Meblerbogen 16mm', menge: 10, einheit: 'Stk.', zustand: 'neu' },
    { name: 'Kupferrohr 22mm', menge: 12, einheit: 'm', zustand: 'neu' }
  ]
};
fs.writeFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), JSON.stringify(aktiveSession, null, 2));

// Mock-KI für den Router
function mockKI(szenarien) {
  return async (systemPrompt, userText) => {
    const t = userText.toLowerCase();
    for (const s of szenarien) {
      if (t.includes(s.match)) {
        return JSON.stringify(s.response);
      }
    }
    // Default: konversation
    return JSON.stringify({ aktion: 'konversation', confidence: 0.9 });
  };
}

async function test(name, userText, expectedAktion, expectedExperte) {
  console.log('\n=== ' + name + ' ===');
  const kiMock = mockKI([{
    match: userText.toLowerCase(),
    response: { aktion: expectedAktion, experte: expectedExperte, confidence: 0.9 }
  }]);
  const result = await router.routingEntscheidung({
    text: userText,
    dokInfo: null,
    chatId: TEST_CHAT,
    kontext: { mainChat: kiMock, letzteNachrichten: async () => [] }
  });
  if (result.aktion === expectedAktion && (!expectedExperte || result.experte === expectedExperte)) {
    console.log('  ✅ PASS  (Aktion: ' + result.aktion + ', Experte: ' + result.experte + ')');
  } else {
    console.log('  ❌ FAIL — erwartet: ' + expectedAktion + ' / ' + expectedExperte + ', bekommen: ' + result.aktion + ' / ' + result.experte);
  }
}

async function run() {
  // User-Bestätigungen, die den Materialaufmaß-Workflow auslösen sollen
  await test('"fertig"', 'fertig', 'verarbeiten', 'materialaufmass');
  await test('"passt"', 'passt', 'verarbeiten', 'materialaufmass');
  await test('"stimmt"', 'stimmt so', 'verarbeiten', 'materialaufmass');
  await test('"jetzt zum pdf"', 'jetzt zum pdf', 'verarbeiten', 'materialaufmass');
  await test('"PDF bitte"', 'PDF bitte', 'verarbeiten', 'materialaufmass');
  await test('"erstelle das PDF"', 'erstelle das PDF', 'verarbeiten', 'materialaufmass');
  await test('"mache das PDF"', 'mache das PDF jetzt', 'verarbeiten', 'materialaufmass');

  // Anpassungen
  await test('"ändere Position 1 auf 5"', 'ändere Position 1 auf 5', 'verarbeiten', 'materialaufmass');
  await test('"Position 2 raus"', 'Position 2 raus', 'verarbeiten', 'materialaufmass');

  // Ergänzungen
  await test('"2 mehr"', 'noch 2 mehr dazu', 'verarbeiten', 'materialaufmass');
  await test('"X dazu"', 'X dazu', 'verarbeiten', 'materialaufmass');

  // Was NICHT materialaufmass triggern sollte
  await test('"Hallo" → konversation (kein Materialaufmaß-Trigger)', 'Hallo, wie geht es dir?', 'konversation', null);
  await test('"Danke" → konversation', 'Danke!', 'konversation', null);

  // Cleanup
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
}

run().catch(e => { console.error('FEHLER:', e); process.exit(1); });
