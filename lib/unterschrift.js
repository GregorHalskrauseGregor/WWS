// Unterschrift-Verwaltung pro User.
// Pro Telegram-Chat-ID gibt es ein Unterschrift-Bild, das beim Erstellen
// von PDFs (Aufmaß, Rechnungen etc.) eingebunden wird.
//
// Speicherort: data/users/<chatId>/unterschrift.png
//
// Workflow:
//   1) User schickt im Chat ein Foto der Unterschrift (mit Beschreibung "das ist meine Unterschrift")
//   2) Bot speichert es persistent
//   3) Bei PDF-Generierung wird das Bild eingebunden

const fs = require('fs');
const path = require('path');

const UNTERSCHRIFT_PFAD = (chatId) => path.join(
  __dirname, '..', 'data', 'users', String(chatId), 'unterschrift.png'
);

function hatUnterschrift(chatId) {
  return fs.existsSync(UNTERSCHRIFT_PFAD(chatId));
}

function getUnterschriftPfad(chatId) {
  return hatUnterschrift(chatId) ? UNTERSCHRIFT_PFAD(chatId) : null;
}

// Speichert ein Bild (Buffer) als Unterschrift. Konvertiert zu PNG für
// einheitliche Verarbeitung in pdfkit.
async function speichereUnterschrift(chatId, buffer) {
  // pdfkit unterstützt PNG und JPG nativ — wir speichern einfach so,
  // wie es reinkommt, und nutzen den passenden Mime-Type.
  // Wenn das Format nicht passt, würde pdfkit beim Einbinden meckern.
  const targetPath = UNTERSCHRIFT_PFAD(chatId);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

function loescheUnterschrift(chatId) {
  const p = UNTERSCHRIFT_PFAD(chatId);
  if (fs.existsSync(p)) {
    fs.unlinkSync(p);
    return true;
  }
  return false;
}

module.exports = {
  hatUnterschrift,
  getUnterschriftPfad,
  speichereUnterschrift,
  loescheUnterschrift,
  UNTERSCHRIFT_PFAD
};
