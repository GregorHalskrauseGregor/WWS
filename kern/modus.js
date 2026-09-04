// Exklusive Modi — wenn der Bot gerade NUR eine Sache tun soll.
//
// Zwei Stellen brauchen das, und beide aus demselben Grund: es gibt Momente, in
// denen eine nebenher hereinlaufende Nachricht echten Schaden anrichtet.
//
//   options         Einstellungen aendern. Waehrenddessen soll keine halbe
//                   Materialbuchung dazwischenfunken, die eine gerade
//                   umgestellte Rolle noch mit den alten Rechten sieht.
//   reservierung    Der Lagerist arbeitet eine Reservierung Position fuer
//                   Position ab. Kaeme dabei eine zweite Reservierung in den
//                   Verlauf, waere fuer ihn nicht mehr erkennbar, welche Zahl
//                   zu welcher Position gehoert — und er bucht Material auf den
//                   falschen Auftrag.
//
// Der Modus haengt am Chat, nicht am Nutzer: derselbe Mensch kann im normalen
// Bot arbeiten, waehrend im Lager-Bot ein Workflow laeuft.
//
// Bewusst nur im Speicher. Ein Neustart soll niemanden aussperren — ein
// haengengebliebener Modus in einer Datei waere ein Bot, der auf nichts mehr
// antwortet und den niemand aufbekommt.

const _modi = new Map();

// Wie lange ein Modus hoechstens haelt. Wer mitten im Workflow das Handy
// weglegt, soll den Bot nicht dauerhaft blockieren.
const MAX_ALTER_MS = 30 * 60 * 1000;

function schluessel(chatId) { return String(chatId); }

function aktiv(chatId) {
  const m = _modi.get(schluessel(chatId));
  if (!m) return null;
  if (Date.now() - m.seit > MAX_ALTER_MS) {
    _modi.delete(schluessel(chatId));
    return null;
  }
  return m;
}

function starte(chatId, art, daten = {}) {
  const m = { art, seit: Date.now(), daten };
  _modi.set(schluessel(chatId), m);
  return m;
}

// Zustand innerhalb eines laufenden Modus fortschreiben, ohne ihn neu zu setzen.
function aktualisiere(chatId, daten) {
  const m = aktiv(chatId);
  if (!m) return null;
  m.daten = { ...m.daten, ...daten };
  m.seit = Date.now(); // jede Eingabe verlaengert die Frist
  return m;
}

function beende(chatId) {
  return _modi.delete(schluessel(chatId));
}

function alle() {
  return [...(_modi.entries())].map(([chatId, m]) => ({ chatId, ...m }));
}

module.exports = { aktiv, starte, aktualisiere, beende, alle, MAX_ALTER_MS };
