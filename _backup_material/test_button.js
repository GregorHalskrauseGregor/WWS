// Testet den kompletten Button-Flow: diktieren -> Button wird gezeigt ->
// callback auf aufmass_pdf -> PDF wird generiert

const fs = require('fs');
const path = require('path');
const matExp = require('../experten/materialaufmass');
const libUnterschrift = require('../lib/unterschrift');

const TEST_CHAT = 88888;
const TEST_DIR = path.join(__dirname, '..', 'data', 'users', String(TEST_CHAT));
if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
fs.mkdirSync(TEST_DIR, { recursive: true });
libUnterschrift.speichereUnterschrift(TEST_CHAT, Buffer.from('FAKE'));

// Mock-KI: simuliert Markdown-Antwort
function mockMainChat() {
  return Promise.resolve(`**Projekt-Nr.:** 26-0111
**Bezeichnung:** Heizraumumbau
| Pos. | Material | Menge | Einheit |
| 1 | Schwarzrohr DN 50 | 12 | m |
| 2 | KFR-Ventil 1" | 1 | St. |`);
}

// Mock-Bot: sendet nichts wirklich, protokolliert nur
let lastSentMessage = null;
let lastSentButtons = null;
const mockBot = {
  sendMessage: async (chatId, text, opts) => {
    lastSentMessage = { chatId, text, opts };
    if (opts && opts.reply_markup && opts.reply_markup.inline_keyboard) {
      lastSentButtons = opts.reply_markup.inline_keyboard;
    }
    return { message_id: 12345 };
  },
  editMessageReplyMarkup: async () => ({}),
  sendDocument: async (chatId, doc) => ({ document: doc }),
  answerCallbackQuery: async () => ({}),
  getFileLink: async () => 'http://example.com/file'
};

const kontext = { mainChat: mockMainChat, schreibeEintrag: () => {}, bot: mockBot };

async function run() {
  console.log('=== Schritt 1: Diktat-Nachricht ===');
  lastSentMessage = null;
  lastSentButtons = null;
  const r1 = await matExp.verarbeite({
    chatId: TEST_CHAT,
    text: 'Aufmaß 26-0111 Heizraumumbau, 12m Schwarzrohr DN 50, 1 KFR-Ventil 1 Zoll'
  }, kontext);
  console.log('Antwort:', r1.antwort ? r1.antwort.slice(0, 100) : '(null)');
  console.log('_inlineButton:', r1._inlineButton);
  console.log('Button gesendet?', !!lastSentButtons);
  if (lastSentButtons) {
    console.log('  Buttons:');
    lastSentButtons[0].forEach(b => console.log('    -', b.text, '(' + b.callback_data + ')'));
  }
  console.log();

  console.log('=== Schritt 2: User klickt "PDF erstellen" ===');
  const r2 = await matExp.onCallback(TEST_CHAT, 'aufmass_pdf', kontext);
  console.log('Antwort:', r2.antwort);
  console.log('_sendDocument:', r2._sendDocument);
  if (r2._sendDocument) {
    const stat = fs.statSync(r2._sendDocument);
    console.log('PDF-Größe:', stat.size, 'Bytes');
  }
  console.log();

  console.log('=== Schritt 3: User klickt "Abbrechen" ===');
  const r3 = await matExp.onCallback(TEST_CHAT, 'aufmass_abbrechen', kontext);
  console.log('Antwort:', r3.antwort);
  const sessionExists = fs.existsSync(path.join(TEST_DIR, 'aufnahme_session.json'));
  console.log('Session gelöscht?', !sessionExists);
  console.log();

  console.log('=== Schritt 4: User klickt "Anpassen" ===');
  // Session wiederherstellen
  await matExp.verarbeite({
    chatId: TEST_CHAT,
    text: 'Aufmaß 26-0111 Heizraumumbau, 12m Schwarzrohr DN 50, 1 KFR-Ventil 1 Zoll'
  }, kontext);
  const r4 = await matExp.onCallback(TEST_CHAT, 'aufmass_anpassen', kontext);
  console.log('Antwort:', r4.antwort);
  console.log();

  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  console.log('=== Cleanup erledigt ===');
}

run().catch((e) => { console.error('FEHLER:', e); process.exit(1); });
