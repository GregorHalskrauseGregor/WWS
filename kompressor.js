// Komprimierung: hält Themen-Verläufe und das globale Gedächtnis klein.
//
// Strategie pro Thema (rollende Zusammenfassung):
//   - Wenn messages.length > SCHWELLE: die ältesten BLOCK Nachrichten + die bisherige
//     summary werden der KI gegeben, mit dem Auftrag daraus EINE neue summary zu bauen.
//   - Diese neue summary ersetzt die alte. Die jüngsten (SCHWELLE - BLOCK) Nachrichten
//     bleiben unverändert im Verlauf stehen.
//   - Im Kontext sieht die KI dann: [summary] + [jüngste Nachrichten]. Token-Bedarf
//     bleibt damit dauerhaft im Rahmen, egal wie lang das Thema wird.
//
// Strategie für das Gedächtnis: gleiches Prinzip, ohne "jüngste" — das Gedächtnis ist
// ein einziger Topf. Wenn die Faktenliste zu lang wird, alles zusammenfassen lassen.

const { ladeThema, speichereThema } = require('./themen');
const { ladeFakten, ersetzeFakten } = require('./gedaechtnis');

// Schwellwerte — bewusst moderat, damit Komprimierung nicht bei jeder zweiten Nachricht läuft.
const THEMA_SCHWELLE = 20;   // ab dieser Anzahl Nachrichten wird komprimiert
const THEMA_BLOCK = 10;      // ...die ältesten BLOCK zusammenfassen
const GEDAECHTNIS_SCHWELLE = 30; // ab dieser Fakten-Anzahl wird komprimiert

// Sehr grobe Token-Schätzung: 4 Zeichen ≈ 1 Token. Reicht für "wird es zu lang?".
function schaetzeTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Sollte dieses Thema komprimiert werden?
function themaBereitZurKomprimierung(thema) {
  return Array.isArray(thema.messages) && thema.messages.length > THEMA_SCHWELLE;
}

// Sollte das Gedächtnis komprimiert werden?
function gedaechtnisBereitZurKomprimierung(chatId) {
  return ladeFakten(chatId).length > GEDAECHTNIS_SCHWELLE;
}

function messagesAlsText(messages) {
  return messages
    .map((m) => {
      const wer = m.rolle === 'user' ? 'Nutzer' : 'Assistent';
      return `${wer}: ${m.inhalt}`;
    })
    .join('\n');
}

// Komprimiert ein einzelnes Thema. Gibt das aktualisierte Thema zurück oder null,
// wenn nichts zu tun war. lightChat ist die Provider-Funktion (mit rolle: 'light'
// oder 'main', je nach Konfiguration).
async function komprimiereThema(chatId, themaId, lightChat) {
  const thema = ladeThema(chatId, themaId);
  if (!thema) return null;
  if (!themaBereitZurKomprimierung(thema)) return thema;

  const aelteste = thema.messages.slice(0, THEMA_BLOCK);
  const blockText = messagesAlsText(aelteste);
  const vorhandeneSummary = thema.summary || '(noch keine)';

  const systemPrompt = `Du führst eine rollierende Zusammenfassung eines Chat-Verlaufs weiter.
Dir werden die bisherige Zusammenfassung und ein Block älterer Nachrichten gegeben.
Erzeuge eine NEUE Zusammenfassung, die:
- die alte Zusammenfassung komplett enthält (nichts Wichtiges aus früher verdrängen)
- die neuen Nachrichten verdichtet einbaut (offene Fragen, Entscheidungen, Fakten, Präferenzen)
- als kompakter Fließtext in 2.-Person Singular gegenüber dem Nutzer formuliert ist
- KEINE wörtlichen Zitate, KEINE erfundenen Details
- maximal ca. 400 Wörter lang ist
Antworte AUSSCHLIESSLICH mit der neuen Zusammenfassung, ohne Präfix oder JSON.`;

  const userText = `Bisherige Zusammenfassung:
"""
${vorhandeneSummary}
"""

Ältere Nachrichten, die eingebaut werden sollen:
"""
${blockText}
"""`;

  const neueSummary = (await lightChat(systemPrompt, userText)).trim();

  thema.summary = neueSummary;
  thema.messages = thema.messages.slice(THEMA_BLOCK);
  speichereThema(chatId, thema);
  return thema;
}

async function komprimiereGedaechtnis(chatId, lightChat) {
  const fakten = ladeFakten(chatId);
  if (fakten.length <= GEDAECHTNIS_SCHWELLE) return false;

  const systemPrompt = `Du komprimierst eine Faktensammlung (Notizen, die das KI-Gedächtnis über einen Nutzer erweitern).
Fasse zusammen, entferne Redundanzen, behalte alle wichtigen Informationen (Präferenzen, Fakten, laufende Projekte, Personen, Deadlines, Aussagen des Nutzers über sich selbst).
Antworte als nummerierte Liste, ein Fakt pro Zeile, ohne Einleitung oder Kommentar.`;

  const userText = `Aktuelle Faktensammlung (eine Zeile pro Fakt):
"""
${fakten.join('\n')}
"""`;

  const roh = (await lightChat(systemPrompt, userText)).trim();
  // Jede nichtleere Zeile wird ein Fakt. Nummerierungen ("1. ...") werden entfernt.
  const neueFakten = roh
    .split('\n')
    .map((z) => z.replace(/^\s*\d+[.)]\s*/, '').trim())
    .filter(Boolean);

  if (neueFakten.length === 0) {
    // Defensive: wenn die KI Mistook baut, lieber Original behalten als Datenverlust.
    return false;
  }
  ersetzeFakten(chatId, neueFakten);
  return true;
}

// Schätzt die Token für den Teil, der pro Anfrage an die Haupt-KI geht:
// aktive Topic-Summary + jüngste Messages. Vor dem Versand aufrufen, um ggf.
// noch aggressiver zu komprimieren.
function schaetzeThemaTokens(thema) {
  const basis = thema.summary || '';
  const nachrichten = messagesAlsText(thema.messages || []);
  return schaetzeTokens(basis) + schaetzeTokens(nachrichten);
}

module.exports = {
  THEMA_SCHWELLE,
  THEMA_BLOCK,
  GEDAECHTNIS_SCHWELLE,
  themaBereitZurKomprimierung,
  gedaechtnisBereitZurKomprimierung,
  komprimiereThema,
  komprimiereGedaechtnis,
  schaetzeTokens,
  schaetzeThemaTokens
};
