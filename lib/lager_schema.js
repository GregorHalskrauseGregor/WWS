// Gemeinsames Schema für alle Lager-Bewegungen (Rückgabe/Wareneingang und
// Entnahme/Verbrauch). Beide Experten erfassen dieselben Positionsdaten und
// unterscheiden sich nur darin, was am Ende mit material.xlsx passiert.
//
// Vorher lag diese Struktur zweimal fast identisch in material_rueckgabe.js
// und material_entnahme.js, inklusive zweier eigener JSON-Parser.

const { KATEGORIEN } = require('../kategorien');

const POSITIONS_SCHEMA = {
  positionen: {
    pflicht: true, typ: 'liste', min: 1, label: 'Positionen',
    felder: {
      menge: 'zahl',
      einheit: 'text',
      bezeichnung: 'text',
      zustand: 'text?',
      kategorie: 'text?',
      artikelnummer: 'text?'
    },
    beschreibung: 'Eine Zeile je Artikel',
    frage: 'Welches Material und wie viel? (z. B. „12 m Kupferrohr 22mm, 3 Wandscheiben DN20")'
  }
};

const HINWEISE_BASIS =
  '- Mengenmuster: "12m Kupferrohr", "3 Stück Wandscheibe DN20", "5x Fitting".\n' +
  '- Einheiten normalisieren: "Stück"/"stk" -> "Stk.", "lfm", "m", "kg".\n' +
  '- DN-Angaben beibehalten ("DN20", "DN 20" beides als "DN20" schreiben).\n' +
  '- kategorie aus dieser festen Liste wählen, sonst "Sonstiges":\n    ' +
  KATEGORIEN.join(', ') + '\n' +
  '- Bei Lieferscheinen/Tabellen: jede Artikelzeile ist eine Position.\n' +
  '- Typische Diktier- und OCR-Fehler still korrigieren.';

const HINWEIS_ZUSTAND =
  '\n- zustand ist eines von: "neu", "gebraucht", "verschmutzt". Ohne Angabe: "neu".';

module.exports = { POSITIONS_SCHEMA, HINWEISE_BASIS, HINWEIS_ZUSTAND };
