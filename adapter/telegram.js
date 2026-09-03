// Telegram-Adapter — die EINZIGE Datei, die Telegram kennt.
//
// Aufgabe: Nachrichten entgegennehmen, in neutrale Eingaben übersetzen, den
// Orchestrator fragen und dessen neutrales Ergebnis rendern (Text, Dateien,
// Knöpfe). Fachlogik steht hier keine.
//
// Ein zweiter Adapter (Web, WhatsApp, CLI) müsste nur diese Datei nachbauen.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const { SCHWELLEN, PFADE } = require('../config');
const orchestrator = require('../kern/orchestrator');
const experten = require('../experten');
const themen = require('../themen');
const gedaechtnis = require('../gedaechtnis');
const kompressor = require('../kompressor');
const benutzer = require('../benutzer');
const ratelimit = require('../ratelimit');
const { schreibeEintrag, leseLetzte } = require('../protokoll');
const { ladeBegruessung } = require('../begruessung');
const { transkribiere } = require('../transcribe');
const { mistralOCR } = require('../ocr');
const { excelZuText, wordZuText } = require('../dokument');

function starte({ token, provider, mainChat, lightChat }) {
  const bot = new TelegramBot(token, { polling: true });
  const offeneBestaetigungen = new Map();

  // ───────────────────────────────────────────────────────────── Ausgabe

  async function sendeText(chatId, text) {
    if (!text) return;
    for (const block of teile(text)) {
      try {
        await bot.sendMessage(chatId, block, { parse_mode: 'Markdown' });
      } catch {
        // Markdown kann an Nutzerdaten scheitern (einzelne * oder _).
        // Dann lieber unformatiert senden als gar nicht.
        await bot.sendMessage(chatId, block).catch(() => {});
      }
    }
  }

  function teile(text) {
    const bloecke = [];
    let block = '';
    for (const zeile of String(text).split('\n')) {
      const kandidat = block ? block + '\n' + zeile : zeile;
      if (kandidat.length > SCHWELLEN.TELEGRAM_MAX) {
        if (block) bloecke.push(block);
        block = zeile;
      } else { block = kandidat; }
    }
    if (block) bloecke.push(block);
    return bloecke;
  }

  // Rendert das neutrale Orchestrator-Ergebnis.
  async function rendere(chatId, ergebnis) {
    if (!ergebnis) return;
    const knoepfe = ergebnis.knoepfe || [];
    if (knoepfe.length > 0) {
      const markup = { inline_keyboard: [knoepfe.map((k) => ({ text: k.text, callback_data: k.daten }))] };
      try {
        await bot.sendMessage(chatId, ergebnis.text, { parse_mode: 'Markdown', reply_markup: markup });
      } catch {
        await bot.sendMessage(chatId, ergebnis.text, { reply_markup: markup }).catch(() => {});
      }
    } else {
      await sendeText(chatId, ergebnis.text);
    }
    for (const datei of ergebnis.dateien || []) {
      try {
        if (fs.existsSync(datei)) await bot.sendDocument(chatId, datei);
      } catch (err) {
        await sendeText(chatId, `Konnte die Datei nicht senden: ${err.message}`);
      }
    }
  }

  async function mitTippt(chatId, fn) {
    bot.sendChatAction(chatId, 'typing').catch(() => {});
    return fn();
  }

  // ──────────────────────────────────────── Tool-Bestätigung (Inline-Knöpfe)

  function beschreibe(toolCalls) {
    return toolCalls.map((c) => {
      if (c.name === 'web_search') return `🔍 Web-Suche: „${c.args.query || '?'}"`;
      if (c.name === 'web_fetch') return `🌐 Webseite lesen: ${c.args.url || '?'}`;
      return `🔧 ${c.name}(${JSON.stringify(c.args).slice(0, 80)})`;
    }).join('\n');
  }

  function frageBestaetigung(chatId) {
    return (toolCalls) => new Promise((resolve) => {
      const id = crypto.randomBytes(8).toString('hex');
      let erledigt = false;
      let nachrichtId = 0;

      const fertig = (wert) => {
        if (erledigt) return;
        erledigt = true;
        offeneBestaetigungen.delete(id);
        clearTimeout(timer);
        resolve(wert);
      };

      const timer = setTimeout(() => {
        if (nachrichtId) {
          bot.editMessageReplyMarkup({ inline_keyboard: [] },
            { chat_id: chatId, message_id: nachrichtId }).catch(() => {});
        }
        bot.sendMessage(chatId, '⏱️ Bestätigung abgelaufen, Aufruf abgebrochen.').catch(() => {});
        fertig({ erlaubt: false, grund: 'Zeitüberschreitung' });
      }, SCHWELLEN.TOOL_BESTAETIGUNG_TIMEOUT_MS);

      bot.sendMessage(chatId,
        `⚠️ Die KI möchte folgende externe Aktion ausführen:\n\n${beschreibe(toolCalls)}\n\nErlauben?`,
        { reply_markup: { inline_keyboard: [[
          { text: '✅ Ja, abrufen', callback_data: 'tool_ok:' + id },
          { text: '❌ Nein', callback_data: 'tool_no:' + id }
        ]] } }
      ).then((m) => { nachrichtId = m.message_id; })
       .catch(() => fertig({ erlaubt: false, grund: 'Sendefehler' }));

      offeneBestaetigungen.set(id, fertig);
    });
  }

  // Alles, was Kern und Experten an Außenwelt brauchen — mehr nicht.
  function dienste(chatId) {
    return {
      mainChat, lightChat, provider,
      protokoll: schreibeEintrag,
      melde: (text) => sendeText(chatId, text),
      frageBestaetigung: frageBestaetigung(chatId),
      chat: mainChat // der Vorgangs-Motor nutzt den Hauptkanal für die Extraktion
    };
  }

  async function verarbeite(chatId, eingabe) {
    try {
      const ergebnis = await orchestrator.verarbeiteNachricht({ chatId, ...eingabe }, dienste(chatId));
      await rendere(chatId, ergebnis);
    } catch (err) {
      console.error(err);
      schreibeEintrag('Fehler', `Verarbeitung (${chatId}): ${err.message}`);
      await sendeText(chatId, 'Fehler bei der Verarbeitung: ' + err.message);
    }
  }

  async function ladeDatei(fileId) {
    const link = await bot.getFileLink(fileId);
    const res = await fetch(link);
    return Buffer.from(await res.arrayBuffer());
  }

  // ───────────────────────────────────────────────────────── Eingangs-Handler

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;

    let userState;
    try {
      userState = benutzer.initialisiereAusMessage(msg);
    } catch (err) {
      console.error('User-Initialisierung fehlgeschlagen:', err);
      return;
    }
    if (userState.warNeu) {
      const name = userState.profil.displayName ? `, ${userState.profil.displayName}` : '';
      await sendeText(chatId, `👋 Hallo${name}! Schreib einfach los — oder tipp /start für die Anleitung.`);
      schreibeEintrag('Info', `Neuer User: ${userState.profil.chatId}`);
    }

    // Text
    if (msg.text) {
      if (msg.text.trim().startsWith('/')) return; // Commands laufen über onText
      return mitTippt(chatId, () => verarbeite(chatId, { text: msg.text.trim() }));
    }

    // Sprachnachricht: IMMER erst transkribieren, dann normal weiter.
    if (msg.voice || msg.audio) {
      const quelle = msg.voice || msg.audio;
      try {
        await mitTippt(chatId, async () => {
          await sendeText(chatId, '🎙 Sprachnachricht wird transkribiert …');
          const text = await transkribiere(await ladeDatei(quelle.file_id));
          await sendeText(chatId, `Verstanden: „${text}"`);
          await verarbeite(chatId, { text });
        });
      } catch (err) {
        schreibeEintrag('Fehler', `Sprachnachricht: ${err.message}`);
        await sendeText(chatId, 'Fehler bei der Spracherkennung: ' + err.message);
      }
      return;
    }

    // Foto
    if (msg.photo) {
      try {
        await mitTippt(chatId, async () => {
          const bestes = msg.photo[msg.photo.length - 1];
          const buffer = await ladeDatei(bestes.file_id);
          const name = `foto-${Date.now()}.jpg`;
          // OCR liefert den Text; der Router entscheidet anhand von Beschriftung
          // und Inhalt, was damit passiert.
          let inhalt = '';
          try {
            inhalt = await mistralOCR(buffer.toString('base64'), 'image/jpeg');
          } catch (err) {
            schreibeEintrag('Fehler', `OCR: ${err.message}`);
          }
          await verarbeite(chatId, {
            text: msg.caption || '',
            dokInhalt: inhalt,
            dokInfo: { name, mimeType: 'image/jpeg', size: buffer.length, pfad: null },
            datei: { buffer, name, mimeType: 'image/jpeg' }
          });
        });
      } catch (err) {
        schreibeEintrag('Fehler', `Foto: ${err.message}`);
        await sendeText(chatId, 'Fehler bei der Bildverarbeitung: ' + err.message);
      }
      return;
    }

    // Dokument
    if (msg.document) {
      try {
        await mitTippt(chatId, async () => {
          const d = msg.document;
          const buffer = await ladeDatei(d.file_id);
          const name = d.file_name || `datei-${Date.now()}`;
          const mime = d.mime_type || '';
          const inhalt = await dateiZuText(buffer, mime, name);

          // Der Router braucht ggf. eine Inhalts-Vorschau aus der echten Datei.
          const temp = path.join(require('os').tmpdir(), `wws-${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
          try { fs.writeFileSync(temp, buffer); } catch { /* Vorschau ist optional */ }

          await verarbeite(chatId, {
            text: msg.caption || '',
            dokInhalt: inhalt,
            dokInfo: { name, mimeType: mime, size: buffer.length, pfad: fs.existsSync(temp) ? temp : null },
            datei: { buffer, name, mimeType: mime }
          });
          try { fs.unlinkSync(temp); } catch { /* egal */ }
        });
      } catch (err) {
        schreibeEintrag('Fehler', `Dokument: ${err.message}`);
        await sendeText(chatId, 'Fehler beim Einlesen der Datei: ' + err.message);
      }
    }
  });

  async function dateiZuText(buffer, mime, name) {
    const n = String(name).toLowerCase();
    try {
      if (mime === 'application/pdf' || n.endsWith('.pdf')) {
        return await mistralOCR(buffer.toString('base64'), 'application/pdf');
      }
      if (n.endsWith('.xlsx') || n.endsWith('.xls')) return await excelZuText(buffer);
      if (n.endsWith('.docx') || n.endsWith('.doc')) return await wordZuText(buffer);
      if (mime.startsWith('image/')) return await mistralOCR(buffer.toString('base64'), mime);
      if (mime.startsWith('text/') || n.endsWith('.txt') || n.endsWith('.csv')) {
        return buffer.toString('utf-8').slice(0, 20000);
      }
    } catch (err) {
      schreibeEintrag('Fehler', `Datei-Auslese (${name}): ${err.message}`);
    }
    return '';
  }

  // ──────────────────────────────────────────────────────────── Knopfdrücke

  bot.on('callback_query', async (query) => {
    const daten = query.data || '';
    const chatId = query.message && query.message.chat.id;
    const knoepfeWeg = () => {
      if (!query.message) return;
      bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }).catch(() => {});
    };

    if (daten.startsWith('tool_')) {
      const [, id] = daten.split(':');
      const warten = offeneBestaetigungen.get(id);
      if (!warten) {
        bot.answerCallbackQuery(query.id, { text: 'Abgelaufen oder unbekannt.' }).catch(() => {});
        return;
      }
      const erlaubt = daten.startsWith('tool_ok');
      bot.answerCallbackQuery(query.id, { text: erlaubt ? 'Führe aus …' : 'Abgebrochen.' }).catch(() => {});
      knoepfeWeg();
      warten({ erlaubt, grund: erlaubt ? 'vom Nutzer erlaubt' : 'vom Nutzer abgelehnt' });
      return;
    }

    if (daten.startsWith('vorgang_')) {
      knoepfeWeg();
      bot.answerCallbackQuery(query.id).catch(() => {});
      const [aktion, themaId] = daten.split(':');
      const ergebnis = aktion === 'vorgang_ok'
        ? await orchestrator.bestaetigeVorgang({ chatId, themaId }, dienste(chatId))
        : await orchestrator.brichVorgangAb({ chatId, themaId });
      await rendere(chatId, ergebnis);
      return;
    }

    bot.answerCallbackQuery(query.id).catch(() => {});
  });

  // ───────────────────────────────────────────────────────────────── Commands

  const antworte = (msg, text) => sendeText(msg.chat.id, text);

  bot.onText(/^\/start\b/, async (msg) => antworte(msg, ladeBegruessung()));

  bot.onText(/^\/themen\b/, (msg) => {
    const index = themen.ladeIndex(msg.chat.id);
    if (index.length === 0) {
      return antworte(msg, 'Du hast noch keine Themen. Schreib einfach los — das erste wird automatisch angelegt.');
    }
    const offene = require('../kern/vorgang').offeneVorgaenge(msg.chat.id);
    const zeilen = index.map((t, i) => {
      const v = offene.find((o) => o.themaId === t.id);
      const datum = (t.lastActivity || '').slice(0, 16).replace('T', ' ');
      return `${i + 1}. *${t.name}* (${t.messageCount} Nachrichten, zuletzt ${datum})` +
        (v ? `\n    ⚠ offener Vorgang: ${v.experteId}` : '');
    });
    return antworte(msg, 'Deine Themen:\n' + zeilen.join('\n'));
  });

  bot.onText(/^\/neu(?:\s+(.+))?/, (msg, m) => {
    const t = themen.erstelleThema(msg.chat.id, (m && m[1] && m[1].trim()) || 'Neues Thema');
    return antworte(msg, `Neues Thema „${t.name}" angelegt.`);
  });

  bot.onText(/^\/thema(?:\s+(.+))?/, (msg, m) => {
    const suche = m && m[1] && m[1].trim();
    if (!suche) return antworte(msg, 'Benutzung: /thema <Name>');
    const t = themen.findeThemaMitName(msg.chat.id, suche);
    if (!t) return antworte(msg, `Kein Thema mit „${suche}" gefunden. /themen zeigt alle.`);
    const voll = themen.ladeThema(msg.chat.id, t.id);
    if (!voll || !(voll.messages || []).length) return antworte(msg, `Thema „${t.name}" ist noch leer.`);
    const zeilen = voll.messages.map((x) =>
      `[${(x.zeit || '').slice(0, 16).replace('T', ' ')}] ${x.rolle === 'user' ? 'Du' : 'Bot'}: ${x.inhalt}`);
    return antworte(msg, `Verlauf von „${t.name}":\n` + zeilen.join('\n'));
  });

  bot.onText(/^\/umbenennen\s+(\S+)\s+(.+)/, (msg, m) => {
    const t = themen.findeThemaMitName(msg.chat.id, m[1]);
    if (!t) return antworte(msg, `Kein Thema mit „${m[1]}" gefunden.`);
    return antworte(msg, `Thema umbenannt in „${themen.benenneThemaUm(msg.chat.id, t.id, m[2]).name}".`);
  });

  bot.onText(/^\/loeschen\s+(\S+)/, (msg, m) => {
    const t = themen.findeThemaMitName(msg.chat.id, m[1]);
    if (!t) return antworte(msg, `Kein Thema mit „${m[1]}" gefunden.`);
    themen.loescheThema(msg.chat.id, t.id);
    return antworte(msg, `Thema „${t.name}" gelöscht.`);
  });

  bot.onText(/^\/zusammenfassung(?:\s+(.+))?/, (msg, m) => {
    const suche = m && m[1] && m[1].trim();
    const t = suche ? themen.findeThemaMitName(msg.chat.id, suche) : themen.ladeIndex(msg.chat.id)[0];
    if (!t) return antworte(msg, 'Noch kein Thema vorhanden.');
    const voll = themen.ladeThema(msg.chat.id, t.id);
    return antworte(msg, `Zusammenfassung von „${t.name}":\n` +
      ((voll && voll.summary) || '(noch keine — das Thema ist zu kurz)'));
  });

  bot.onText(/^\/gedaechtnis\b/, (msg) => {
    const fakten = gedaechtnis.ladeFakten(msg.chat.id);
    if (!fakten.length) return antworte(msg, 'Das Langzeit-Gedächtnis ist noch leer. Schreib „merke dir: …".');
    return antworte(msg, 'Langzeit-Gedächtnis:\n' + fakten.map((f, i) => `${i + 1}. ${f}`).join('\n'));
  });

  bot.onText(/^\/merke\s+(.+)/, (msg, m) => {
    const fakt = m[1].trim();
    return antworte(msg, gedaechtnis.fuegeHinzu(msg.chat.id, fakt) ? `Gemerkt: ${fakt}` : 'Steht schon drin.');
  });

  bot.onText(/^\/vergiss\s+(\d+)/, (msg, m) =>
    antworte(msg, gedaechtnis.entferneFakt(msg.chat.id, parseInt(m[1], 10) - 1)
      ? 'Fakt entfernt.' : 'Diese Nummer gibt es nicht. /gedaechtnis zeigt die Liste.'));

  bot.onText(/^\/user\b/, (msg) => {
    const rl = ratelimit.status(msg.chat.id);
    const p = benutzer.ladeProfil(msg.chat.id);
    return antworte(msg,
      `Deine Chat-ID: ${msg.chat.id}\n` +
      (p ? `Name: ${p.displayName || '—'}\nErster Kontakt: ${(p.firstSeen || '').slice(0, 10)}\n` +
           `Daten unter: data/users/${p.chatId}/\n` : 'Profil: (noch nicht initialisiert)\n') +
      `Themen: ${themen.ladeIndex(msg.chat.id).length}\n` +
      `Gedächtnis: ${gedaechtnis.ladeFakten(msg.chat.id).length} Fakten\n` +
      `Limits: ${rl.stunde}/h, ${rl.tag}/Tag, ${rl.tools} Tool-Calls/Tag`);
  });

  bot.onText(/^\/wer_bin_ich\b/, (msg) => {
    const p = benutzer.ladeProfil(msg.chat.id);
    if (!p) return antworte(msg, 'Kein Profil gefunden. Schreib erst eine Nachricht.');
    return antworte(msg, 'Dein Profil:\n' +
      `Chat-ID: ${p.chatId}\nName: ${p.displayName || '—'}\n` +
      `Username: ${p.username ? '@' + p.username : '—'}\n` +
      `Erster Kontakt: ${(p.firstSeen || '').slice(0, 19).replace('T', ' ')}\n` +
      `Letzter Kontakt: ${(p.lastSeen || '').slice(0, 19).replace('T', ' ')}`);
  });

  bot.onText(/^\/delete[-_]my[-_]data\b/, (msg) => {
    if (!benutzer.ladeProfil(msg.chat.id)) return antworte(msg, 'Du hast hier keine gespeicherten Daten.');
    const ok = benutzer.loescheAlles(msg.chat.id);
    if (ok) schreibeEintrag('Sicherheit', `User-Daten gelöscht auf Wunsch: ${msg.chat.id}`);
    return antworte(msg, ok
      ? '✅ Alle deine Daten sind gelöscht. Beim nächsten Schreiben wird frisch angelegt.'
      : 'Konnte deine Daten nicht löschen — bitte beim Admin melden.');
  });

  bot.onText(/^\/protokoll\b/, (msg) => antworte(msg, leseLetzte(20) || 'Das Protokoll ist noch leer.'));

  bot.onText(/^\/experten\b/, (msg) => {
    const zeilen = experten.listeStatus().map((e) =>
      `${e.emoji} *${e.name}* — ${e.implementiert ? '✅ aktiv' : '🚧 Stub'} _(${e.art})_\n   ${e.beschreibung}` +
      (e.tools.length ? `\n   Werkzeuge: ${e.tools.join(', ')}` : '') +
      (e.commands.length ? `\n   Befehle: ${e.commands.map((c) => '/' + c).join(', ')}` : ''));
    return antworte(msg, '*Expertensysteme:*\n\n' + zeilen.join('\n\n') +
      '\n\n_Schreib einfach los — der Router wählt automatisch._');
  });

  bot.onText(/^\/komprimieren\b/, async (msg) => {
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    let gemacht = 0;
    for (const e of themen.ladeIndex(msg.chat.id)) {
      const t = themen.ladeThema(msg.chat.id, e.id);
      if (t && kompressor.themaBereitZurKomprimierung(t)) {
        await kompressor.komprimiereThema(msg.chat.id, e.id, lightChat);
        gemacht++;
      }
    }
    const ged = gedaechtnis.istVoll(msg.chat.id)
      ? await kompressor.komprimiereGedaechtnis(msg.chat.id, lightChat) : false;
    return antworte(msg, `Komprimierung fertig. ${gemacht} Thema/Themen verdichtet${ged ? ', Gedächtnis verdichtet' : ''}.`);
  });

  bot.onText(/^\/options\b/, (msg) => {
    const p = path.join(PFADE.DATA, 'options.json');
    if (!fs.existsSync(p)) return antworte(msg, '❌ options.json nicht gefunden.');
    let o;
    try { o = JSON.parse(fs.readFileSync(p, 'utf-8')); }
    catch (e) { return antworte(msg, '❌ options.json ist kaputt: ' + e.message); }
    const zeilen = [`*${o.name || 'Bot'}*`];
    if (o.kurzbeschreibung) zeilen.push('_' + o.kurzbeschreibung + '_', '');
    if (Array.isArray(o.funktionen) && o.funktionen.length) {
      zeilen.push('*Kann:*', ...o.funktionen.map((f) => '• ' + f), '');
    }
    if (Array.isArray(o.befehle) && o.befehle.length) {
      zeilen.push('*Befehle:*', ...o.befehle.map((b) =>
        typeof b === 'string' ? '• ' + b : `• ${b.befehl} — ${b.beschreibung}`));
    }
    return antworte(msg, zeilen.join('\n'));
  });

  // Von Experten mitgebrachte Befehle — der Kern kennt sie nicht namentlich.
  for (const cmd of experten.alleCommands()) {
    const muster = new RegExp(`^\\/${cmd.name}(?:\\s+(.+))?\\s*$`);
    bot.onText(muster, async (msg, m) => {
      try {
        const ergebnis = await cmd.ausfuehren({
          chatId: msg.chat.id,
          argument: (m && m[1] && m[1].trim()) || null,
          dienste: dienste(msg.chat.id)
        });
        await rendere(msg.chat.id, ergebnis);
      } catch (err) {
        schreibeEintrag('Fehler', `Command /${cmd.name}: ${err.message}`);
        await sendeText(msg.chat.id, `Fehler bei /${cmd.name}: ${err.message}`);
      }
    });
  }

  const cmdNamen = experten.alleCommands().map((c) => '/' + c.name);
  console.log(`Telegram-Adapter läuft. Experten-Befehle: ${cmdNamen.join(', ') || '(keine)'}`);
  return bot;
}

module.exports = { starte };
