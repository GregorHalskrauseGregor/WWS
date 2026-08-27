require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { getProvider } = require('./providers');
const { addierePositionen, entnehmePositionen, pruefeBedarf, suchePositionen, gesamteListe, EXCEL_PATH } = require('./material');
const { transkribiere } = require('./transcribe');
const { mistralOCR } = require('./ocr');
const { excelZuText, wordZuText } = require('./dokument');
const { ladeRegeln, speichereRegel, ladeArtikelgruppen, speichereArtikelgruppe, REGELN_PATH, GRUPPEN_PATH } = require('./wissen');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('TELEGRAM_BOT_TOKEN fehlt in der .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const provider = getProvider();

// Telegram erlaubt max. 4096 Zeichen pro Nachricht. Teilt an Zeilenumbrüchen auf,
// damit auch sehr lange Listen vollständig ankommen, statt gekappt zu werden.
const TELEGRAM_MAX_LAENGE = 3800;

async function sendeLangeNachricht(chatId, text) {
  const zeilen = text.split('\n');
  const bloecke = [];
  let aktuellerBlock = '';

  for (const zeile of zeilen) {
    const kandidat = aktuellerBlock ? aktuellerBlock + '\n' + zeile : zeile;
    if (kandidat.length > TELEGRAM_MAX_LAENGE) {
      if (aktuellerBlock) bloecke.push(aktuellerBlock);
      aktuellerBlock = zeile;
    } else {
      aktuellerBlock = kandidat;
    }
  }
  if (aktuellerBlock) bloecke.push(aktuellerBlock);

  for (const block of bloecke) {
    await bot.sendMessage(chatId, block);
  }
  return bloecke.length;
}

// Feste Kategorienliste, damit die Einordnung über Hunderte/Tausende Positionen konsistent bleibt.
const KATEGORIEN = [
  'Rohre & Leitungen',
  'Fittinge & Verbindungstechnik',
  'Armaturen & Ventile',
  'Pumpen & Antriebe',
  'Wärmeerzeugung',
  'Heizkörper & Flächenheizung',
  'Sanitärobjekte',
  'Dämmung & Isolierung',
  'Befestigung & Montagematerial',
  'Elektro & Steuerungstechnik',
  'Werkzeug & Verbrauchsmaterial',
  'Sonstiges'
];

// Baut den Systemprompt jedes Mal neu auf, damit zuletzt gemerkte Regeln/Artikelgruppen sofort greifen.
function baueSystemPrompt() {
  const regeln = ladeRegeln();
  const gruppen = ladeArtikelgruppen();

  let prompt = `Du wandelst Nachrichten eines Handwerkers über Materialpositionen in strukturierte Daten um.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt, ohne zusätzlichen Text davor oder danach, in genau einer dieser Formen:

{"aktion":"hinzufuegen","positionen":[{"bezeichnung":"Kugelhahn DN20","menge":3,"einheit":"Stück","zustand":"neu","kategorie":"Armaturen & Ventile"}]}
{"aktion":"entnehmen","positionen":[{"bezeichnung":"Kugelhahn DN20","menge":2,"einheit":"Stück","zustand":"neu"}]}
{"aktion":"materialbedarf","positionen":[{"bezeichnung":"Kugelhahn DN20","menge":5}]}
{"aktion":"abfrage","suchbegriff":"Kugelhahn"}
{"aktion":"liste"}
{"aktion":"regel_merken","regel":"Formulierte Regel als vollständiger Satz"}
{"aktion":"artikelgruppe_merken","gruppe":"Formulierte Gruppierungsregel als vollständiger Satz"}

Bedeutung der Aktionen:
- "hinzufuegen": Material kommt neu dazu, wird geliefert, eingelagert ODER von einem Monteur in die Firma zurückgegeben/eingesortiert. Bei Rückgabe durch einen Monteur "zustand" anhand der Beschreibung wählen: "gebraucht" bei normal gebrauchtem, funktionsfähigem Material, "verschmutzt" wenn der Monteur Verschmutzung/verunreinigt/dreckig o. Ä. erwähnt, sonst "neu" (z. B. bei neuwertig/ungebraucht oder wenn nichts zum Zustand gesagt wird).
- "entnehmen": Material wird tatsächlich verbraucht, verbaut oder mitgenommen (Bestand sinkt sofort)
- "materialbedarf": Ein Monteur benötigt Material für einen Einsatz und fragt, was davon im Lager vorhanden ist. WICHTIG: Diese Aktion verändert den Bestand NICHT, sie prüft nur. Erkennbar an Formulierungen wie "Ich brauche ...", "Für den Einsatz benötige ich ...", "Haben wir ... für einen Auftrag da?"
- "abfrage": einfache Frage, ob/wie viel von einer Position insgesamt vorhanden ist
- "liste": Frage nach dem kompletten Bestand
- "regel_merken": Der Nutzer bittet ausdrücklich darum, sich eine Regel dauerhaft zu merken (z. B. "Merke dir, dass ...", "Neue Regel: ...")
- "artikelgruppe_merken": Der Nutzer bittet ausdrücklich darum, mehrere ähnliche Artikel unter einem gemeinsamen Sammelbegriff zusammenzufassen

Allgemeine Regeln:
- "einheit" ist optional, Standard ist "Stück"
- "zustand" ist optional bei "hinzufuegen"/"entnehmen", nur "neu", "gebraucht" oder "verschmutzt", Standard ist "neu"
- "kategorie" bei "hinzufuegen": IMMER eine der folgenden festen Kategorien wählen, die inhaltlich am besten passt: ${KATEGORIEN.join(', ')}. Bei Unsicherheit "Sonstiges" verwenden. Bei "entnehmen"/"abfrage"/"materialbedarf" wird "kategorie" nicht benötigt.
- Zahlwörter in Ziffern umwandeln (z. B. "drei" -> 3)
- Text kommt oft aus Spracherkennung/Diktat -> offensichtliche Erkennungsfehler sinnvoll interpretieren
- Bei "hinzufuegen"/"entnehmen"/"abfrage"/"materialbedarf": wenn eine Artikelgruppe unten die genannte Variante abdeckt, IMMER den dort festgelegten Sammelbegriff als "bezeichnung" verwenden, nicht die Variante selbst`;

  if (gruppen) {
    prompt += `\n\nBekannte Artikelgruppen (Varianten auf den jeweiligen Sammelbegriff normalisieren):\n${gruppen}`;
  }
  if (regeln) {
    prompt += `\n\nZusätzliche vom Nutzer festgelegte Regeln, die IMMER zu beachten sind:\n${regeln}`;
  }

  return prompt;
}

// Verarbeitet einen (bereits vorliegenden) Text-String, egal ob getippt oder transkribiert.
async function verarbeiteText(chatId, text) {
  try {
    const raw = await provider.chat(baueSystemPrompt(), text);
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      bot.sendMessage(chatId, 'Konnte die Nachricht nicht auswerten. Bitte anders formulieren.');
      return;
    }
    const intent = JSON.parse(jsonMatch[0]);

    if (intent.aktion === 'hinzufuegen') {
      const ergebnisse = await addierePositionen(intent.positionen);
      const antwortText = ergebnisse
        .map((e) => `${e.bezeichnung} [${e.kategorie}] (${e.zustand}): jetzt ${e.menge} ${e.einheit}`)
        .join('\n');
      bot.sendMessage(chatId, 'Eingetragen:\n' + antwortText);
    } else if (intent.aktion === 'entnehmen') {
      const ergebnisse = await entnehmePositionen(intent.positionen);
      const antwortText = ergebnisse
        .map((e) => {
          if (e.unbekannt) {
            return `${e.bezeichnung} (${e.zustand}): war nicht in der Liste, nichts entnommen`;
          }
          if (e.fehlend > 0) {
            return `${e.bezeichnung} (${e.zustand}): ${e.entnommen} entnommen, ${e.fehlend} fehlten (Bestand jetzt 0)`;
          }
          return `${e.bezeichnung} (${e.zustand}): ${e.entnommen} entnommen, jetzt noch ${e.neueMenge} ${e.einheit || ''}`;
        })
        .join('\n');
      bot.sendMessage(chatId, antwortText);
    } else if (intent.aktion === 'materialbedarf') {
      const ergebnisse = await pruefeBedarf(intent.positionen);
      const verfuegbarZeilen = ergebnisse
        .filter((e) => e.verfuegbar > 0)
        .map((e) => `${e.bezeichnung}: ${e.verfuegbar} von ${e.angefragt} da (Lager gesamt: ${e.gesamtBestand} ${e.einheit})`);
      const fehlendZeilen = ergebnisse
        .filter((e) => e.fehlend > 0)
        .map((e) => `${e.bezeichnung}: ${e.fehlend} ${e.einheit} fehlen`);

      let antwort = '';
      if (verfuegbarZeilen.length > 0) {
        antwort += 'Aus dem Lager verfügbar:\n' + verfuegbarZeilen.join('\n');
      }
      if (fehlendZeilen.length > 0) {
        antwort += (antwort ? '\n\n' : '') + 'Muss bestellt werden:\n' + fehlendZeilen.join('\n');
      }
      bot.sendMessage(chatId, antwort || 'Nichts von den angefragten Positionen ist vorrätig.');
    } else if (intent.aktion === 'abfrage') {
      const treffer = await suchePositionen(intent.suchbegriff);
      if (treffer.length === 0) {
        bot.sendMessage(chatId, `Keine Position gefunden zu "${intent.suchbegriff}".`);
      } else {
        const antwortText = treffer
          .map((t) => `${t.bezeichnung} [${t.kategorie}]: neu ${t.mengeNeu}, gebraucht ${t.mengeGebraucht}, verschmutzt ${t.mengeVerschmutzt} (${t.einheit})`)
          .join('\n');
        await sendeLangeNachricht(chatId, antwortText);
      }
    } else if (intent.aktion === 'liste') {
      const alle = await gesamteListe();
      if (alle.length === 0) {
        bot.sendMessage(chatId, 'Die Materialliste ist noch leer.');
      } else {
        const gruppen = {};
        for (const t of alle) {
          if (!gruppen[t.kategorie]) gruppen[t.kategorie] = [];
          gruppen[t.kategorie].push(t);
        }

        const antwortText = Object.entries(gruppen)
          .map(([kategorie, artikel]) => {
            const zeilen = artikel
              .map((t) => `  ${t.bezeichnung}: neu ${t.mengeNeu}, gebraucht ${t.mengeGebraucht}, verschmutzt ${t.mengeVerschmutzt} (${t.einheit})`)
              .join('\n');
            return `${kategorie}:\n${zeilen}`;
          })
          .join('\n\n');

        const anzahlNachrichten = await sendeLangeNachricht(chatId, antwortText);

        // Musste die Liste auf mehrere Nachrichten aufgeteilt werden -> zusätzlich die Excel-Datei
        // mitschicken, das ist zum Durchsuchen/Filtern oft praktischer als viele Textnachrichten.
        if (anzahlNachrichten > 1) {
          bot.sendDocument(chatId, EXCEL_PATH);
        }
      }
    } else if (intent.aktion === 'regel_merken') {
      speichereRegel(intent.regel);
      bot.sendMessage(chatId, `Regel gemerkt: "${intent.regel}"`);
    } else if (intent.aktion === 'artikelgruppe_merken') {
      speichereArtikelgruppe(intent.gruppe);
      bot.sendMessage(chatId, `Artikelgruppe gemerkt: "${intent.gruppe}"`);
    } else {
      bot.sendMessage(chatId, 'Aktion nicht erkannt.');
    }
  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, 'Fehler bei der Verarbeitung: ' + err.message);
  }
}

// Extrahiert Materialpositionen aus bereits vorliegendem Text (egal ob per OCR aus einem
// Foto/PDF gewonnen, oder direkt aus Excel/Word ausgelesen). Läuft rein textbasiert ->
// funktioniert mit JEDEM AI_PROVIDER, auch MiniMax, keine Bilderkennung nötig.
async function extrahierePositionenAusText(inhalt) {
  const systemPrompt = `Du liest den ausgelesenen Inhalt eines Lieferscheins, einer Materialliste,
einer Excel-Tabelle oder eines Word-Dokuments aus (als Text/Markdown bereits extrahiert).
Erkenne ALLE aufgeführten Materialpositionen mit Menge und, falls erkennbar, Einheit.
Antworte AUSSCHLIESSLICH mit einem JSON-Objekt in genau dieser Form, ohne zusätzlichen Text:

{"positionen":[{"bezeichnung":"...","menge":5,"einheit":"Stück","kategorie":"..."}]}

Regeln:
- "einheit" ist optional, Standard ist "Stück"
- "kategorie": IMMER eine der folgenden festen Kategorien wählen, die inhaltlich am besten passt: ${KATEGORIEN.join(', ')}. Bei Unsicherheit "Sonstiges" verwenden.
- Neu geliefertes/importiertes Material gilt als Zustand "neu" (automatisch gesetzt, nicht ins JSON aufnehmen)
- Wenn eine Menge nicht eindeutig lesbar ist, überspringe die Position lieber, als zu raten
- Kopf-/Fußzeilen, Firmenadressen, Bestellnummern, Summenzeilen, Tabellenüberschriften etc. sind KEINE Materialpositionen, nur echte Artikelzeilen erfassen`;

  const raw = await provider.chat(systemPrompt, inhalt);
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Konnte keine Positionen im Dokument erkennen.');
  }
  const daten = JSON.parse(jsonMatch[0]);
  return daten.positionen || [];
}

// Zentraler Dateityp-Router: Fotos/Screenshots/PDF -> Mistral OCR -> Text.
// Excel/Word -> direktes Auslesen, kein OCR nötig. Danach in beiden Fällen derselbe letzte Schritt.
async function importiereAusDatei(buffer, mimeType, chatId) {
  let text;

  if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
    bot.sendMessage(chatId, 'Dokument wird per OCR ausgelesen …');
    const base64 = buffer.toString('base64');
    text = await mistralOCR(base64, mimeType);
  } else if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel'
  ) {
    bot.sendMessage(chatId, 'Excel-Datei wird ausgelesen …');
    text = await excelZuText(buffer);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    bot.sendMessage(chatId, 'Word-Dokument wird ausgelesen …');
    text = await wordZuText(buffer);
  } else {
    bot.sendMessage(chatId, `Dateityp "${mimeType}" wird nicht unterstützt. Unterstützt: Fotos, PDF, .xlsx, .docx.`);
    return;
  }

  if (!text || !text.trim()) {
    bot.sendMessage(chatId, 'Es konnte kein Text aus der Datei extrahiert werden.');
    return;
  }

  const positionen = await extrahierePositionenAusText(text);
  if (positionen.length === 0) {
    bot.sendMessage(chatId, 'Es wurden keine Materialpositionen erkannt.');
    return;
  }

  const ergebnisse = await addierePositionen(positionen);
  const antwortText = ergebnisse
    .map((e) => `${e.bezeichnung} [${e.kategorie}] (${e.zustand}): jetzt ${e.menge} ${e.einheit}`)
    .join('\n');
  await sendeLangeNachricht(chatId, `${ergebnisse.length} Position(en) eingetragen:\n` + antwortText);
}

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;

  // Getippte Nachricht (inkl. Text, der auf dem Handy per Diktierfunktion eingetippt wurde)
  if (msg.text) {
    await verarbeiteText(chatId, msg.text);
    return;
  }

  // Telegram-Sprachnachricht (aufgenommenes Audio)
  if (msg.voice) {
    try {
      bot.sendMessage(chatId, 'Sprachnachricht wird transkribiert, bei längeren Aufnahmen kann das etwas dauern …');
      const fileLink = await bot.getFileLink(msg.voice.file_id);
      const audioRes = await fetch(fileLink);
      const audioBuffer = Buffer.from(await audioRes.arrayBuffer());

      const text = await transkribiere(audioBuffer);
      bot.sendMessage(chatId, `Verstanden: "${text}"`);
      await verarbeiteText(chatId, text);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Fehler bei der Spracherkennung: ' + err.message);
    }
    return;
  }

  // Foto (Lieferschein, Screenshot einer Materialliste, handschriftliche Liste)
  if (msg.photo) {
    try {
      const besteAufloesung = msg.photo[msg.photo.length - 1];
      const fileLink = await bot.getFileLink(besteAufloesung.file_id);
      const bildRes = await fetch(fileLink);
      const bildBuffer = Buffer.from(await bildRes.arrayBuffer());
      await importiereAusDatei(bildBuffer, 'image/jpeg', chatId);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Fehler bei der Dateiauswertung: ' + err.message);
    }
    return;
  }

  // Datei-Upload (PDF, .xlsx, .docx, oder ein Foto, das als Datei statt komprimiert geschickt wurde)
  if (msg.document) {
    try {
      const fileLink = await bot.getFileLink(msg.document.file_id);
      const dateiRes = await fetch(fileLink);
      const dateiBuffer = Buffer.from(await dateiRes.arrayBuffer());
      await importiereAusDatei(dateiBuffer, msg.document.mime_type, chatId);
    } catch (err) {
      console.error(err);
      bot.sendMessage(chatId, 'Fehler bei der Dateiauswertung: ' + err.message);
    }
  }
});

// /excel gibt die aktuelle Datei direkt im Chat aus
bot.onText(/\/excel/, (msg) => {
  bot.sendDocument(msg.chat.id, EXCEL_PATH);
});

// /regeln zeigt die aktuell gemerkten Regeln
bot.onText(/\/regeln/, (msg) => {
  const regeln = ladeRegeln();
  bot.sendMessage(msg.chat.id, regeln || 'Noch keine Regeln gemerkt.');
});

// /gruppen zeigt die aktuell gemerkten Artikelgruppen
bot.onText(/\/gruppen/, (msg) => {
  const gruppen = ladeArtikelgruppen();
  bot.sendMessage(msg.chat.id, gruppen || 'Noch keine Artikelgruppen gemerkt.');
});

console.log('Telegram-Bot läuft (Polling-Modus).');
