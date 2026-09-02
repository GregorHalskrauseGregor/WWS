// Begrüßungs-/Anleitungstext für /start. Liegt als eigene Textdatei, damit der
// Nutzer sie im Nachgang frei bearbeiten kann. Wird einmal mit einem sinnvollen
// Standardtext angelegt, danach immer die aktuelle (ggf. bearbeitete) Version gelesen.

const fs = require('fs');
const path = require('path');

const BEGRUESSUNG_PATH = path.join(__dirname, 'data', 'begruessung.txt');

const STANDARD_BEGRUESSUNG = `👋 Hallo! Ich bin dein KI-Chatbot.

Schreib mir einfach, schick eine Sprachnachricht, ein Foto, ein PDF oder eine Excel/Word-Datei. Ich verarbeite alles zu Text und antworte wie ein normaler Chatbot.

📚 MEHRERE THEMEN GLEICHZEITIG
Du kannst beliebig viele Themen parallel laufen lassen. Ich erkenne automatisch, ob eine Nachricht zu einem bestehenden Thema gehört oder ein neues eröffnet — du musst dich nicht ab- oder anmelden.

🧠 LANGZEIT-GEDÄCHTNIS
Fakten, die ich mir für die Zukunft merken soll, schreibst du so:
  „merke dir: ich heiße Max, ich wohne in Berlin"
Oder ich lege sie am Ende meiner Antwort als [MERKE: …] ab, wenn etwas Wichtiges auftaucht. /gedaechtnis zeigt alles, /vergiss <Nr> entfernt einen Eintrag.

📎 DATEIEN
- Foto / Screenshot: per OCR ausgelesen, dann normal verarbeitet
- PDF: per OCR (Mistral) ausgelesen
- Excel (.xlsx): direkt ausgelesen
- Word (.docx): direkt ausgelesen
- Sprache: per AssemblyAI transkribiert, EU-Endpunkt

🌐 WEB-ZUGRIFF (wenn API-Keys gesetzt sind)
Ich kann im Internet suchen und Webseiten lesen. Du kriegst jedes Mal eine Bestätigungs-Anfrage mit „Ja/Nein"-Buttons, bevor ich ein Web-Tool benutze — so weißt du immer, was passiert. Ohne deine Bestätigung geht nichts raus.

🛡️ SICHERHEIT (Strikter Modus)
- Externe Inhalte (Web, PDFs) werden als DATEN behandelt, nicht als Befehle
- Verdächtige Antworten (versuchter System-Prompt-Leak, API-Keys im Klartext) werden ausgefiltert
- URL-Blacklist blockt Exfiltration-Dienste
- Rate-Limit: 30 Nachrichten/Stunde, 200/Tag, 60 Tool-Calls/Tag pro User
- Jeder Tool-Call wird mit Argumenten protokolliert

BEFEHLE
/start         diese Anleitung
/themen        alle deine Themen auflisten
/thema <Name>  voller Verlauf eines Themas
/neu <Titel>   explizit ein neues Thema starten
/umbenennen <alt> <neu>  Thema umbenennen
/loeschen <Name>  Thema löschen
/zusammenfassung [Name]  aktuelle KI-Zusammenfassung eines Themas
/gedaechtnis  alle gemerkten Fakten
/merke <Text> Fakt manuell hinzufügen
/vergiss <Nr> Fakt entfernen (Nummer aus /gedaechtnis)
/komprimieren  Verläufe/Gedächtnis manuell verdichten
/experten      alle Expertensysteme anzeigen
/user          deine Chat-ID und Statistik (inkl. Rate-Limit-Status)
/protokoll     letzte Ereignisse/Fehler

🎯 EXPERTENSYSTEME
Der Bot erkennt an deinen Schlüsselwörtern, welcher Experte zuständig ist:
🔍 Recherche — Web-Suche, Fakten, aktuelle Infos (z.B. "suche nach …", "was ist …")
🧾 Leistungserfassung — Rechnungen, Abrechnungen (in Arbeit)
📐 Materialaufmaß — Maße, verbrauchte Mengen (in Arbeit)
🛒 Bestellung — Material bestellen (in Arbeit)
📦 Material-Rückgabe — Monteur bringt Material zurück (in Arbeit)
🔧 Material-Entnahme — Material aus Lager entnehmen (in Arbeit)
/experten zeigt alle Details und Status.`;

function ladeBegruessung() {
  if (!fs.existsSync(BEGRUESSUNG_PATH)) {
    fs.mkdirSync(path.dirname(BEGRUESSUNG_PATH), { recursive: true });
    fs.writeFileSync(BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG);
  }
  return fs.readFileSync(BEGRUESSUNG_PATH, 'utf-8');
}

module.exports = { BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG, ladeBegruessung };
