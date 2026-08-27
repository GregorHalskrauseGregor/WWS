// Begrüßungs-/Anleitungstext, den der Bot bei /start schickt. Liegt als eigene Textdatei
// vor, damit der Nutzer sie im Nachgang frei bearbeiten kann. Wird nur einmal mit einem
// sinnvollen Standardtext angelegt, danach immer die aktuelle (ggf. bearbeitete) Version gelesen.

const fs = require('fs');
const path = require('path');

const BEGRUESSUNG_PATH = path.join(__dirname, 'data', 'begruessung.txt');

const STANDARD_BEGRUESSUNG = `👋 Willkommen beim Material-Bot von Horst Zienert GmbH!

Ich verwalte den Lagerbestand für dich. Schreib mir einfach ganz normal, oder schick eine Sprachnachricht.

📦 MATERIAL HINZUFÜGEN / ZURÜCKGEBEN
"3 Kugelhahn DN20 hinzufügen"
"Ich habe 5 Kugelhähne DN20 gebraucht zurückgebracht"

🔧 MATERIAL ENTNEHMEN (wird verbaut/verbraucht, Bestand sinkt)
"2 Kugelhahn DN20 entnehmen"

📋 MATERIALBEDARF PRÜFEN (verändert nichts, prüft nur)
"Ich brauche 8 Kugelhahn DN20 für einen Auftrag"

❓ BESTAND ABFRAGEN
"Wie viel Kupferrohr 22mm haben wir?"
"Zeig mir den kompletten Bestand"

🧠 REGELN UND ARTIKELGRUPPEN MERKEN
"Merke dir, dass alle Kugelhähne für Trinkwasser zugelassen sein müssen"
"Fasse alle Rotguss-Kugelhähne für Heizung als 'Kugelhahn Heizung Rotguss' zusammen"

📸 LIEFERSCHEIN / MATERIALLISTE EINLESEN
Schick mir ein Foto, ein PDF, eine Excel- oder Word-Datei – ich lese die Positionen automatisch aus und trage sie ein.

Befehle:
/excel – aktuelle Materialliste als Datei
/regeln – gemerkte Regeln anzeigen
/gruppen – gemerkte Artikelgruppen anzeigen
/protokoll – letzte Ereignisse/Fehler anzeigen
/start – diese Anleitung erneut anzeigen`;

function ladeBegruessung() {
  if (!fs.existsSync(BEGRUESSUNG_PATH)) {
    fs.mkdirSync(path.dirname(BEGRUESSUNG_PATH), { recursive: true });
    fs.writeFileSync(BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG);
  }
  return fs.readFileSync(BEGRUESSUNG_PATH, 'utf-8');
}

module.exports = { BEGRUESSUNG_PATH, ladeBegruessung };
