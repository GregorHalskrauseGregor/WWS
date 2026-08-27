# KI-Excel-Tool (Telegram-Bot)

Telegram-Bot, der Materialpositionen per Nachricht entgegennimmt, sie mit einer KI interpretiert und in einer Excel-Datei einträgt/addiert. Der KI-Anbieter ist austauschbar (Anthropic, OpenAI, MiniMax).

## Telegram-Bot anlegen

1. In Telegram den Bot **@BotFather** öffnen
2. `/newbot` senden, Namen vergeben
3. Du bekommst einen **Token** (lange Zeichenkette) — dieser kommt in die `.env`

## Lokal einrichten

1. Terminal in diesem Ordner öffnen
2. Abhängigkeiten installieren:
   npm install
3. Beispiel-Materialliste erzeugen:
   npm run setup-example
4. `.env.example` zu `.env` kopieren:
   cp .env.example .env
5. In `.env` eintragen:
   - TELEGRAM_BOT_TOKEN (von BotFather)
   - AI_PROVIDER (anthropic, openai oder minimax)
   - den passenden API Key für den gewählten Anbieter
6. Bot starten:
   npm start
7. In Telegram den eigenen Bot öffnen und eine Nachricht schreiben, z. B.:
   "3 Kugelhahn DN20 hinzufügen"
   "2 Kugelhahn DN20 entnehmen"
   "Ich habe 5 Kugelhähne DN20 gebraucht zurückgebracht"
   "Ich brauche 8 Kugelhahn DN20 für einen Auftrag"
   "Wie viel Kupferrohr 22mm haben wir?"
   "Merke dir, dass alle Kugelhähne für Trinkwasser zugelassen sein müssen"
   "Fasse alle Rotguss-Kugelhähne für Heizung als 'Kugelhahn Heizung Rotguss' zusammen"
   "/excel" (schickt die aktuelle Datei als Datei im Chat)
   "/regeln" (zeigt alle gemerkten Regeln)
   "/gruppen" (zeigt alle gemerkten Artikelgruppen)

   Ein Foto eines Lieferscheins, einer handschriftlichen Liste, oder ein PDF, eine .xlsx- oder .docx-Datei schicken → der Bot liest die Positionen aus und trägt sie automatisch als "neu" ein. Fotos/PDFs laufen über Mistral OCR (MISTRAL_API_KEY in der .env nötig), Excel/Word werden direkt ausgelesen. Funktioniert mit JEDEM AI_PROVIDER, auch MiniMax – Bilderkennung im Chat-Anbieter ist dafür nicht mehr nötig, das übernimmt Mistral OCR vorab.

   Auch Telegram-Sprachnachrichten (Mikrofon-Symbol) funktionieren, auch längere Aufnahmen bis ca. 10 Minuten – der Bot transkribiert sie zuerst über AssemblyAI (Batch, EU-Endpunkt) und verarbeitet sie danach genauso wie Text. Dafür ASSEMBLYAI_API_KEY in der .env eintragen. Die Verarbeitung läuft über den EU-Endpunkt (api.eu.assemblyai.com), damit die Daten in der EU bleiben.

## Drei Anwendungsfälle

1. **Materialrückgabe** (Monteur bringt Material zurück in die Firma) — läuft über die normale "hinzufuegen"-Erkennung, aber mit Zustand "neu", "gebraucht" oder "verschmutzt". Jeder Artikel ist EINE Zeile mit drei Mengenspalten (Menge Neu, Menge Gebraucht, Menge Verschmutzt) statt mehrerer Zeilen.
2. **Materialbedarf prüfen** (Monteur braucht Material für einen Einsatz) — reine Abfrage, verändert den Bestand NICHT. Zeigt, was sofort aus dem Lager verfügbar ist (alle drei Mengenspalten zusammengerechnet) und was fehlt/bestellt werden muss. Die eigentliche Reservierung läuft mündlich mit dem Lageristen, nicht über den Bot.
3. **Lieferschein-/Screenshot-/PDF-/Excel-/Word-Import** (für den Lageristen) — ein Foto, PDF, eine .xlsx- oder .docx-Datei schicken, der Bot liest die Positionen aus und trägt sie als Wareneingang (Zustand "neu") ein. Fotos/PDFs/handschriftliche Listen laufen über Mistral OCR, Excel/Word werden direkt ausgelesen (kein OCR nötig). Funktioniert mit jedem AI_PROVIDER, auch MiniMax. Sehr lange Dokumente (z. B. hunderte Zeilen) werden automatisch in Häppchen von je ~40 Zeilen aufgeteilt und nacheinander verarbeitet, damit keine KI-Anfrage am Token-Limit scheitert – bei größeren Imports meldet der Bot den Fortschritt Abschnitt für Abschnitt.

## Excel-Struktur und Kategorien

Eine Zeile pro Artikel: Kategorie | Bezeichnung | Menge Neu | Menge Gebraucht | Menge Verschmutzt | Einheit. Bleibt auch bei Hunderten/Tausenden Positionen übersichtlich und lässt sich in Excel selbst leicht nach Kategorie filtern/sortieren.

Feste Kategorienliste (in bot.js als KATEGORIEN definiert, dort anpassbar):
Rohre & Leitungen, Fittinge & Verbindungstechnik, Armaturen & Ventile, Pumpen & Antriebe, Wärmeerzeugung, Heizkörper & Flächenheizung, Sanitärobjekte, Dämmung & Isolierung, Befestigung & Montagematerial, Elektro & Steuerungstechnik, Werkzeug & Verbrauchsmaterial, Sonstiges

Die KI ordnet neue Positionen automatisch einer dieser Kategorien zu. Bereits vergebene Kategorien werden bei erneutem Hinzufügen nicht überschrieben. "/liste" zeigt immer die vollständige, nach Kategorie gruppierte Liste – bei Bedarf aufgeteilt auf mehrere Telegram-Nachrichten (Telegrams Zeichenlimit pro Nachricht liegt bei 4096). Musste aufgeteilt werden, schickt der Bot zusätzlich die Excel-Datei direkt mit, das ist zum Durchsuchen/Filtern oft praktischer als viele Textnachrichten.

## Bestandsschutz

Entnahmen können die Materialliste nie ins Minus bringen:
- Reicht der Bestand nicht, wird nur das Vorhandene abgezogen (Bestand landet bei 0), die Fehlmenge wird zurückgemeldet
- Ist die Position unbekannt, wird nichts angelegt, der Bot meldet das

## Gedächtnis-Dokumente

Zwei Textdateien unter data/, die der Bot selbst schreibt und bei jeder Nachricht automatisch mit einbezieht:
- data/regeln.txt — allgemeine Regeln, die der Nutzer per Nachricht festlegt (z. B. Zulassungsanforderungen)
- data/artikelgruppen.txt — Sammelbegriffe für Artikel-Varianten, die als eine Position geführt werden sollen (verhindert unnötig viele Einzelpositionen für im Grunde gleiches Material)

Beide Dateien lassen sich jederzeit direkt bearbeiten (einfacher Text, eine Regel pro Zeile) oder per Telegram-Nachricht erweitern.

## Struktur

- bot.js — Haupteinstieg, empfängt Telegram-Nachrichten, steuert den Ablauf
- providers/ — ein Modul pro KI-Anbieter, alle mit gleicher chat()-Funktion
- providers/index.js — wählt den Anbieter anhand von AI_PROVIDER
- material.js — Excel-Logik: Positionen addieren (mit Kategorie und Zustandsspalten neu/gebraucht/verschmutzt), entnehmen (mit Bestandsschutz), Bedarf prüfen (read-only), suchen, auflisten
- wissen.js — Speicherung/Abruf der Gedächtnis-Dokumente (Regeln, Artikelgruppen)
- transcribe.js — Spracherkennung über AssemblyAI
- ocr.js — Mistral OCR: wandelt Fotos, Screenshots und PDFs in Text um
- dokument.js — direktes Auslesen von Excel- und Word-Dateien (kein OCR nötig)
- providers/anthropic.js, providers/openai.js — unterstützen zusätzlich Bilderkennung (aktuell ungenutzt, da der Lieferschein-Import jetzt über Mistral OCR + reinen Text läuft und damit mit jedem Anbieter funktioniert)
- data/material.xlsx — die eigentliche Materialliste (Origin)
- data/regeln.txt, data/artikelgruppen.txt — Gedächtnis-Dokumente

## Anbieter wechseln

Nur AI_PROVIDER in der .env ändern (z. B. von minimax auf anthropic) und den passenden API Key eintragen. Kein Code-Umbau nötig.

## Deployment (Railway)

Wird im nächsten Schritt ergänzt, sobald das lokale Testen funktioniert.
