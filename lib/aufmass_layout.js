// Das Layout des Zienert-Aufmaßformulars — einmal, als Zahlen.
//
// WOHER DIE ZAHLEN KOMMEN: nicht geschätzt, sondern gemessen. Der Vordruck ist
// ein 300-dpi-Bild (kein Vektor), also wurde er gerendert und das Raster über
// die dunklen Pixelreihen und -spalten gefunden. Wer das nachrechnen will:
// tools/vermesse_vordruck.js macht genau das und gibt diese Tabelle aus.
//
// WARUM ZENTRAL: vorher steckten die Positionen in den 231 Feldern des
// Vorlagen-PDFs — unsichtbar, unprüfbar und nur mit Acrobat zu ändern. Zwei
// Fehler waren so hineingeraten und fielen erst auf, als die blauen Kästen weg
// waren: die Kopffelder lagen über ihren eigenen Beschriftungen, und es gab
// eine Tabellenzeile mehr als der Vordruck hat — die erste saß auf der
// Spaltenüberschrift.
//
// Koordinaten sind PDF-Punkte, Nullpunkt unten links.

const SEITE = { breite: 595.276, hoehe: 841.89 };

// Die Tabelle: senkrechte Trennlinien, gemessen von links.
const SPALTEN_X = [57.01, 112.69, 140.66, 169.46, 287.92, 453.42, 506.70, 576.55];

const SPALTEN = [
  { feld: 'pos',         titel: 'Pos.',        von: 0, ausrichtung: 'links' },
  { feld: 'menge',       titel: 'Menge',       von: 1, ausrichtung: 'rechts' },
  { feld: 'me',          titel: 'ME',          von: 2, ausrichtung: 'links' },
  { feld: 'artikelnr',   titel: 'Art.-Nr.',    von: 3, ausrichtung: 'links' },
  { feld: 'bezeichnung', titel: 'Bezeichnung', von: 4, ausrichtung: 'links' },
  { feld: 'ep',          titel: 'EP',          von: 5, ausrichtung: 'rechts' },
  { feld: 'gp',          titel: 'GP',          von: 6, ausrichtung: 'rechts' }
];

const TABELLE = {
  oben: 731.37,          // obere Rahmenlinie
  kopfzeileBis: 712.17,  // Unterkante der Spaltenüberschriften
  unten: 96.49,          // untere Rahmenlinie
  zeilenHoehe: 19.86,
  zeilen: 31             // gemessen, nicht geraten — die Vorlage hatte 32 Felder
};

// Kopf- und Fußfelder. "linie" ist die gedruckte Linie, auf der der Wert sitzt;
// das Feld wird knapp darüber gesetzt, damit die Schrift nicht auf der Linie
// klebt und die Beschriftung links davon frei bleibt.
const KOPF = {
  seite:       { x: 283.0, bis: 327.0, linie: 805.3 },
  seite_von:   { x: 349.0, bis: 392.0, linie: 805.3 },
  projekt_nr:  { x: 100.0, bis: 392.0, linie: 777.2 },
  bauvorhaben: { x: 111.0, bis: 392.0, linie: 748.9 }
};

const FUSS = {
  linie: 39.12,
  datum: { x: 85.0, bis: 172.0 },
  // KEINE Felder für die Unterschriften: dort wird ein Bild eingesetzt.
  // Ein Formularfeld an dieser Stelle würde das Bild überdecken und ließe
  // sich außerdem nachträglich beschreiben — bei einer Unterschrift ist das
  // genau das, was nicht passieren darf.
  unterschrift_kunde:   { x: 246.0, bis: 371.0, hoehe: 34 },
  unterschrift_monteur: { x: 452.0, bis: 577.0, hoehe: 34 }
};

const SCHRIFT = { normal: 9, klein: 8, feldHoehe: 14.5, innenAbstand: 2.5 };

// Die Zeile n (1-basiert) auf einer Seite: Ober- und Unterkante.
function zeileOben(n) {
  return TABELLE.kopfzeileBis - (n - 1) * TABELLE.zeilenHoehe;
}
function zeileUnten(n) {
  return zeileOben(n) - TABELLE.zeilenHoehe;
}

// Das Rechteck einer Zelle: { x, y, breite, hoehe } für ein Formularfeld.
function zelle(spaltenFeld, zeilenNr) {
  const s = SPALTEN.find((c) => c.feld === spaltenFeld);
  if (!s) throw new Error(`Unbekannte Spalte: ${spaltenFeld}`);
  const x1 = SPALTEN_X[s.von] + SCHRIFT.innenAbstand;
  const x2 = SPALTEN_X[s.von + 1] - SCHRIFT.innenAbstand;
  return {
    x: x1,
    y: zeileUnten(zeilenNr) + SCHRIFT.innenAbstand,
    breite: x2 - x1,
    hoehe: SCHRIFT.feldHoehe
  };
}

// Wie viele Seiten braucht diese Anzahl Positionen? Mindestens eine — ein
// Aufmaß ohne Positionen ist trotzdem ein Blatt mit Kopf und Unterschrift.
function seitenAnzahl(anzahlPositionen) {
  return Math.max(1, Math.ceil((anzahlPositionen || 0) / TABELLE.zeilen));
}

module.exports = {
  SEITE, SPALTEN, SPALTEN_X, TABELLE, KOPF, FUSS, SCHRIFT,
  zeileOben, zeileUnten, zelle, seitenAnzahl
};
