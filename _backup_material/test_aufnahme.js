// Testet den Materialaufmaß-Experten end-to-end.
// Wir mocken die KI, damit wir die Pipeline ohne echte API durchspielen können.

const fs = require('fs');
const path = require('path');
const matExp = require('../experten/materialaufmass');
const libUnterschrift = require('../lib/unterschrift');

const TEST_CHAT = 88888;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));

// Aufräumen vor Test
function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

cleanup();

// Mock-KI, die verschiedene JSON-Extraktionen je nach Input zurückgibt.
// Bei "ändere"-Inputs liest sie die existierende Session und modifiziert sie.
function mockMainChat(systemPrompt, userText) {
  console.log('--- KI-Aufruf ---');
  console.log('  User-Input:', userText);

  // Existierende Session aus System-Prompt extrahieren (Mock-Vereinfachung)
  const sessionMatch = systemPrompt.match(/BISHERIGE SESSION[^\n]*\n([\s\S]+?)\n\n/);
  let existingSession = null;
  if (sessionMatch) {
    try { existingSession = JSON.parse(sessionMatch[1]); } catch {}
  }

  if (userText.includes('ändere Position 2 auf 5')) {
    if (existingSession && existingSession.positionen && existingSession.positionen[1]) {
      const updated = JSON.parse(JSON.stringify(existingSession));
      updated.positionen[1].menge = 5;
      return Promise.resolve(JSON.stringify({
        projekt: updated.projekt,
        positionen: updated.positionen,
        vollstaendig: true,
        fehlt: []
      }));
    }
  }

  // Standard-Fälle
  if (userText.includes('komplett')) {
    return Promise.resolve(JSON.stringify({
      projekt: { nummer: 'PRJ-2026-001', bezeichnung: 'Badsanierung Müller' },
      positionen: [
        { name: 'Kupferrohr 22mm', menge: 12, einheit: 'm', artikelnummer: null },
        { name: 'Wandscheibe DN20', menge: 3, einheit: 'Stk.', artikelnummer: 'WS-12345' }
      ],
      vollstaendig: true,
      fehlt: []
    }));
  }
  if (userText.includes('alles_fehlt')) {
    return Promise.resolve(JSON.stringify({
      projekt: { nummer: null, bezeichnung: null },
      positionen: [],
      vollstaendig: false,
      fehlt: ['Projektnummer', 'Bezeichnung', 'mindestens 1 Position']
    }));
  }
  if (userText.includes('nur_nummer')) {
    return Promise.resolve(JSON.stringify({
      projekt: { nummer: 'PRJ-2026-001', bezeichnung: null },
      positionen: [],
      vollstaendig: false,
      fehlt: ['Bezeichnung', 'mindestens 1 Position']
    }));
  }
  return Promise.resolve('{}');
}

const kontext = { mainChat: mockMainChat, schreibeEintrag: () => {} };

async function runTests() {
  console.log('=== Test 1: Alles auf einmal ===');
  let r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'Aufmaß komplett: PRJ-2026-001, Badsanierung Müller, 12m Kupferrohr 22mm, 3 Wandscheiben DN20 Art-Nr WS-12345' }, kontext);
  console.log('Antwort:', r.antwort);
  if (r._sendDocument) console.log('PDF generiert:', r._sendDocument);
  console.log('');

  console.log('=== Test 2: Nur Projektnummer, alles andere fehlt ===');
  cleanup();
  r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'Aufmaß nur_nummer: PRJ-2026-001' }, kontext);
  console.log('Antwort:', r.antwort);
  console.log('');

  console.log('=== Test 3: Nichts erkannt ===');
  cleanup();
  r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'Aufmaß alles_fehlt' }, kontext);
  console.log('Antwort:', r.antwort);
  console.log('');

  console.log('=== Test 4: Anpassung (Position 2 von 3 auf 5) ===');
  cleanup();
  // Erst alles erfassen
  await matExp.verarbeite({ chatId: TEST_CHAT, text: 'Aufmaß komplett: PRJ-2026-001, Badsanierung Müller, 12m Kupferrohr 22mm, 3 Wandscheiben DN20 Art-Nr WS-12345' }, kontext);
  // Dann anpassen
  r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'ändere Position 2 auf 5 Stück' }, kontext);
  console.log('Antwort:', r.antwort);
  if (r._sendDocument) {
    console.log('PDF generiert (nach Anpassung):', r._sendDocument);
    // Schau in die Session, ob Position 2 wirklich 5 ist
    const session = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    console.log('Session nach Anpassung:', JSON.stringify(session.positionen, null, 2));
  }
  console.log('');

  console.log('=== Test 5: Unterschrift hochladen ===');
  const fakeUnterschrift = Buffer.from('FAKE-IMAGE-DATA-FOR-UNTERSCHRIFT');
  await libUnterschrift.speichereUnterschrift(TEST_CHAT, fakeUnterschrift);
  console.log('Unterschrift gespeichert:', libUnterschrift.hatUnterschrift(TEST_CHAT));
  console.log('');

  console.log('=== Test 6: Komplett mit Unterschrift -> PDF generieren ===');
  r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'Aufmaß komplett: PRJ-2026-001, Badsanierung Müller, 12m Kupferrohr 22mm, 3 Wandscheiben DN20 Art-Nr WS-12345' }, kontext);
  console.log('Antwort:', r.antwort);
  if (r._sendDocument) {
    const stat = fs.statSync(r._sendDocument);
    console.log('PDF-Datei:', r._sendDocument, '(Größe:', stat.size, 'Bytes)');
  }
  console.log('');

  console.log('=== Test 7: Abbruch ===');
  r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'stop' }, kontext);
  console.log('Antwort:', r.antwort);
  const sessionExists = fs.existsSync(path.join(TEST_DIR, 'aufnahme_session.json'));
  console.log('Session nach Abbruch gelöscht:', !sessionExists);
}

runTests().then(() => {
  console.log('\n=== Cleanup ===');
  cleanup();
  console.log('Test-Verzeichnis entfernt.');
}).catch((err) => {
  console.error('FEHLER:', err);
  cleanup();
  process.exit(1);
});
