// Der Lager-Bot — zweiter Telegram-Bot, nur fuer den Lageristen.
//
// Warum ein eigener Bot und kein eigener Chat im normalen Bot: die Liste der
// offenen Reservierungen wird staendig neu geschickt, damit sie unten steht.
// Zwischen Aufmassen, Recherchen und Smalltalk waere sie nach zwei Minuten
// weggerutscht — und eine Aufgabenliste, die man suchen muss, wird nicht
// abgearbeitet.
//
// Dieser Bot hat KEINEN Router und KEINE Experten. Er kann genau drei Dinge:
// die Liste zeigen, eine Reservierung Position fuer Position durchgehen, und
// das Ergebnis buchen. Alles, was hier komplizierter waere, gehoert in den
// normalen Bot.
//
// DIE LISTE. Es gibt immer nur eine: die alte wird geloescht, die neue kommt
// ans Ende. Geprueft wird jede Minute; nur wenn sich wirklich etwas geaendert
// hat, wird getauscht — sonst blinkt das Handy des Lageristen im Minutentakt.

const TelegramBot = require('node-telegram-bot-api');

const { PFADE } = require('../config');
const material = require('../material');
const reservierungen = require('../reservierungen');
const rollen = require('../rollen');
const modus = require('../kern/modus');
const benachrichtigung = require('../benachrichtigung');
const nachricht = require('../lib/lager_nachricht');
const { schreibeEintrag } = require('../protokoll');

const TAKT_MS = 60 * 1000;

// Wem die Liste geschickt wird, und welche Nachricht dort gerade steht.
// Nur im Speicher: nach einem Neustart wird die Liste einfach neu geschickt.
const _empfaenger = new Map(); // chatId -> { messageId, signatur }

function signaturVon(offene) {
  return offene.map((r) => `${r.id}:${r.status}:${r.positionen.length}`).join('|');
}

function starte({ token }) {
  if (!token) {
    console.log('Lager-Bot: kein TELEGRAM_LAGER_TOKEN gesetzt — der Lagerist bekommt keine Reservierungen.');
    return null;
  }

  const bot = new TelegramBot(token, { polling: true });

  async function sendeText(chatId, text, extra = {}) {
    try {
      return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra });
    } catch {
      // Markdown kann an einer Materialbezeichnung mit Unterstrich scheitern.
      // Dann lieber ohne Formatierung als gar nicht.
      return bot.sendMessage(chatId, text, extra);
    }
  }

  const jaNein = (r, index) => ({
    reply_markup: {
      inline_keyboard: [[
        { text: `✅ ${r.positionen[index].menge} ${r.positionen[index].einheit} da`, callback_data: `da:${r.id}:${index}` },
        { text: '❌ nicht da', callback_data: `nix:${r.id}:${index}` }
      ]]
    }
  });

  const abschlussKnoepfe = (r) => ({
    reply_markup: {
      inline_keyboard: [
        [{ text: '📦 Zurechtgelegt — ausbuchen', callback_data: `fertig:${r.id}:1` }],
        [{ text: '🔖 Liegt im Regal — reserviert lassen', callback_data: `fertig:${r.id}:0` }]
      ]
    }
  });

  // ───────────────────────────────────────────────────────────── Liste

  async function zeigeListe(chatId, { erzwinge = false } = {}) {
    // Waehrend ein Workflow laeuft, wird nichts nachgeschoben — sonst rutscht
    // dem Lageristen mitten im Durchgehen eine neue Liste dazwischen.
    if (modus.aktiv(chatId)) return;

    const offene = reservierungen.offene();
    const signatur = signaturVon(offene);
    const stand = _empfaenger.get(String(chatId)) || {};
    if (!erzwinge && stand.signatur === signatur) return;

    if (stand.messageId) {
      try { await bot.deleteMessage(chatId, stand.messageId); } catch { /* schon weg */ }
    }
    const gesendet = await sendeText(chatId, nachricht.offeneListe(offene));
    _empfaenger.set(String(chatId), { messageId: gesendet && gesendet.message_id, signatur });
  }

  async function zeigeListeAllen(optionen) {
    for (const chatId of _empfaenger.keys()) await zeigeListe(chatId, optionen);
  }

  // ───────────────────────────────────────────────────────── Workflow

  async function starteWorkflow(chatId, id) {
    const r = reservierungen.lade(id);
    if (!r) return sendeText(chatId, `Die Reservierung /${id} gibt es nicht (mehr).`);
    if (r.status !== reservierungen.STATUS.offen && r.status !== reservierungen.STATUS.in_arbeit) {
      return sendeText(chatId, `Die Reservierung /${id} ist schon bearbeitet (${r.status}).`);
    }

    reservierungen.setzeStatus(id, reservierungen.STATUS.in_arbeit,
      { bearbeitetVon: String(chatId) });
    modus.starte(chatId, 'reservierung', { id, index: 0 });
    schreibeEintrag('Lager', `${chatId} bearbeitet Reservierung ${id}`);

    // Die Liste verschwindet fuer die Dauer des Workflows — der Bildschirm soll
    // genau eine Frage zeigen.
    const stand = _empfaenger.get(String(chatId));
    if (stand && stand.messageId) {
      try { await bot.deleteMessage(chatId, stand.messageId); } catch { /* egal */ }
      _empfaenger.set(String(chatId), { messageId: null, signatur: null });
    }

    return frageNaechste(chatId, id, 0);
  }

  async function frageNaechste(chatId, id, index) {
    const r = reservierungen.lade(id);
    if (!r) { modus.beende(chatId); return; }
    if (index >= r.positionen.length) return frageAbschluss(chatId, r);
    modus.aktualisiere(chatId, { id, index });
    return sendeText(chatId, nachricht.positionsFrage(r, index), jaNein(r, index));
  }

  async function frageAbschluss(chatId, r) {
    modus.aktualisiere(chatId, { id: r.id, index: r.positionen.length, abschluss: true });
    return sendeText(chatId, nachricht.abschlussFrage(r), abschlussKnoepfe(r));
  }

  async function antworteAufPosition(chatId, id, index, menge) {
    const r = reservierungen.lade(id);
    if (!r || !r.positionen[index]) return;
    reservierungen.setzeBestaetigung(id, index, menge);
    return frageNaechste(chatId, id, index + 1);
  }

  // ──────────────────────────────────────────────────── Abschluss buchen

  async function schliesseAb(chatId, id, zurechtgelegt) {
    // Gebucht wird in reservierungen.abschliessen() — ein Adapter uebersetzt
    // Nachrichten, er bewegt keinen Bestand.
    const ergebnis = await reservierungen.abschliessen(id, {
      zurechtgelegt, material, pfad: PFADE.MATERIAL_XLSX
    });
    if (!ergebnis) { modus.beende(chatId); return; }

    const { reservierung: fertig, bilanz, korrekturen } = ergebnis;
    if (korrekturen.length) {
      schreibeEintrag('Lager', `Bestand korrigiert (${id}): ${korrekturen.join(' | ')}`);
    }

    const bescheid = await benachrichtigung.sende('hauptbot', fertig.monteurChatId,
      nachricht.monteurBescheid(fertig, bilanz));
    if (!bescheid.gesendet) {
      schreibeEintrag('Fehler', `Monteur nicht erreicht (${id}): ${bescheid.grund}`);
    }

    modus.beende(chatId);

    await sendeText(chatId, [
      zurechtgelegt ? '✅ Ausgebucht und als bereitgestellt vermerkt.' : '🔖 Bleibt reserviert.',
      korrekturen.length ? '\n📉 Bestand angepasst:\n' + korrekturen.map((m) => '• ' + m).join('\n') : '',
      bescheid.gesendet ? '\nDer Monteur ist informiert.' : '\n⚠️ Der Monteur konnte nicht benachrichtigt werden.'
    ].filter(Boolean).join('\n'));

    // Und sofort die naechste Aufgabe zeigen.
    return zeigeListe(chatId, { erzwinge: true });
  }

  // ─────────────────────────────────────────────────────────── Eingang

  bot.onText(/^\/start\b/, async (msg) => {
    const chatId = msg.chat.id;
    const rolle = rollen.rolleVon(chatId);
    if (rolle !== 'lagerist') {
      return sendeText(chatId,
        '📦 Das ist der Lager-Bot.\n\nDu bist hier nicht als Lagerist eingetragen. ' +
        'Im normalen Bot kann dir jemand mit Admin-Zugang die Rolle geben: /options <Kennwort>');
    }
    _empfaenger.set(String(chatId), {});
    await sendeText(chatId,
      '📦 *Lager-Bot*\n\nAb jetzt bekommst du hier jede Reservierung.\n\n' +
      'Die Liste steht immer als letzte Nachricht im Chat — tipp auf eine Nummer, ' +
      'um eine Reservierung Position für Position durchzugehen.');
    return zeigeListe(chatId, { erzwinge: true });
  });

  bot.onText(/^\/liste\b/, async (msg) => {
    _empfaenger.set(String(msg.chat.id), _empfaenger.get(String(msg.chat.id)) || {});
    return zeigeListe(msg.chat.id, { erzwinge: true });
  });

  // Die Reservierungsnummer als Befehl: /r7k3m9x2
  bot.onText(/^\/(r[a-z0-9]{8})\b/i, async (msg, m) => {
    const chatId = msg.chat.id;
    if (modus.aktiv(chatId)) {
      return sendeText(chatId, '⏸ Du bist noch in einer Reservierung. Erst die zu Ende bringen.');
    }
    return starteWorkflow(chatId, m[1].toLowerCase());
  });

  // Freitext: im Workflow ist das eine Teilmenge ("5"), sonst ein Hinweis.
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (!text || text.startsWith('/')) return;

    const aktiv = modus.aktiv(chatId);
    if (!aktiv || aktiv.art !== 'reservierung') {
      return sendeText(chatId, 'Tipp auf eine Reservierungsnummer aus der Liste, oder /liste für eine neue Übersicht.');
    }
    if (aktiv.daten.abschluss) {
      return sendeText(chatId, 'Nimm einen der beiden Knöpfe: zurechtgelegt oder liegt im Regal.');
    }

    const zahl = Number(text.replace(',', '.').replace(/[^\d.]/g, ''));
    if (!Number.isFinite(zahl) || zahl < 0) {
      return sendeText(chatId, 'Ich brauche eine Zahl — oder tipp auf einen der beiden Knöpfe.');
    }
    return antworteAufPosition(chatId, aktiv.daten.id, aktiv.daten.index, zahl);
  });

  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const [was, id, wert] = String(query.data || '').split(':');
    try { await bot.answerCallbackQuery(query.id); } catch { /* egal */ }

    if (was === 'da' || was === 'nix') {
      const r = reservierungen.lade(id);
      if (!r) return;
      const index = Number(wert);
      const menge = was === 'da' ? r.positionen[index].menge : 0;
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }); } catch { /* egal */ }
      return antworteAufPosition(chatId, id, index, menge);
    }

    if (was === 'fertig') {
      try { await bot.editMessageReplyMarkup({ inline_keyboard: [] },
        { chat_id: chatId, message_id: query.message.message_id }); } catch { /* egal */ }
      return schliesseAb(chatId, id, wert === '1');
    }
  });

  // ─────────────────────────────────────────────────────── Minutentakt

  const takt = setInterval(() => {
    zeigeListeAllen().catch((err) => schreibeEintrag('Fehler', `Lager-Takt: ${err.message}`));
  }, TAKT_MS);
  if (typeof takt.unref === 'function') takt.unref();

  benachrichtigung.registriere('lagerbot', (chatId, text, extra) => sendeText(chatId, text, extra));

  console.log('Lager-Bot läuft. Takt: alle 60 Sekunden.');
  return bot;
}

module.exports = { starte, _empfaenger, signaturVon };
