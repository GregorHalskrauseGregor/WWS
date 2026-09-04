# Grosshandel-Service

Playwright-Service, der Bestellungen bei SHK-Grosshaendlern (GC-Gruppe, RNF, ...)
im Browser absetzt. Wird vom WWS-Bot per HTTP aufgerufen.

## Aufbau

```
WWS-Bot (lokal auf deinem PC)
   |
   |  POST /bestellung
   |  Bearer <SERVICE_TOKEN>
   v
Grosshandel-Service (Hetzner-Box)
   |
   +-- Playwright/Chromium
   |     +-- storage/Gc.json   (Login-Session GC)
   |     +-- storage/Rnf.json  (Login-Session RNF)
   |
   +-- selectors/gc.yaml      (Selektoren + URLs GC)
   +-- selectors/rnf.yaml     (Selektoren + URLs RNF)
   |
   +-- screenshots/<jobId>/   (Audit-Log pro Bestellung)
```

## Deployment (Hetzner-Box)

Auf einer frischen Ubuntu-24/26-Box einmalig:

```bash
# 1. SSH-Key hinterlegen, dann einloggen
ssh root@<box-ip>

# 2. Setup laufen lassen (idempotent)
bash setup-server.sh

# 3. Repo klonen
cd /opt/grosshandel-service
git clone <dein-repo-url> .
cp .env.example .env
nano .env   # SERVICE_TOKEN + GC_USER/GC_PASS setzen

# 4. Bauen und starten
docker compose up -d --build

# 5. Pruefen
curl http://127.0.0.1:8787/health
# -> {"status":"ok","browser":"not_started","contexts":[]}

# 6. Erste GC-Login-Session anstossen (einmalig pro Grosshaendler)
curl -X POST http://127.0.0.1:8787/login/GC \
  -H "Authorization: Bearer $SERVICE_TOKEN"
# -> {"ok":true,"grosshaendler":"GC"}
# Prueft, ob Login klappt; speichert die Session. Ab jetzt kein Login mehr noetig.
```

## Updates deployen

```bash
cd /opt/grosshandel-service
git pull
docker compose up -d --build
docker compose logs -f --tail=100
```

## WWS-Bot-Seite

In WWS `.env` eintragen:

```
GROSSHANDEL_SERVICE_URL=http://<box-ip>:8787
GROSSHANDEL_SERVICE_TOKEN=<identisch mit SERVICE_TOKEN auf der Box>
```

## API

### `GET /health`
Kein Auth. Liefert Service- und Browser-Status.

### `POST /login/:grosshaendler`
Erzwingt einen frischen Login (z. B. wenn die Session abgelaufen ist). Speichert
die Session in `data/storage/<grosshaendler>.json`. Ab dann wird die Session
bei jeder Bestellung wiederverwendet, bis sie ablaeuft (typischerweise einige
Tage, je nach Cookie-Lebensdauer des Portals).

### `POST /bestellung`
Body:
```json
{
  "grosshaendler": "GC",
  "vorgangId": "12345-1725451234",
  "chatId": "12345",
  "positionen": [
    { "artikelnr": "12345", "menge": 5, "bezeichnung": "Kugelhahn DN20", "einheit": "Stk." }
  ],
  "lieferadresse": "Baustelle Mueller, Musterstr. 1",
  "bemerkung": "Lieferung 8-10 Uhr"
}
```

Antwort:
```json
{
  "ok": true,
  "jobId": "gc-1725451234-ab12cd",
  "bestellnummer": "AB-12345",
  "screenshot": "/app/screenshots/gc-.../4-bestaetigung.png",
  "log": "5 Positionen verarbeitet"
}
```

### `GET /job/:id`
Listet die zu einem Job gespeicherten Dateien (Screenshots + log.txt).

## Neuen Grosshaendler anlegen

1. Neue Datei `selectors/<klein>.yaml` anlegen (Vorlage: `selectors/gc.yaml`)
2. In `server.js` die Liste `GUELTIGE_GROSSHAENDLER` in `experten/grosshandel.js` ergaenzen
3. In `.env` `<KLEIN>_USER` und `<KLEIN>_PASS` setzen
4. `docker compose restart`
5. Einmal `POST /login/<KLEIN>` aufrufen, um die Session zu speichern
