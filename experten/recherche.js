// Recherche-Experte: Web-Suche, Fakten-Recherche, Quellen prüfen.
// Nutzt die globalen Web-Tools (web_search, web_fetch) wenn die jeweiligen
// API-Keys gesetzt sind. Fällt auf das Trainingswissen der KI zurück, wenn
// keine Keys da sind.

module.exports = {
  id: 'recherche',
  name: 'Recherche',
  emoji: '🔍',
  description: 'Sucht im Internet nach Fakten, Nachrichten, Anleitungen, Produkten, Wetter, Adressen, Personen — alles, wofür du aktuelle Daten brauchst.',
  triggers: [
    'recherche', 'recherchiere', 'recherchier',
    'such nach', 'suche nach', 'such mal', 'finde', 'find mal', 'find raus',
    'was ist', 'was sind', 'wer ist', 'wer war', 'wann ist', 'wann war',
    'wo ist', 'wo finde', 'wo gibt', 'wie funktioniert',
    'internet', 'web', 'online', 'google', 'aktuell', 'aktuelles',
    'wetter', 'nachrichten', 'news', 'preis', 'kosten', 'test', 'bewertung',
    'recherchiere', 'gibt es', 'gibts'
  ],
  systemPromptAdd: `RECHERCHE-MODUS AKTIV.
Du hast Zugriff auf Web-Tools (web_search, web_fetch). Nutze sie aktiv, wenn der Nutzer nach aktuellen Informationen fragt, die nicht in deinem Trainingswissen sind oder sich ändern können (Wetter, Nachrichten, Preise, Personen-Status, neue Produkte, technische Spezifikationen, Bedienungsanleitungen).

Regeln:
- Bevorzuge web_search für offene Fragen (Was ist X? Wer ist Y?)
- Nutze web_fetch, wenn du eine konkrete URL laden sollst
- Wenn KEIN Web-Tool verfügbar ist, sag das ehrlich und antworte aus deinem Trainingswissen
- Nenne Quellen (URLs) in deiner Antwort, damit der Nutzer nachprüfen kann
- Halte Antworten prägnant — 2-4 Sätze + ggf. die wichtigsten Quellen`,
  tools: null, // null = Standard-Tools (web_search, web_fetch falls Keys gesetzt)
  implementiert: true,

  verarbeite: async (input, kontext) => {
    // Der Recherche-Experte delegiert an den normalen Haupt-KI-Flow mit
    // Tool-Loop. Der Bot ruft mainChatMitTools auf, das Tool-Confirmation-
    // Handling, das Output-Filter und das Themen-Anhängen läuft ganz normal.
    //
    // Wir geben dem Bot eine "Anweisung" zurück, dass er den Standard-Flow
    // nutzen soll. Das geschieht über ein Marker-Objekt, das bot.js erkennt.

    return {
      _delegate: 'standard', // Signal an bot.js: nutze den normalen Tool-Loop
      antwort: null,         // wird vom Standard-Flow gefüllt
      merkeHook: null
    };
  }
};
