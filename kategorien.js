// SHK-Kategorien — die oberste Ebene des Warengruppen-Baums.
//
// Frueher stand die Liste hier fest im Code, waehrend die Wissensbasis dieselben
// Kategorien nochmal fuehrte. Zwei Listen fuer dieselbe Sache laufen zwangslaeufig
// auseinander, deshalb ist die Warengruppenkarte die einzige Quelle: ihre
// "##"-Ueberschriften SIND die Kategoriespalte der Lagerdatei.
//
// Das ist die einzige Stelle, an der Wissen noch deterministisch ausgewertet
// wird — und zwar mit Absicht. Die Kategoriespalte braucht ein festes
// Vokabular, sonst schreibt jede Buchung eine neue Schreibweise in die Excel.
//
// Die Reihenfolge bestimmt die Abschnitte in der Lagerliste.

const wissen = require('./lib/wissen');

let _kategorien = null;
function laden() {
  if (_kategorien) return _kategorien;
  try {
    const aus = wissen.kategorien();
    _kategorien = aus.length ? aus : ['Sonstiges'];
  } catch (err) {
    console.warn('Warengruppenkarte nicht lesbar, nutze Notliste: ' + err.message);
    _kategorien = ['Sonstiges'];
  }
  return _kategorien;
}

module.exports = {
  get KATEGORIEN() { return laden(); },
  neuLaden() { _kategorien = null; wissen.neuLaden(); return laden(); }
};
