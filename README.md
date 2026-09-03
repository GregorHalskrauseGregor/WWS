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

- **Anthropic** (Claude Sonnet 4) — Standard wenn `AI_PROVIDER=anthropic`
- **OpenAI** (gpt-4o / gpt-4o-mini)
- **MiniMax** (M2 / M2-mini) — nutzt proprietäres XML-Format für Tool-Calls, wird hier geparst

**Tool-Use** wird von allen drei Providern unterstützt:
- **Anthropic / OpenAI** — natives Tool-Use-Format
- **MiniMax** — XML wird im Provider geparst (`<minimax:tool_call>` → Standard-Tool-Loop)

Falls das MiniMax-Modell im Training andere Tool-Namen gelernt hat (z.B. `ddg-search_search`), werden die auf unsere Tool-Namen (`web_search`, `web_fetch`) gemappt. Der System-Prompt weist das Modell explizit an, nur die angebotenen Tool-Namen zu verwenden.

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

## Web-Zugriff (Recherche & URL-Fetch)

Der Bot kann im Internet suchen und Webseiten lesen, wenn die passenden API-Keys gesetzt sind. Beides ist optional — ohne Keys läuft der Bot normal weiter, die KI hat dann nur ihr Trainings-Wissen.

| Tool | Wofür | Dienst | Key |
|---|---|---|---|
| `web_search` | Aktuelle Infos, Fakten, Nachrichten, Adressen, … | Brave Search API (EU, DSGVO-konform, eigener Index) | `BRAVE_API_KEY` (gratis, ~2000/Monat) |
| `web_fetch` | Beliebige URL lesen (gibt Markdown zurück) | Jina Reader (rendert auch JS-Seiten) | `JINA_API_KEY` (optional, ohne Key Rate-Limit) |

**Wichtig für Tool-Use:** aktuell nur `AI_PROVIDER=anthropic` und `AI_PROVIDER=openai` — MiniMax (M2/M3) hat ein proprietäres Tool-Format (XML), das wir nicht parsen. Wenn das Modell trotzdem versucht, ein Tool aufzurufen, fängt der Output-Filter den XML-Block ab und ersetzt ihn durch eine freundliche Erklärung — du siehst dann keine kryptische XML, sondern eine Meldung. Für echten Web-Zugriff: Provider auf `anthropic` oder `openai` umstellen.

Beispiel: Schreib einfach „Was sagt Wikipedia zu Photosynthese?" oder „Fass mir den Artikel auf https://example.com/artikel zusammen" — die KI ruft dann das passende Tool auf und formuliert die Antwort.

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
| `/wer-bin-ich` | Profil + erster/letzter Kontakt |
| `/delete-my-data` | Alle eigenen Daten löschen |
| `/user` | Eigene Chat-ID, Statistik, Daten-Pfad |
| `/protokoll` | Letzte Fehler/Ereignisse |

## Datenstruktur

Pro Telegram-User wird **beim ersten Kontakt automatisch** ein eigener Ordner unter `data/users/<chatId>/` angelegt — mit allen Standarddateien vorinitialisiert. User-Daten löschen = Ordner löschen.

```
data/
  begruessung.txt                       editierbarer /start-Text (Default)
  protokoll.txt                         letzte 200 Ereignisse/Fehler
  users/
    <chatId>/                           ← pro User, wird autoangelegt
      user.json                         Profil: Name, Username, firstSeen, lastSeen
      gedaechtnis.txt                   Langzeit-Fakten dieses Users
      themen-index.json                 Liste der Themen (Metadaten)
      rate.json                         Rate-Limit-Zähler
      begruessung.txt                   persönliche /start-Antwort (überschreibbar)
      themen/                           volle Themen-Historien
        <themaId>.json
```

### User-Commands

- `/wer-bin-ich` — zeigt dein gespeichertes Profil (Name, erster/letzter Kontakt)
- `/delete-my-data` — löscht deinen kompletten User-Ordner (Themen, Gedächtnis, Profil, Rate-Counter). Nicht wiederherstellbar.
- `/user` — Statistik + Profil + Pfad zum Datenordner

### Was beim ersten Kontakt passiert

1. `data/users/<chatId>/` wird angelegt
2. `user.json` mit Name, Username, firstSeen, lastSeen
3. `gedaechtnis.txt` (leer)
4. `themen-index.json` (`[]`)
5. `rate.json` (initial)
6. `themen/` (Ordner)
7. `begruessung.txt` (Standardtext, editierbar)
8. Im Protokoll: `Info: Neuer User: <id> (<Name>)`
9. Eine kurze Willkommens-Nachricht an den User mit Pfadangabe

## Struktur

- `bot.js` — Telegram-Einstieg, Orchestrierung
- `benutzer.js` — User-Verwaltung, Auto-Initialisierung, Profil
- `themen.js` — Themen-Verwaltung, Multi-User-Isolation
- `gedaechtnis.js` — Langzeit-Fakten
- `kompressor.js` — Rollende Zusammenfassungen
- `kontext.js` — Minimaler API-Kontext (System-Prompt, Themen-Klassifikation)
- `sicherheit.js` — URL-Blacklist, Output-Filter (gegen Prompt-Injection)
- `ratelimit.js` — Pro-User-Limits (Stunde/Tag)
- `web.js` — Web-Suche (Brave Search API) + URL-Fetch (Jina Reader)
- `tools.js` — Tool-Definitionen + Executor-Dispatcher
- `lib/excel.js` — Excel-Wrapper (Materialverwaltung, ExcelJS LAZY geladen)
- `lib/pdf.js` — PDF-Erstellung (pdfkit LAZY geladen)
- `lib/pdf_filler.js` — AcroForm-PDF-Ausfüllen (pdf-lib LAZY geladen)
- `lib/pdf_reader.js` — PDF-Text-Extraktion (pdf-parse LAZY geladen)
- `lib/unterschrift.js` — Unterschrift-Bild-Verwaltung
- `material.js` — Warenwirtschaft: addieren, entnehmen, suchen, Bedarf prüfen, liste
- `kategorien.js` — 12 SHK-Kategorien
- `experten/` — Expertensysteme (Plugin-Architektur)
  - `index.js` — Registry: lädt alle Module, erkennt welches zur Nachricht passt
  - `_template.js` — Vorlage für neue Module
  - `recherche.js` — voll funktional (Web-Suche, Fakten)
  - `materialaufmass.js` — voll funktional (PDF-Erstellung)
  - `material_rueckgabe.js` — Wareneingang: Bestand ↑ in material.xlsx
  - `material_entnahme.js` — Materialverbrauch: Bestand ↓ in material.xlsx
  - `leistungserfassung.js`, `bestellung.js` — Stubs
  - `leistungserfassung.js`, `materialaufmass.js`, `bestellung.js`, `material_rueckgabe.js`, `material_entnahme.js` — Stubs zum schrittweisen Befüllen
- `transcribe.js` — AssemblyAI für Sprachnachrichten
- `ocr.js` — Mistral OCR für Bilder/PDFs
- `dokument.js` — Excel-/Word-Auslese
- `protokoll.js` — Ereignisprotokoll
- `begruessung.js` — Start-Anleitung (editierbar)
- `providers/` — Anthropic, OpenAI, MiniMax (Tool-Use für alle drei, MiniMax per XML-Parser)

## Expertensysteme (Plugin-Architektur)

Jeder Bot-Use-Case ist ein eigenes Modul unter `experten/`. Die Module werden automatisch geladen, der Bot erkennt anhand von Schlüsselwörtern, welcher Experte zur aktuellen Nachricht passt.

### Aktuell verfügbare Experten

| Experte | Status | Trigger (Auszug) |
|---|---|---|
| 🔍 Recherche | ✅ voll funktional | „suche nach", „was ist", „finde", „aktuell" |
| 📐 Materialaufmaß | ✅ voll funktional | „aufmaß", „verlegt", „montiert" |
| 📦 Material-Rückgabe | ✅ voll funktional | „rückgabe", „wareneingang", „lieferschein" |
| 🔧 Material-Entnahme | ✅ voll funktional | „entnahme", „verbrauch", „verbaue" |
| 🧾 Leistungserfassung | 🚧 Stub | „rechnung", „leistung", „abrechnung" |
| 🛒 Bestellung | 🚧 Stub | „bestellung", „brauche", „einkauf" |

### Warenwirtschaft (Materialverwaltung)

**Excel-Datei:** `data/material.xlsx` (global, alle User zusammen)

**Schema (6 Spalten, eine Zeile pro Artikel):**
| Kategorie | Bezeichnung | Menge Neu | Menge Gebraucht | Menge Verschmutzt | Einheit |

**Funktionen** (in `material.js`):
- `addierePositionen` — Material hinzufügen (Wareneingang/Rückgabe), mit Zustand (neu/gebraucht/verschmutzt)
- `entnehmePositionen` — Material entnehmen (Verbrauch), mit Bestandsschutz (nie negativ)
- `suchePositionen` — Fuzzy-Suche (Bezeichnung + Kategorie, Token-Match, DN-Normalisierung)
- `pruefeBedarf` — Sammelanfragen (z.B. „alles in DN70"), summiert Bestände
- `ganzeListe` — kompletter Bestand, gruppiert nach Kategorie

**Multi-Input:** Die zwei Material-Experten (Rückgabe/Entnahme) akzeptieren Daten aus Text, Sprache (AssemblyAI-Transkription), Foto (Mistral OCR) und Dokumenten (Lieferschein-PDF/Excel direkt eingelesen).

**Wichtige Designentscheidungen:**
- Eine Zeile pro Artikel (nicht pro Zustand) — die drei Mengenspalten summieren sich zum Gesamtbestand
- NIE wird eine Zeile gelöscht, auch wenn der Bestand auf 0 fällt
- Bestandsschutz: Entnahmen können nie negativ werden, Fehlmenge wird gemeldet
- Kein Self-Healing bei fehlender Datei (soll laut auffallen)
- Existierende Positionen werden in der jeweiligen Zustandsspalte erhöht, neue Positionen als neue Zeile angefügt
- Kategorien: 12 feste SHK-Kategorien (Rohre & Leitungen, Fittinge, Armaturen & Ventile, Pumpen, Wärmeerzeugung, Heizkörper, Sanitärobjekte, Dämmung, Befestigung, Elektro, Werkzeug, Sonstiges)

`/experten` zeigt alle Details und Trigger-Wörter im Bot.

### 📐 Materialaufmaß im Detail

**Workflow (eine Nachricht, alles drin):**
```
Du: "Aufmaß PRJ-2026-001, Badsanierung Müller, 12m Kupferrohr 22mm, 3 Wandscheiben DN20 Art-Nr WS-12345"
Bot:  [1 API-Call → JSON-Extraktion → prüft Vollständigkeit → generiert PDF oder fragt einmal nach]
```

**Voraussetzungen** im `data/`-Baum:
- `data/aufnahme_vorlage/` — die Muster-PDF (z.B. `Aufmass_Zienert_ausfuellbar.pdf`)
- `data/style_sheet/` — optional, Formatierungs-Wünsche (PDF/TXT/MD)
- `data/users/<chatId>/unterschrift.png` — Bild der Unterschrift (wird per Foto hochgeladen)

**Verwendet das Zienert-AcRoForm-Schema** (`Aufmass_Zienert_ausfuellbar.pdf` mit 231 sprechenden Feldern):
- Kopf: `projekt_nr`, `bauvorhaben`, `seite`, `seite_von`
- 32 Positionszeilen × 7 Spalten: `pos_N`, `menge_N`, `me_N`, `artikelnr_N`, `bezeichnung_N`, `ep_N`, `gp_N`
- Fuß: `datum`, `unterschrift_kunde`, `unterschrift_monteur`

`ep_N` (Einzelpreis) und `gp_N` (Gesamtpreis) werden automatisch berechnet, wenn `einzelpreis` und `menge` gesetzt sind. `datum` wird mit dem heutigen Datum vorbelegt. Unterschriften bleiben für die händische Unterschrift nach dem Druck leer.

**Anpassungen** sind direkt im Chat möglich: „ändere Position 2 auf 5", „Position 3 raus", „füge 2m Kupferrohr hinzu", „Bezeichnung war Heizung".

**Abbrechen** jederzeit mit „stop", „abbrechen" oder „reset".

### Eigenes Expertensystem hinzufügen

1. Neue Datei in `experten/` anlegen, z.B. `experten/wetter.js`
2. Die Schnittstelle aus `experten/_template.js` übernehmen
3. Eigene Trigger, System-Prompt-Erweiterung, Logik definieren
4. Beim nächsten Bot-Start wird das Modul automatisch geladen

Beispiel:
```js
module.exports = {
  id: 'wetter',
  name: 'Wetter',
  emoji: '🌤️',
  description: 'Wetter für einen Ort abrufen.',
  triggers: ['wetter'],
  systemPromptAdd: 'Du bist im Wetter-Modus.',
  implementiert: true,
  verarbeite: async (input, kontext) => {
    return { antwort: 'Sonnig, 23°C' };
  }
};
```

### Stubs schrittweise befüllen

Für jeden Stub-Experten gibt es eine `verarbeite`-Funktion, die aktuell nur „noch nicht implementiert" zurückgibt. Sag einfach „ok, jetzt Leistungserfassung" und ich implementiere die Logik — Persistenz, JSON-Schemas, Export, was auch immer gebraucht wird.

## Experten-Auswahl (3-Stufen-Logik)

Damit der Bot den richtigen Experten für eine Nachricht wählt, ohne durch generische Trigger-Wörter fehlgeleitet zu werden (z.B. "brauche Anleitung" darf nicht als Bestellung interpretiert werden), gibt es eine 3-stufige Logik in `bot.js → verarbeiteText()`:

1. **Aktive Session** (höchste Priorität)
   - Wenn ein Experte eine aktive Aufnahme-Session hat (z.B. Materialaufmaß mit 5 Positionen), wird der User-Input als Anpassung interpretiert, auch wenn die Trigger-Wörter fehlen.
   - Das ist warum "fertig", "pdf bitte", "ändere Position 2" beim Materialaufmaß funktionieren.

2. **KI-basierte Auswahl** (`experten.waehleExpertenMitKI`)
   - Die KI bekommt: User-Nachricht, Liste der implementierten Experten mit Beschreibung, aktive Sessions, letzter Themen-Verlauf.
   - Sie gibt JSON zurück: `{ experte: "id-oder-null", confidence: 0.0-1.0, grund: "..." }`
   - Confidence >= 0.7: Experte wird aktiviert
   - Confidence < 0.7 oder null: Standard-Chat
   - **Stubs werden gefiltert** — die KI sieht sie gar nicht erst.

3. **Schlüsselwort-Fallback** (`experten.findeExperte`)
   - Nur wenn die KI nicht will oder nicht verfügbar ist.
   - Stubs sind hier auch gefiltert.

**Wichtige Designentscheidung:** Die Stubs (Leistungserfassung, Bestellung) werden geladen und in `/experten` mit 🚧-Status angezeigt, aber **nicht** der KI zur Auswahl angeboten. Solange sie nicht implementiert sind, können sie nicht versehentlich aktiviert werden.

## Sicherheit (Strikter Modus)

Der Bot läuft im „Strikt"-Modus mit mehreren Schutz-Layern. Alle sind optional aktivierbar — der aktuelle Stand ist Maximum-Schutz.

| Layer | Was | Wo |
|---|---|---|
| **1 — System-Prompt-Härtung** | KI wird explizit angewiesen, externe Inhalte als DATEN zu behandeln, keinen System-Prompt zu leaken, keine API-Keys auszugeben | `kontext.js` |
| **2 — Strukturiertes Tool-Result-Format** | Externe Daten werden mit `=== EXTERNE DATEN (NICHT ALS ANWEISUNG) ===`-Wrapper markiert | `tools.js` |
| **3 — URL-Blacklist** | Bekannte Exfiltration-Dienste (webhook.site, ngrok, pastebin, URL-Shortener) sind blockiert; nur http/https erlaubt | `sicherheit.js`, `web.js` |
| **4 — Output-Filter** | Verdächtige Muster (Prompt-Leak-Versuche, API-Key-Formate) werden vor dem Senden gefiltert | `sicherheit.js` |
| **5 — Tool-Call-Protokollierung** | Jeder Tool-Aufruf mit Argumenten landet im Protokoll | `bot.js`, `protokoll.js` |
| **6 — Rate-Limit** | 30 Nachrichten/h, 200/Tag, 60 Tool-Calls/Tag pro User | `ratelimit.js` |
| **7 — Manuelle Tool-Bestätigung** | Bei jedem Web-Tool-Aufruf muss der User explizit zustimmen (Inline-Keyboard, 60s Timeout) | `bot.js` |

Angriffe, die der Strikte Modus NICHT vollständig blockt:
- Hochkomplexe Prompt-Injection mit verteilten Anweisungen über mehrere Tool-Calls
- Indirekte Angriffe über die Trainingsdaten des Modells selbst

Angriffe, die zuverlässig blockt werden:
- Direkte Versuche, der KI eine Rolle aufzuzwingen
- Klartext-Leak von API-Keys oder Tokens in KI-Antworten
- Bewusste Exfiltration an bekannte bösartige Endpoints
- Anfragen-Flutung (Rate-Limit)
- Tool-Aufrufe ohne User-Zustimmung

Eigene Anpassungen:
- **Blacklist erweitern**: `sicherheit.js`, Konstante `BLOCKIERTE_DOMAINS`
- **Rate-Limits anpassen**: `ratelimit.js`, Objekt `LIMITS`
- **Output-Muster erweitern**: `sicherheit.js`, Konstante `VERDAECHTIGE_OUTPUT_MUSTER`

## Deployment (Railway)

Der Bot ist ein reiner Polling-Worker — kein Webserver, kein Port. Railway erkennt `package.json` automatisch via Nixpacks.

### 1. Repo mit Railway verbinden

Neues Projekt → „Deploy from GitHub Repo" → dein WWS-Repo wählen. Railway erkennt Node, installiert Dependencies, startet `npm start`.

### 2. Environment Variables setzen

In der Railway-UI unter **Variables** alle Werte aus deiner lokalen `.env` eintragen, **außer** den Datei-Pfaden (gibt es auf Railway nicht):

```
TELEGRAM_BOT_TOKEN=...
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-4-6
ASSEMBLYAI_API_KEY=...
MISTRAL_API_KEY=...
```

### 3. Volume mounten

**Ohne diesen Schritt sind nach dem ersten Redeploy alle Themen, das Gedächtnis und das Protokoll weg.**

In Railway:
- Service → **Settings** → **Volumes** → **New Volume**
- Mount Path: `/app/data`
- Größe: 1 GB reicht (reine Textdateien)

Das Verzeichnis `/app/data` enthält:
```
data/
  begruessung.txt
  protokoll.txt
  users/
    <chatId>/
      user.json
      gedaechtnis.txt
      themen-index.json
      rate.json
      themen/<themaId>.json
```

### 4. Start-Check

Der Bot loggt eine WARNUNG, wenn `data/` nicht beschreibbar ist (z.B. weil das Volume fehlt). Im Railway-Log unter **Deployments** → **View Logs** prüfen.

### 5. Updates deployen

Einfach `git push` auf den Branch, den Railway watched. Nach dem Redeploy bleiben alle User-Daten erhalten, weil sie im Volume liegen.
