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
const TelegramBot = require('node-telegram-bot-api');
const { getProvider } = require('./providers');
const { transkribiere } = require('./transcribe');
const { mistralOCR } = require('./ocr');
const { excelZuText, wordZuText } = require('./dokument');
const themen = require('./themen');
const gedaechtnis = require('./gedaechtnis');
const kompressor = require('./kompressor');
const kontext = require('./kontext');
const { schreibeEintrag, leseLetzte } = require('./protokoll');
const { ladeBegruessung } = require('./begruessung');

// Telegram-Limit pro Nachricht. Wir teilen lange Antworten an Zeilenumbrüchen auf.
const TELEGRAM_MAX = 3800;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN fehlt in der .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const mainProvider = getProvider('main');
const lightProvider = getProvider('light');

// Wrapper, die die Provider-Rolle weitergeben, ohne den Aufrufer mit dem ganzen
// Provider-Objekt zu belasten.
async function mainChat(systemPrompt, userMessage, opts = {}) {
  return mainProvider.chat(systemPrompt, userMessage, { ...opts, rolle: 'main' });
}
async function lightChat(systemPrompt, userMessage, opts = {}) {
  return lightProvider.chat(systemPrompt, userMessage, { ...opts, rolle: 'light' });
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
  const systemPrompt = kontext.baueHauptSystemPrompt(gedaechtnisText);
  const messages = kontext.baueHauptMessages(thema, userText, dokInhalt);

  // 3) Haupt-KI-Antwort (eine chat-Anfrage, die alle Messages als Verlauf bekommt)
  const raw = await mainChatMultiMessage(systemPrompt, messages);

  const { sichtbar, merkeFakt } = extrahiereMerkeHooks(raw);

  // 4) MERKE-Hook ins Gedächtnis schieben
  let merkeHinweis = '';
  if (merkeFakt) {
    const ok = gedaechtnis.fuegeHinzu(chatId, merkeFakt);
    if (ok) merkeHinweis = '\n\n_gemerkt: ' + merkeFakt + '_';
  }

  // 5) Senden
  const text = (sichtbar || '(keine Antwort)') + merkeHinweis;
  await sendeLang(chatId, text);

  // 6) In Themen-Historie anhängen
  themen.haengeNachrichtAn(chatId, thema.id, 'user', userText);
  themen.haengeNachrichtAn(chatId, thema.id, 'assistant', sichtbar || '');

  // 7) Komprimierung im Hintergrund (blockiert den User nicht)
  komprimiereWennNoetig(chatId, thema.id).catch((err) => {
    schreibeEintrag('Fehler', `Komprimierung fehlgeschlagen (${thema.id}): ${err.message}`);
  });
}

// Multi-Message-Chat: die Provider haben aktuell eine 2-Argument-Signatur
// (systemPrompt, userMessage). Wir setzen hier die Messages zu einem einzigen
// user-String zusammen, der die vorherigen Turns als Kontext einbaut.
// (Erweiterung auf native Multi-Message pro Provider bleibt für später.)
async function mainChatMultiMessage(systemPrompt, messages) {
  if (messages.length === 0) return '';
  const letzte = messages[messages.length - 1];
  const vorherige = messages.slice(0, -1);
  if (vorherige.length === 0) {
    return mainChat(systemPrompt, letzte.content);
  }
  // Vorherige Messages werden kompakt als "Bisheriger Verlauf:" zusammengefasst.
  // Die letzte Message ist die eigentliche Frage.
  const block = vorherige
    .map((m) => {
      const wer = m.role === 'assistant' ? 'Assistent' : 'Nutzer';
      return `${wer}: ${m.content}`;
    })
    .join('\n');
  const kombi = `Bisheriger Verlauf in diesem Thema:
"""
${block}
"""

Aktuelle Nutzernachricht:
"""
${letzte.content}
"""`;
  return mainChat(systemPrompt, kombi);
}

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
  bot.sendMessage(msg.chat.id, `Deine Chat-ID: ${msg.chat.id}\nThemen: ${themen.ladeIndex(msg.chat.id).length}\nGedächtnis: ${gedaechtnis.ladeFakten(msg.chat.id).length} Fakten`);
});

bot.onText(/\/protokoll/, (msg) => {
  const text = leseLetzte(20);
  bot.sendMessage(msg.chat.id, text || 'Das Protokoll ist noch leer.');
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
