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
const { getProvider, uebersicht } = require('./providers');
const fachdienste = require('./dienste');
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

// Ein Anbieter je Aufgabe — konfigurierbar, mit Fallback-Kette (siehe providers/index.js).
const chatProvider = getProvider('chat');
const nurText = (provider) => async (systemPrompt, userMessage, opts = {}) =>
  (await provider.chat(systemPrompt, userMessage, opts)).content;

const antwortChat = nurText(chatProvider);
const routerChat = nurText(getProvider('router'));
const extraktionChat = nurText(getProvider('extraktion'));
const summaryChat = nurText(getProvider('summary'));

const geladen = experten.listeStatus();
for (const r of uebersicht()) {
  console.log(`Anbieter ${r.rolle.padEnd(11)} ${r.anbieter} (${r.modell})`);
}
for (const d of fachdienste.status()) {
  console.log(`Dienst   ${d.art.padEnd(14)} ` +
    d.kette.map((a) => `${a.name}${a.bereit ? '' : ' (kein Key)'}`).join(' -> ') || '(keiner)');
}
console.log(`Experten: ${geladen.filter((e) => e.implementiert).map((e) => e.id).join(', ') || '(keine)'}` +
  (geladen.some((e) => !e.implementiert)
    ? ` | Stubs: ${geladen.filter((e) => !e.implementiert).map((e) => e.id).join(', ')}` : ''));
adapter.starte({ token, provider: chatProvider, antwortChat, routerChat, extraktionChat, summaryChat });
