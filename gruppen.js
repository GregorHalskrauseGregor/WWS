// Gruppen — wem gehört welche Telegram-Gruppe, und was gehört dort hinein.
//
// ══════════════════════════════════════════════════════════════════════════
// DIE EINSCHRÄNKUNG DER TELEGRAM-BOT-API, VON DER ALLES ANDERE ABHÄNGT
// ══════════════════════════════════════════════════════════════════════════
//
// Ein Bot kann KEINE Gruppe erstellen und sich in keine einladen. Das können
// nur Menschen. Was ein Bot bekommt: eine Meldung, WENN ihn jemand hinzufügt —
// samt der Angabe, WER das war. Genau daran hängt hier der Besitz.
//
//   Torsten fügt den Bot zur Gruppe "Baustelle Sinn" hinzu
//        └─► Telegram meldet: my_chat_member, from = Torsten
//             └─► registriereBesitzer(gruppe, Torsten)
//
// Ab da gilt:
//
//   • Die Gruppe gehört Torstens Konto. In /einstellungen taucht sie auf.
//   • Was in der Gruppe passiert, wird unter TORSTENS Konto abgelegt — nicht
//     unter einer eigenen Gruppen-Ablage. Ein Aufmaß, das dort beginnt, findet
//     er im Einzelchat wieder und umgekehrt.
//   • Reden darf jeder in der Gruppe, der den Zugangscode hat. Wer ihn nicht
//     hat, wird still übergangen — im Gruppenchat nach einem Code zu fragen
//     hiesse, ihn vor allen anderen auszusprechen.
//
// ══════════════════════════════════════════════════════════════════════════
// ABLAGE
// ══════════════════════════════════════════════════════════════════════════
//
//   data/gruppen.json
//   {
//     "gruppen": { "-1001234": { besitzer, titel, angelegt, zuletzt } },
//     "faeden":  { "-1001234:17": { titel, themaName, gebundenAn, themen[] } }
//   }
//
// Besitz hängt an der GRUPPE, nicht am einzelnen Forum-Thema: wer den Bot
// hinzufügt, holt ihn für die ganze Gruppe, nicht für ein Thema darin.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('./config');

const DATEI = path.join(PFADE.DATA, 'gruppen.json');
const MAX_THEMEN = 12;

// ──────────────────────────────────────────────────────────────── Ablage

function leer() { return { gruppen: {}, faeden: {} }; }

function lade() {
  try {
    if (!fs.existsSync(DATEI)) return leer();
    const roh = JSON.parse(fs.readFileSync(DATEI, 'utf-8'));
    if (!roh || typeof roh !== 'object') return leer();
    // Vorgängerformat: flache Karte "<id>" bzw. "<id>:<thread>" -> Eintrag.
    // Wird beim ersten Lesen mitgenommen, damit nichts von Hand umgetragen
    // werden muss.
    if (!roh.gruppen && !roh.faeden) {
      const neu = leer();
      for (const [k, e] of Object.entries(roh)) {
        if (!e || typeof e !== 'object') continue;
        neu.faeden[k] = e;
        const gid = String(e.gruppenId || k.split(':')[0]);
        if (gid && !neu.gruppen[gid]) {
          neu.gruppen[gid] = {
            besitzer: e.besitzer || null, titel: e.titel || null,
            angelegt: e.angelegt || new Date().toISOString(), zuletzt: e.zuletzt || null
          };
        }
      }
      return neu;
    }
    return { gruppen: roh.gruppen || {}, faeden: roh.faeden || {} };
  } catch {
    return leer();
  }
}

function speichere(daten) {
  try {
    fs.mkdirSync(path.dirname(DATEI), { recursive: true });
    const temp = DATEI + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(daten, null, 2), 'utf-8');
    fs.renameSync(temp, DATEI);
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

// ────────────────────────────────────────────────────────────── Besitz

// Wird gerufen, wenn Telegram meldet, dass der Bot einer Gruppe hinzugefügt
// wurde. besitzer ist die User-ID dessen, der ihn hinzugefügt hat — im
// Einzelchat ist das zugleich seine chatId, und darunter liegen seine Daten.
function registriereBesitzer(gruppenId, besitzer, titel) {
  const daten = lade();
  const id = String(gruppenId);
  const vorher = daten.gruppen[id] || {};
  daten.gruppen[id] = {
    besitzer: besitzer == null ? (vorher.besitzer || null) : String(besitzer),
    titel: titel || vorher.titel || null,
    angelegt: vorher.angelegt || new Date().toISOString(),
    zuletzt: new Date().toISOString()
  };
  speichere(daten);
  return daten.gruppen[id];
}

function besitzerVon(gruppenId) {
  const e = lade().gruppen[String(gruppenId)];
  return (e && e.besitzer) || null;
}

function gruppeInfo(gruppenId) {
  return lade().gruppen[String(gruppenId)] || null;
}

// Alle Gruppen EINES Kontos. Das ist die Liste, die in /einstellungen steht.
function fuerBesitzer(chatId) {
  const id = String(chatId);
  const daten = lade();
  return Object.entries(daten.gruppen)
    .filter(([, e]) => e && String(e.besitzer) === id)
    .map(([gruppenId, e]) => ({ gruppenId, ...e }))
    .sort((a, b) => String(b.zuletzt || '').localeCompare(String(a.zuletzt || '')));
}

function loeseAb(gruppenId) {
  const daten = lade();
  const id = String(gruppenId);
  if (!daten.gruppen[id]) return false;
  delete daten.gruppen[id];
  for (const k of Object.keys(daten.faeden)) {
    if (k === id || k.startsWith(id + ':')) delete daten.faeden[k];
  }
  speichere(daten);
  return true;
}

// ─────────────────────────────────────────────────────────────── Fäden

// Bei jeder Gruppennachricht: Titel auffrischen, Thema-Namen festhalten.
function merke(msg) {
  if (!istGruppe(msg)) return null;
  const gruppenId = msg.chat.id;
  const threadId = msg.message_thread_id || null;
  const k = schluessel(gruppenId, threadId);
  const daten = lade();
  const vorher = daten.faeden[k] || {};

  // Beim ersten Beitrag in einem frisch erstellten Forum-Thema liefert Telegram
  // den Namen mit. Später nicht mehr — deshalb merken wir ihn.
  const themaName =
    (msg.forum_topic_created && msg.forum_topic_created.name) ||
    (msg.reply_to_message && msg.reply_to_message.forum_topic_created &&
      msg.reply_to_message.forum_topic_created.name) ||
    vorher.themaName || null;

  daten.faeden[k] = {
    gruppenId, threadId,
    titel: (msg.chat && msg.chat.title) || vorher.titel || null,
    themaName,
    gebundenAn: vorher.gebundenAn || null,
    themen: vorher.themen || [],
    angelegt: vorher.angelegt || new Date().toISOString(),
    zuletzt: new Date().toISOString()
  };
  const gid = String(gruppenId);
  if (daten.gruppen[gid]) {
    daten.gruppen[gid].titel = (msg.chat && msg.chat.title) || daten.gruppen[gid].titel;
    daten.gruppen[gid].zuletzt = new Date().toISOString();
  }
  speichere(daten);
  return daten.faeden[k];
}

function info(gruppenId, threadId) {
  return lade().faeden[schluessel(gruppenId, threadId)] || null;
}

function setze(gruppenId, threadId, felder) {
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  daten.faeden[k] = {
    ...(daten.faeden[k] || { gruppenId, threadId }),
    ...felder,
    zuletzt: new Date().toISOString()
  };
  speichere(daten);
  return daten.faeden[k];
}

function themaNotieren(gruppenId, threadId, name) {
  const sauber = String(name || '').trim();
  if (!sauber) return;
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  const e = daten.faeden[k] || { gruppenId, threadId, themen: [] };
  e.themen = e.themen || [];
  if (!e.themen.includes(sauber)) {
    e.themen.push(sauber);
    if (e.themen.length > MAX_THEMEN) e.themen = e.themen.slice(-MAX_THEMEN);
  }
  e.zuletzt = new Date().toISOString();
  daten.faeden[k] = e;
  speichere(daten);
}

// Die eine Zeile, die jeder Nachricht aus einer Gruppe vorangestellt wird.
// Bewusst kurz: Router und Experten sollen wissen, wo sie sind, ohne dass es
// Tokens frisst.
function kontextZeile(msg) {
  if (!istGruppe(msg)) return '';
  const e = merke(msg);
  if (!e) return '';
  const teile = [];
  if (e.titel) teile.push(`Gruppe „${e.titel}"`);
  if (e.themaName) teile.push(`Thema „${e.themaName}"`);
  if (e.gebundenAn) teile.push(`Faden: ${e.gebundenAn}`);
  const von = msg.from && (msg.from.first_name || msg.from.username);
  if (von) teile.push(`von ${von}`);
  if (e.themen && e.themen.length) teile.push(`bisher hier: ${e.themen.join(', ')}`);
  if (!teile.length) return '';
  return `[${teile.join(' | ')}]`;
}

function alle() {
  const daten = lade();
  return Object.values(daten.faeden)
    .sort((a, b) => String(b.zuletzt || '').localeCompare(String(a.zuletzt || '')));
}

function entferne(gruppenId, threadId) {
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  if (!daten.faeden[k]) return false;
  delete daten.faeden[k];
  speichere(daten);
  return true;
}

// ───────────────────────────────────────────────── Forum-Themen (optional)

function forumChatId() {
  const roh = String(process.env.TELEGRAM_FORUM_CHAT_ID || '').trim();
  return roh || null;
}

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

  let link = null;
  try {
    const inv = await bot.createChatInviteLink(chat, { name: titel.slice(0, 32) });
    link = inv && inv.invite_link ? inv.invite_link : null;
  } catch { /* ohne Recht kein Link — das Thema existiert trotzdem */ }

  setze(chat, threadId, { themaName: titel, gebundenAn: titel });
  return { chatId: chat, threadId, link, titel };
}

module.exports = {
  DATEI,
  istGruppe,
  registriereBesitzer, besitzerVon, gruppeInfo, fuerBesitzer, loeseAb,
  merke, info, setze, themaNotieren, kontextZeile, alle, entferne,
  forumChatId, erstelleForumThema,
  _intern: { lade, speichere, schluessel }
};
