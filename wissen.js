const fs = require('fs');
const path = require('path');

const REGELN_PATH = path.join(__dirname, 'data', 'regeln.txt');
const GRUPPEN_PATH = path.join(__dirname, 'data', 'artikelgruppen.txt');

function ladeDatei(pfad) {
  if (!fs.existsSync(pfad)) return '';
  return fs.readFileSync(pfad, 'utf-8').trim();
}

function speichereZeile(pfad, text) {
  fs.mkdirSync(path.dirname(pfad), { recursive: true });
  fs.appendFileSync(pfad, text.trim() + '\n');
}

module.exports = {
  REGELN_PATH,
  GRUPPEN_PATH,
  ladeRegeln: () => ladeDatei(REGELN_PATH),
  speichereRegel: (text) => speichereZeile(REGELN_PATH, text),
  ladeArtikelgruppen: () => ladeDatei(GRUPPEN_PATH),
  speichereArtikelgruppe: (text) => speichereZeile(GRUPPEN_PATH, text)
};
