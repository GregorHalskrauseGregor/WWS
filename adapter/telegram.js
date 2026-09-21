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
const raeume = require('../arbeitsraeume');
const ratelimit = require('../ratelimit');
const { schreibeEintrag, leseLetzte } = require('../protokoll');
const fachdienste = require('../dienste');
const { excelZuText, wordZuText } = require('../dokument');

function starte({ token, provider, antwortChat, routerChat, extraktionChat, summaryChat }) {
  const bot = new TelegramBot(token, { polling: true });
  const offeneBestaetigungen = new Map();

  // ───────────────────────────────────── Zweite Instanz erkennen und ansagen
  //
  // Laeuft derselbe Bot-Token an ZWEI Stellen — etwa noch auf dem Laptop und
  // schon auf der Box —, verteilt Telegram die Nachrichten zufaellig auf beide.
  // Nach aussen sieht das nach Spuk aus: mal antwortet der Bot, mal nicht;
  // Knopfdruecke blinken zwanzig Sekunden und versanden; und wenn doch eine
  // Antwort kommt, passt sie zum Stand der ANDEREN Instanz, nicht zu dem, was
  // man selbst geschrieben hat.
  //
  // Telegram meldet das sauber als 409. Bisher landete das im allgemeinen
  // Rauschen. Ab jetzt steht es in Klartext im Log — wer einmal danach gesucht
  // hat, soll es beim naechsten Mal sofort sehen.
  // Die eigene ID, um in "X hat Y hinzugefuegt" zu erkennen, ob Y wir sind.
  let eigeneId = null;

  // ══════════════════════════════════════════════════════════════════════
  // PRIVACY MODE — die haeufigste Ursache fuer "der Bot schweigt in Gruppen"
  // ══════════════════════════════════════════════════════════════════════
  //
  // Telegram stellt einem Bot in Gruppen ab Werk NUR Befehle zu. Normale
  // Nachrichten bekommt er gar nicht erst. Von aussen sieht das aus, als
  // haette der Bot einen Fehler: /meine_gruppe kommt an, alles danach nicht.
  //
  // Man sieht das nirgends im Log, weil nichts ankommt — es gibt keinen
  // Fehler, nur Stille. Deshalb fragt der Bot beim Start selbst nach und sagt
  // es deutlich, statt jeden danach suchen zu lassen.
  let darfAllesLesen = null;   // null = noch nicht bekannt
  bot.getMe()
    .then((me) => {
      eigeneId = me && me.id;
      darfAllesLesen = me && me.can_read_all_group_messages === true;
      if (darfAllesLesen === false) {
        console.warn(
          '\n══════════════════════════════════════════════════════════════════\n' +
          '  HINWEIS: In Gruppen sieht dieser Bot nur Befehle.\n' +
          '\n' +
          '  Telegrams "Group Privacy" ist eingeschaltet — normale Nachrichten\n' +
          '  werden dem Bot in Gruppen nicht zugestellt. Er wirkt dort stumm.\n' +
          '\n' +
          '  Abstellen im @BotFather:\n' +
          '    /mybots -> Bot waehlen -> Bot Settings -> Group Privacy -> Turn off\n' +
          '\n' +
          '  Danach den Bot einmal aus der Gruppe entfernen und neu hinzufuegen,\n' +
          '  sonst greift die Aenderung dort nicht.\n' +
          '══════════════════════════════════════════════════════════════════\n');
      }
    })
    .catch((err) => console.error('getMe fehlgeschlagen:', err.message));

  let konfliktZuletzt = 0;
  bot.on('polling_error', (err) => {
    const text = String((err && (err.message || err.code)) || err);
    if (!/409|conflict|terminated by other getUpdates/i.test(text)) {
      console.error('Telegram-Polling:', text);
      return;
    }
    if (Date.now() - konfliktZuletzt < 60_000) return;   // nicht im Sekundentakt bruellen
    konfliktZuletzt = Date.now();
    console.error(
      '\n══════════════════════════════════════════════════════════════════\n' +
      '  ACHTUNG: derselbe Telegram-Token laeuft an ZWEI Stellen.\n' +
      '\n' +
      '  Telegram verteilt die Nachrichten dann zufaellig auf beide.\n' +
      '  Folge: nur etwa jede zweite Nachricht kommt hier an, Knoepfe\n' +
      '  blinken ins Leere, und Antworten passen nicht zum Verlauf.\n' +
      '\n' +
      '  Beende die andere Instanz — meist ein altes "npm start" auf dem\n' +
      '  Laptop. Danach klaert sich das von selbst.\n' +
      '══════════════════════════════════════════════════════════════════\n');
    schreibeEintrag('Fehler', 'Telegram 409: zweite Bot-Instanz mit demselben Token');
  });

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
  // ══════════════════════════════════════════════════════════════════════
  // ABLAGE UND ANTWORTZIEL SIND NICHT DASSELBE
  // ══════════════════════════════════════════════════════════════════════
  //
  // Im Einzelchat fallen beide zusammen. In einer Gruppe nicht: verarbeitet
  // wird unter dem Konto des BESITZERS — dort liegen seine Fäden, sein
  // Gedächtnis, seine Vorgänge —, geantwortet wird aber in die GRUPPE.
  // Deshalb wandert ab hier überall ein Paar durch: kontoId und ziel.
  function dienste(kontoId, ziel = kontoId) {
    return {
      provider,
      routerChat,             // Faden- und Experten-Entscheidung
      chat: extraktionChat,   // Vorgangs-Motor: Freitext -> Delta-Operationen
      antwortChat,            // freie Antworten
      lightChat: summaryChat, // Zusammenfassen, Gedächtnis
      protokoll: schreibeEintrag,
      melde: (text) => sendeText(ziel, text),
      frageBestaetigung: frageBestaetigung(ziel),
      // Wohin eine SPAETERE Antwort gehoert (Forum-Thema). Experten, die einen
      // Auftrag einstellen und erst Minuten danach melden, speichern das mit.
      antwortZiel: () => zielOpt()
    };
  }

  async function verarbeite(kontoId, eingabe, ziel = kontoId, ort = null) {
    try {
      // Der Arbeitsraum wird beim ersten Wort im Thema angelegt — leer. Was
      // hier arbeitet, zieht gleich danach von selbst ein.
      let raum = null;
      if (ort) {
        const name = (gruppen.info(ort.gruppenId, ort.threadId) || {}).themaName || null;
        const r = raeume.sorgeFuerRaum(ort.gruppenId, ort.threadId, { name, konto: kontoId });
        if (r) raum = { name: r.name, faeden: r.faeden || [] };
      }

      const ergebnis = await orchestrator.verarbeiteNachricht(
        { chatId: kontoId, ...eingabe, raum }, dienste(kontoId, ziel));
      await rendere(ziel, ergebnis);

      // Erst NACH der Verarbeitung: jetzt steht fest, in welchem Faden
      // gearbeitet wurde. Ein Faden, der hier entsteht, gehört ab sofort zu
      // diesem Arbeitsraum — er bleibt aber ganz normal dem Konto zugeordnet
      // und ist überall sonst genauso erreichbar.
      if (ort && ergebnis && ergebnis.themaId) {
        raeume.fuegeHinzu(ort.gruppenId, ort.threadId, ergebnis.themaId);
      }
    } catch (err) {
      console.error(err);
      schreibeEintrag('Fehler', `Verarbeitung (Konto ${kontoId}, Ziel ${ziel}): ${err.message}`);
      await sendeText(ziel, 'Fehler bei der Verarbeitung: ' + err.message);
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
  // In einer Gruppe funktionieren Befehle NICHT — mit genau einer Ausnahme.
  //
  // Der Grund ist nicht Bequemlichkeit: fast jeder Befehl schreibt oder liest
  // unter msg.chat.id. In einer Gruppe waere das die Gruppen-ID und nicht das
  // Konto des Besitzers — ein /projekt dort wuerde einen Projektordner unter
  // einer Kennung anlegen, die keinem Menschen gehoert, und niemand faende ihn
  // je wieder. Lieber ehrlich sagen, dass es im Einzelchat gehoert, als etwas
  // an der falschen Stelle ablegen.
  //
  // Freier Text, Sprache, Fotos und Dateien laufen in der Gruppe normal — die
  // gehen durch kontoFuer() und landen beim richtigen Konto.
  const BEFEHLE_IN_GRUPPEN = new Set(['faden_hierher', 'meine_gruppe', 'add', 'raum', 'raus']);

  function befehlsName(msg) {
    const m = String((msg && msg.text) || '').match(/^\/([A-Za-z0-9_]+)/);
    return m ? m[1].toLowerCase() : '';
  }

  function befehl(muster, handler) {
    bot.onText(muster, (msg, m) => imThema(msg, async () => {
      if (gruppen.istGruppe(msg)) {
        // Die Übernahme muss VOR kontoFuer laufen: die Gruppe hat ja noch kein
        // Konto — sonst bräuchte es den Befehl nicht.
        if (befehlsName(msg) === 'meine_gruppe') return handler(msg, m);
        const zugriff = await kontoFuer(msg);
        if (!zugriff) return;
        if (!BEFEHLE_IN_GRUPPEN.has(befehlsName(msg))) {
          if (!merkeBehandelt(msg)) {
            await sendeText(msg.chat.id,
              'Befehle beantworte ich nur im Einzelchat mit mir — dort weiß ich sicher, ' +
              'zu wessen Ablage das gehört.\n\nHier in der Gruppe schreib einfach normal ' +
              'los: Text, Sprache, Fotos und Dateien verarbeite ich ganz normal.');
          }
          return;
        }
        return handler(msg, m);
      }
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

  // ══════════════════════════════════════════════════════════════════════
  // WEM GEHÖRT DIESE NACHRICHT?
  // ══════════════════════════════════════════════════════════════════════
  //
  // Einzelchat: dem Absender, Antwort geht an ihn zurück. Fertig.
  //
  // Gruppe: der Gruppe ist ein Konto zugeordnet — das des Menschen, der den
  // Bot hinzugefügt hat. Unter DESSEN Konto wird gearbeitet. Reden darf jeder
  // in der Gruppe, der freigeschaltet ist; alle anderen werden still
  // übergangen. Im Gruppenchat nach dem Zugangscode zu fragen hieße, ihn vor
  // allen Anwesenden auszusprechen — deshalb passiert das dort NIE.
  //
  // Rückgabe null heißt: diese Nachricht geht uns nichts an.
  async function kontoFuer(msg) {
    if (!gruppen.istGruppe(msg)) {
      return { kontoId: msg.chat.id, ziel: msg.chat.id, inGruppe: false, ort: null };
    }

    const gruppenId = msg.chat.id;
    const besitzer = gruppen.besitzerVon(gruppenId);
    if (!besitzer) {
      // Entweder wurde der Bot hinzugefügt, bevor dieser Stand lief, oder
      // Telegram hat den Einlader nicht mitgeliefert. Einmal sagen, dann Ruhe.
      if (!merkeBehandelt(msg)) {
        await sendeText(gruppenId,
          '👋 Ich bin da, aber diese Gruppe ist noch keinem Konto zugeordnet — ' +
          'ich weiß also nicht, unter wessen Ablage ich hier arbeiten soll.\n\n' +
          'Wenn sie dir gehören soll, schreib hier einmal `/meine_gruppe`.\n\n' +
          '_Das geht nur, solange die Gruppe niemandem gehört, und nur für jemanden, ' +
          'der mir schon einmal im Einzelchat den Zugangscode geschickt hat._');
      }
      return null;
    }

    const absender = msg.from && msg.from.id;
    if (zugang.aktiv() && !zugang.istFreigeschaltet(absender)) {
      schreibeEintrag('Zugang',
        `Gruppe ${gruppenId}: ${absender} ist nicht freigeschaltet, Nachricht übergangen`);
      return null;
    }
    // Der Ort des Arbeitsraums: Gruppe + Thema. Ohne Thema-ID (Allgemein-Thema
    // einer Forumgruppe oder eine normale Gruppe ohne Themen) gibt es keinen
    // Raum — dort sieht der Bot alles, was dem Konto gehört.
    const threadId = (msg.is_topic_message && msg.message_thread_id) || null;
    const ort = raeume.istRaumfaehig(gruppenId, threadId)
      ? { gruppenId, threadId }
      : null;
    return { kontoId: besitzer, ziel: gruppenId, inGruppe: true, absender, ort };
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
      // Wartungsbefehle gehoeren nie in eine Gruppe — dort liest jeder mit.
      if (gruppen.istGruppe(msg)) return;
      const aktiv = modus.aktiv(msg.chat.id);
      if (aktiv && aktiv.art === 'options' && aktiv.daten.admin) return handler(msg, m);
      if (await modusFaengtAb(msg)) return;
      await sendeText(msg.chat.id,
        '🔒 Das ist ein Wartungsbefehl.\n\nÖffne dafür den Admin-Bereich:\n`/einstellungen <Kennwort>`');
    }));
  }

  bot.on('message', (msg) => imThema(msg, async () => {
    const inGruppe = gruppen.istGruppe(msg);

    // Im Einzelchat: Zugang VOR allem anderen, auch vor dem Anlegen von
    // Nutzerdaten — fuer einen gesperrten Chat entsteht so kein einziger Ordner.
    // In der Gruppe uebernimmt kontoFuer() die Pruefung, mit anderen Regeln.
    if (!inGruppe && await gateFaengtAb(msg)) return;

    // ── Ersatzweg zur Zuordnung ──────────────────────────────────────────
    //
    // my_chat_member ist der saubere Weg, aber er ist nicht der einzige, auf
    // dem ein Bot in eine Gruppe kommt. Wird die Gruppe GLEICH MIT dem Bot
    // angelegt ("Matthias hat die Gruppe «Dila» erstellt"), schicken manche
    // Telegram-Clients nur die Dienstnachricht und kein my_chat_member. Die
    // Gruppe bliebe dann für immer ohne Konto, und der Bot verwiese stur
    // darauf, man möge ihn neu hinzufügen — obwohl man genau das getan hat.
    if (inGruppe && !gruppen.besitzerVon(msg.chat.id) && msg.from) {
      const binDabei = msg.group_chat_created === true ||
        (Array.isArray(msg.new_chat_members) &&
          msg.new_chat_members.some((u) => eigeneId != null && u && u.id === eigeneId));
      if (binDabei) {
        gruppen.registriereBesitzer(msg.chat.id, msg.from.id, msg.chat.title);
        schreibeEintrag('Gruppen',
          `Gruppe "${msg.chat.title || '?'}" (${msg.chat.id}) über Dienstnachricht ` +
          `Konto ${msg.from.id} zugeordnet`);
        await begruesseInGruppe(msg.chat, msg.from);
        return;
      }
    }

    const zugriff = await kontoFuer(msg);
    if (!zugriff) return;
    const chatId = zugriff.kontoId;   // hier liegen die Daten
    const ziel = zugriff.ziel;        // hierhin geht die Antwort

    // Nutzerakte nur im Einzelchat anlegen. Eine Gruppe ist kein Nutzer — ihre
    // Nachrichten laufen ohnehin unter dem Konto des Besitzers, und das gibt es
    // laengst, sonst haette er sich nie freischalten koennen.
    if (!inGruppe) {
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

      // Modus zuerst: eine Nachricht, die waehrend der Einstellungen
      // hereinkommt, darf nicht nebenher verarbeitet werden. Der
      // Einstellungsbereich ist ein Einzelchat-Ding — eine Gruppe haelt er
      // nicht an, sonst legt ein offenes Menue die halbe Baustelle lahm.
      if (await modusFaengtAb(msg)) return;
    }

    // Text
    if (msg.text) {
      if (msg.text.trim().startsWith('/')) return; // Commands laufen über onText
      const text = mitGruppenKontext(msg, msg.text.trim());
      return mitTippt(ziel, () => verarbeite(chatId, { text }, ziel, zugriff.ort));
    }

    // Sprachnachricht: IMMER erst transkribieren, dann normal weiter.
    if (msg.voice || msg.audio) {
      const quelle = msg.voice || msg.audio;
      try {
        await mitTippt(ziel, async () => {
          await sendeText(chatId, '🎙 Sprachnachricht wird transkribiert …');
          const text = await fachdienste.transkription(await ladeDatei(quelle.file_id), quelle.mime_type || 'audio/ogg');
          await sendeText(chatId, `Verstanden: „${text}"`);
          await verarbeite(chatId, { text: mitGruppenKontext(msg, text) }, ziel, zugriff.ort);
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
        await mitTippt(ziel, async () => {
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
          }, ziel, zugriff.ort);
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
        await mitTippt(ziel, async () => {
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
          }, ziel, zugriff.ort);
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

  async function begruesseInGruppe(chat, einlader) {
    const name = (einlader && (einlader.first_name || einlader.username)) || 'dir';
    await sendeText(chat.id,
      `👋 Bin dabei. Diese Gruppe gehört ab jetzt zum Konto von *${name}*.\n\n` +
      `Alles, was hier entsteht — Aufmaße, Bestellungen, Notizen — liegt in ${name}s ` +
      'Ablage und ist auch im Einzelchat mit mir da. Und umgekehrt.\n\n' +
      (zugang.aktiv()
        ? 'Mitreden kann jeder hier, der mir einmal im Einzelchat den Zugangscode ' +
          'geschickt hat. Wen ich nicht kenne, den überhöre ich — hier nach dem Code ' +
          'zu fragen hieße, ihn vor allen auszusprechen.'
        : '⚠️ Es ist kein Zugangscode gesetzt. Damit kann hier jeder mit mir arbeiten.') +
      (darfAllesLesen === false
        ? '\n\n⚠️ *Noch eine Einstellung fehlt.* Telegram stellt mir hier gerade nur ' +
          'Befehle zu — normale Nachrichten sehe ich nicht. Abstellen im @BotFather:\n' +
          '`/mybots` → diesen Bot → *Bot Settings* → *Group Privacy* → *Turn off*\n\n' +
          'Danach entfern mich einmal aus der Gruppe und füg mich neu hinzu, sonst ' +
          'greift es hier nicht.'
        : ''));
  }

  // ════════════════════════════════════════════════════════════════════════
  // WER DEN BOT HINZUFÜGT, DEM GEHÖRT DIE GRUPPE
  // ════════════════════════════════════════════════════════════════════════
  //
  // Ein Bot kann sich in keine Gruppe einladen — das muss ein Mensch tun. Was
  // Telegram dem Bot aber mitteilt: DASS er hinzugefügt wurde, und von WEM.
  // Genau daran hängt der Besitz. Kein Kopplungscode, kein zweiter Schritt:
  // hinzufügen genügt.
  bot.on('my_chat_member', async (upd) => {
    try {
      const chat = (upd && upd.chat) || {};
      if (chat.type !== 'group' && chat.type !== 'supergroup') return;

      const status = upd.new_chat_member && upd.new_chat_member.status;
      const einlader = upd.from || {};

      // Rausgeworfen oder verlassen: Zuordnung mit aufräumen, sonst zeigt
      // /einstellungen für immer eine Gruppe an, die es nicht mehr gibt.
      if (status === 'left' || status === 'kicked') {
        if (gruppen.loeseAb(chat.id)) {
          // Die Räume gehen mit. Die FÄDEN bleiben — die gehören dem Konto,
          // nicht dem Raum. Genau das ist der Unterschied.
          const weg = raeume.entferneGruppe(chat.id);
          schreibeEintrag('Gruppen',
            `Aus "${chat.title || chat.id}" entfernt, Zuordnung gelöscht` +
            (weg ? `, ${weg} Arbeitsraum/Arbeitsräume aufgelöst (Fäden bleiben)` : ''));
        }
        return;
      }
      if (status !== 'member' && status !== 'administrator') return;

      // Schon zugeordnet? Dann nichts anfassen. Eine Statusänderung (Mitglied
      // wird Admin) darf den Besitzer nicht stillschweigend austauschen.
      const vorhanden = gruppen.besitzerVon(chat.id);
      if (vorhanden) {
        gruppen.registriereBesitzer(chat.id, vorhanden, chat.title);
        return;
      }

      gruppen.registriereBesitzer(chat.id, einlader.id, chat.title);
      schreibeEintrag('Gruppen',
        `Gruppe "${chat.title || '?'}" (${chat.id}) gehört jetzt zu Konto ${einlader.id}`);

      await begruesseInGruppe(chat, einlader);
    } catch (err) {
      console.error('my_chat_member:', err.message);
      schreibeEintrag('Fehler', `Gruppen-Zuordnung: ${err.message}`);
    }
  });

  // ──────────────────────────────────────────────────────────── Knopfdrücke

  bot.on('callback_query', (query) => imThema(query.message, async () => {
    const daten = query.data || '';
    const herkunft = (query.message && query.message.chat) || {};
    const ausGruppe = herkunft.type === 'group' || herkunft.type === 'supergroup';

    // Das Zugangs-Gate galt bisher nur fuer Nachrichten und Befehle. Ein
    // Knopfdruck kam daran vorbei — wer eine weitergeleitete Nachricht mit
    // Knoepfen hat, konnte damit einen Vorgang bestaetigen, ohne je den Code
    // eingegeben zu haben. Eine Tuer neben der verschlossenen Tuer.
    // Geprueft wird, wer DRUECKT, nicht wo der Knopf haengt.
    const druecker = (query.from && query.from.id) || null;
    if (zugang.aktiv() && !zugang.istFreigeschaltet(druecker)) {
      bot.answerCallbackQuery(query.id, {
        text: 'Du bist nicht freigeschaltet. Schick mir zuerst im Einzelchat den Zugangscode.',
        show_alert: true
      }).catch(() => {});
      return;
    }

    // In einer Gruppe gehoert der Vorgang dem Konto des Besitzers — der Knopf
    // muss denselben Vorgang treffen wie die Nachricht davor, sonst bestaetigt
    // er ins Leere.
    let chatId = herkunft.id;
    let ziel = herkunft.id;
    if (ausGruppe) {
      const besitzer = gruppen.besitzerVon(herkunft.id);
      if (!besitzer) {
        bot.answerCallbackQuery(query.id, {
          text: 'Diese Gruppe ist keinem Konto zugeordnet.', show_alert: true
        }).catch(() => {});
        return;
      }
      chatId = besitzer;
    }
    const knoepfeWeg = () => {
      if (!query.message) return;
      bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: ziel, message_id: query.message.message_id }).catch(() => {});
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
        ? await orchestrator.bestaetigeVorgang({ chatId, themaId }, dienste(chatId, ziel))
        : await orchestrator.brichVorgangAb({ chatId, themaId });
      await rendere(ziel, ergebnis);
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

  // Eine Anleitung, kein Knopf: ein Bot kann sich selbst in keine Gruppe
  // einladen. Das ist keine fehlende Funktion, das laesst Telegram nicht zu.
  function gruppenAnleitung(kurz) {
    return (kurz ? '' : '👥 *Du hast noch keine Gruppe mit mir.*\n\n') +
      '*So fügst du eine hinzu:*\n' +
      '1. Gruppe in Telegram öffnen (oder neu anlegen)\n' +
      '2. Gruppenname antippen → *Mitglieder hinzufügen*\n' +
      '3. Mich suchen und hinzufügen\n\n' +
      '_Wer mich hinzufügt, dem gehört die Gruppe._ Füg mich also selbst hinzu, ' +
      'dann läuft alles unter deinem Konto.';
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

  // Rettungsweg für Gruppen, die der Bot betreten hat, ohne dass eine
  // Zuordnung entstand — etwa weil er dort schon war, bevor dieser Stand lief.
  // Bewusst eng: nur in einer Gruppe, nur wenn sie NIEMANDEM gehört, und nur
  // für jemanden, der freigeschaltet ist. Danach greift wieder die Regel, dass
  // ein bestehender Besitzer nicht stillschweigend ausgetauscht wird.
  befehl(/^\/meine_gruppe\b/i, async (msg) => {
    if (!gruppen.istGruppe(msg)) {
      return sendeText(msg.chat.id,
        'Das funktioniert nur *in* einer Gruppe — schreib es dort hinein.');
    }
    const gruppenId = msg.chat.id;
    const wer = msg.from || {};

    const besitzer = gruppen.besitzerVon(gruppenId);
    if (besitzer) {
      return sendeText(gruppenId,
        String(besitzer) === String(wer.id)
          ? 'Diese Gruppe gehört bereits zu deinem Konto.'
          : 'Diese Gruppe gehört schon einem anderen Konto. Wer sie übernehmen will, ' +
            'muss mich erst entfernen und neu hinzufügen.');
    }
    if (zugang.aktiv() && !zugang.istFreigeschaltet(wer.id)) {
      return sendeText(gruppenId,
        'Dafür musst du mir zuerst im Einzelchat den Zugangscode schicken. ' +
        '_Hier in der Gruppe bitte nicht — den läse jeder mit._');
    }

    gruppen.registriereBesitzer(gruppenId, wer.id, msg.chat.title);
    schreibeEintrag('Gruppen',
      `Gruppe "${msg.chat.title || '?'}" (${gruppenId}) per /meine_gruppe an Konto ${wer.id}` +
      (darfAllesLesen === false ? ' — ACHTUNG: Group Privacy ist an, normale Nachrichten kommen nicht an' : ''));
    await begruesseInGruppe(msg.chat, wer);
  });

  // ════════════════════════════════════════════════════════════════════════
  // ARBEITSRÄUME — /raum, /add, /raus
  // ════════════════════════════════════════════════════════════════════════
  //
  // Ein Telegram-Thema ist ein Sichtfenster auf die eigenen Fäden, kein
  // Behälter. Siehe arbeitsraeume.js. Deshalb heißt /add auch "dazuholen" und
  // /raus "nicht mehr anzeigen" — gelöscht wird dabei nie etwas.

  function fadenListe(kontoId, ids) {
    const index = themen.ladeIndex(kontoId) || [];
    const bekannt = new Map(index.map((t) => [t.id, t]));
    return (ids || []).map((id) => bekannt.get(id)).filter(Boolean);
  }

  // Fäden des Kontos nach Namen suchen. Gibt eine Rangliste zurück, damit der
  // Bot bei Mehrdeutigkeit fragen kann statt zu raten.
  function sucheFaeden(kontoId, suchwort) {
    const s = String(suchwort || '').toLowerCase().trim();
    if (!s) return [];
    const index = themen.ladeIndex(kontoId) || [];
    const treffer = index.filter((t) => String(t.name || '').toLowerCase().includes(s));
    return treffer.length ? treffer : index.filter((t) =>
      s.split(/\s+/).filter((w) => w.length >= 3)
        .some((w) => String(t.name || '').toLowerCase().includes(w)));
  }

  async function raumOderHinweis(msg) {
    if (!gruppen.istGruppe(msg)) {
      await sendeText(msg.chat.id,
        'Arbeitsräume sind Telegram-*Themen* — das funktioniert nur in einer Gruppe, ' +
        'in der Themen eingeschaltet sind.');
      return null;
    }
    const zugriff = await kontoFuer(msg);
    if (!zugriff) return null;
    if (!zugriff.ort) {
      await sendeText(zugriff.ziel,
        'Hier gibt es keinen Arbeitsraum.\n\n' +
        'Im Allgemein-Thema sehe ich alles, was zum Konto gehört — das ist Absicht. ' +
        'Einen abgegrenzten Arbeitsraum bekommst du, indem du in dieser Gruppe ein ' +
        '*eigenes Thema* anlegst und dort schreibst.');
      return null;
    }
    return zugriff;
  }

  befehl(/^\/raum\b/i, async (msg) => {
    const zugriff = await raumOderHinweis(msg);
    if (!zugriff) return;
    const { gruppenId, threadId } = zugriff.ort;
    const name = (gruppen.info(gruppenId, threadId) || {}).themaName || null;
    const r = raeume.sorgeFuerRaum(gruppenId, threadId, { name, konto: zugriff.kontoId });
    const drin = fadenListe(zugriff.kontoId, r.faeden);

    if (!drin.length) {
      return sendeText(zugriff.ziel,
        `🗂️ *Arbeitsraum ${r.name ? '„' + r.name + '"' : ''}*\n\n` +
        'Hier liegt noch nichts. Fang einfach an — was hier entsteht, zieht von ' +
        'selbst ein.\n\nEtwas Bestehendes dazuholen: `/add <Stichwort>`');
    }
    await sendeText(zugriff.ziel,
      `🗂️ *Arbeitsraum ${r.name ? '„' + r.name + '"' : ''}* — ${drin.length} Faden/Fäden\n` +
      drin.map((t) => `• ${t.name}` + (t.messageCount ? `  _(${t.messageCount} Nachrichten)_` : '')).join('\n') +
      '\n\n_Nur diese sehe ich hier. Dazuholen: `/add <Stichwort>` · ' +
      'Ausblenden: `/raus <Stichwort>`_');
  });

  befehl(/^\/add(?:\s+(.+))?\s*$/i, async (msg, m) => {
    const zugriff = await raumOderHinweis(msg);
    if (!zugriff) return;
    const { gruppenId, threadId } = zugriff.ort;
    const suchwort = (m && m[1] && m[1].trim()) || '';

    const name = (gruppen.info(gruppenId, threadId) || {}).themaName || null;
    const r = raeume.sorgeFuerRaum(gruppenId, threadId, { name, konto: zugriff.kontoId });

    if (!suchwort) {
      const index = (themen.ladeIndex(zugriff.kontoId) || []).slice(0, 10);
      return sendeText(zugriff.ziel,
        '`/add <Stichwort>` holt einen bestehenden Faden in diesen Arbeitsraum.\n\n' +
        (index.length
          ? 'Zuletzt bearbeitet:\n' + index.map((t) => `• ${t.name}`).join('\n')
          : 'Du hast noch keine Fäden.'));
    }

    const treffer = sucheFaeden(zugriff.kontoId, suchwort);
    if (!treffer.length) {
      return sendeText(zugriff.ziel, `Keinen Faden gefunden, der zu „${suchwort}" passt.`);
    }
    if (treffer.length > 1) {
      return sendeText(zugriff.ziel,
        `Mehrere passen zu „${suchwort}" — welcher?\n` +
        treffer.slice(0, 8).map((t) => `• \`/add ${t.name}\``).join('\n'));
    }

    const t = treffer[0];
    if ((r.faeden || []).includes(t.id)) {
      return sendeText(zugriff.ziel, `*${t.name}* ist hier schon drin.`);
    }
    raeume.fuegeHinzu(gruppenId, threadId, t.id);
    schreibeEintrag('Arbeitsraum', `${gruppenId}:${threadId} + Faden ${t.id} (${t.name})`);
    await sendeText(zugriff.ziel,
      `🗂️ *${t.name}* ist jetzt in diesem Arbeitsraum.\n\n` +
      '_Der Faden liegt weiterhin in deiner Ablage und ist auch im Einzelchat da — ' +
      'er ist hier nur zusätzlich sichtbar._');
  });

  befehl(/^\/raus(?:\s+(.+))?\s*$/i, async (msg, m) => {
    const zugriff = await raumOderHinweis(msg);
    if (!zugriff) return;
    const { gruppenId, threadId } = zugriff.ort;
    const suchwort = (m && m[1] && m[1].trim()) || '';
    if (!suchwort) return sendeText(zugriff.ziel, '`/raus <Stichwort>` blendet einen Faden hier aus. `/raum` zeigt, was drin ist.');

    const r = raeume.finde(gruppenId, threadId);
    const drin = fadenListe(zugriff.kontoId, r && r.faeden);
    const treffer = drin.filter((t) => String(t.name || '').toLowerCase().includes(suchwort.toLowerCase()));
    if (!treffer.length) return sendeText(zugriff.ziel, `„${suchwort}" ist hier nicht drin. \`/raum\` zeigt die Liste.`);
    if (treffer.length > 1) {
      return sendeText(zugriff.ziel, 'Mehrere passen — welcher?\n' +
        treffer.slice(0, 8).map((t) => `• \`/raus ${t.name}\``).join('\n'));
    }
    raeume.nimmRaus(gruppenId, threadId, treffer[0].id);
    await sendeText(zugriff.ziel,
      `🗂️ *${treffer[0].name}* wird hier nicht mehr angezeigt.\n\n` +
      '_Gelöscht ist nichts — der Faden liegt weiter in deiner Ablage._');
  });

  // Nur DEINE Gruppen. Was andere mit dem Bot machen, geht dich nichts an —
  // und umgekehrt.
  befehl(/^\/gruppen\b/i, async (msg) => {
    const chatId = msg.chat.id;
    const meine = gruppen.fuerBesitzer(chatId);
    if (!meine.length) {
      return sendeText(chatId, gruppenAnleitung());
    }
    const zeilen = meine.slice(0, 25).map((g) => {
      const seit = (g.angelegt || '').slice(0, 10);
      return `• *${g.titel || g.gruppenId}*` + (seit ? `  _seit ${seit}_` : '');
    });
    await sendeText(chatId,
      `👥 *Deine Gruppen* (${meine.length})\n` + zeilen.join('\n') +
      '\n\nWas dort entsteht, liegt in deiner Ablage — du siehst es auch hier im ' +
      'Einzelchat.\n\n' + gruppenAnleitung(true));
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
