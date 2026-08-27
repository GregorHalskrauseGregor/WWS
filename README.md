# KI-Excel-Tool

Webinterface mit Chat-Fenster. Die KI liest/bearbeitet eine Excel-Datei auf dem Server. Über den Download-Button lädst du die aktuelle Version herunter.

## Lokal einrichten

1. Terminal in diesem Ordner öffnen
2. Abhängigkeiten installieren:
   npm install
3. Beispiel-Excel-Datei erzeugen:
   npm run setup-example
4. `.env.example` zu `.env` kopieren und den eigenen Anthropic API Key eintragen:
   cp .env.example .env
5. Server starten:
   npm start
6. Im Browser öffnen: http://localhost:3000

## Struktur

- server.js — Backend (Express), liest/schreibt die Excel-Datei, ruft die KI-API auf
- public/index.html — Chat-Oberfläche im Browser
- data/arbeitsdatei.xlsx — die eigentliche Excel-Datei (Origin)
- create-example.js — erzeugt einmalig eine Beispiel-Datei

## Deployment (Railway)

Wird im nächsten Schritt ergänzt, sobald das lokale Testen funktioniert.
