// Begrüßungs-/Anleitungstext für /start. Liegt als eigene Textdatei (data/begruessung.txt),
// damit der Nutzer sie im Nachgang frei bearbeiten kann. Beim ersten Start wird die
// Standard-Definition hier angelegt; danach wird immer die (ggf. editierte) Datei gelesen.

const fs = require('fs');
const path = require('path');

const BEGRUESSUNG_PATH = path.join(__dirname, 'data', 'begruessung.txt');

const STANDARD_BEGRUESSUNG = `👋 Hallo! Ich bin dein KI-Chatbot — ein Telegram-Bot mit Gedächtnis, Themenverwaltung und einem Plugin-System aus Expertensystemen für deinen Handwerker-Alltag.

🎯 WAS ICH KANN
— Beliebige Fragen beantworten (Konversation, Beratung, Erklärungen)
— Themen dauerhaft speichern: du kannst beliebig viele Themen parallel laufen lassen
— Sprachnachrichten, Fotos, PDFs, Excel- und Word-Dateien schicken — alles wird verarbeitet
— Im Netz suchen und Webseiten lesen (über die Brave Search API, EU-konform)
— PDFs erstellen — z.B. Materialaufmaße mit deinem eigenen Vorlagen-Layout
— Langzeit-Fakten merken, die du mir über dich erzählst

🧠 MEHRERE THEMEN GLEICHZEITIG
Du kannst beliebig viele Themen parallel laufen lassen. Ich erkenne automatisch, ob eine Nachricht zu einem bestehenden Thema gehört oder ein neues eröffnet — du musst dich nicht ab- oder anmelden. Lange Verläufe werden im Hintergrund zu Zusammenfassungen komprimiert.

📎 DATEIEN & EINGABEN
— Foto / Screenshot → per Mistral OCR ausgelesen
— PDF → per Mistral OCR (rendert auch JS-lastige Seiten)
— .xlsx → direkt ausgelesen via ExcelJS
— .docx → direkt ausgelesen via Mammoth
— Sprachnachricht → per AssemblyAI transkribiert (EU-Endpunkt, deutsch)
— beliebige URL → per Jina Reader geladen und zusammengefasst

🛡️ SICHERHEIT (Strikter Modus)
— Externe Inhalte (Web, PDFs) werden als DATEN behandelt, nicht als Befehle
— Verdächtige Antworten (versuchter System-Prompt-Leak, API-Keys im Klartext) werden ausgefiltert
— URL-Blacklist blockt Exfiltration-Dienste (webhook.site, ngrok, pastebin etc.)
— Rate-Limit: 30 Nachrichten/Stunde, 200/Tag, 60 Tool-Calls/Tag pro User
— Jeder Web-Tool-Aufruf muss explizit per Inline-Button bestätigt werden
— Jeder Tool-Call wird mit Argumenten protokolliert
— Multi-User-Isolation: deine Daten sind komplett getrennt von anderen Usern

🎯 EXPERTENSYSTEME
Ich erkenne an deinen Schlüsselwörtern, welcher Experte für deine Nachricht zuständig ist:

🔍 Recherche — Web-Suche, Fakten, aktuelle Infos (z.B. „suche nach …", „was ist …") — voll funktional
📐 Materialaufmaß — diktierte Positionen werden gesammelt, PDF mit Mustervorlage + Style-Sheet + Unterschrift wird generiert und zurückgeschickt — voll funktional
🧾 Leistungserfassung — Rechnungen, Abrechnungen — in Arbeit (Stub)
🛒 Bestellung — Material bestellen — in Arbeit (Stub)
📦 Material-Rückgabe — Monteur bringt Material zurück — in Arbeit (Stub)
🔧 Material-Entnahme — Material aus Lager entnehmen — in Arbeit (Stub)

/experten zeigt alle Details, Status und Trigger-Wörter.

BEFEHLE
/start              diese Anleitung
/experten           alle Expertensysteme anzeigen
/themen             alle Themen auflisten
/thema <Name>       voller Verlauf eines Themas
/neu <Titel>        explizit ein neues Thema starten
/umbenennen <alt> <neu>   Thema umbenennen
/loeschen <Name>    Thema löschen
/zusammenfassung [Name]   aktuelle KI-Zusammenfassung
/gedaechtnis        alle gemerkten Fakten
/merke <Text>       Fakt manuell hinzufügen
/vergiss <Nr>       Fakt entfernen (Nummer aus /gedaechtnis)
/komprimieren       Verläufe/Gedächtnis manuell verdichten
/wer-bin-ich        Profil + erster/letzter Kontakt
/delete-my-data     alle eigenen Daten löschen (Themen, Gedächtnis, Profil, Rate-Counter)
/user               Chat-ID, Statistik, Rate-Limit-Status, Pfad zum Datenordner
/protokoll          letzte Ereignisse/Fehler
/reset_aufnahme     Materialaufmaß-Session zurücksetzen (falls sie hängt)

📐 MATERIALAUFMASS IM DETAIL
Workflow (alles in einer Nachricht, kein Schritt-für-Schritt-Gefragt):
   „Materialaufmaß PRJ-2026-001, Badsanierung Müller, 12m Kupferrohr 22mm, 3 Wandscheiben DN20 Art-Nr WS-12345"
   → Ich extrahiere alles, frage nur nach wenn was fehlt, und generiere das PDF.

Voraussetzungen im data/-Baum:
   — data/aufnahme_vorlage/   Muster-PDF (z.B. Aufmass_Zienert_ausfuellbar.pdf mit AcroForm-Feldern)
   — data/style_sheet/         optional, Formatierungs-Wünsche (PDF/TXT/MD)
   — data/users/<chatId>/unterschrift.png  einmalig per Foto hochladen, mit Caption "Hier ist meine Unterschrift"

Anpassungen im Chat:
   — „ändere Position 2 auf 5"
   — „Position 3 raus"
   — „Bezeichnung war Heizung, nicht Sanitär"
   — „füge 2m Kupferrohr hinzu"

Abbrechen jederzeit mit „stop", „abbrechen" oder „reset".

💡 TIPPS
— Schick Sprachnachrichten wie beim Diktieren — ich verstehe sie
— Schick Fotos mit Caption "Hier ist meine Unterschrift" → wird gespeichert und in künftige PDFs eingebunden
— Schreib „merke dir: …" für Fakten, die ich dauerhaft behalten soll
— Bei langen Gesprächen fasst der Bot alte Messages automatisch zu Zusammenfassungen zusammen, damit ich nicht den Überblick verliere

📁 DEINE DATEN
Alles liegt unter data/users/<deine-chat-id>/, z.B. data/users/12345/
   user.json          Profil
   gedaechtnis.txt    Langzeit-Fakten
   themen-index.json  Themen-Übersicht
   rate.json          Rate-Limit-Zähler
   begruessung.txt    deine persönliche /start-Antwort (überschreibbar)
   unterschrift.png   gespeicherte Unterschrift
   aufnahme_session.json  laufende Materialaufmaß-Erfassung
   themen/            volle Themen-Historien
   aufnahmen/         generierte Aufmaß-PDFs

User-Daten löschen = den ganzen Ordner data/users/<deine-chat-id>/ löschen
(oder /delete-my-data schicken).`;

function ladeBegruessung() {
  if (!fs.existsSync(BEGRUESSUNG_PATH)) {
    fs.mkdirSync(path.dirname(BEGRUESSUNG_PATH), { recursive: true });
    fs.writeFileSync(BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG);
  }
  return fs.readFileSync(BEGRUESSUNG_PATH, 'utf-8');
}

module.exports = { BEGRUESSUNG_PATH, STANDARD_BEGRUESSUNG, ladeBegruessung };
