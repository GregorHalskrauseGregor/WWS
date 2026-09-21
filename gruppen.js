// Gesprächsfäden in Telegram-Gruppen auslagern.
//
// EHRLICHE EINSCHRÄNKUNG DER TELEGRAM-BOT-API:
// Ein Bot kann KEINE Gruppe erstellen. Es gibt dafür keine Methode — Gruppen
// legen nur Menschen an. Was ein Bot kann:
//   - in einer Forum-Gruppe (Supergruppe mit aktivierten Themen), in der er
//     Admin ist, ein THEMA anlegen: createForumTopic
//   - für einen Chat, in dem er Admin ist, einen Einladungslink erzeugen:
//     createChatInviteLink
//
// Daraus ergeben sich zwei Wege, beide hier unterstützt:
//
//   A) FORUM-WEG (automatisch, empfohlen)
//      Einmalig: eine Supergruppe anlegen, "Themen" einschalten, den Bot als
//      Admin hinzufügen, ihre Chat-ID in TELEGRAM_FORUM_CHAT_ID eintragen.
//      Danach legt der Bot pro Gesprächsfaden ein eigenes Forum-Thema an und
//      schickt den Link. Das ist die strukturelle Trennung, die gewünscht war.
//
//   B) MANUELLER WEG (ohne Vorbereitung)
//      Der Nutzer legt selbst eine Gruppe an und fügt den Bot hinzu. In der
//      Gruppe bindet er den Faden mit /faden_hierher.
//
// In BEIDEN Fällen gilt: Eine Gruppe ist für den Bot ein eigener Chat mit
// eigener Themen-Ablage (data/users/<gruppenId>/). Er verhält sich dort wie im
// Einzelchat — bekommt aber zu jeder Nachricht mit, in welcher Gruppe und zu
// welchem Thema er gerade schreibt.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('./config');

const DATEI = path.join(PFADE.DATA, 'gruppen.json');

function lade() {
  try {
    if (!fs.existsSync(DATEI)) return {};
    const roh = JSON.parse(fs.readFileSync(DATEI, 'utf-8'));
    return roh && typeof roh === 'object' ? roh : {};
  } catch {
    return {};
  }
}

function speichere(daten) {
  try {
    fs.mkdirSync(path.dirname(DATEI), { recursive: true });
    fs.writeFileSync(DATEI, JSON.stringify(daten, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Gruppen-Datei nicht schreibbar:', err.message);
    return false;
  }
}

function schluessel(gruppenId, threadId) {
  return threadId ? `${gruppenId}:${threadId}` : String(gruppenId);
}

function istGruppe(msg) {
  const typ = msg && msg.chat && msg.chat.type;
  return typ === 'group' || typ === 'supergroup';
}

// Legt bei jeder Gruppennachricht den Eintrag an bzw. frischt Titel auf.
function merke(msg) {
  if (!istGruppe(msg)) return null;
  const gruppenId = msg.chat.id;
  const threadId = msg.message_thread_id || null;
  const k = schluessel(gruppenId, threadId);
  const daten = lade();
  const vorher = daten[k] || {};

  // Beim ersten Beitrag in einem frisch erstellten Forum-Thema liefert
  // Telegram den Namen mit. Später nicht mehr — deshalb merken wir ihn.
  const themaName =
    (msg.forum_topic_created && msg.forum_topic_created.name) ||
    (msg.reply_to_message && msg.reply_to_message.forum_topic_created &&
      msg.reply_to_message.forum_topic_created.name) ||
    vorher.themaName || null;

  daten[k] = {
    gruppenId,
    threadId,
    titel: (msg.chat && msg.chat.title) || vorher.titel || null,
    themaName,
    besitzer: vorher.besitzer || null,
    gebundenAn: vorher.gebundenAn || null,   // Faden-Name aus dem Einzelchat
    themen: vorher.themen || [],             // worüber hier gesprochen wurde
    angelegt: vorher.angelegt || new Date().toISOString(),
    zuletzt: new Date().toISOString()
  };
  speichere(daten);
  return daten[k];
}

function info(gruppenId, threadId) {
  return lade()[schluessel(gruppenId, threadId)] || null;
}

function setze(gruppenId, threadId, felder) {
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  daten[k] = { ...(daten[k] || { gruppenId, threadId }), ...felder, zuletzt: new Date().toISOString() };
  speichere(daten);
  return daten[k];
}

// Behandelte Themen mitschreiben — das ist der Kontext, den der Bot später
// bei jeder Nachricht mitbekommt ("worum geht es in dieser Gruppe?").
const MAX_THEMEN = 12;
function themaNotieren(gruppenId, threadId, name) {
  const sauber = String(name || '').trim();
  if (!sauber) return;
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  const e = daten[k] || { gruppenId, threadId, themen: [] };
  e.themen = e.themen || [];
  if (!e.themen.includes(sauber)) {
    e.themen.push(sauber);
    if (e.themen.length > MAX_THEMEN) e.themen = e.themen.slice(-MAX_THEMEN);
  }
  e.zuletzt = new Date().toISOString();
  daten[k] = e;
  speichere(daten);
}

// Die eine Zeile, die jeder Nachricht aus einer Gruppe vorangestellt wird.
// Bewusst kurz: der Router und die Experten sollen wissen, wo sie sind, ohne
// dass es Tokens frisst.
function kontextZeile(msg) {
  if (!istGruppe(msg)) return '';
  const e = merke(msg);
  if (!e) return '';
  const teile = [];
  if (e.titel) teile.push(`Gruppe „${e.titel}"`);
  if (e.themaName) teile.push(`Thema „${e.themaName}"`);
  if (e.gebundenAn) teile.push(`Faden: ${e.gebundenAn}`);
  if (e.themen && e.themen.length) teile.push(`bisher hier: ${e.themen.join(', ')}`);
  if (!teile.length) return '';
  return `[${teile.join(' | ')}]`;
}

function alle() {
  return Object.values(lade()).sort((a, b) => (b.zuletzt || '').localeCompare(a.zuletzt || ''));
}

function entferne(gruppenId, threadId) {
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  if (!daten[k]) return false;
  delete daten[k];
  speichere(daten);
  return true;
}

// ───────────────────────────────────────────────── Forum-Themen (Weg A)

function forumChatId() {
  const roh = String(process.env.TELEGRAM_FORUM_CHAT_ID || '').trim();
  return roh || null;
}

// Legt ein Forum-Thema an und gibt {threadId, link} zurück.
// Wirft mit einer verständlichen Meldung, wenn die Voraussetzungen fehlen.
async function erstelleForumThema(bot, name) {
  const chat = forumChatId();
  if (!chat) {
    throw new Error(
      'Kein Forum konfiguriert. Einmalig einrichten:\n' +
      '1. In Telegram eine Gruppe anlegen und zur Supergruppe machen\n' +
      '2. In den Gruppen-Einstellungen „Themen" (Topics) einschalten\n' +
      '3. Diesen Bot als Administrator hinzufügen (Recht: Themen verwalten)\n' +
      '4. Die Chat-ID der Gruppe als TELEGRAM_FORUM_CHAT_ID in die .env eintragen\n' +
      '\nDanach lege ich pro Faden automatisch ein eigenes Thema an.'
    );
  }
  const titel = String(name || 'Faden').trim().slice(0, 128) || 'Faden';
  const thema = await bot.createForumTopic(chat, titel);
  const threadId = thema.message_thread_id;

  // Einladungslink: nur möglich, wenn der Bot Admin mit Einladerecht ist.
  let link = null;
  try {
    const inv = await bot.createChatInviteLink(chat, { name: titel.slice(0, 32) });
    link = inv && inv.invite_link ? inv.invite_link : null;
  } catch { /* ohne Recht kein Link — das Thema existiert trotzdem */ }

  setze(chat, threadId, { titel: null, themaName: titel, gebundenAn: titel });
  return { chatId: chat, threadId, link, titel };
}

module.exports = {
  DATEI,
  istGruppe,
  merke,
  info,
  setze,
  themaNotieren,
  kontextZeile,
  alle,
  entferne,
  forumChatId,
  erstelleForumThema
};
