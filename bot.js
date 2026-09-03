// Einstiegspunkt.
//
// Diese Datei verdrahtet nur noch: Konfiguration prüfen, KI-Anbieter wählen,
// Adapter starten. Der eigentliche Ablauf liegt in kern/, der Telegram-Bezug
// in adapter/telegram.js, die Fachlogik in experten/.
//
//   adapter/telegram.js   Ein- und Ausgabe (austauschbar)
//         │
//   kern/orchestrator.js  Ablauf: Router → Thema → Experte → Antwort
//         ├─ kern/router.js         EINE Entscheidung: Faden + Aktion + Experte
//         ├─ kern/vorgang.js        Vorgangszustand, am Thema (parallele Fäden)
//         ├─ kern/vorgangsmotor.js  sammeln, nachfragen, ausführen (generisch)
//         ├─ kern/werkzeuge.js      globale + experteneigene Tools
//         └─ kern/toolloop.js       Tool-Schleife mit Nutzer-Freigabe
//         │
//   experten/*.js         Fachlogik als Plugins (Auto-Load)
//   providers/, dienste/  austauschbare KI-Anbieter und Fach-APIs

require('dotenv').config();

const fs = require('fs');
const { PFADE } = require('./config');
const { getProvider } = require('./providers');
const experten = require('./experten');
const adapter = require('./adapter/telegram');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN fehlt in der .env');
  process.exit(1);
}

// Auf Railway muss unter /app/data ein Volume liegen, sonst sind nach dem
// nächsten Deploy alle Themen, Vorgänge und das Gedächtnis weg.
try {
  fs.mkdirSync(PFADE.USERS, { recursive: true });
} catch (err) {
  console.error('WARNUNG: data/ ist nicht beschreibbar. Ohne gemountetes Volume ' +
    'gehen alle Daten beim nächsten Redeploy verloren. Ursache: ' + err.message);
}

const mainProvider = getProvider('main');
const lightProvider = getProvider('light');

// Dünne Wrapper: Aufrufer bekommen nur den Text, nicht das ganze Provider-Objekt.
const mainChat = async (systemPrompt, userMessage, opts = {}) =>
  (await mainProvider.chat(systemPrompt, userMessage, { ...opts, rolle: 'main' })).content;
const lightChat = async (systemPrompt, userMessage, opts = {}) =>
  (await lightProvider.chat(systemPrompt, userMessage, { ...opts, rolle: 'light' })).content;

const geladen = experten.listeStatus();
console.log(`Provider main:  ${mainProvider.name}`);
console.log(`Provider light: ${lightProvider.name}`);
console.log(`Experten: ${geladen.filter((e) => e.implementiert).map((e) => e.id).join(', ') || '(keine)'}` +
  (geladen.some((e) => !e.implementiert)
    ? ` | Stubs: ${geladen.filter((e) => !e.implementiert).map((e) => e.id).join(', ')}` : ''));
if (process.env.BRAVE_API_KEY || process.env.JINA_API_KEY) {
  console.log('Web-Tools aktiv: ' +
    [process.env.BRAVE_API_KEY && 'web_search', process.env.JINA_API_KEY && 'web_fetch']
      .filter(Boolean).join(' '));
}

adapter.starte({ token, provider: mainProvider, mainChat, lightChat });
