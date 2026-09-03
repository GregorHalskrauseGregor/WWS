// 🔍 Recherche — Prompt-Experte.
//
// Braucht keine eigene Logik: er schärft nur den System-Prompt und lässt den
// normalen Chat-Flow mit Tool-Loop laufen. Vorher stand dafür ein Marker-Objekt
// (_delegate:'standard') im Rückgabewert, das bot.js kennen musste.

module.exports = {
  id: 'recherche',
  name: 'Recherche',
  emoji: '🔍',
  beschreibung: 'Sucht im Internet nach Fakten, Anleitungen, Produkten, Preisen und technischen Daten und nennt die Quellen.',

  zustaendigWenn:
    'Der Nutzer will etwas WISSEN, das aktuelle oder nachschlagbare Information ist: ' +
    'eine Anleitung, ein Datenblatt, ein Preis, eine technische Angabe, eine Adresse, ' +
    'eine Nachricht, oder er nennt eine konkrete URL zum Nachlesen. ' +
    'Auch wenn er nur "brauche eine Anleitung für X" sagt.',

  implementiert: true,

  systemPromptAdd: `RECHERCHE-MODUS AKTIV.
Du hast Zugriff auf Web-Tools (web_search, web_fetch). Nutze sie, wenn der Nutzer nach Informationen fragt, die sich ändern können oder nicht sicher in deinem Wissen stehen: Preise, Datenblätter, Anleitungen, Normen, Nachrichten, Produkte.

Regeln:
- web_search für offene Fragen, web_fetch für eine konkrete URL.
- Nur EINE Suche pro Anfrage, danach die Antwort formulieren.
- Ist kein Web-Tool verfügbar, sag das ehrlich und antworte aus deinem Wissen.
- Nenne die Quellen-URLs, damit der Nutzer nachprüfen kann.
- Prägnant bleiben: 2-4 Sätze plus Quellen.`
};
