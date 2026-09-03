// 📦 Material-Rückgabe / Wareneingang — Vorgangs-Experte.
// Erhöht den Bestand in material.xlsx, getrennt nach Zustand.

const material = require('../material');
const { PFADE } = require('../config');
const { POSITIONS_SCHEMA, HINWEISE_BASIS, HINWEIS_ZUSTAND } = require('../lib/lager_schema');

module.exports = {
  id: 'material_rueckgabe',
  name: 'Material-Rückgabe',
  emoji: '📦',
  beschreibung: 'Bucht zurückgegebenes oder angeliefertes Material in den Lagerbestand ein (Menge, Zustand, Bezeichnung).',

  zustaendigWenn:
    'Der Nutzer bringt Material ZURÜCK ins Lager oder es kommt NEU an: Rückgabe, ' +
    'Wareneingang, Anlieferung, Lieferschein einbuchen, Restmaterial abgeben, ' +
    '"übrig geblieben", "wieder eingelagert". Der Bestand soll STEIGEN.',

  implementiert: true,
  schema: POSITIONS_SCHEMA,
  extraktionsHinweise: HINWEISE_BASIS + HINWEIS_ZUSTAND,

  async finalisiere({ daten }, dienste) {
    const ergebnisse = await material.addierePositionen(daten.positionen, PFADE.MATERIAL_XLSX);
    if (ergebnisse.length === 0) {
      return { text: '📦 Keine Position konnte gebucht werden — bitte Menge und Bezeichnung prüfen.' };
    }
    dienste.protokoll?.('Experte', `Wareneingang: ${ergebnisse.length} Position(en) gebucht`);
    const zeilen = ergebnisse.map((r) =>
      `• ${r.bezeichnung} (${r.zustand}): ${r.vorher} → *${r.nachher}* ${r.einheit || ''}` +
      (r.neu ? ' _neu angelegt_' : ''));
    return { text: `📦 *Eingebucht:*\n${zeilen.join('\n')}` };
  }
};
