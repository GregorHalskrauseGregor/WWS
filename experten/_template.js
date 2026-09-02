// VORLAGE FÜR EIN EXPERTEN-MODUL
//
// Jedes Expertensystem lebt als eigene Datei in diesem Ordner. Die Datei
// exportiert ein Objekt mit der unten dokumentierten Schnittstelle. Die
// Registry (experten/index.js) lädt automatisch alle .js-Dateien (außer
// dieser Template-Datei), und bot.js nutzt sie zur Erkennung und Verarbeitung.
//
// ----------------------------------------------------------------------
// SCHNITTSTELLE
// ----------------------------------------------------------------------
//
//   id           - Pflicht: eindeutige ID, kleingeschrieben, snake_case
//                  (z.B. 'recherche', 'leistungserfassung', 'materialaufmass')
//   name         - Pflicht: User-sichtbarer Name
//   emoji        - Optional: ein Emoji für die User-Darstellung
//   description  - Pflicht: was macht dieser Experte? (User-sichtbar)
//   triggers     - Pflicht: Liste von Schlüsselwörtern, die den Experten
//                  aktivieren. Matching ist case-insensitive und
//                  substring-basiert ("Aufmaß" matcht "Aufmaß erstellen")
//   systemPromptAdd
//                - Pflicht: Zusätzlicher System-Prompt, der beim Aktivieren
//                  an den Haupt-Prompt angehängt wird. Hier beschreibst du,
//                  WIE der Experte arbeiten soll, was er darf, was nicht.
//   tools        - Optional: Liste der Tool-Namen aus tools.js, die aktiv
//                  sein sollen, wenn dieser Experte aktiv ist. null/[] =
//                  Standard-Tools (web_search, web_fetch je nach Keys)
//   implementiert
//                - Pflicht: true wenn voll funktional, false für Stub
//   verarbeite   - Pflicht: async (input, kontext) => { antwort, merkeHook? }
//
// ----------------------------------------------------------------------
// INPUT (was die verarbeite-Funktion bekommt)
// ----------------------------------------------------------------------
//
//   input = {
//     chatId,             - Telegram-Chat-ID des Users
//     text,               - die ursprüngliche User-Nachricht
//     dokInhalt,          - ggf. extrahierter Datei-Inhalt
//     thema,              - das aktive Thema (vom Themen-System)
//     history,            - die letzten Messages des Themas
//     systemPrompt,       - der bisherige System-Prompt (ohne diesen Experten)
//     gedaechtnisText,    - die Langzeit-Fakten des Users
//   }
//
// ----------------------------------------------------------------------
// KONTEXT (Hilfsfunktionen, die du nutzen kannst)
// ----------------------------------------------------------------------
//
//   kontext = {
//     mainChat(systemPrompt, userMessage, opts)  - Haupt-KI aufrufen
//     lightChat(systemPrompt, userMessage, opts) - kleine KI für Mini-Aufgaben
//     mainChatMitTools(chatId, systemPrompt, messages, tools) - mit Tool-Loop
//     klassifiziereThema(text)                    - Themen-Klassifikation
//     ladeThema(chatId, themaId)                  - ein Thema laden
//     speichereThema(chatId, thema)               - ein Thema speichern
//     schreibeEintrag(typ, nachricht)             - ins Protokoll loggen
//     sicherheit.filterOutput(text)               - Output-Filter (gegen Leak)
//     ratelimit.pruefeNachricht(chatId)           - Rate-Limit-Check
//     ratelimit.pruefeToolCall(chatId)            - Tool-Limit
//     // ... weitere Helper, je nach Bedarf
//   }
//
// ----------------------------------------------------------------------
// RÜCKGABE
// ----------------------------------------------------------------------
//
//   {
//     antwort:    string,    // was der User sehen soll
//     merkeHook:  string|null, // optional, wird ins Langzeit-Gedächtnis geschoben
//     skipThemaAnhang: boolean, // optional, default false. Wenn true, wird die
//                                // Antwort nicht ins Themen-Verlauf geschrieben
//                                // (z.B. wenn der Experte eigene Persistenz hat)
//   }

module.exports = {
  id: 'beispiel',
  name: 'Beispiel-Experte',
  emoji: '⚙️',
  description: 'Hier steht, was dieser Experte tut.',
  triggers: ['beispiel', 'test'],
  systemPromptAdd: 'Du bist jetzt im Beispiel-Experten-Modus. ...',
  tools: null, // null = Standard-Tools verwenden, [] = keine Tools
  implementiert: false,

  verarbeite: async (input, kontext) => {
    return {
      antwort: 'Der Beispiel-Experte ist noch nicht implementiert. Sag dem Bot-Besitzer, dass er diesen Experten als nächstes bauen soll.',
      merkeHook: null
    };
  }
};
