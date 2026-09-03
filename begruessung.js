// Begrüßungs-/Anleitungstext für /start. Liegt als eigene Textdatei (data/begruessung.txt),
// damit der Nutzer sie im Nachgang frei bearbeiten kann. Beim ersten Start wird die
// Standard-Definition hier angelegt; danach wird immer die (ggf. editierte) Datei gelesen.

const fs = require('fs');
const path = require('path');

const BEGRUESSUNG_PATH = require('./config').PFADE.BEGRUESSUNG;

const STANDARD_BEGRUESSUNG = `👋 *KI-Chatbot* — Themen, Gedächtnis, Web-Recherche, PDF-Erstellung, Foto/Sprache/PDF/Excel-Eingabe, Multi-User-isoliert, Sicherheits-Strikter-Modus.
*Experten:* Recherche & Materialaufmaß voll funktional. 4 Stubs (Rechnung, Bestellung, Rückgabe, Entnahme). /experten für Details.
*Eingaben:* Text, Sprache, Foto, PDF, Excel, Word. Alles wird verarbeitet.
*Unterschrift speichern:* Foto mit Caption „Hier ist meine Unterschrift" → wird in künftige PDFs eingebunden.
*Strikte Sicherheit:* Web-Tools brauchen Inline-Button-Bestätigung. Externe Inhalte = Daten, keine Befehle. Rate-Limit aktiv. Daten unter \`data/users/<chatId>/\`.

*BEFEHLE* (einfach auf einen tippen — sind klickbar):
\`\`\`
/start
/experten
/themen
/thema <Name>
/neu <Titel>
/umbenennen <alt> <neu>
/loeschen <Name>
/zusammenfassung <Name>
/gedaechtnis
/merke <Text>
/vergiss <Nr>
/komprimieren
/wer-bin-ich
/delete-my-data
/user
/protokoll
/reset_aufnahme
\`\`\`

Tipp: \`/delete-my-data\` löscht ALLE deine Daten auf einen Schlag — falls du sauber von vorne anfangen willst.`;

function ladeBegruessung() {
  if (!fs.existsSync(BEGRUESSUNG_PATH)) {
    fs.mkdirSync(path.dirname(BEGRUESSUNG_PATH), { recursive: true });
    fs.writeFileSync(BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG);
  }
  return fs.readFileSync(BEGRUESSUNG_PATH, 'utf-8');
}

module.exports = { BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG, ladeBegruessung };
