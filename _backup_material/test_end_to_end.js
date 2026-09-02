// End-to-End: Markdown-KI wie im Screenshot, dann "jetzt als pdf"

const fs = require('fs');
const path = require('path');
const matExp = require('../experten/materialaufmass');
const libUnterschrift = require('../lib/unterschrift');

const TEST_CHAT = 88888;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
libUnterschrift.speichereUnterschrift(TEST_CHAT, Buffer.from('FAKE'));

// KI simuliert: zuerst Markdown (Screenshot-Fall), dann leeres JSON
function mockMainChat(systemPrompt, userText) {
  const t = (userText || '').toLowerCase();
  if (t.includes('26-0111') || t.includes('heizraumumbau')) {
    // Genau die Markdown-Antwort wie im Screenshot
    return Promise.resolve(`**Projekt-Nr.:** 26-0111
**Bezeichnung:** Heizraumumbau
**Datum:** ${new Date().toLocaleDateString('de-DE')}

| Pos. | Material | Menge | Einheit |
|------|----------|-------|---------|
| 1 | Schwarzrohr DN 50 | 12 | m |
| 2 | KFR-Ventil 1" (Rotguss) | 1 | St. |

Falls du noch weitere Positionen ergänzen möchtest.`);
  }
  // Bei "jetzt als pdf" oder "fertig" — leeres JSON
  return Promise.resolve('{"projekt":{"nummer":null,"bezeichnung":null},"positionen":[],"vollstaendig":false,"fehlt":["Projektnummer","Bezeichnung","mindestens 1 Position"]}');
}

const kontext = { mainChat: mockMainChat, schreibeEintrag: () => {} };

async function run() {
  console.log('=== Schritt 1: Diktat-Nachricht ===');
  let r = await matExp.verarbeite({
    chatId: TEST_CHAT,
    text: 'Bitte schreibe mir ein Aufmaß zum Material für die Projektnummer 26-0111. Bezeichnung ist Heizraumumbau. Folgende Materialposition bitte hinzufügen: Schwarzrohr DN 50, 12 Meter, und ein KFR-Ventil 1 Zoll, Rotguss.'
  }, kontext);
  console.log('Antwort:');
  console.log(r.antwort);
  if (r._sendDocument) console.log('PDF:', r._sendDocument);
  console.log();

  // Session-Inhalt prüfen
  const session1 = JSON.parse(fs.readFileSync(path.join(TEST_DIR, 'aufnahme_session.json'), 'utf-8'));
  console.log('Session nach Schritt 1:');
  console.log('  Projekt:', JSON.stringify(session1.projekt));
  console.log('  Positionen:', session1.positionen.length, '(erwartet: 2)');
  console.log();

  console.log('=== Schritt 2: "jetzt als pdf" ===');
  r = await matExp.verarbeite({ chatId: TEST_CHAT, text: 'jetzt als pdf' }, kontext);
  console.log('Antwort:');
  console.log(r.antwort);
  if (r._sendDocument) {
    console.log();
    console.log('✅ PDF generiert:', r._sendDocument);
    const stat = fs.statSync(r._sendDocument);
    console.log('   Größe:', stat.size, 'Bytes');
  }
  console.log();

  // Cleanup
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('=== Cleanup erledigt ===');
}

run().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
