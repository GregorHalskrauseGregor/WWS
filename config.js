// Zentrale Konfiguration: Schwellwerte, Limits und Pfade an EINER Stelle.
//
// Vorher lagen diese Werte verstreut in bot.js, router.js, experten/index.js,
// kompressor.js und ratelimit.js — teils doppelt und mit unterschiedlichen
// Werten (Router 0.6 vs. Experten-Auswahl 0.7). Ab hier gibt es pro
// Entscheidung genau eine Zahl.

const path = require('path');

const WURZEL = __dirname;
// Datenwurzel ist umlenkbar: auf Railway zeigt das Volume woanders hin, und
// Tests laufen so gegen ein Wegwerf-Verzeichnis statt gegen echte Nutzerdaten.
const DATA = process.env.WWS_DATA
  ? path.resolve(process.env.WWS_DATA)
  : path.join(WURZEL, 'data');

// ---------------------------------------------------------------- Schwellen
const SCHWELLEN = {
  // Frueher: Confidence-Schwelle, unter der Router-Entscheidungen verworfen
  // wurden. Jetzt abgeschafft: die KI entscheidet immer, der Nutzer kann
  // in der Folgenachricht korrigieren. Konstante bleibt als historische
  // Referenz, wird aber im Router nicht mehr ausgewertet.
  ROUTER_CONFIDENCE: 0.0,

  // Rollende Zusammenfassung: ab so vielen Nachrichten wird verdichtet,
  // dabei werden die ältesten THEMA_BLOCK Nachrichten zusammengefasst.
  THEMA_SCHWELLE: 20,
  THEMA_BLOCK: 10,

  // Gedächtnis: ab so vielen Fakten wird komprimiert.
  GEDAECHTNIS_SCHWELLE: 30,

  // Tool-Loop: maximale Runden, bis abgebrochen wird.
  MAX_TOOL_ITER: 3,

  // Wie lange auf die Tool-Bestätigung des Users gewartet wird.
  TOOL_BESTAETIGUNG_TIMEOUT_MS: 60_000,

  // Telegram-Limit pro Nachricht (mit Sicherheitsabstand).
  TELEGRAM_MAX: 3800,

  // Wie viele Nachrichten des Themas der Router als Kontext sieht.
  //
  // 600 Zeichen waren zu knapp: eine Bestellung mit zehn Positionen ist allein
  // schon laenger. Der Router sah dann nur noch das Ende des Verlaufs — also
  // seine eigene Rueckfrage und die Antwort darauf, aber nicht mehr, worum es
  // ueberhaupt ging. Damit kann er nicht erkennen, dass die Nachricht eine
  // Fortsetzung ist, und faengt von vorn an.
  ROUTER_VERLAUF_ANZAHL: 6,
  ROUTER_VERLAUF_MAX_ZEICHEN: 2500,

  // Datei-Vorschau für den Router. Die Grenze gilt fürs Einlesen des Textes;
  // die Formularfeld-Analyse ist billig und laeuft bis zur Telegram-Obergrenze.
  // (500 KB waren zu knapp: schon eine normale Formular-PDF hat ~900 KB, damit
  // wurde sie ungeprueft durchgereicht und als leeres Aufmass verarbeitet.)
  VORSCHAU_ZEICHEN: 500,
  VORSCHAU_MAX_BYTES: 4_000_000,
  FORMULAR_MAX_BYTES: 20_000_000
};

// ------------------------------------------------------------------ Limits
const LIMITS = {
  NACHRICHTEN_PRO_STUNDE: 30,
  NACHRICHTEN_PRO_TAG: 200,
  TOOL_CALLS_PRO_TAG: 60
};

// ------------------------------------------------------------------- Pfade
const PFADE = {
  WURZEL,
  DATA,
  USERS: path.join(DATA, 'users'),
  VORLAGEN: path.join(DATA, 'aufnahme_vorlage'),
  STYLE: path.join(DATA, 'style_sheet'),
  ANHAENGE: path.join(DATA, 'anhaenge'),
  MATERIAL_XLSX: path.join(DATA, 'material.xlsx'),
  PROTOKOLL: path.join(DATA, 'protokoll.txt'),
  BEGRUESSUNG: path.join(DATA, 'begruessung.txt'),
  RESERVIERUNGEN: path.join(DATA, 'reservierungen'),
  RESERVIERUNG: (id) => path.join(DATA, 'reservierungen', `${id}.json`),

  // Pro-User-Ablage
  user: (chatId) => path.join(DATA, 'users', String(chatId)),
  userDatei: (chatId, name) => path.join(DATA, 'users', String(chatId), name),

  // Pro-Thema-Ablage. WICHTIG (Umbau Stufe 2): Vorgänge hängen am Thema,
  // nicht am User — sonst kann immer nur ein Aufmaß gleichzeitig laufen.
  themenOrdner: (chatId) => path.join(DATA, 'users', String(chatId), 'themen'),
  themaDatei: (chatId, themaId) =>
    path.join(DATA, 'users', String(chatId), 'themen', `${themaId}.json`),
  vorgangOrdner: (chatId, themaId) =>
    path.join(DATA, 'users', String(chatId), 'themen', String(themaId)),
  vorgangDatei: (chatId, themaId) =>
    path.join(DATA, 'users', String(chatId), 'themen', String(themaId), 'vorgang.json')
};

module.exports = { SCHWELLEN, LIMITS, PFADE };
