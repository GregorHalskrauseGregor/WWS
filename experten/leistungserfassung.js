// STUB: Leistungserfassung-Experte
//
// Wird die Abrechnung erbrachter Leistungen erstellen. Beim SHK-Handwerker
// z.B. Rohre verlegt, Heizkörper angeschlossen, Bad installiert.
//
// Geplant:
// - Positionen mit Menge, Einheit, Einzelpreis, Gesamtpreis
// - Bezug auf Kunde / Auftrag / Bauvorhaben
// - Speicherung in data/users/<chatId>/leistungen/<YYYY-MM>/<nr>.json
// - Export als PDF / DOCX (über docx-Bibliothek)

module.exports = {
  id: 'leistungserfassung',
  name: 'Leistungserfassung',
  emoji: '🧾',
  description: 'Erstellt und verwaltet Abrechnungen für erbrachte Handwerker-Leistungen (Rohre verlegt, Heizkörper montiert, etc.). Noch nicht implementiert.',
  triggers: [
    'leistungserfassung', 'leistung', 'leistungen',
    'rechnung', 'rechnungen', 'rg', 'faktura', 'fakture',
    'abrechnung', 'abrechnen', 'abgerechnet',
    'verrechnen', 'verrechnung',
    'positionen', 'posten'
  ],
  systemPromptAdd: `LEISTUNGSERFASSUNG-MODUS (STUB).
Du erkennst, dass der Nutzer eine Leistungserfassung / Rechnung erstellen oder bearbeiten möchte. Dieser Experte ist noch nicht implementiert — antworte dem Nutzer ehrlich, dass dieser Bereich bald verfügbar sein wird, und frag, ob er stattdessen etwas anderes braucht (z.B. Recherche).`,
  tools: null,
  implementiert: false,

  verarbeite: async (input, kontext) => {
    return {
      antwort: '🧾 *Leistungserfassung* ist noch nicht implementiert.\n\nGeplant: Positionen erfassen (Menge × Einzelpreis), Kunde/Auftrag zuordnen, als PDF/DOCX exportieren.\n\nSag dem Bot-Besitzer, dass er diesen Experten als nächstes bauen soll — dann geht\'s los.',
      merkeHook: null
    };
  }
};
