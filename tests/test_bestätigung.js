// Reproduziert den Screenshot-Flow: diktieren -> bestätigen -> PDF
const fs = require('fs');
const path = require('path');
const matExp = require('../experten/materialaufmass');
const libUnterschrift = require('../lib/unterschrift');

const TEST_CHAT = 88888;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));

function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

cleanup();

// Setup: Unterschrift + Vorlage bereits da
fs.mkdirSync(TEST_DIR, { recursive: true });
libUnterschrift.speichereUnterschrift(TEST_CHAT, Buffer.from('FAKE-SIGNATURE'));

// Mock-KI: simuliert das Verhalten der echten KI
function mockMainChat(systemPrompt, userText) {
  const t = (userText || '').toLowerCase();
  console.log('  [Mock-KI] Input enthält "26-0311"?', t.includes('26-0311'));

  // Bei "passt", "fertig" o.ä. gibt die KI ein leeres JSON zurück,
  // weil sie keine Aufmaß-Daten findet. Genau wie in deinem Bug.
  if (/^(passt|fertig|weiter|ok|ja)/.test(t.trim())) {
    console.log('  [Mock-KI] -> Bestätigung, leeres JSON');
    return Promise.resolve(JSON.stringify({
      projekt: { nummer: null, bezeichnung: null },
      positionen: [],
      vollstaendig: false,
      fehlt: ['Projektnummer', 'Bezeichnung', 'mindestens 1 Position']
    }));
  }

  // Erste Diktat-Nachricht — wenn die Projektnummer erkennbar ist, voll parsen
  if (t.includes('26-0311')) {
    console.log('  [Mock-KI] -> Materialaufmaß erkannt, vollständiges JSON');
    return Promise.resolve(JSON.stringify({
      projekt: { nummer: '26-0311', bezeichnung: 'Umbau Trinkwasserverteiler' },
      positionen: [
        { name: 'Schwarzrohr DN 100', menge: 6, einheit: 'm', artikelnummer: null },
        { name: 'KFE-Ventil 1/2"', menge: 1, einheit: 'Stk.', artikelnummer: null },
        { name: 'Profipressbogen 15mm 90° innen', menge: 4, einheit: 'Stk.', artikelnummer: null },
        { name: 'Profipressbogen 15mm 45 innen außen', menge: 3, einheit: 'Stk.', artikelnummer: null }
      ],
      vollstaendig: true,
      fehlt: []
    }));
  }

  console.log('  [Mock-KI] -> Fallback leeres JSON');
  return Promise.resolve('{}');
}

const kontext = { mainChat: mockMainChat, schreibeEintrag: () => {} };

async function runTests() {
  console.log('=== Schritt 1: Diktat-Nachricht mit allen Daten ===');
  let r = await matExp.verarbeite({
    chatId: TEST_CHAT,
    text: 'Bitte erstelle ein Materialaufmaß zur Projektnummer 26-0311. Klartextbezeichnung ist Umbau Trinkwasserverteiler. Ja, so, als Materialposition habe ich ein Schwarzrohr DN 100, 6 Meter, ein KFE-Ventil, halb Zoll. Dann habe ich 3 mal Kupferbogen, Profipress heißt das, also Profipressbogen 15, 90 Grad innen, genau, davon wie gesagt 4 Stück. Dann noch 45 Grad Profipressbögen innen, außen, davon 3 Stück.'
  }, kontext);
  console.log('Antwort:');
  console.log(r.antwort);
  if (r._sendDocument) console.log('PDF:', r._sendDocument);
  console.log();

  // Session nach Schritt 1 prüfen
  const session1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
  console.log('Session nach Schritt 1:');
  console.log('  Projekt:', JSON.stringify(session1.projekt));
  console.log('  Positionen:', session1.positionen.length);
  console.log();

  console.log('=== Schritt 2: "passt. jetzt als pdf" ===');
  r = await matExp.verarbeite({
    chatId: TEST_CHAT,
    text: 'passt. jetzt als pdf'
  }, kontext);
  console.log('Antwort:');
  console.log(r.antwort);
  if (r._sendDocument) {
    console.log('PDF generiert:', r._sendDocument);
    const stat = fs.statSync(r._sendDocument);
    console.log('Größe:', stat.size, 'Bytes');

    // Session prüfen — sollte UNVERÄNDERT sein (nicht durch das leere JSON überschrieben)
    const session2 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
    console.log('Session nach Schritt 2 (sollte 4 Positionen haben):');
    console.log('  Projekt:', JSON.stringify(session2.projekt));
    console.log('  Positionen:', session2.positionen.length, '(erwartet: 4)');
  }
  console.log();

  // Cleanup
  cleanup();
  console.log('=== Cleanup erledigt ===');
}

runTests().catch((e) => {
  console.error('FEHLER:', e);
  cleanup();
  process.exit(1);
});
