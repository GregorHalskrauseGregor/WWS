// STUB: Material-Entnahme-Experte
//
// Material wird tatsächlich verbraucht, verbaut oder mitgenommen für einen Auftrag.
// Bestand sinkt sofort. Vergleichbar mit dem alten Material-Excel-Bot-Verhalten.

module.exports = {
  id: 'material_entnahme',
  name: 'Material-Entnahme',
  emoji: '🔧',
  description: 'Dokumentiert Material-Entnahmen aus dem Lager (Material wird verbaut, verbraucht, mitgenommen). Noch nicht implementiert.',
  triggers: [
    'entnahme', 'entnehme', 'entnehmen', 'entnommen',
    'nehme', 'nehmen',
    'verbrauche', 'verbraucht', 'verbrauch',
    'verbaue', 'verbaut', 'verbau', 'verbaut',
    'hole material', 'nehme mit', 'mitgenommen', 'mitzunehmen',
    'bestand sinkt', 'abgang', 'aus dem lager'
  ],
  systemPromptAdd: `MATERIAL-ENTNAHME-MODUS (STUB).
Du erkennst, dass der Nutzer eine Materialentnahme dokumentieren möchte (z.B. "2 Wandscheiben für Auftrag Müller entnommen"). Dieser Experte ist noch nicht implementiert — antworte dem Nutzer ehrlich, dass dieser Bereich bald verfügbar sein wird.`,
  tools: null,
  implementiert: false,

  verarbeite: async (input, kontext) => {
    return {
      antwort: '🔧 *Material-Entnahme* ist noch nicht implementiert.\n\nGeplant: Material mit Menge aus dem Lager entnehmen, Bestand aktualisieren, Bezug zum Auftrag dokumentieren.\n\nSag dem Bot-Besitzer, dass er diesen Experten als nächstes bauen soll.',
      merkeHook: null
    };
  }
};
