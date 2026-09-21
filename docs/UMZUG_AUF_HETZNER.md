# Umzug: Bot auf die Hetzner-Box, Browser bleibt auf dem Laptop

Stand: 15.09.2026

---

## Was sich ändert

**Vorher:** Alles auf dem Laptop. Läuft der nicht, läuft nichts.

**Nachher:**

```
              Telegram
                 │
                 ▼
     ┌───────────────────────────┐
     │  Hetzner-Box              │   läuft durch
     │  ─────────────            │
     │  Router, alle Experten    │
     │  Lager, Projektordner     │
     │  Wissen, Aufmaß, Zugang   │
     │                           │
     │  Auftragsstelle  ◄────────┼──── der Laptop fragt nach
     └───────────────────────────┘     (Port 8788, Long-Poll)
                 ▲
                 │  holt Aufträge ab, meldet Ergebnisse zurück
                 │
     ┌───────────────────────────┐
     │  Dein Laptop              │   nur wenn er an ist
     │  ─────────────            │
     │  agent.js                 │
     │  server.js + echtes Chrome│
     │  → gconlineplus.de        │
     └───────────────────────────┘
```

**Warum der Browser nicht mit auf die Box kann:** GC sperrt Rechenzentrums-IPs
schon auf Netzwerkebene (Imperva, noch vor der ersten Seite). Das ist keine
Einstellung, die man umlegt. Hetzner-IPs sehen für GC aus wie ein Bot-Netz,
egal was im Browser steht.

**Warum die Box den Laptop nicht anruft:** Der Laptop hat keine feste Adresse,
sitzt hinter dem Router und schläft zwischendurch. Also dreht sich die Richtung
um: der Laptop hält eine Leitung zur Box offen und wartet auf Arbeit.

### Was das im Alltag bedeutet

| | |
|---|---|
| Lager, Projektordner, Aufmaß, Wissen, Recherche | laufen **immer**, Laptop egal |
| Großhandel-Bestellung | Laptop muss an sein — sonst **wartet** der Auftrag |
| Bestellen vom Handy bei zugeklapptem Laptop | geht. Der Auftrag läuft, sobald du den Laptop aufmachst |
| Antwort im Chat | kommt in **zwei Teilen**: erst „eingestellt", später das Ergebnis mit Screenshot |

---

## ⚠️ Der Kalenderbot bleibt unangetastet

Auf der Box läuft noch ein zweiter Bot. Alles hier ist so gebaut, dass er
nicht berührt wird:

| | |
|---|---|
| Verzeichnis | `/opt/wws` — eigenes, nicht das des Kalenderbots |
| Compose-Projekt | `name: wws` — `docker compose` greift nur auf diesen Stack |
| Container | `wws-bot` |
| Port | `AGENT_PORT`, Standard 8788 — vorher geprüft |
| Firewall | genau **eine** neue Regel, nichts entfernt |

**Diese Befehle sind sicher** (immer aus `/opt/wws` heraus):

```bash
docker compose up -d        # startet nur wws
docker compose restart      # nur wws
docker compose logs -f      # nur wws
docker compose down         # stoppt nur wws
```

**Diese Befehle nicht benutzen** — sie treffen alles auf der Box:

```bash
docker stop $(docker ps -q)      # ⛔️ stoppt auch den Kalenderbot
docker system prune -a           # ⛔️ löscht dessen Images mit
docker rm -f $(docker ps -aq)    # ⛔️ räumt alles ab
```

---

## Schritt 1 — Bestandsaufnahme (ändert nichts)

Kopier `box-pruefen.sh` auf die Box und lass es laufen:

```bash
scp "Claude outputs/box-pruefen.sh" root@BOX-IP:/root/
ssh root@BOX-IP
bash /root/box-pruefen.sh
```

Das zeigt dir: laufende Container, belegte Ports, Firewall, Platz. **Schau dir
an, was der Kalenderbot belegt**, und ob 8788 frei ist. Ist er belegt, nimm
später `AGENT_PORT=8799` oder eine andere freie Zahl — an beiden Stellen
(Box-`.env` und Laptop-`.env`).

---

## Schritt 2 — Token erzeugen

Auf der Box:

```bash
openssl rand -hex 32
```

Das Ergebnis brauchst du **zweimal**: in der `.env` auf der Box und in der
`.env` des Agenten auf dem Laptop. Es ist das einzige, was die beiden
auseinanderhält — schreib es dir kurz raus.

---

## Schritt 3 — Repo auf die Box

```bash
mkdir -p /opt/wws
cd /opt/wws
git clone <dein-repo-url> .
```

Läuft der alte Grosshandel-Service noch auf der Box, kannst du ihn abschalten —
er kommt von dort ohnehin nicht an GC vorbei. **Nur diesen einen**, nicht mehr:

```bash
cd /opt/grosshandel-service && docker compose down
```

(Optional. Lässt du ihn laufen, stört er nur, wenn er Port 8787 belegt.)

---

## Schritt 4 — Daten mitnehmen

Auf dem **Laptop**, im WWS-Ordner:

```
Claude outputs\daten-packen.bat
```

Das packt `data\`, `wissen\` und `werkzeuge.md` in `wws-daten.zip` — also
Lagerbestand, alle Gesprächsfäden, das Gedächtnis, Projektordner,
Wissenskarten, Katalogindex. Die `.env` ist **absichtlich nicht dabei**: die
Zugangsdaten trägst du auf der Box von Hand ein.

Dann rüber:

```bash
scp wws-daten.zip root@BOX-IP:/opt/wws/
ssh root@BOX-IP
cd /opt/wws
apt install -y unzip        # falls noch nicht da
unzip -o wws-daten.zip
rm wws-daten.zip
ls data wissen              # kurz nachsehen, dass alles da ist
```

---

## Schritt 5 — `.env` auf der Box

```bash
cd /opt/wws
cp .env.example .env
nano .env
```

Das Wichtigste:

```
TELEGRAM_BOT_TOKEN=…            wie bisher
TELEGRAM_LAGER_TOKEN=…          wie bisher
ZUGANGS_CODE=…                  dein Login-Code
MINIMAX_API_KEY=…               bzw. dein Mistral-Key
ASSEMBLYAI_API_KEY=…
MISTRAL_API_KEY=…
BRAVE_API_KEY=…
ADMIN_KENNWORT=…

AGENT_TOKEN=<der Token aus Schritt 2>
AGENT_PORT=8788                 falls belegt: andere Zahl
AGENT_HOST=0.0.0.0

# Diese beiden bleiben auf der Box LEER — hier gibt es keinen Browser:
# GROSSHANDEL_SERVICE_URL=
# GROSSHANDEL_SERVICE_TOKEN=
```

> **Wichtig:** Der Telegram-Bot-Token darf nur an **einer** Stelle laufen.
> Läuft der Bot noch auf dem Laptop, beende ihn dort, bevor du hier startest —
> sonst streiten sich zwei Prozesse um dieselben Nachrichten und es kommt
> jede zweite Antwort nicht an.

---

## Schritt 6 — Firewall: eine Regel, sonst nichts

```bash
ufw allow 8788/tcp comment 'WWS Auftragsstelle'
ufw status numbered
```

Passt den Port an, falls du in Schritt 1 einen anderen genommen hast. **Keine
bestehende Regel löschen** — die Nummern in der Liste gehören teilweise dem
Kalenderbot.

---

## Schritt 7 — Starten

```bash
cd /opt/wws
docker compose up -d --build
docker compose logs -f --tail=80
```

Im Log musst du sehen:

```
Anbieter chat        minimax (MiniMax-M2)
Dienst   ocr         mistral
Experten: bestellung, grosshandel, lager, ...
Auftragsstelle: 0 offen, 0 gesamt (/app/data/auftraege)
Auftragsstelle hört auf 0.0.0.0:8788 — der Laptop-Agent holt hier seine Aufträge ab.
Telegram-Adapter läuft.
```

Von außen prüfen (vom Laptop aus):

```
curl http://BOX-IP:8788/health
```

Antwort:

```json
{"status":"ok","dienst":"wws-auftragsstelle","warteschlange":{...},"agent":{"online":false,...}}
```

Kommt hier nichts, liegt es an der Firewall oder am Port — nicht am Bot.

---

## Schritt 8 — Laptop-Seite einrichten

Im Ordner `grosshandel-service\` auf dem Laptop:

1. `.env` ergänzen (die neuen Zeilen stehen in `.env.example`):

```
AUFTRAGSSTELLE_URL=http://BOX-IP:8788
AGENT_TOKEN=<derselbe Token wie auf der Box>
AGENT_ID=felix
LOKALER_DIENST=http://127.0.0.1:8787
SCREENSHOT_DIR=./screenshots
```

Die bisherigen Zeilen (`SERVICE_TOKEN`, `GC_USER`, `GC_PASS`, `AI_*`) bleiben
wie sie sind — die Großhändler-Zugangsdaten bleiben auf dem Laptop und gehen
nie über die Leitung zur Box.

2. Starten:

```
laptop-start.bat
```

Zwei Fenster gehen auf: der Browser-Dienst und der Agent. Beide bleiben offen.
Stürzt einer ab, startet er sich in 5 Sekunden selbst neu.

Im Agent-Fenster musst du sehen:

```
[19:14:51] Agent "felix" startet.
[19:14:51]   Box:            http://BOX-IP:8788
[19:14:51]   lokaler Dienst: http://127.0.0.1:8787
[19:14:51]   Dienst gerade:  erreichbar
```

3. In Telegram:

```
/grosshandel_status
```

muss jetzt **🟢 Laptop erreichbar** zeigen.

---

## Schritt 9 — Autostart auf dem Laptop (optional)

Damit der Agent nach jedem Hochfahren von allein läuft:

1. `Win` + `R` → `taskschd.msc`
2. *Aufgabe erstellen* (nicht „einfache Aufgabe")
3. **Allgemein:** Name `WWS Laptop-Agent`, *Unabhängig von der
   Benutzeranmeldung ausführen* **nicht** wählen — Chrome braucht eine
   angemeldete Sitzung
4. **Trigger:** *Bei Anmeldung*
5. **Aktionen:** Programm `C:\_M REDUX\Github\WWS\grosshandel-service\laptop-start.bat`,
   *Starten in* `C:\_M REDUX\Github\WWS\grosshandel-service`
6. **Bedingungen:** Haken bei „Nur starten, wenn Netzverbindung besteht"
   entfernen — der Agent wartet selbst, bis Netz da ist
7. **Einstellungen:** „Aufgabe beenden, falls sie länger läuft als" **aus**

---

## Wie du merkst, dass es läuft

| Befehl | Was er zeigt |
|---|---|
| `/grosshandel_status` | Ist der Laptop erreichbar? Läuft dort der Browser-Dienst? Was liegt in der Warteschlange? |
| `/bestellungen` | Deine letzten Aufträge mit Stand |
| `curl http://BOX-IP:8788/health` | Lebt die Auftragsstelle? (ohne Token) |
| `docker compose logs -f --tail=50` | Was der Bot gerade tut |

Vier Zustände kann ein Auftrag haben:

| | |
|---|---|
| ⏳ wartet | Eingestellt, Laptop noch nicht dran |
| ⚙️ läuft | Laptop arbeitet gerade |
| ✅ fertig | Warenkorb steht, Screenshot kommt mit |
| ❌ fehlgeschlagen | Sicher nichts passiert — einfach nochmal schicken |
| ❓ unklar | **Erst im Portal nachsehen.** Siehe unten |

### „Unklar" — und warum es diesen Zustand gibt

Bricht etwas ab, **nachdem** der Warenkorb angelegt sein könnte, weiß niemand,
wie weit der Browser gekommen ist. Einfach nochmal zu bestellen würde dann
doppelt liefern. Deshalb wiederholt der Bot Bestellungen **nie** von selbst und
sagt dir stattdessen: erst nachsehen.

Der Bot unterscheidet sauber:

- **Login schlägt fehl** → sicher nichts passiert → ❌, nochmal schicken
- **Weiterleiten schlägt fehl** → Warenkorb existiert schon → ❓, nachsehen
- **Laptop klappt mitten drin zu** → unbekannt → ❓, nachsehen

---

## Wenn etwas nicht geht

**`/grosshandel_status` sagt „hat sich noch nie gemeldet"**
Der Agent kommt nicht durch. Vom Laptop aus prüfen:
`curl http://BOX-IP:8788/health`. Kommt nichts → Firewall/Port.
Kommt `{"error":"Token stimmt nicht"}` → die beiden `AGENT_TOKEN` sind
verschieden.

**„⚠️ Browser-Dienst auf dem Laptop läuft nicht"**
Der Agent ist da, `server.js` nicht. Das Dienst-Fenster ansehen. Solange das
so ist, holt der Agent **absichtlich** keine Aufträge ab — sie warten, statt
reihenweise als fehlgeschlagen bei dir zu landen.

**Bestellungen bleiben auf „wartet" stehen**
Laptop an? Beide Fenster offen? `/grosshandel_status` zeigt, woran es liegt.

**Der Bot antwortet doppelt oder gar nicht**
Dann läuft er noch an zwei Stellen. Auf dem Laptop das alte Bot-Fenster
schließen — der Telegram-Token verträgt nur einen Empfänger.

**Der Kalenderbot ist weg**
Sollte nicht passieren, aber: `docker ps -a` zeigt seinen Container. Aus
**seinem** Verzeichnis `docker compose up -d`. Dieser Stack hier fasst ihn an
keiner Stelle an.

---

## Zurück auf den Laptop, falls nötig

Der alte Weg ist nicht gelöscht, nur nicht aktiv:

1. Auf der Box: `cd /opt/wws && docker compose down`
2. Auf dem Laptop in der WWS-`.env`:
   `AGENT_TOKEN` leer lassen, dafür
   `GROSSHANDEL_SERVICE_URL=http://127.0.0.1:8787` und `GROSSHANDEL_SERVICE_TOKEN=…`
3. `npm start`

Ohne `AGENT_TOKEN` schaltet der Großhandel-Experte automatisch in den
Direktbetrieb: Bestellung, zwei Minuten warten, Ergebnis sofort — wie vorher.
Die Daten musst du dann von der Box zurückholen (`scp -r root@BOX-IP:/opt/wws/data .`).

---

## Was noch offen ist

**HTTPS.** Ohne Domain läuft die Auftragsstelle als einfaches HTTP, der Token
geht im Klartext über die Leitung. In einem fremden WLAN könnte ihn jemand
mitlesen und eigene Bestellungen einstellen. Die GC-Zugangsdaten sind davon
nicht betroffen — die liegen auf dem Laptop. Wenn du eine Domain auf die Box
zeigen lässt, stehen in der `docker-compose.yml` fünf auskommentierte Zeilen für
Caddy, die HTTPS automatisch einrichten. **Vorher prüfen, ob der Kalenderbot
schon Port 80/443 belegt.**

**Getestet ist die Strecke, nicht der Umzug.** Warteschlange, Agent, Long-Poll,
Abbruchfälle und Neustart habe ich gegeneinander laufen lassen (siehe unten).
Der Docker-Bau auf der echten Box und der erste Durchlauf mit echtem GC stehen
aus — beides kann ich von hier nicht ausführen.

---

## Was ich getestet habe

Mit einer Attrappe des Playwright-Dienstes, echte Prozesse, echtes HTTP:

- Bestellung bei ausgeschaltetem Laptop → wartet, läuft beim Einschalten von allein an
- Agent läuft, Browser-Dienst aus → Agent holt bewusst nichts ab, Bot sagt warum
- Normaler Durchlauf → fertig, Screenshot kommt über die Leitung im Chat an
- Zwei Bestellungen gleichzeitig → sauber nacheinander
- Falscher Token → 401; `/health` bleibt ohne Token erreichbar
- Laptop stirbt mitten im Auftrag → nach Ablauf der Frist „unklar", mit Warnung
- Box neu gestartet → offene Aufträge und Zustände überleben
- Login-Fehler (früh) → ❌ „nochmal schicken"
- Fehler beim Weiterleiten (spät) → ❓ „erst nachsehen"
- Rückmeldung wird bis zu 10-mal wiederholt, falls die Box kurz weg ist
- Antwort landet im richtigen Forum-Thema, auch Minuten später
