// Telegram-Adapter — die EINZIGE Datei, die Telegram kennt.
//
// Aufgabe: Nachrichten entgegennehmen, in neutrale Eingaben übersetzen, den
// Orchestrator fragen und dessen neutrales Ergebnis rendern (Text, Dateien,
// Knöpfe). Fachlogik steht hier keine.
//
// Ein zweiter Adapter (Web, WhatsApp, CLI) müsste nur diese Datei nachbauen.

const fs = require('fs');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const antwortZiel = new AsyncLocalStorage();
const TelegramBot = require('node-telegram-bot-api');

const { SCHWELLEN, PFADE } = require('../config');
const modus = require('../kern/modus');
const optionen = require('../optionen');
const hilfe = require('../hilfe');
const benachrichtigung = require('../benachrichtigung');
const orchestrator = require('../kern/orchestrator');
const experten = require('../experten');
const themen = require('../themen');
const gedaechtnis = require('../gedaechtnis');
const kompressor = require('../kompressor');
const benutzer = require('../benutzer');
const zugang = require('../zugang');
const gruppen = require('../gruppen');
const ratelimit = require('../ratelimit');
const { schreibeEintrag, leseLetzte } = require('../protokoll');
const fachdienste = require('../dienste');
const { excelZuText, wordZuText } = require('../dokument');

function starte({ token, provider, antwortChat, routerChat, extraktionChat, summaryChat }) {
  const bot = new TelegramBot(token, { polling: true });
  const offeneBestaetigungen = new Map();

  // ───────────────────────────────────────────────────────────── Ausgabe

  // ─────────────────────────────────────────── Antwort-Ziel in Forum-Gruppen
  //
  // In einer Forum-Gruppe landet eine Antwort OHNE message_thread_id im Thema
  // "Allgemein" — nicht dort, wo gefragt wurde. Das würde die ausgelagerten
  // Fäden wertlos machen. Der Thread wird deshalb für die Dauer einer Nachricht
  // mitgeführt, und zwar über AsyncLocalStorage statt über einen Eintrag pro
  // Chat: zwei Themen derselben Gruppe können gleichzeitig hereinkommen, ein
  // gemeinsamer Eintrag würde die Antworten dann vertauschen.
  function threadVon(msg) {
    return (msg && msg.is_topic_message && msg.message_thread_id) ? msg.message_thread_id : null;
  }

  function imThema(msg, fn) {
    const t = threadVon(msg);
    return t ? antwortZiel.run({ threadId: t }, fn) : fn();
  }

  function zielOpt() {
    const s = antwortZiel.getStore();
    return s && s.threadId ? { message_thread_id: s.threadId } : {};
  }

  async function sendeText(chatId, text) {
    if (!text) return;
    for (const block of teile(text)) {
      try {
        await bot.sendMessage(chatId, block, { parse_mode: 'Markdown', ...zielOpt() });
      } catch {
        // Markdown kann an Nutzerdaten scheitern (einzelne * oder _).
        // Dann lieber unformatiert senden als gar nicht.
        await bot.sendMessage(chatId, block, { ...zielOpt() }).catch(() => {});
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
        await bot.sendMessage(chatId, ergebnis.text, { parse_mode: 'Markdown', reply_markup: markup, ...zielOpt() });
      } catch {
        await bot.sendMessage(chatId, ergebnis.text, { reply_markup: markup, ...zielOpt() }).catch(() => {});
      }
    } else {
      await sendeText(chatId, ergebnis.text);
    }
    for (const datei of ergebnis.dateien || []) {
      try {
        if (fs.existsSync(datei)) await bot.sendDocument(chatId, datei, { ...zielOpt() });
      } catch (err) {
        await sendeText(chatId, `Konnte die Datei nicht senden: ${err.message}`);
      }
    }
  }

  async function mitTippt(chatId, fn) {
    bot.sendChatAction(chatId, 'typing', { ...zielOpt() }).catch(() => {});
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
        bot.sendMessage(chatId, '⏱️ Bestätigung abgelaufen, Aufruf abgebrochen.', { ...zielOpt() }).catch(() => {});
        fertig({ erlaubt: false, grund: 'Zeitüberschreitung' });
      }, SCHWELLEN.TOOL_BESTAETIGUNG_TIMEOUT_MS);

      bot.sendMessage(chatId,
        `⚠️ Die KI möchte folgende externe Aktion ausführen:\n\n${beschreibe(toolCalls)}\n\nErlauben?`,
        { ...zielOpt(), reply_markup: { inline_keyboard: [[
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
      provider,
      routerChat,             // Faden- und Experten-Entscheidung
      chat: extraktionChat,   // Vorgangs-Motor: Freitext -> Delta-Operationen
      antwortChat,            // freie Antworten
      lightChat: summaryChat, // Zusammenfassen, Gedächtnis
      protokoll: schreibeEintrag,
      melde: (text) => sendeText(chatId, text),
      frageBestaetigung: frageBestaetigung(chatId),
      // Wohin eine SPAETERE Antwort gehoert (Forum-Thema). Experten, die einen
      // Auftrag einstellen und erst Minuten danach melden, speichern das mit.
      antwortZiel: () => zielOpt()
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

  // Solange ein exklusiver Modus laeuft, geht NICHTS anderes durch — weder
  // Befehle noch Text. Registriert wird deshalb ueber diesen Wrapper und nicht
  // direkt ueber bot.onText: sonst haette jeder neue Befehl die Sperre vergessen.
  function befehl(muster, handler) {
    bot.onText(muster, (msg, m) => imThema(msg, async () => {
      // Zugang zuerst: ohne Freischaltung geht KEIN Befehl durch.
      if (await gateFaengtAb(msg)) return;
      if (await modusFaengtAb(msg)) return;
      return handler(msg, m);
    }));
  }

  // Telegram ruft fuer eine Befehlsnachricht ZWEI Wege auf: bot.on('message')
  // und den passenden onText-Handler. Ohne dieses Gedaechtnis wuerde der
  // Einstellungsbereich auf jeden Befehl zweimal antworten.
  const schonBehandelt = new Set();
  function merkeBehandelt(msg) {
    const id = `${msg.chat.id}:${msg.message_id}`;
    if (schonBehandelt.has(id)) return true;
    schonBehandelt.add(id);
    if (schonBehandelt.size > 500) schonBehandelt.delete(schonBehandelt.values().next().value);
    return false;
  }

  // ─────────────────────────────────────────────────────────── Zugangs-Gate
  //
  // Laeuft VOR allem anderen und ist vollstaendig deterministisch: kein Router,
  // keine KI, kein Experte. Wer nicht freigeschaltet ist, sieht ausschliesslich
  // die Aufforderung, den Code einzugeben — so lange, bis er stimmt.
  async function gateFaengtAb(msg) {
    const chatId = msg.chat.id;
    if (zugang.istFreigeschaltet(chatId)) return false;

    const from = msg.from || {};
    const r = zugang.pruefe(chatId, msg.text || '', {
      displayName: [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || null,
      username: from.username || null
    });
    if (r.durchlassen) return false;

    // Telegram ruft fuer eine Befehlsnachricht message UND onText auf — ohne
    // dieses Gedaechtnis kaeme die Code-Aufforderung doppelt.
    if (merkeBehandelt(msg)) return true;
    await sendeText(chatId, r.text);
    if (r.neu) schreibeEintrag('Zugang', `Freigeschaltet: ${chatId} (${from.username || from.first_name || '?'})`);
    return true;
  }

  // Nachrichten aus einer Gruppe bekommen eine kurze Kontextzeile vorangestellt:
  // in welcher Gruppe, welchem Forum-Thema und worum es dort bisher ging. Der
  // Router und die Experten lesen das mit, ohne dass sie Telegram kennen muessen.
  function mitGruppenKontext(msg, text) {
    const k = gruppen.kontextZeile(msg);
    if (!k) return text;
    return text ? `${k}\n${text}` : k;
  }

  // Gibt true zurueck, wenn die Nachricht vom laufenden Modus erledigt wurde.
  async function modusFaengtAb(msg) {
    const chatId = msg.chat.id;
    const aktiv = modus.aktiv(chatId);
    if (!aktiv) return false;

    const text = (msg.text || '').trim();

    if (aktiv.art === 'options') {
      const r = optionen.verarbeite(chatId, text, aktiv.daten);
      // Wartungsbefehl im Admin-Bereich: nicht abfangen, normal ausfuehren lassen.
      if (r.durchlassen) return false;
      if (merkeBehandelt(msg)) return true;
      if (r.beenden) modus.beende(chatId);
      else if (r.daten) modus.aktualisiere(chatId, r.daten);
      await sendeText(chatId, r.text);
      return true;
    }

    if (merkeBehandelt(msg)) return true;
    // Unbekannter Modus: nicht stillschweigend schlucken, sondern sagen, was los ist.
    await sendeText(chatId,
      '⏸ Gerade läuft etwas anderes. Schließ das erst ab, dann geht es hier weiter.');
    return true;
  }

  // Wartungsbefehle laufen NUR im geoeffneten Admin-Bereich. Ausserhalb sagt der
  // Bot, wo sie liegen — statt sie stillschweigend zu ignorieren oder sie jedem
  // anzubieten.
  function adminBefehl(muster, handler) {
    bot.onText(muster, (msg, m) => imThema(msg, async () => {
      const aktiv = modus.aktiv(msg.chat.id);
      if (aktiv && aktiv.art === 'options' && aktiv.daten.admin) return handler(msg, m);
      if (await modusFaengtAb(msg)) return;
      await sendeText(msg.chat.id,
        '🔒 Das ist ein Wartungsbefehl.\n\nÖffne dafür den Admin-Bereich:\n`/einstellungen <Kennwort>`');
    }));
  }

  bot.on('message', (msg) => imThema(msg, async () => {
    const chatId = msg.chat.id;

    // Zugang VOR allem anderen — auch vor dem Anlegen von Nutzerdaten. Fuer
    // einen gesperrten Chat entsteht so kein einziger Ordner.
    if (await gateFaengtAb(msg)) return;

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

    // Modus zuerst: eine Nachricht, die waehrend der Einstellungen hereinkommt,
    // darf nicht nebenher verarbeitet werden.
    if (await modusFaengtAb(msg)) return;

    // Text
    if (msg.text) {
      if (msg.text.trim().startsWith('/')) return; // Commands laufen über onText
      const text = mitGruppenKontext(msg, msg.text.trim());
      return mitTippt(chatId, () => verarbeite(chatId, { text }));
    }

    // Sprachnachricht: IMMER erst transkribieren, dann normal weiter.
    if (msg.voice || msg.audio) {
      const quelle = msg.voice || msg.audio;
      try {
        await mitTippt(chatId, async () => {
          await sendeText(chatId, '🎙 Sprachnachricht wird transkribiert …');
          const text = await fachdienste.transkription(await ladeDatei(quelle.file_id), quelle.mime_type || 'audio/ogg');
          await sendeText(chatId, `Verstanden: „${text}"`);
          await verarbeite(chatId, { text: mitGruppenKontext(msg, text) });
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
            inhalt = await fachdienste.ocr(buffer, 'image/jpeg');
          } catch (err) {
            schreibeEintrag('Fehler', `OCR: ${err.message}`);
          }
          await verarbeite(chatId, {
            text: mitGruppenKontext(msg, msg.caption || ''),
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
          let inhalt = '';
          try {
            inhalt = await dateiZuText(buffer, mime, name);
          } catch (err) {
            inhalt = '';
          }
          // Stillschweigend mit leerem Inhalt weiterzumachen ist die schlechteste
          // Variante: der Experte findet nichts und fragt alles noch einmal ab,
          // ohne dass jemand weiss, warum.
          if (!inhalt.trim() && !(msg.caption || '').trim()) {
            await sendeText(chatId, `⚠️ Ich konnte aus \`${name}\` keinen Text lesen. ` +
              `Falls es ein Scan oder Foto ist, fehlt dafür der OCR-Zugang (MISTRAL_API_KEY). ` +
              `Du kannst mir den Inhalt auch einfach schreiben oder diktieren.`);
          }

          // Der Router braucht ggf. eine Inhalts-Vorschau aus der echten Datei.
          const temp = path.join(require('os').tmpdir(), `wws-${Date.now()}-${name.replace(/[^\w.-]/g, '_')}`);
          try { fs.writeFileSync(temp, buffer); } catch { /* Vorschau ist optional */ }

          await verarbeite(chatId, {
            text: mitGruppenKontext(msg, msg.caption || ''),
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
  }));

  async function dateiZuText(buffer, mime, name) {
    const n = String(name).toLowerCase();
    try {
      if (mime === 'application/pdf' || n.endsWith('.pdf')) {
        // Reihenfolge nach Zuverlaessigkeit und Kosten:
        // 1) AcroForm-Feldwerte — exakte Daten, kein Dienst noetig
        // 2) eingebetteter Text
        // 3) OCR (kostet, braucht Key, nur fuer Scans und Fotos sinnvoll)
        const tmp = path.join(require('os').tmpdir(), `wws-pdf-${Date.now()}.pdf`);
        try {
          fs.writeFileSync(tmp, buffer);
          const felder = await require('../lib/pdf_filler').leseFeldWerte(tmp);
          if (felder.ausgefuellt.length > 0) {
            return felder.ausgefuellt.map((f) => `${f.name}: ${f.wert}`).join('\n');
          }
        } catch { /* kein Formular-PDF */ }
        finally { try { fs.unlinkSync(tmp); } catch { /* egal */ } }

        try {
          const text = (await require('pdf-parse')(buffer)).text || '';
          if (text.trim().length > 80) return text;
        } catch { /* dann eben OCR */ }
        return await fachdienste.ocr(buffer, 'application/pdf');
      }
      if (n.endsWith('.xlsx') || n.endsWith('.xls')) return await excelZuText(buffer);
      if (n.endsWith('.docx') || n.endsWith('.doc')) return await wordZuText(buffer);
      if (mime.startsWith('image/')) return await fachdienste.ocr(buffer, mime);
      if (mime.startsWith('text/') || n.endsWith('.txt') || n.endsWith('.csv')) {
        return buffer.toString('utf-8').slice(0, 20000);
      }
    } catch (err) {
      schreibeEintrag('Fehler', `Datei-Auslese (${name}): ${err.message}`);
    }
    return '';
  }

  // ──────────────────────────────────────────────────────────── Knopfdrücke

  bot.on('callback_query', (query) => imThema(query.message, async () => {
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
  }));

  // ───────────────────────────────────────────────────────────────── Commands

  const antworte = (msg, text) => sendeText(msg.chat.id, text);

  befehl(/^\/start\b/i, async (msg) => antworte(msg, hilfe.startText(msg.chat.id)));

  befehl(/^\/themen\b/, (msg) => {
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




  befehl(/^\/loeschen\s+(\S+)/, (msg, m) => {
    const t = themen.findeThemaMitName(msg.chat.id, m[1]);
    if (!t) return antworte(msg, `Kein Thema mit „${m[1]}" gefunden.`);
    themen.loescheThema(msg.chat.id, t.id);
    return antworte(msg, `Thema „${t.name}" gelöscht.`);
  });

  befehl(/^\/zusammenfassung(?:\s+(.+))?/, (msg, m) => {
    const suche = m && m[1] && m[1].trim();
    const t = suche ? themen.findeThemaMitName(msg.chat.id, suche) : themen.ladeIndex(msg.chat.id)[0];
    if (!t) return antworte(msg, 'Noch kein Thema vorhanden.');
    const voll = themen.ladeThema(msg.chat.id, t.id);
    return antworte(msg, `Zusammenfassung von „${t.name}":\n` +
      ((voll && voll.summary) || '(noch keine — das Thema ist zu kurz)'));
  });

  befehl(/^\/gedaechtnis\b/, (msg) => {
    const fakten = gedaechtnis.ladeFakten(msg.chat.id);
    if (!fakten.length) return antworte(msg, 'Das Langzeit-Gedächtnis ist noch leer. Schreib „merke dir: …".');
    return antworte(msg, 'Langzeit-Gedächtnis:\n' + fakten.map((f, i) => `${i + 1}. ${f}`).join('\n'));
  });


  befehl(/^\/vergiss\s+(\d+)/, (msg, m) =>
    antworte(msg, gedaechtnis.entferneFakt(msg.chat.id, parseInt(m[1], 10) - 1)
      ? 'Fakt entfernt.' : 'Diese Nummer gibt es nicht. /gedaechtnis zeigt die Liste.'));


  befehl(/^\/wer_bin_ich\b/, (msg) => {
    const p = benutzer.ladeProfil(msg.chat.id);
    if (!p) return antworte(msg, 'Kein Profil gefunden. Schreib erst eine Nachricht.');
    return antworte(msg, 'Dein Profil:\n' +
      `Chat-ID: ${p.chatId}\nName: ${p.displayName || '—'}\n` +
      `Username: ${p.username ? '@' + p.username : '—'}\n` +
      `Erster Kontakt: ${(p.firstSeen || '').slice(0, 19).replace('T', ' ')}\n` +
      `Letzter Kontakt: ${(p.lastSeen || '').slice(0, 19).replace('T', ' ')}`);
  });

  befehl(/^\/delete[-_]my[-_]data\b/, (msg) => {
    if (!benutzer.ladeProfil(msg.chat.id)) return antworte(msg, 'Du hast hier keine gespeicherten Daten.');
    const ok = benutzer.loescheAlles(msg.chat.id);
    if (ok) schreibeEintrag('Sicherheit', `User-Daten gelöscht auf Wunsch: ${msg.chat.id}`);
    return antworte(msg, ok
      ? '✅ Alle deine Daten sind gelöscht. Beim nächsten Schreiben wird frisch angelegt.'
      : 'Konnte deine Daten nicht löschen — bitte beim Admin melden.');
  });

  adminBefehl(/^\/protokoll\b/, (msg) => antworte(msg, leseLetzte(20) || 'Das Protokoll ist noch leer.'));


  adminBefehl(/^\/komprimieren\b/, async (msg) => {
    bot.sendChatAction(msg.chat.id, 'typing').catch(() => {});
    let gemacht = 0;
    for (const e of themen.ladeIndex(msg.chat.id)) {
      const t = themen.ladeThema(msg.chat.id, e.id);
      if (t && kompressor.themaBereitZurKomprimierung(t)) {
        await kompressor.komprimiereThema(msg.chat.id, e.id, summaryChat);
        gemacht++;
      }
    }
    const ged = gedaechtnis.istVoll(msg.chat.id)
      ? await kompressor.komprimiereGedaechtnis(msg.chat.id, summaryChat) : false;
    return antworte(msg, `Komprimierung fertig. ${gemacht} Thema/Themen verdichtet${ged ? ', Gedächtnis verdichtet' : ''}.`);
  });


  adminBefehl(/^\/dienste\b/, (msg) => {
    const { uebersicht } = require('../providers');
    const rollen = uebersicht().map((r) =>
      `• ${r.rolle}: ${r.anbieter} (${r.modell})`).join('\n');
    const fach = fachdienste.status().map((d) =>
      `• ${d.art}: ` + d.kette.map((a) => `${a.name} ${a.bereit ? '✅' : '⚪️'}`).join(', ')).join('\n');
    return antworte(msg,
      '*KI-Anbieter je Aufgabe:*\n' + rollen +
      '\n\n*Fach-Dienste:*\n' + fach +
      '\n\n_⚪️ = kein Key gesetzt. Reihenfolge und Anbieter stehen in der .env._');
  });

  // Von Experten mitgebrachte Befehle — der Kern kennt sie nicht namentlich.
  // /einstellungen und /einstellungen <kennwort>. Oeffnet den Modus, der alles
  // andere anhaelt. Steht bewusst VOR den Experten-Befehlen: waere ein Experte
  // auf denselben Namen gekommen, wuerde er hier die Einstellungen verdecken.
  // "options" bleibt als alter Name gueltig, damit niemand ins Leere tippt.
  befehl(/^\/(?:einstellungen|options)(?:\s+(.+))?\s*$/i, async (msg, m) => {
    const chatId = msg.chat.id;
    const { daten, text } = optionen.oeffne(chatId, m && m[1] ? m[1].trim() : null);
    modus.starte(chatId, 'options', daten);
    schreibeEintrag('Einstellungen', `geöffnet von ${chatId}${daten.admin ? ' (Admin)' : ''}`);
    await sendeText(chatId, text);
  });

  befehl(/^\/befehle\b/i, (msg) => antworte(msg, hilfe.befehleText(msg.chat.id)));

  // /storno_r7k3m9x2 — antippbar, weil Telegram keine Befehle mit Leerzeichen
  // verlinkt. Wird auf "/storno r7k3m9x2" abgebildet, damit es nur EINEN
  // Befehl im Experten gibt.
  befehl(/^\/([a-z_]+)_(r[a-z0-9]{8})\b/i, async (msg, m) => {
    const cmd = experten.alleCommands().find((c) => c.name.toLowerCase() === m[1].toLowerCase());
    if (!cmd) return;
    const chatId = msg.chat.id;
    try {
      const ergebnis = await cmd.ausfuehren({ chatId, argument: m[2], dienste: dienste(chatId) });
      if (ergebnis && ergebnis.text) await sendeText(chatId, ergebnis.text);
    } catch (err) {
      await sendeText(chatId, `Fehler bei /${m[1]}: ${err.message}`);
    }
  });

  for (const cmd of experten.alleCommands()) {
    const muster = new RegExp(`^\\/${cmd.name}(?:\\s+(.+))?\\s*$`, 'i');
    // Einrichtungs- und Diagnosebefehle der Experten liegen im selben
    // Admin-Bereich wie die des Kerns. Welche das sind, steht an EINER Stelle
    // (optionen.ADMIN_BEFEHLE) — sonst driftet die Liste im Hilfetext von der
    // Liste im Code weg.
    const registriere = optionen.ADMIN_BEFEHLE.includes(cmd.name) ? adminBefehl : befehl;
    registriere(muster, async (msg, m) => {
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

  // ─────────────────────────────────────────── Gruppen / Fäden auslagern

  // /gruppe [Name] — legt fuer den aktuellen Faden ein eigenes Forum-Thema an.
  // Telegram laesst Bots KEINE Gruppen erstellen; der Forum-Weg ist das, was
  // ein Bot tatsaechlich darf. Ohne konfiguriertes Forum erklaert der Bot den
  // manuellen Weg, statt eine Faehigkeit vorzutaeuschen, die es nicht gibt.
  befehl(/^\/gruppe(?:\s+(.+))?\s*$/i, async (msg, m) => {
    const chatId = msg.chat.id;
    const gewuenscht = (m && m[1] && m[1].trim()) || null;
    const name = gewuenscht ||
      (themen.ladeIndex(chatId)[0] && themen.ladeIndex(chatId)[0].name) ||
      'Neuer Faden';
    try {
      const r = await gruppen.erstelleForumThema(bot, name);
      gruppen.setze(r.chatId, r.threadId, { besitzer: String(chatId), gebundenAn: name });
      schreibeEintrag('Gruppen', `Forum-Thema "${r.titel}" angelegt fuer ${chatId}`);
      await sendeText(chatId,
        `✅ Eigenes Thema *${r.titel}* angelegt.\n\n` +
        (r.link ? `Beitreten: ${r.link}\n\n` : '') +
        'Dort schreibst du ab jetzt zu diesem Faden — ich verhalte mich genauso wie hier, ' +
        'weiß aber immer, in welchem Thema ich gerade bin.');
    } catch (err) {
      await sendeText(chatId,
        '📂 *Faden in eine Gruppe auslagern*\n\n' +
        '⚠️ Telegram erlaubt Bots nicht, selbst Gruppen zu erstellen — das können nur Menschen. ' +
        'Zwei Wege gibt es:\n\n' +
        '*Weg A — automatisch (einmal einrichten):*\n' + err.message + '\n\n' +
        '*Weg B — von Hand, sofort:*\n' +
        '1. Gruppe in Telegram anlegen\n' +
        '2. Diesen Bot zur Gruppe hinzufügen\n' +
        '3. In der Gruppe `/faden_hierher ' + name + '` schreiben\n\n' +
        'Danach ist die Gruppe dein eigener Faden.');
    }
  });

  // In einer Gruppe: diese Gruppe (bzw. dieses Forum-Thema) als eigenen Faden
  // registrieren. Der Bot arbeitet dort ohnehin mit eigener Themen-Ablage —
  // das hier gibt dem Ganzen nur den Namen und den Kontext.
  befehl(/^\/faden_hierher(?:\s+(.+))?\s*$/i, async (msg, m) => {
    const chatId = msg.chat.id;
    if (!gruppen.istGruppe(msg)) {
      return sendeText(chatId, 'Das funktioniert nur *in* einer Gruppe. Schreib es dort hinein.');
    }
    const name = (m && m[1] && m[1].trim()) || (msg.chat && msg.chat.title) || 'Faden';
    gruppen.merke(msg);
    gruppen.setze(chatId, msg.message_thread_id || null, {
      gebundenAn: name,
      besitzer: String((msg.from && msg.from.id) || chatId)
    });
    schreibeEintrag('Gruppen', `Faden "${name}" gebunden an ${chatId}`);
    await sendeText(chatId,
      `✅ Dieser Chat ist jetzt der Faden *${name}*.\n\n` +
      'Schreib einfach los — ich arbeite hier genauso wie im Einzelchat und weiß bei jeder ' +
      'Nachricht, dass sie zu diesem Faden gehört.');
  });

  befehl(/^\/gruppen\b/i, async (msg) => {
    const alle = gruppen.alle();
    if (!alle.length) return sendeText(msg.chat.id, 'Noch keine Gruppen oder Forum-Themen registriert. `/gruppe` legt eins an.');
    const zeilen = alle.slice(0, 25).map((g) => {
      const titel = g.gebundenAn || g.themaName || g.titel || String(g.gruppenId);
      const wo = g.titel ? ` (${g.titel})` : '';
      const th = g.themen && g.themen.length ? `\n    Themen: ${g.themen.join(', ')}` : '';
      return `• *${titel}*${wo}${th}`;
    });
    await sendeText(msg.chat.id, 'Ausgelagerte Fäden:\n' + zeilen.join('\n'));
  });

  // ─────────────────────────────────────────── Werkzeug-Registry / Zugang

  adminBefehl(/^\/werkzeuge\b/i, async (msg) => {
    const st = experten.registryStatus();
    if (!st.vorhanden) {
      return sendeText(msg.chat.id,
        `Keine Registry gefunden.\nErwartet: \`${st.datei}\`\n\n` +
        'Ohne die Datei laufen alle Experten wie bisher.');
    }
    const zeilen = st.eintraege.map((e) => {
      const flag = e.aktiv ? '✅' : '⛔️';
      const modul = e.hatModul === false ? '  ⚠️ kein Modul' : '';
      const braucht = e.braucht && e.braucht.length ? `\n    braucht: ${e.braucht.join(', ')}` : '';
      return `${flag} *${e.id}* — ${e.name}${modul}${braucht}`;
    });
    const ohne = st.ohneEintrag.length
      ? `\n\n⚠️ Module ohne Registry-Eintrag (laufen mit, undokumentiert):\n${st.ohneEintrag.join(', ')}`
      : '';
    await sendeText(msg.chat.id,
      `*Werkzeug-Registry*\n\`${st.datei}\`\n\n` + zeilen.join('\n') + ohne +
      '\n\n_Ändern: Datei bearbeiten, Bot neu starten._');
  });

  adminBefehl(/^\/zugang(?:\s+(\S+))?\s*$/i, async (msg, m) => {
    const arg = m && m[1] && m[1].trim();
    if (arg && /^-?\d+$/.test(arg)) {
      const weg = zugang.entziehe(arg);
      schreibeEintrag('Zugang', `Entzogen: ${arg} durch ${msg.chat.id}`);
      return sendeText(msg.chat.id, weg ? `Zugang für ${arg} entzogen.` : `${arg} stand nicht auf der Liste.`);
    }
    const liste = zugang.liste();
    if (!zugang.aktiv()) {
      return sendeText(msg.chat.id,
        '⚠️ *Kein Zugangsschutz aktiv.*\nZum Aktivieren `ZUGANGS_CODE=...` in die .env eintragen und neu starten.');
    }
    if (!liste.length) return sendeText(msg.chat.id, 'Noch niemand freigeschaltet.');
    await sendeText(msg.chat.id,
      '*Freigeschaltete Chats:*\n' +
      liste.map((e) => `• \`${e.chatId}\` ${e.name || ''} — seit ${(e.seit || '').slice(0, 10)}`).join('\n') +
      '\n\n_Entziehen: /zugang <chatId>_');
  });

  // Der Lager-Bot schickt dem Monteur den Bescheid ueber DIESEN Bot — dort hat
  // der Monteur seinen Chat, nicht im Lager-Bot. Die Auftragsstelle meldet hier
  // ebenfalls herein, wenn der Laptop eine Bestellung abgearbeitet hat; deshalb
  // nimmt der Kanal auch Dateien an (Screenshot vom fertigen Warenkorb).
  benachrichtigung.registriere('hauptbot', async (chatId, text, extra) => {
    const senden = () => rendere(chatId, { text, dateien: (extra && extra.dateien) || [] });
    // Eine Bestellung kann in einem Forum-Thema ausgeloest worden sein. Die
    // Rueckmeldung kommt Minuten spaeter und damit ausserhalb jeder laufenden
    // Nachricht — ohne das mitgegebene Ziel landete sie in "Allgemein".
    const thread = extra && extra.ziel && extra.ziel.message_thread_id;
    return thread ? antwortZiel.run({ threadId: thread }, senden) : senden();
  });

  console.log(zugang.startHinweis());
  const cmdNamen = experten.alleCommands().map((c) => '/' + c.name);
  console.log(`Telegram-Adapter läuft. Experten-Befehle: ${cmdNamen.join(', ') || '(keine)'}`);
  return bot;
}

module.exports = { starte };
