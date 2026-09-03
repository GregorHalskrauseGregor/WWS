// VORLAGE FÜR EIN EXPERTEN-MODUL
//
// Jede .js-Datei in diesem Ordner wird beim Start automatisch geladen und
// geprüft. Dateien mit führendem _ (wie diese) werden übersprungen.
//
// ══════════════════════════════════════════════════════════════════════════
// DREI BAUARTEN — nimm die einfachste, die reicht
// ══════════════════════════════════════════════════════════════════════════
//
// 1) VORGANG   schema + finalisiere()
//    Für alles, was über mehrere Nachrichten zusammenwächst: Aufmaß,
//    Bestellung, Lagerbuchung, Rechnung. Du beschreibst NUR die Felder.
//    Das Sammeln, Nachfragen, Korrigieren ("Position 2 auf 5"), Bestätigen
//    und Abbrechen macht kern/vorgangsmotor.js für alle Experten gleich.
//    → Beispiele: materialaufmass.js, bestellung.js
//
// 2) PROMPT    systemPromptAdd (+ optional tools)
//    Für alles, was die KI im Gespräch selbst erledigt. Du schärfst den
//    System-Prompt und gibst ihr ggf. eigene Werkzeuge an die Hand.
//    → Beispiele: recherche.js, lagerauskunft.js
//
// 3) FREI      verarbeite()
//    Nur wenn du wirklich volle Kontrolle brauchst. Du bekommst die Nachricht
//    und lieferst das Ergebnis selbst.
//
// ══════════════════════════════════════════════════════════════════════════
// PFLICHTFELDER (alle Bauarten, auch Stubs)
// ══════════════════════════════════════════════════════════════════════════
//
//   id              eindeutig, klein, snake_case
//   name            für den Nutzer sichtbar
//   beschreibung    was der Experte tut (erscheint in /experten)
//   zustaendigWenn  ⚠ WICHTIGSTES FELD: in Prosa, wann DU zuständig bist —
//                   und wann ausdrücklich NICHT. Der Router liest genau das,
//                   um zu entscheiden. Es gibt keine Trigger-Wörter mehr.
//                   Schreib die typischen Verwechslungen mit hinein.
//   implementiert   false = Stub. Stubs werden dem Router nie angeboten.
//
// ══════════════════════════════════════════════════════════════════════════
// RÜCKGABE (überall gleich, transport-neutral)
// ══════════════════════════════════════════════════════════════════════════
//
//   { text, dateien: ['/pfad.pdf'], knoepfe: [{text, daten}], vorgangEnde }
//
//   Kein Telegram, kein bot-Objekt, kein sendDocument. Der Adapter rendert das.
//
// ══════════════════════════════════════════════════════════════════════════
// dienste (überall verfügbar)
// ══════════════════════════════════════════════════════════════════════════
//
//   dienste.chat(systemPrompt, text)   KI für Extraktion
//   dienste.antwortChat(...)           KI für freie Antworten
//   dienste.lightChat(...)             kleines Modell für Nebenaufgaben
//   dienste.protokoll(typ, text)       ins Ereignisprotokoll
//   dienste.melde(text)                Zwischenmeldung an den Nutzer
//
// Fach-APIs (OCR, Transkription, Suche) über require('../dienste').

module.exports = {
  id: 'beispiel',
  name: 'Beispiel',
  emoji: '⚙️',
  beschreibung: 'Was dieser Experte für den Nutzer tut.',

  zustaendigWenn:
    'Der Nutzer will … . NICHT gemeint sind … (das ist Experte X).',

  implementiert: false,

  // ─── Bauart 1: Vorgang ───────────────────────────────────────────────
  // schema: {
  //   kunde: {
  //     pflicht: true, typ: 'text', label: 'Kunde',
  //     beschreibung: 'Hinweis für die KI, wie das Feld aussieht',
  //     frage: 'Für welchen Kunden?'          // genau so wird nachgefragt
  //   },
  //   positionen: {
  //     pflicht: true, typ: 'liste', min: 1, label: 'Positionen',
  //     felder: { menge: 'zahl', einheit: 'text', bezeichnung: 'text',
  //               notiz: 'text?' },           // ? = optional
  //     frage: 'Welche Positionen?'
  //   }
  // },
  // extraktionsHinweise: 'Fachwissen für die Extraktion (Einheiten, Formate).',
  // async finalisiere({ chatId, themaId, daten }, dienste) {
  //   return { text: 'Fertig.', dateien: [] };
  // },

  // ─── Bauart 2: Prompt ────────────────────────────────────────────────
  // systemPromptAdd: 'Du bist jetzt im …-Modus. Regeln: …',
  // nurEigeneTools: true,          // blendet Web-Suche aus
  // tools: [{
  //   name: 'etwas_pruefen',
  //   beschreibung: 'Was das Werkzeug tut (die KI liest das).',
  //   parameter: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
  //   ausfuehren: async ({ x }) => 'Ergebnis für ' + x
  // }],

  // ─── Bauart 3: frei ──────────────────────────────────────────────────
  // async verarbeite({ chatId, themaId, text, dokInhalt, thema }, dienste) {
  //   return { text: 'Antwort' };
  // },

  // ─── Optional für alle ───────────────────────────────────────────────
  // commands: [{
  //   name: 'beispiel_status',
  //   beschreibung: 'Erscheint in /experten',
  //   ausfuehren: async ({ chatId, argument, dienste }) => ({ text: '…' })
  // }],
  // onDatei: async ({ chatId, themaId, buffer, dateiName, mimeType, beschriftung }) => {
  //   return null;   // null = normal weiterverarbeiten
  // }
};
