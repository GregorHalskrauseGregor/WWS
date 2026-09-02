# KI-Chatbot (Telegram-Bot)

Telegram-Bot, der wie ein normaler Chatbot funktioniert. Du kannst Text, Sprachmemos, Fotos, PDFs, Excel- und Word-Dateien schicken — alles wird zu Text verarbeitet und an eine KI-API weitergeleitet, die dir antwortet.

Du kannst beliebig viele Themen parallel laufen lassen. Der Bot erkennt automatisch, ob deine Nachricht zu einem bestehenden Thema gehört oder ein neues eröffnet. Ältere Verläufe werden zu Zusammenfassungen komprimiert, damit die KI pro Anfrage nur den Kontext bekommt, den sie wirklich braucht.

## Telegram-Bot anlegen

1. In Telegram den Bot **@BotFather** öffnen
2. `/newbot` senden, Namen vergeben
3. Du bekommst einen **Token** (lange Zeichenkette) — dieser kommt in die `.env`

## Lokal einrichten

1. Terminal in diesem Ordner öffnen
2. Abhängigkeiten installieren:
   ```
   npm install
   ```
3. `.env.example` zu `.env` kopieren:
   ```
   cp .env.example .env
   ```
4. In `.env` eintragen:
   - `TELEGRAM_BOT_TOKEN` (von BotFather)
   - `AI_PROVIDER` (anthropic, openai oder minimax)
   - den passenden API-Key für den gewählten Anbieter
5. Bot starten:
   ```
   npm start
   ```
6. In Telegram den Bot öffnen und lostippen.

## Eingaben

| Eingabe | Vorverarbeitung | API |
|---|---|---|
| Text | — | direkt zur KI |
| Sprachmemo | AssemblyAI (EU) | Transkript → KI |
| Foto / Screenshot | Mistral OCR | OCR → KI |
| PDF | Mistral OCR | OCR → KI |
| .xlsx | ExcelJS | Tabellen → Text → KI |
| .docx | mammoth | Word → Text → KI |

## KI-Anbieter

- **Anthropic** (Claude Sonnet 4) — Standard
- **OpenAI** (gpt-4o / gpt-4o-mini)
- **MiniMax** (M2 / M2-mini)

Wechsel = nur `AI_PROVIDER` in der `.env` ändern, kein Code-Umbau.

## Themen & Kontext

Jede Unterhaltung läuft in einem „Thema". Du kannst beliebig viele parallel haben. Der Bot ordnet deine Nachrichten anhand der Themen-Namen + 1-Satz-Beschreibung zu — du musst dich nicht aktiv durch Menüs klicken.

Pro Thema wird der Verlauf dauerhaft gespeichert (JSON-Datei pro Thema). Ab einer gewissen Länge werden die ältesten Nachrichten per KI zu einer **rollenden Zusammenfassung** verdichtet. Im Kontext für die KI landen dann:

```
[Systemrolle + Langzeit-Gedächtnis]
   +
[Zusammenfassung des aktiven Themas, falls vorhanden]
   +
[Die letzten ~20 Nachrichten des Themas]
   +
[Deine aktuelle Nachricht]
```

Volltext-Verläufe anderer Themen werden **nicht** mitgeschickt — sie liegen auf der Festplatte und sind nur über `/thema <Name>` abrufbar.

## Langzeit-Gedächtnis

Pro User (Telegram-Chat) eine eigene Datei mit Fakten, die **immer** im System-Prompt mitgeschickt werden. Drei Wege, etwas reinzuschreiben:

- Du schreibst: `merke dir: ich heiße Max, wohne in Berlin`
- Die KI hängt an ihre Antwort eine Zeile `[MERKE: <fakt>]` an — die wird automatisch rausgefiltert, bevor du sie siehst, und gespeichert.
- Du editierst die Datei `data/users/<chatId>/gedaechtnis.txt` direkt.

Befehle: `/gedaechtnis`, `/merke <Text>`, `/vergiss <Nr>`.

Wenn das Gedächtnis zu lang wird (> 6000 Zeichen), wird es beim nächsten Lauf automatisch per KI komprimiert (alte/duplizierte Fakten raus, wichtige bleiben).

## Light-Provider (optional, spart Kosten)

Standard: alle Aufgaben laufen über dasselbe Modell. Optional kannst du ein zweites, kleines Modell für die Hintergrund-Aufgaben konfigurieren:

```
AI_PROVIDER_LIGHT=openai
OPENAI_MODEL_LIGHT=gpt-4o-mini
```

Dann laufen Themen-Klassifikation und Komprimierung über das Light-Modell, nur die Antwort-Generierung über das starke Hauptmodell. Spart bei vielen aktiven Usern spürbar Kosten, ohne dass die Antwort-Qualität leidet.

## Multi-User

Jeder Telegram-Chat bekommt eigene Themen, eigenes Gedächtnis, eigene Verläufe. Daten liegen unter `data/users/<chatId>/…`. User sehen sich gegenseitig nicht.

## Befehle

| Befehl | Funktion |
|---|---|
| `/start` | Anleitung |
| `/themen` | Liste aller Themen |
| `/thema <Name>` | Voller Verlauf eines Themas |
| `/neu <Titel>` | Neues Thema starten |
| `/umbenennen <alt> <neu>` | Thema umbenennen |
| `/loeschen <Name>` | Thema löschen |
| `/zusammenfassung [Name]` | Aktuelle KI-Zusammenfassung |
| `/gedaechtnis` | Alle gemerkten Fakten |
| `/merke <Text>` | Fakt manuell hinzufügen |
| `/vergiss <Nr>` | Fakt entfernen |
| `/komprimieren` | Verläufe/Gedächtnis manuell verdichten |
| `/user` | Eigene Chat-ID, Statistik |
| `/protokoll` | Letzte Fehler/Ereignisse |

## Datenstruktur

```
data/
  begruessung.txt         editierbarer /start-Text
  protokoll.txt           letzte 200 Ereignisse/Fehler
  users/
    <chatId>/
      gedaechtnis.txt     Langzeit-Fakten dieses Users
      themen-index.json   Liste der Themen (Metadaten)
      themen/
        <themaId>.json    Volle Historie + Rollzusammenfassung
```

## Struktur

- `bot.js` — Telegram-Einstieg, Orchestrierung
- `themen.js` — Themen-Verwaltung, Multi-User-Isolation
- `gedaechtnis.js` — Langzeit-Fakten
- `kompressor.js` — Rollende Zusammenfassungen
- `kontext.js` — Minimaler API-Kontext (System-Prompt, Themen-Klassifikation)
- `transcribe.js` — AssemblyAI für Sprachnachrichten
- `ocr.js` — Mistral OCR für Bilder/PDFs
- `dokument.js` — Excel-/Word-Auslese
- `protokoll.js` — Ereignisprotokoll
- `begruessung.js` — Start-Anleitung (editierbar)
- `providers/` — Anthropic, OpenAI, MiniMax

## Deployment (Railway)

Wird ergänzt, sobald das lokale Testen läuft.
