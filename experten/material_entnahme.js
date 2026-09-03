// 🔧 Material-Entnahme / Verbrauch — Vorgangs-Experte.
// Reduziert den Bestand in material.xlsx, mit Bestandsschutz (nie negativ).

const material = require('../material');
const { PFADE } = require('../config');
const { POSITIONS_SCHEMA, HINWEISE_BASIS, HINWEIS_ZUSTAND } = require('../lib/lager_schema');

module.exports = {
  id: 'material_entnahme',
  name: 'Material-Entnahme',
  emoji: '🔧',
  beschreibung: 'Bucht entnommenes bzw. verbrauchtes Material aus dem Lagerbestand aus, mit Bestandsschutz.',

  zustaendigWenn:
    'Der Nutzer NIMMT Material aus dem Lager oder hat es verbraucht: Entnahme, ' +
    'Verbrauch, "verbaue", "mitgenommen", "aus dem Lager geholt", Materialausgabe. ' +
    'Der Bestand soll SINKEN. (Nicht zu verwechseln mit dem Aufmaß, das dokumentiert, ' +
    'was auf der Baustelle verbaut wurde, ohne den Lagerbestand zu ändern.)',

  implementiert: true,
  schema: POSITIONS_SCHEMA,
  extraktionsHinweise: HINWEISE_BASIS + HINWEIS_ZUSTAND,

  async finalisiere({ daten }, dienste) {
    const ergebnisse = await material.entnehmePositionen(daten.positionen, PFADE.MATERIAL_XLSX);
    if (ergebnisse.length === 0) {
      return { text: '🔧 Keine Position konnte entnommen werden — bitte Menge und Bezeichnung prüfen.' };
    }
    dienste.protokoll?.('Experte', `Entnahme: ${ergebnisse.length} Position(en) gebucht`);
    const zeilen = ergebnisse.map((r) => {
      if (r.unbekannt) {
        return `• ${r.bezeichnung}: ⚠️ nicht im Lager gefunden (${r.mengeAngefragt} angefragt)`;
      }
      const fehl = r.fehlend > 0
        ? `  ⚠️ ${r.fehlend} ${r.einheit || ''} fehlten im Bestand`
        : '';
      return `• ${r.bezeichnung}: ${r.vorher} → *${r.nachher}* ${r.einheit || ''}${fehl}`;
    });
    return { text: `🔧 *Entnommen:*\n${zeilen.join('\n')}` };
  }
};
