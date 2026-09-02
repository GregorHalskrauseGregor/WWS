// Telegram-Chatbot mit Themen-Verwaltung, Gedächtnis und Kontext-Komprimierung.
//
// Datenfluss pro eingehender Nachricht:
//   1) Vorverarbeitung zu Text (OCR / Transkription / Datei-Auslese)
//   2) Themen-Klassifikation per Light-Provider (gibt es ein passendes Thema?)
//   3) Aktives Thema laden (oder neues anlegen)
//   4) Kontext zusammenbauen (System-Rolle + Gedächtnis + Themen-Summary + Verlauf)
//   5) Haupt-KI antworten lassen
//   6) [MERKE: ...]-Hooks aus der Antwort rausfiltern und ins Gedächtnis schreiben
//   7) Antwort an Telegram senden
//   8) Nachricht ins Thema anhängen
//   9) Komprimierung anstoßen, wenn Schwellen überschritten
//
// Multi-User: Jeder Telegram-Chat bekommt eigene Themen, eigenes Gedächtnis.

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');
const { transkribiere } = require('./transcribe');
const { mistralOCR } = require('./ocr');
const { excelZuText, wordZuText } = require('./dokument');
const themen = require('./themen');
const gedaechtnis = require('./gedaechtnis');
const kompressor = require('./kompressor');
const kontext = require('./kontext');
const toolsModul = require('./tools');
const sicherheit = require('./sicherheit');
const ratelimit = require('./ratelimit');
const benutzer = require('./benutzer');
const experten = require('./experten');
const { schreibeEintrag, leseLetzte } = require('./protokoll');
const { ladeBegruessung } = require('./begruessung');
const { getProvider } = require('./providers');

// Telegram-Limit pro Nachricht. Wir teilen lange Antworten an Zeilenumbrüchen auf.
const TELEGRAM_MAX = 3800;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN fehlt in der .env');
  process.exit(1);
}

// Sanity-Check: kann der Bot ins data/-Verzeichnis schreiben? Auf Railway muss
// dort ein Volume gemountet sein, sonst sind nach dem nächsten Redeploy alle
// Themen/Gedächtnis/Protokoll weg. Wir schreiben nicht — wir versuchen nur mkdir.
try {
  require('fs').mkdirSync(path.join(__dirname, 'data', 'users'), { recursive: true });
} catch (err) {
  console.error('WARNUNG: data/-Verzeichnis ist nicht beschreibbar. ' +
    'In Railway muss unter /app/data ein Volume gemountet sein, sonst ' +
    'gehen alle gespeicherten Daten bei jedem Redeploy verloren. Ursache: ' + err.message);
}

const bot = new TelegramBot(token, { polling: true });
const mainProvider = getProvider('main');
const lightProvider = getProvider('light');

// Hauptprovider muss Tool-Use unterstützen — wir bauen das für alle drei
// Provider so, dass es geht (Anthropic/OpenAI nativ, MiniMax per XML-Parser).
const mainToolProvider = mainProvider;

console.log('Provider main: ' + mainProvider.name);
console.log('Provider light: ' + lightProvider.name);
if (process.env.BRAVE_API_KEY || process.env.JINA_API_KEY) {
  const tools = (process.env.BRAVE_API_KEY ? 'web_search ' : '') + (process.env.JINA_API_KEY ? 'web_fetch' : '');
  console.log('Web-Tools aktiv: ' + tools.trim());
}

// Wrapper, die die Provider-Rolle weitergeben, ohne den Aufrufer mit dem ganzen
// Provider-Objekt zu belasten. Provider liefern {content, toolCalls} — die Wrapper
// hier geben für Aufrufer ohne Tool-Loop nur den Text-Content zurück.
async function mainChat(systemPrompt, userMessage, opts = {}) {
  const r = await mainProvider.chat(systemPrompt, userMessage, { ...opts, rolle: 'main' });
  return r.content;
}
async function lightChat(systemPrompt, userMessage, opts = {}) {
  const r = await lightProvider.chat(systemPrompt, userMessage, { ...opts, rolle: 'light' });
  return r.content;
}

async function sendeLang(chatId, text) {
  if (!text) return 1;
  const zeilen = text.split('\n');
  const bloecke = [];
  let block = '';
  for (const z of zeilen) {
    const kandidat = block ? block + '\n' + z : z;
    if (kandidat.length > TELEGRAM_MAX) {
      if (block) bloecke.push(block);
      block = z;
    } else {
      block = kandidat;
    }
  }
  if (block) bloecke.push(block);
  for (const b of bloecke) {
    await bot.sendMessage(chatId, b);
  }
  return bloecke.length;
}

// "tippt..." Indikator, damit der Nutzer sieht, dass was passiert.
async function mitTipptIndikator(chatId, fn) {
  try {
    await bot.sendChatAction(chatId, 'typing');
  } catch { /* nicht alle Chats unterstützen das, egal */ }
  return fn();
}

// Extrahiert [MERKE: ...]-Zeilen aus einer KI-Antwort. Gibt {sichtbar, merkeFakt}
// zurück. Mehrere MERKE-Zeilen werden zu einer kommaseparierten Zeile zusammengeführt.
function extrahiereMerkeHooks(antwort) {
  if (!antwort) return { sichtbar: '', merkeFakt: null };
  const zeilen = antwort.split('\n');
  const merkeZeilen = [];
  const sichtbarZeilen = [];
  for (const z of zeilen) {
    const m = z.match(/^\s*\[MERKE:\s*(.+?)\s*\]\s*$/i);
    if (m) merkeZeilen.push(m[1].trim());
    else sichtbarZeilen.push(z);
  }
  const merkeFakt = merkeZeilen.length ? merkeZeilen.join('; ') : null;
  return { sichtbar: sichtbarZeilen.join('\n').trim(), merkeFakt };
}

// Zentrale Verarbeitung: von (bereits vorliegendem) Text bis zur KI-Antwort.
async function verarbeiteText(chatId, userText, dokInhalt = '') {
  // 0) Rate-Limit prüfen, BEVOR irgendwas anderes läuft.
  const rl = ratelimit.pruefeNachricht(chatId);
  if (!rl.ok) {
    bot.sendMessage(chatId, '⛔ ' + rl.grund);
    schreibeEintrag('Sicherheit', `Rate-Limit blockt Nachricht von ${chatId}: ${rl.grund}`);
    return;
  }
  ratelimit.zaehleNachricht(chatId);

  // 1) Themen-Klassifikation per Light-Provider
  const klassifikation = await kontext.klassifiziereThema(lightChat, chatId, userText);
  let thema;
  if (klassifikation.themaId) {
    thema = themen.ladeThema(chatId, klassifikation.themaId);
    if (!thema) {
      // Inkonsistenz: Index kennt das Thema, Datei fehlt. Neu anlegen.
      thema = themen.erstelleThema(chatId, klassifikation.neuName || 'Wiederhergestelltes Thema');
    }
  } else {
    thema = themen.erstelleThema(chatId, klassifikation.neuName || kontext.leiteThemaNamenAb(userText));
  }

  // 2) Kontext aufbauen
  const gedaechtnisText = gedaechtnis.ladeGedaechtnis(chatId);

  // 2a) Experten-Erkennung: passt die Nachricht zu einem registrierten
  // Expertensystem? Wenn ja, wird dessen systemPromptAdd an den Haupt-Prompt
  // angehängt und dessen verarbeite() aufgerufen.
  const experte = experten.findeExperte(userText);
  const expertenKontext = experte ? experte.systemPromptAdd : null;
  const systemPrompt = kontext.baueHauptSystemPrompt(gedaechtnisText, expertenKontext);

  if (experte) {
    schreibeEintrag('Experte', `Aktiv: ${experte.id} (${chatId}) — Trigger erkannt in Nachricht`);
  }
  const messages = kontext.baueHauptMessages(thema, userText, dokInhalt);

  // 3) Haupt-KI-Antwort mit Tool-Loop (Web-Suche, URL-Fetch wenn Keys gesetzt).
  //    Wenn ein Experte aktiv ist und sein verarbeite() _delegate:'standard'
  //    zurückgibt, läuft der Standard-Flow. Andernfalls wird die experten-eigene
  //    Antwort direkt genommen (z.B. bei Stubs).
  let raw;
  let expertenErgebnis = null; // wird später für _sendDocument etc. gebraucht
  if (experte && typeof experte.verarbeite === 'function') {
    const input = {
      chatId, text: userText, dokInhalt, thema,
      systemPrompt, gedaechtnisText
    };
    const kontextHilfs = {
      mainChat, lightChat, mainChatMitTools,
      schreibeEintrag, bot
    };
    let ergebnis;
    try {
      ergebnis = await experte.verarbeite(input, kontextHilfs);
    } catch (err) {
      schreibeEintrag('Fehler', `Experte ${experte.id} abgestürzt (${chatId}): ${err.message}`);
      ergebnis = { antwort: `Fehler im ${experte.name}-Modul: ${err.message}`, merkeHook: null };
    }
    expertenErgebnis = ergebnis;
    if (ergebnis && ergebnis._delegate === 'standard') {
      // Recherche-Experte: normaler Tool-Loop
      const tools = toolsModul.verfuegbareTools(mainToolProvider);
      raw = await mainChatMitTools(chatId, systemPrompt, messages, tools);
    } else {
      // Stub oder Experte mit eigener Antwort
      raw = ergebnis.antwort || '';
    }
  } else {
    // Kein Experte, normaler Standard-Flow
    const tools = toolsModul.verfuegbareTools(mainToolProvider);
    raw = await mainChatMitTools(chatId, systemPrompt, messages, tools);
  }

  const { sichtbar, merkeFakt } = extrahiereMerkeHooks(raw);

  // 4) Output-Filter: verdächtige Muster (Prompt-Leak, API-Keys, rohe Tool-XML)
  //    rausfiltern, BEVOR der User die Antwort zu sehen kriegt.
  const gefiltert = sicherheit.filterOutput(sichtbar || '');
  if (gefiltert.gefiltert.length > 0) {
    schreibeEintrag('Sicherheit', `Output-Filter hat ${gefiltert.gefiltert.length} verdächtige Stelle(n) entfernt (${chatId}): ${gefiltert.gefiltert.join(', ')}`);
  }

  // 5) MERKE-Hook ins Gedächtnis schieben
  let merkeHinweis = '';
  if (merkeFakt) {
    const ok = gedaechtnis.fuegeHinzu(chatId, merkeFakt);
    if (ok) merkeHinweis = '\n\n_gemerkt: ' + merkeFakt + '_';
  }

  // 6) Senden — ggf. mit Hinweis voran, falls der Filter rohe Tool-Calls
  //    o.Ä. abgefangen hat. Der User kriegt dann eine Erklärung statt dem
  //    verwirrenden Original-Output.
  //    Wenn der Experte ein _sendDocument mitschickt (z.B. ein PDF), wird das
  //    ebenfalls an den User geschickt.
  const hinweis = gefiltert.hinweis ? gefiltert.hinweis + '\n\n' : '';
  const text = hinweis + (gefiltert.text || '(keine Antwort)') + merkeHinweis;
  await sendeLang(chatId, text);

  // Optional: Dokument (z.B. PDF) aus dem Experten-Result mitschicken
  if (expertenErgebnis && expertenErgebnis._sendDocument) {
    try {
      const fs = require('fs');
      if (fs.existsSync(expertenErgebnis._sendDocument)) {
        await bot.sendDocument(chatId, expertenErgebnis._sendDocument);
      }
    } catch (err) {
      console.error('Konnte _sendDocument nicht senden:', err.message);
    }
  }

  // 7) In Themen-Historie anhängen (den gefilterten Text speichern — wir wollen
  //    nicht den rohen Output mit den gefilterten Geheimnissen persistieren)
  themen.haengeNachrichtAn(chatId, thema.id, 'user', userText);
  themen.haengeNachrichtAn(chatId, thema.id, 'assistant', gefiltert.text || '');

  // 8) Komprimierung im Hintergrund (blockiert den User nicht)
  komprimiereWennNoetig(chatId, thema.id).catch((err) => {
    schreibeEintrag('Fehler', `Komprimierung fehlgeschlagen (${thema.id}): ${err.message}`);
  });
}

// Multi-Message-Chat mit Tool-Loop. Ersetzt die frühere "alles-in-einen-String-packen"-
// Variante, weil die Provider inzwischen native Multi-Message + Tool-Use können.
// Ablauf:
//   1) Provider mit den bisherigen Messages + (falls vorhanden) Tool-Defs aufrufen
//   2) Wenn toolCalls zurückkommen: User um Bestätigung fragen (Inline-Keyboard),
//      dann Tools ausführen und Ergebnisse als weitere Messages anhängen.
//      Maximal MAX_TOOL_ITER Iterationen.
//   3) Wenn keine toolCalls mehr: finalen content zurückgeben (vorher durch den
//      Output-Filter schicken).
const MAX_TOOL_ITER = 3;
const TOOL_BESTAETIGUNG_TIMEOUT_MS = 60_000;

// State für offene Tool-Bestätigungen. Key: confirmationId.
// Nach Auflösung (Klick oder Timeout) wird der Eintrag gelöscht.
const pendingConfirmations = new Map();

function neueConfirmationId() {
  return crypto.randomBytes(8).toString('hex');
}

function beschreibeToolCalls(toolCalls) {
  return toolCalls.map((c) => {
    if (c.name === 'web_search') {
      return '🔍 Web-Suche nach: „' + (c.args.query || '?') + '"';
    }
    if (c.name === 'web_fetch') {
      return '🌐 Webseite lesen: ' + (c.args.url || '?');
    }
    return '🔧 ' + c.name + '(' + JSON.stringify(c.args).slice(0, 80) + ')';
  }).join('\n');
}

async function warteAufToolBestaetigung(chatId, toolCalls) {
  const confId = neueConfirmationId();
  const text = '⚠️ Die KI möchte folgende externe Aktion ausführen:\n\n' +
    beschreibeToolCalls(toolCalls) +
    '\n\nErlauben?';

  return new Promise((resolve) => {
    let resolved = false;
    const cleanup = () => {
      pendingConfirmations.delete(confId);
      clearTimeout(timer);
    };
    const resolveOnce = (wert) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(wert);
    };

    const timer = setTimeout(() => {
      // Timeout: als Ablehnung werten, User hat nicht reagiert.
      bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
        chat_id: chatId,
        message_id: bestaetigungsMsgId
      }).catch(() => { /* egal, Buttons sind eh nur kosmetisch */ });
      bot.sendMessage(chatId, '⏱️ Bestätigung abgelaufen, Tool-Aufruf abgebrochen.');
      resolveOnce({ erlaubt: false, grund: 'Timeout' });
    }, TOOL_BESTAETIGUNG_TIMEOUT_MS);

    let bestaetigungsMsgId = 0;
    bot.sendMessage(chatId, text, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Ja, abrufen', callback_data: 'tool_ok:' + confId },
          { text: '❌ Nein, abbrechen', callback_data: 'tool_no:' + confId }
        ]]
      }
    }).then((sent) => {
      bestaetigungsMsgId = sent.message_id;
    }).catch((err) => {
      console.error('Konnte Bestätigungs-Nachricht nicht senden:', err);
      resolveOnce({ erlaubt: false, grund: 'Sendefehler' });
    });

    pendingConfirmations.set(confId, { resolve: resolveOnce });
  });
}

async function mainChatMitTools(chatId, systemPrompt, initialMessages, tools) {
  let messages = [...initialMessages];
  const providerName = mainProvider.name;

  for (let i = 0; i < MAX_TOOL_ITER; i++) {
    const opts = { rolle: 'main', messages, maxTokens: 2000 };
    if (tools && tools.length > 0) opts.tools = tools;
    const antwort = await mainProvider.chat(systemPrompt, '', opts);

    if (!antwort.toolCalls || antwort.toolCalls.length === 0) {
      return antwort.content || '';
    }

    // User-Bestätigung einholen (Strikter Modus).
    const bestaetigung = await warteAufToolBestaetigung(chatId, antwort.toolCalls);
    if (!bestaetigung.erlaubt) {
      // KI bekommt "abgelehnt" als Tool-Result, damit sie ihre Antwort ohne
      // das Tool formulieren kann.
      const toolResults = antwort.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        result: 'Tool-Aufruf wurde vom Nutzer abgelehnt: ' + bestaetigung.grund +
          '. Antworte ohne dieses Tool, basierend auf deinem bisherigen Wissen.'
      }));
      schreibeEintrag('Sicherheit', `Tool-Aufruf abgelehnt (${chatId}): ${antwort.toolCalls.map(c => c.name + ' ' + JSON.stringify(c.args)).join('; ')}`);
      messagesAktualisieren(messages, antwort, toolResults, providerName);
      continue;
    }

    // Tool-Rate-Limit prüfen.
    const toolCheck = ratelimit.pruefeToolCall(chatId);
    if (!toolCheck.ok) {
      const toolResults = antwort.toolCalls.map((c) => ({
        id: c.id,
        name: c.name,
        result: toolCheck.grund
      }));
      bot.sendMessage(chatId, '⚠️ ' + toolCheck.grund);
      schreibeEintrag('Sicherheit', `Tool-Limit erreicht (${chatId})`);
      messagesAktualisieren(messages, antwort, toolResults, providerName);
      continue;
    }
    ratelimit.zaehleToolCall(chatId, antwort.toolCalls.length);

    // Tools ausführen — parallel, alle unabhängig. Ergebnisse ins Protokoll loggen.
    const toolResults = await Promise.all(antwort.toolCalls.map(async (call) => {
      const result = await toolsModul.fuehreToolAus(call.name, call.args);
      // Tool-Call ins Protokoll — für Audit-Zwecke.
      schreibeEintrag('Tool', `${call.name} (${chatId}): ${JSON.stringify(call.args).slice(0, 200)}`);
      return { id: call.id, name: call.name, result };
    }));

    messagesAktualisieren(messages, antwort, toolResults, providerName);
  }

  // Iterationslimit erreicht — die KI kam nicht zum Ende. Was sie bisher gesagt
  // hat, ist die beste Annäherung.
  schreibeEintrag('Warnung', `Tool-Loop nach ${MAX_TOOL_ITER} Iterationen abgebrochen (${chatId}).`);
  return '(Die Anfrage hat zu viele Tool-Aufrufe gebraucht und wurde abgebrochen.)';
}

function messagesAktualisieren(messages, antwort, toolResults, providerName) {
  if (providerName === 'anthropic') {
    messages.push({
      role: 'assistant',
      content: antwort.toolCalls.map((c) => ({
        type: 'tool_use', id: c.id, name: c.name, input: c.args
      }))
    });
    messages.push({
      role: 'user',
      content: toolResults.map((r) => ({
        type: 'tool_result', tool_use_id: r.id, content: r.result
      }))
    });
  } else if (providerName === 'openai' || providerName === 'minimax') {
    // OpenAI-kompatibles Format. MiniMax akzeptiert das gleiche Schema für
    // tool_calls und tool-Role-Messages. Wichtig: das hier war der Bug, der
    // zu Endlosschleifen geführt hat — ohne diesen Branch hat MiniMax die
    // Tool-Results nie gesehen und immer wieder den gleichen Tool-Call gemacht.
    messages.push({
      role: 'assistant',
      content: antwort.content || null,
      tool_calls: antwort.toolCalls.map((c) => ({
        id: c.id, type: 'function',
        function: { name: c.name, arguments: JSON.stringify(c.args) }
      }))
    });
    for (const r of toolResults) {
      messages.push({ role: 'tool', tool_call_id: r.id, content: r.result });
    }
  }
  // Bei anderen Providern (z.B. zukünftige, die Tool-Use nicht können) wird
  // schlicht nichts getan — der Bot bekommt die Tool-Results nicht zurück,
  // aber das sollte nie passieren, weil wir vorher die Tool-Use-Fähigkeit prüfen.
}

// Globaler Callback-Handler für Inline-Keyboard-Klicks.
bot.on('callback_query', (query) => {
  const data = query.data || '';
  if (!data.startsWith('tool_')) {
    bot.answerCallbackQuery(query.id).catch(() => {});
    return;
  }
  const [, confId] = data.split(':');
  const pending = pendingConfirmations.get(confId);
  if (!pending) {
    bot.answerCallbackQuery(query.id, {
      text: 'Diese Anfrage ist abgelaufen oder unbekannt.',
      show_alert: false
    }).catch(() => {});
    return;
  }
  const erlaubt = data.startsWith('tool_ok');
  bot.answerCallbackQuery(query.id, {
    text: erlaubt ? 'Erlaubt, führe aus …' : 'Abgebrochen.'
  }).catch(() => {});
  // Buttons aus der Bestätigungsnachricht entfernen.
  if (query.message) {
    bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id
    }).catch(() => {});
  }
  pending.resolve({ erlaubt, grund: erlaubt ? 'vom Nutzer erlaubt' : 'vom Nutzer abgelehnt' });
});

async function komprimiereWennNoetig(chatId, themaId) {
  const t = themen.ladeThema(chatId, themaId);
  if (t && kompressor.themaBereitZurKomprimierung(t)) {
    await kompressor.komprimiereThema(chatId, themaId, lightChat);
  }
  if (gedaechtnis.istVoll(chatId)) {
    await kompressor.komprimiereGedaechtnis(chatId, lightChat);
  }
}

// ----------------- Input-Handler -----------------

// Text -> sofort verarbeiten
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Beim allerersten Kontakt: komplette User-Verzeichnisstruktur anlegen.
  // Macht den Bot-Daten-Stand vorhersehbar und gibt dem Admin eine
  // saubere Struktur zum Pflegen / Löschen pro User.
  let userState;
  try {
    userState = benutzer.initialisiereAusMessage(msg);
  } catch (err) {
    console.error('User-Initialisierung fehlgeschlagen:', err);
    return; // Ohne User-State keine Verarbeitung — lieber gar nichts als kaputten State.
  }
  if (userState.warNeu) {
    // Kurzer Willkommens-Ping, nicht zu aufdringlich. Der /start-Befehl gibt
    // ohnehin die volle Anleitung.
    const name = userState.profil.displayName ? `, ${userState.profil.displayName}` : '';
    bot.sendMessage(chatId, `👋 Hallo${name}! Deine Daten liegen unter \`data/users/${userState.profil.chatId}/\`. Du kannst jederzeit loschatten — sag einfach was, oder tipp /start für die Anleitung.`);
    schreibeEintrag('Info', `Neuer User: ${userState.profil.chatId} (${userState.profil.displayName || userState.profil.username || 'anonym'})`);
  }

  if (msg.text) {
    const text = msg.text.trim();
    if (text.startsWith('/')) return; // Commands laufen über onText-Handler
    try {
      await mitTipptIndikator(chatId, () => verarbeiteText(chatId, text));
    } catch (err) {
      console.error(err);
      schreibeEintrag('Fehler', `Text-Nachricht: ${err.message}`);
      bot.sendMessage(chatId, 'Fehler bei der Verarbeitung: ' + err.message);
    }
    return;
  }

  if (msg.voice) {
    try {
      await mitTipptIndikator(chatId, async () => {
        await bot.sendMessage(chatId, 'Sprachnachricht wird transkribiert …');
        const link = await bot.getFileLink(msg.voice.file_id);
        const res = await fetch(link);
        const buf = Buffer.from(await res.arrayBuffer());
        const text = await transkribiere(buf);
        await bot.sendMessage(chatId, `Verstanden: „${text}"`);
        await verarbeiteText(chatId, text);
      });
    } catch (err) {
      console.error(err);
      schreibeEintrag('Fehler', `Sprachnachricht: ${err.message}`);
      bot.sendMessage(chatId, 'Fehler bei der Spracherkennung: ' + err.message);
    }
    return;
  }

  if (msg.photo) {
    try {
      await mitTipptIndikator(chatId, async () => {
        // Wenn ein Experte onPhoto unterstützt, leite das Foto dorthin
        const experte = experten.ladeExperten().find((e) => typeof e.onPhoto === 'function');
        // Heuristik: der Materialaufmaß-Experte fängt ALLE Fotos ab,
        // wenn er eine aktive Session hat
        const matExp = experten.ladeExperten().find((e) => e.id === 'materialaufmass');
        if (matExp && typeof matExp.onPhoto === 'function') {
          const sessionDatei = path.join(userVerzeichnisFuerExperten(chatId), 'aufnahme_session.json');
          if (fs.existsSync(sessionDatei)) {
            const bestes = msg.photo[msg.photo.length - 1];
            const r = await matExp.onPhoto(chatId, bestes.file_id, msg, { bot, schreibeEintrag });
            if (r && r.antwort) await bot.sendMessage(chatId, r.antwort);
            return;
          }
        }
        // Standard: Foto per OCR verarbeiten
        const bestes = msg.photo[msg.photo.length - 1];
        const link = await bot.getFileLink(bestes.file_id);
        const res = await fetch(link);
        const buf = Buffer.from(await res.arrayBuffer());
        await importiereUndVerarbeite(buf, 'image/jpeg', chatId, 'Bild');
      });
    } catch (err) {
      console.error(err);
      schreibeEintrag('Fehler', `Foto: ${err.message}`);
      bot.sendMessage(chatId, 'Fehler bei der Bildauswertung: ' + err.message);
    }
    return;
  }

  if (msg.document) {
    try {
      await mitTipptIndikator(chatId, async () => {
        // Wenn ein Experte onDocument unterstützt und eine aktive Session hat
        const matExp = experten.ladeExperten().find((e) => e.id === 'materialaufmass');
        if (matExp && typeof matExp.onDocument === 'function') {
          const sessionDatei = path.join(userVerzeichnisFuerExperten(chatId), 'aufnahme_session.json');
          if (fs.existsSync(sessionDatei)) {
            const r = await matExp.onDocument(chatId, msg.document.mime_type, msg.document.file_name, msg.document.file_id, { bot, schreibeEintrag });
            if (r !== null) {
              if (r && r.antwort) await bot.sendMessage(chatId, r.antwort);
              return;
            }
          }
        }
        // Standard: Datei verarbeiten
        const link = await bot.getFileLink(msg.document.file_id);
        const res = await fetch(link);
        const buf = Buffer.from(await res.arrayBuffer());
        await importiereUndVerarbeite(buf, msg.document.mime_type, chatId, 'Datei');
      });
    } catch (err) {
      console.error(err);
      schreibeEintrag('Fehler', `Datei: ${err.message}`);
      bot.sendMessage(chatId, 'Fehler bei der Dateiauswertung: ' + err.message);
    }
  }
});

function userVerzeichnisFuerExperten(chatId) {
  return path.join(__dirname, 'data', 'users', String(chatId));
}

// Foto / PDF / Excel / Word -> Text extrahieren -> normal weiterverarbeiten.
async function importiereUndVerarbeite(buffer, mimeType, chatId, label) {
  let text;
  if (mimeType && mimeType.startsWith('image/')) {
    await bot.sendMessage(chatId, `${label} wird per OCR ausgelesen …`);
    text = await mistralOCR(buffer.toString('base64'), mimeType);
  } else if (mimeType === 'application/pdf') {
    await bot.sendMessage(chatId, 'PDF wird per OCR ausgelesen …');
    text = await mistralOCR(buffer.toString('base64'), mimeType);
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    await bot.sendMessage(chatId, 'Excel-Datei wird ausgelesen …');
    text = await excelZuText(buffer);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    await bot.sendMessage(chatId, 'Word-Datei wird ausgelesen …');
    text = await wordZuText(buffer);
  } else {
    bot.sendMessage(chatId, `Dateityp „${mimeType}" wird nicht unterstützt. Fotos, PDF, .xlsx, .docx gehen.`);
    return;
  }
  if (!text || !text.trim()) {
    bot.sendMessage(chatId, 'Es konnte kein Text aus der Datei extrahiert werden.');
    return;
  }
  // Kurze Rückmeldung, was extrahiert wurde (gekürzt), damit der Nutzer sieht, dass die
  // Vorverarbeitung geklappt hat.
  const vorschau = text.length > 300 ? text.slice(0, 300) + '…' : text;
  await bot.sendMessage(chatId, `Extrahierter Text (Vorschau):\n${vorschau}`);
  await verarbeiteText(chatId, 'Bitte lies die beigefügte Datei und beantworte/antworte darauf.', text);
}

// ----------------- Commands -----------------

bot.onText(/\/start/, async (msg) => {
  await sendeLang(msg.chat.id, ladeBegruessung());
});

bot.onText(/\/themen/, (msg) => {
  const index = themen.ladeIndex(msg.chat.id);
  if (index.length === 0) {
    bot.sendMessage(msg.chat.id, 'Du hast noch keine Themen. Schreib einfach los — das erste Thema wird automatisch angelegt.');
    return;
  }
  const zeilen = index.map((t, i) => {
    const datum = (t.lastActivity || '').slice(0, 16).replace('T', ' ');
    return `${i + 1}. ${t.name}  (${t.messageCount} Nachrichten, zuletzt ${datum})`;
  });
  bot.sendMessage(msg.chat.id, 'Deine Themen:\n' + zeilen.join('\n'));
});

bot.onText(/\/neu(?:\s+(.+))?/, async (msg, match) => {
  const name = (match && match[1] && match[1].trim()) || 'Neues Thema';
  const thema = themen.erstelleThema(msg.chat.id, name);
  bot.sendMessage(msg.chat.id, `Neues Thema „${thema.name}" angelegt. Du kannst jetzt reinschreiben.`);
});

bot.onText(/\/thema(?:\s+(.+))?/, (msg, match) => {
  const suche = match && match[1] && match[1].trim();
  if (!suche) {
    bot.sendMessage(msg.chat.id, 'Benutzung: /thema <Name-oder-Teil-des-Namens>');
    return;
  }
  const t = themen.findeThemaMitName(msg.chat.id, suche);
  if (!t) {
    bot.sendMessage(msg.chat.id, `Kein Thema mit „${suche}" gefunden. /themen zeigt alle.`);
    return;
  }
  // "Aktives Thema" ist hier informell — die Themen-Zuordnung passiert ohnehin
  // automatisch pro Nachricht. Dieser Command zeigt vor allem den vollen Verlauf.
  const voll = themen.ladeThema(msg.chat.id, t.id);
  if (!voll || !Array.isArray(voll.messages) || voll.messages.length === 0) {
    bot.sendMessage(msg.chat.id, `Thema „${t.name}" ist noch leer.`);
    return;
  }
  const zeilen = voll.messages.map((m) => {
    const wer = m.rolle === 'user' ? 'Du' : 'Bot';
    const zeit = (m.zeit || '').slice(0, 16).replace('T', ' ');
    return `[${zeit}] ${wer}: ${m.inhalt}`;
  });
  sendeLang(msg.chat.id, `Verlauf von „${t.name}":\n` + zeilen.join('\n'));
});

bot.onText(/\/umbenennen\s+(\S+)\s+(.+)/, (msg, match) => {
  const t = themen.findeThemaMitName(msg.chat.id, match[1]);
  if (!t) {
    bot.sendMessage(msg.chat.id, `Kein Thema mit „${match[1]}" gefunden.`);
    return;
  }
  const neu = themen.benenneThemaUm(msg.chat.id, t.id, match[2]);
  bot.sendMessage(msg.chat.id, `Thema umbenannt in „${neu.name}".`);
});

bot.onText(/\/loeschen\s+(\S+)/, (msg, match) => {
  const t = themen.findeThemaMitName(msg.chat.id, match[1]);
  if (!t) {
    bot.sendMessage(msg.chat.id, `Kein Thema mit „${match[1]}" gefunden.`);
    return;
  }
  themen.loescheThema(msg.chat.id, t.id);
  bot.sendMessage(msg.chat.id, `Thema „${t.name}" gelöscht (Historie weg).`);
});

bot.onText(/\/zusammenfassung(?:\s+(.+))?/, (msg, match) => {
  const suche = match && match[1] && match[1].trim();
  let t;
  if (suche) {
    t = themen.findeThemaMitName(msg.chat.id, suche);
  } else {
    const index = themen.ladeIndex(msg.chat.id);
    t = index[0] || null;
  }
  if (!t) {
    bot.sendMessage(msg.chat.id, 'Noch kein Thema vorhanden.');
    return;
  }
  const voll = themen.ladeThema(msg.chat.id, t.id);
  const summary = (voll && voll.summary) || '(noch keine Zusammenfassung — Thema ist zu kurz für eine Komprimierung)';
  bot.sendMessage(msg.chat.id, `Zusammenfassung von „${t.name}":\n${summary}`);
});

bot.onText(/\/gedaechtnis/, (msg) => {
  const fakten = gedaechtnis.ladeFakten(msg.chat.id);
  if (fakten.length === 0) {
    bot.sendMessage(msg.chat.id, 'Das Langzeit-Gedächtnis ist noch leer. Schreib „merke dir: …" oder die KI kann Fakten am Ende ihrer Antwort hinterlegen ([MERKE: …]).');
    return;
  }
  const text = 'Langzeit-Gedächtnis:\n' + fakten.map((f, i) => `${i + 1}. ${f}`).join('\n');
  sendeLang(msg.chat.id, text);
});

bot.onText(/\/merke\s+(.+)/, (msg, match) => {
  const fakt = (match && match[1] || '').trim();
  if (!fakt) return;
  const ok = gedaechtnis.fuegeHinzu(msg.chat.id, fakt);
  bot.sendMessage(msg.chat.id, ok ? `Gemerkt: ${fakt}` : 'Steht schon im Gedächtnis.');
});

bot.onText(/\/vergiss\s+(\d+)/, (msg, match) => {
  const idx = parseInt(match[1], 10) - 1;
  const ok = gedaechtnis.entferneFakt(msg.chat.id, idx);
  bot.sendMessage(msg.chat.id, ok ? 'Fakt entfernt.' : 'Diese Nummer gibt es nicht. /gedaechtnis zeigt die Liste.');
});

bot.onText(/\/user/, (msg) => {
  const rl = ratelimit.status(msg.chat.id);
  const profil = benutzer.ladeProfil(msg.chat.id);
  const profilTeil = profil
    ? `Name: ${profil.displayName || '—'}\n` +
      `Username: ${profil.username ? '@' + profil.username : '—'}\n` +
      `Erster Kontakt: ${(profil.firstSeen || '').slice(0, 10)}\n` +
      `Letzter Kontakt: ${(profil.lastSeen || '').slice(0, 10)}\n` +
      `Daten unter: data/users/${profil.chatId}/\n`
    : 'Profil: (noch nicht initialisiert)';
  bot.sendMessage(msg.chat.id,
    `Deine Chat-ID: ${msg.chat.id}\n` +
    profilTeil +
    `Themen: ${themen.ladeIndex(msg.chat.id).length}\n` +
    `Gedächtnis: ${gedaechtnis.ladeFakten(msg.chat.id).length} Fakten\n` +
    `Rate-Limit: ${rl.stunde} Nachrichten/Stunde, ${rl.tag} Nachrichten/Tag, ${rl.tools} Tool-Calls/Tag`);
});

bot.onText(/\/delete-my-data/, async (msg) => {
  // Hard delete: gesamten User-Ordner weg. Nicht wiederherstellbar.
  const profil = benutzer.ladeProfil(msg.chat.id);
  if (!profil) {
    bot.sendMessage(msg.chat.id, 'Du hast hier keine gespeicherten Daten.');
    return;
  }
  const ok = benutzer.loescheAlles(msg.chat.id);
  if (ok) {
    schreibeEintrag('Sicherheit', `User-Daten gelöscht auf Wunsch: ${msg.chat.id} (${profil.displayName || profil.username || 'anonym'})`);
    bot.sendMessage(msg.chat.id,
      '✅ Alle deine Daten (Themen, Gedächtnis, Profil, Rate-Limit-Counter) sind gelöscht.\n' +
      'Der Ordner `data/users/' + msg.chat.id + '/` ist weg. Wenn du wieder schreibst, wird er frisch angelegt.');
  } else {
    bot.sendMessage(msg.chat.id, 'Konnte deine Daten nicht löschen — frag beim Admin nach.');
  }
});

bot.onText(/\/wer-bin-ich/, (msg) => {
  const profil = benutzer.ladeProfil(msg.chat.id);
  if (!profil) {
    bot.sendMessage(msg.chat.id, 'Kein Profil gefunden. Schreib erst eine Nachricht, dann lege ich eins an.');
    return;
  }
  const zeilen = [
    `Chat-ID: ${profil.chatId}`,
    `Name: ${profil.displayName || '—'}`,
    `Username: ${profil.username ? '@' + profil.username : '—'}`,
    `Erster Kontakt: ${(profil.firstSeen || '').slice(0, 19).replace('T', ' ')}`,
    `Letzter Kontakt: ${(profil.lastSeen || '').slice(0, 19).replace('T', ' ')}`
  ];
  if (profil.notiz) zeilen.push(`Admin-Notiz: ${profil.notiz}`);
  bot.sendMessage(msg.chat.id, 'Dein Profil:\n' + zeilen.join('\n'));
});

bot.onText(/\/protokoll/, (msg) => {
  const text = leseLetzte(20);
  bot.sendMessage(msg.chat.id, text || 'Das Protokoll ist noch leer.');
});

// /experten zeigt alle registrierten Expertensysteme mit Status
bot.onText(/\/experten/, (msg) => {
  const liste = experten.listeStatus();
  const zeilen = liste.map((e) => {
    const status = e.implementiert ? '✅ aktiv' : '🚧 Stub';
    return `${e.emoji} *${e.name}* — ${status}\n   ${e.description}\n   Trigger: ${e.triggers.slice(0, 4).join(', ')}${e.triggers.length > 4 ? ', …' : ''}`;
  });
  const text = '*Verfügbare Expertensysteme:*\n\n' + zeilen.join('\n\n') +
    '\n\n_Schreib einfach los — der richtige Experte wird automatisch an deinen Schlüsselwörtern erkannt._';
  bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/komprimieren/, async (msg) => {
  await bot.sendChatAction(msg.chat.id, 'typing');
  const index = themen.ladeIndex(msg.chat.id);
  let gemacht = 0;
  for (const eintrag of index) {
    const t = themen.ladeThema(msg.chat.id, eintrag.id);
    if (t && kompressor.themaBereitZurKomprimierung(t)) {
      await kompressor.komprimiereThema(msg.chat.id, eintrag.id, lightChat);
      gemacht++;
    }
  }
  let ged = false;
  if (gedaechtnis.istVoll(msg.chat.id)) {
    ged = await kompressor.komprimiereGedaechtnis(msg.chat.id, lightChat);
  }
  bot.sendMessage(msg.chat.id, `Komprimierung fertig. ${gemacht} Thema(en) verdichtet${ged ? ', Gedächtnis verdichtet' : ''}.`);
});

console.log('Telegram-Bot läuft (Polling-Modus).');
