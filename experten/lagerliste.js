// 📄 Lagerliste — freier Experte: schickt den Bestand als aufbereitete Excel.
//
// Bewusst ohne KI-Aufruf und ohne Bestätigungsschritt: es gibt nichts zu
// extrahieren und nichts zu bestätigen, die Aktion ändert keinen Bestand.
// Der Router leitet hierher, den Rest macht Code.

const path = require('path');
const material = require('../material');
const exportModul = require('../lib/lager_export');
const { PFADE } = require('../config');

async function baueListe(chatId, text) {
  // Reservierungen nur auf ausdrücklichen Wunsch — sonst wandert eine interne
  // Spalte in eine Datei, die weitergegeben wird.
  const mitReservierungen = /reserv/i.test(String(text || ''));

  let positionen;
  try {
    positionen = await material.leseAlle(PFADE.MATERIAL_XLSX);
  } catch (err) {
    return { text: '📄 ' + err.message };
  }

  const ordner = path.join(PFADE.user(chatId), 'exporte');
  const datei = path.join(ordner, `Lagerbestand_${exportModul.datumStempel()}.xlsx`);
  await exportModul.erzeuge(datei, positionen, { mitReservierungen });

  const leer = positionen.filter((p) => material.gesamtbestand(p) === 0).length;
  return {
    text: `📄 Lagerbestand als Excel — ${positionen.length} Position${positionen.length === 1 ? '' : 'en'}` +
      (leer ? `, davon ${leer} derzeit nicht vorrätig` : '') +
      (mitReservierungen ? '\n_Mit Reservierungsspalte._' : ''),
    dateien: [datei]
  };
}

module.exports = {
  id: 'lagerliste',
  name: 'Lagerliste',
  emoji: '📄',
  beschreibung: 'Schickt den kompletten Lagerbestand als aufbereitete Excel-Datei, nach Kategorien gegliedert.',

  zustaendigWenn:
    'Der Nutzer will den Lagerbestand als DATEI oder LISTE bekommen: "schick mir die Lagerliste", ' +
    '"Bestandsliste als Excel", "exportier das Lager", "gib mir eine Übersicht als Tabelle". ' +
    'NICHT gemeint: eine einzelne Bestandsfrage wie "wie viel DN70 haben wir" (das ist Lagerauskunft) ' +
    'und keine Buchung.',

  implementiert: true,

  commands: [{
    name: 'lagerliste',
    beschreibung: 'Lagerbestand als Excel-Datei',
    ausfuehren: async ({ chatId, argument }) => baueListe(chatId, argument || '')
  }],

  async verarbeite({ chatId, text }, dienste) {
    dienste.protokoll?.('Experte', `Lagerliste exportiert (${chatId})`);
    return baueListe(chatId, text);
  }
};
