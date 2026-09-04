// Nachrichtenbruecke zwischen den Bots.
//
// Es gibt jetzt zwei Telegram-Bots: den normalen und den des Lageristen. Beide
// muessen sich gegenseitig erreichen — der Lager-Bot schickt dem Monteur den
// Bescheid, der normale Bot loest beim Lageristen eine neue Liste aus.
//
// Direkt geht das nicht: dann wuerde jeder Adapter den anderen importieren, und
// beim naechsten Bot waeren es vier Verbindungen. Stattdessen meldet sich jeder
// Adapter beim Start hier an, und wer etwas schicken will, fragt nach dem Kanal.
// Fehlt der Kanal (Bot nicht konfiguriert, Token fehlt), passiert nichts —
// aber es wird gemeldet, statt still zu verschlucken.

// Die Kanalnamen heissen bewusst NICHT wie die Experten. 'lager' waere hier
// naheliegend gewesen — und haette gegen die Regel verstossen, dass im Kern und
// in den Adaptern kein Expertenname faellt. Ein Test hat das gefangen.
const _kanaele = new Map();

function registriere(name, senden) {
  _kanaele.set(name, senden);
}

function verfuegbar(name) {
  return _kanaele.has(name);
}

async function sende(name, chatId, text, optionen) {
  const kanal = _kanaele.get(name);
  if (!kanal) return { gesendet: false, grund: `Kanal "${name}" ist nicht angemeldet` };
  try {
    await kanal(chatId, text, optionen);
    return { gesendet: true };
  } catch (err) {
    return { gesendet: false, grund: err.message };
  }
}

module.exports = { registriere, verfuegbar, sende, _kanaele };
