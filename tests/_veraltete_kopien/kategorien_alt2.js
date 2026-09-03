// Feste SHK-Kategorienliste.
// Wird von der KI zur Klassifizierung neuer Positionen genutzt und
// bestimmt die Reihenfolge der Kategorie-Abschnitte im "Lagerbestand"-Blatt.
//
// Die KI ordnet NEUE Positionen (z.B. aus Lieferschein-Import) einer
// dieser Kategorien zu. Kategorien aus Importen, die NICHT in dieser
// Liste stehen, werden trotzdem erkannt und alphabetisch ans Ende sortiert.

const KATEGORIEN = [
  'Rohre & Leitungen',
  'Fittinge & Verbindungstechnik',
  'Armaturen & Ventile',
  'Pumpen & Antriebe',
  'Wärmeerzeugung',
  'Heizkörper & Flächenheizung',
  'Sanitärobjekte',
  'Dämmung & Isolierung',
  'Befestigung & Montagematerial',
  'Elektro & Steuerungstechnik',
  'Werkzeug & Verbrauchsmaterial',
  'Sonstiges'
];

module.exports = { KATEGORIEN };
