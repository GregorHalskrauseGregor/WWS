// SHK-Kategorien — die oberste Ebene des Warengruppen-Baums.
//
// Frueher stand die Liste hier fest im Code, waehrend wissen/warengruppen.yaml
// dieselben Kategorien nochmal fuehrte. Zwei Listen fuer dieselbe Sache laufen
// zwangslaeufig auseinander, deshalb ist der Baum jetzt die einzige Quelle.
//
// Die Reihenfolge bestimmt die Abschnitte in der Lagerliste.

const wissen = require('./lib/wissen');

let _kategorien = null;
function laden() {
  if (_kategorien) return _kategorien;
  try {
    const aus = wissen.oberkategorien();
    _kategorien = aus.length ? aus : ['Sonstiges'];
  } catch (err) {
    console.warn('Warengruppen nicht lesbar, nutze Notliste: ' + err.message);
    _kategorien = ['Sonstiges'];
  }
  return _kategorien;
}

module.exports = {
  get KATEGORIEN() { return laden(); },
  neuLaden() { _kategorien = null; wissen.neuLaden(); return laden(); }
};
