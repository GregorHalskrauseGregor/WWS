// STUB: Bestellung-Experte
//
// Wird Bestelllisten für Material erstellen, mit Lieferant, Preis, Liefertermin.
// Optional: Schnittstelle zu Großhändler-APIs (z.B. SHK-Grosshandel, Conrad, etc.)

module.exports = {
  id: 'bestellung',
  name: 'Bestellung',
  emoji: '🛒',
  description: 'Erstellt Material-Bestellungen mit Lieferant, Mengen, Preisen und Liefertermin. Noch nicht implementiert.',
  triggers: [
    'bestellung', 'bestell', 'bestelle', 'bestell mal', 'bestellung aufgeben',
    'order', 'einkauf', 'einkaufen',
    'brauche', 'wir brauchen', 'ich brauche',
    'nachbestellen', 'nachbestellung',
    'lieferant', 'grosshandel', 'großhandel'
  ],
  systemPromptAdd: `BESTELLUNG-MODUS (STUB).
Du erkennst, dass der Nutzer eine Materialbestellung erstellen möchte. Dieser Experte ist noch nicht implementiert — antworte dem Nutzer ehrlich, dass dieser Bereich bald verfügbar sein wird.`,
  tools: null,
  implementiert: false,

  verarbeite: async (input, kontext) => {
    return {
      antwort: '🛒 *Bestellung* ist noch nicht implementiert.\n\nGeplant: Bestellliste mit Lieferant, Artikeln, Mengen, Preisen, Liefertermin — optional mit Anbindung an Großhändler-APIs.\n\nSag dem Bot-Besitzer, dass er diesen Experten als nächstes bauen soll.',
      merkeHook: null
    };
  }
};
