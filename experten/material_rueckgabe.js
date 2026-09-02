// STUB: Material-Rückgabe-Experte
//
// Monteur bringt Material zurück in die Firma (z.B. nach Auftragsende oder
// bei Falschlieferung). Dokumentation: was, wieviel, Zustand (neu/gebraucht/verschmutzt).

module.exports = {
  id: 'material_rueckgabe',
  name: 'Material-Rückgabe',
  emoji: '📦',
  description: 'Dokumentiert Material-Rückgaben (Monteur bringt Material zurück in die Firma). Noch nicht implementiert.',
  triggers: [
    'rückgabe', 'rueckgabe', 'zurückbringen', 'zurückgebracht',
    'retoure', 'falschlieferung', 'falsch geliefert',
    'zurück ins lager', 'wieder eingelagert',
    'bringe zurück', 'mitgebracht'
  ],
  systemPromptAdd: `MATERIAL-RÜCKGABE-MODUS (STUB).
Du erkennst, dass der Nutzer eine Materialrückgabe dokumentieren möchte (z.B. "5 Kugelhähne DN20 vom Auftrag zurück"). Dieser Experte ist noch nicht implementiert — antworte dem Nutzer ehrlich, dass dieser Bereich bald verfügbar sein wird.`,
  tools: null,
  implementiert: false,

  verarbeite: async (input, kontext) => {
    return {
      antwort: '📦 *Material-Rückgabe* ist noch nicht implementiert.\n\nGeplant: Material mit Menge, Zustand (neu/gebraucht/verschmutzt), Bezug zum Auftrag dokumentieren, Bestand im Lager aktualisieren.\n\nSag dem Bot-Besitzer, dass er diesen Experten als nächstes bauen soll.',
      merkeHook: null
    };
  }
};
