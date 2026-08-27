// Feste Kategorienliste, damit die Einordnung über Hunderte/Tausende Positionen konsistent
// bleibt. Wird sowohl von der KI-Klassifizierung (bot.js) als auch von der hübschen
// Excel-Ansicht (ansicht.js, für die Reihenfolge der Abschnitte) verwendet.
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
