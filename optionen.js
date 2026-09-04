// /options — der Einstellungsbereich.
//
// Zwei Ebenen: /options zeigt, was jeder ueber sich selbst sehen darf.
// /options <kennwort> oeffnet zusaetzlich den Admin-Bereich, in dem Rollen
// vergeben werden. Das Kennwort steht in der .env (ADMIN_KENNWORT) und nirgends
// im Code.
//
// SOLANGE DIE EINSTELLUNGEN OFFEN SIND, RUHT DER REST DES BOTS. Das ist keine
// Bequemlichkeit, sondern noetig: eine Nachricht, die waehrend einer laufenden
// Rollenaenderung verarbeitet wird, sieht je nach Zeitpunkt die alte oder die
// neue Rolle. Lieber eine Sekunde blockieren als ein Ergebnis, das von der
// Reihenfolge abhaengt.
//
// Aenderungen werden GESAMMELT und erst bei /options end geschrieben. Wer sich
// vertippt, tippt einfach die richtige Rolle hinterher — nichts ist passiert,
// solange nicht gespeichert wurde.

const rollen = require('./rollen');

const BEFEHLE_ROLLE = {
  zulagerist: 'lagerist',
  zumonteur: 'monteur',
  zuprojektleiter: 'projektleiter',
  zuprojektassistenz: 'projektassistenz'
};

function kennwortStimmt(eingabe) {
  const soll = process.env.ADMIN_KENNWORT;
  if (!soll) return false; // ohne gesetztes Kennwort gibt es keinen Admin-Zugang
  return String(eingabe || '').trim() === soll;
}

function menue(chatId, { admin, geplanteRolle }) {
  const jetzt = rollen.rolleVon(chatId);
  const zeilen = [
    '⚙️ *Einstellungen*',
    '',
    `Deine Rolle: ${rollen.beschreibe(geplanteRolle || jetzt)}` +
      (geplanteRolle && geplanteRolle !== jetzt ? '  _(geändert, noch nicht gespeichert)_' : ''),
    ''
  ];

  if (admin) {
    zeilen.push('🔓 *Admin-Bereich*', '', 'Rolle zuweisen:');
    for (const [befehl, rolle] of Object.entries(BEFEHLE_ROLLE)) {
      const r = rollen.ROLLEN[rolle];
      zeilen.push(`/${befehlSchreibweise(befehl)} — ${r.emoji} ${r.name}`);
    }
    zeilen.push('');
  } else {
    zeilen.push('_Für Änderungen brauchst du den Admin-Zugang: /options <Kennwort>_', '');
  }

  zeilen.push('/options end — speichern und schließen');
  zeilen.push('');
  zeilen.push('_Solange die Einstellungen offen sind, macht der Bot sonst nichts._');
  return zeilen.join('\n');
}

// zulagerist -> zuLagerist. Nur fuer die Anzeige: Telegram-Befehle sind
// unabhaengig von Gross- und Kleinschreibung, gelesen wird kleingeschrieben.
function befehlSchreibweise(klein) {
  return klein.replace(/^zu(.)/, (_, c) => 'zu' + c.toUpperCase());
}

// Beim Oeffnen. Liefert den Anfangszustand des Modus und den Begruessungstext.
function oeffne(chatId, argument) {
  const admin = kennwortStimmt(argument);
  const falschesKennwort = argument && !admin;
  const daten = { admin, geplanteRolle: null };
  let text = menue(chatId, daten);
  if (falschesKennwort) {
    text = '🔒 Kennwort stimmt nicht — die Einstellungen sind trotzdem offen, aber ohne Admin-Rechte.\n\n' + text;
  }
  return { daten, text };
}

// Jede Nachricht, solange der Modus laeuft.
// Rueckgabe: { text, daten?, beenden? }
function verarbeite(chatId, text, daten) {
  const roh = String(text || '').trim();
  const befehl = roh.replace(/^\//, '').split(/\s+/)[0].toLowerCase();
  const rest = roh.replace(/^\S+\s*/, '').trim();

  // /options end — und die naheliegenden Varianten, die jemand tippt, der den
  // Bot verlassen will. Ein Einstellungsbereich, aus dem man nicht rauskommt,
  // ist schlimmer als gar keiner.
  if ((befehl === 'options' && /^(end|ende|schliessen|schließen|fertig)$/i.test(rest))
      || /^(fertig|ende|schliessen|schließen|abbrechen|exit|quit)$/i.test(roh)) {
    return schliesse(chatId, daten);
  }

  if (BEFEHLE_ROLLE[befehl]) {
    if (!daten.admin) {
      return { text: '🔒 Rollen kann nur der Admin vergeben. Öffne mit /options <Kennwort>.' };
    }
    const rolle = BEFEHLE_ROLLE[befehl];
    const neu = { ...daten, geplanteRolle: rolle };
    return {
      daten: neu,
      text: `Vorgemerkt: ${rollen.beschreibe(rolle)}\n\n` +
        '_Noch nicht gespeichert. /options end schreibt es fest._\n\n' + menue(chatId, neu)
    };
  }

  if (befehl === 'options') {
    // Zweites /options im offenen Modus: nachtraeglich das Kennwort nachreichen.
    if (rest && kennwortStimmt(rest)) {
      const neu = { ...daten, admin: true };
      return { daten: neu, text: '🔓 Admin-Zugang entsperrt.\n\n' + menue(chatId, neu) };
    }
    return { text: menue(chatId, daten) };
  }

  return {
    text: 'Das gehört nicht in die Einstellungen.\n\n' + menue(chatId, daten)
  };
}

function schliesse(chatId, daten) {
  const zeilen = [];
  if (daten.geplanteRolle && rollen.setzeRolle(chatId, daten.geplanteRolle)) {
    zeilen.push(`✅ Gespeichert: ${rollen.beschreibe(daten.geplanteRolle)}`);
  } else {
    zeilen.push('✅ Einstellungen geschlossen, nichts geändert.');
  }
  zeilen.push('', 'Der Bot ist wieder normal ansprechbar.');
  return { text: zeilen.join('\n'), beenden: true };
}

module.exports = { oeffne, verarbeite, kennwortStimmt, BEFEHLE_ROLLE };
