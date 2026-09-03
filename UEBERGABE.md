# Übergabe – Stand 03.09.2026

Projekt: **WWS / DILA – Digitaler Lagerist** (Telegram-Bot, Node 22, Railway)
Repo lokal: `C:\_M REDUX\Github\WWS`
Kataloge: `C:\_M REDUX\Claude Test\Kataloge Shops` (aufbereitete Herstellerkataloge, ~36 MB Text unter `Aufbereitet/`)

---

## 1. Was das Programm ist

Ein Telegram-Bot, der **kein festverdrahteter Ablauf** ist, sondern:

- **Router-KI** ganz vorne (`kern/router.js`): entscheidet mit *einem* KI-Call gleichzeitig
  (a) welcher **Gesprächsfaden** (mehrere parallel möglich), (b) welche **Aktion**, (c) welcher **Experte**.
- **Experten-Plugins** in `experten/` – einfach durch neue Datei erweiterbar. Drei Bauarten:
  - `vorgang` – Schema + `finalisiere()`, wird vom generischen Slot-Filling-Motor gefahren
  - `prompt`  – `systemPromptAdd` + eigene Tools
  - `frei`    – eigenes `verarbeite()`
- **Vorgangs-Motor** (`kern/vorgangsmotor.js`): generisches Sammeln unvollständiger, unsortierter Eingaben
  → Extraktion → Delta-Operationen (`setze`, `liste_hinzu`, `liste_aendere`, …) → Lückenprüfung → Rückfrage →
  Bestätigung → Ausführung. Zustand pro Faden unter `data/users/<chatId>/themen/<themaId>/vorgang.json`.
- **Provider-Abstraktion** (`providers/`): Rollen `chat` / `extraktion` / `router` / `summary`, je Rolle Modell +
  Token-Budget, `AI_FALLBACK_KETTE` nur bei echten Ausfällen. Ziel: KI-Anbieter jederzeit austauschbar.
- **Dienste-Registry** (`dienste/`): ocr / transkription / suche / lesen als kleine, spezialisierte APIs
  (AssemblyAI, Mistral-OCR, Brave, Jina), per `<ART>_KETTE` konfigurierbar. Bewusst **deterministisch**.

**Leitlinien des Auftraggebers** (bitte beibehalten):
so viel KI wie möglich; deterministisch nur wo es viele Tokens frisst oder zu spezialisiert ist;
Webbrowsing bewusst deterministisch; keine hartcodierten Programmabläufe – jeder Programmteil per normalem
Chat erreichbar; Eingaben so unsortiert und unvollständig wie möglich annehmen.

---

## 2. Fertig und produktiv

- **Modularer Umbau** abgeschlossen (`bot.js` von 1134 → ~75 Zeilen; `kern/`, `adapter/telegram.js` ist die
  einzige Datei, die Telegram kennt).
- **Lager-Experte** komplett: Einlagern / Entnehmen / Reservieren / Freigeben (`experten/lager.js`),
  deterministische Buchungslogik in `material.js` (nie negativ, Positionen werden nie gelöscht,
  Reservierungen als `chatId:menge; chatId:menge` in eigener Spalte).
- **Lagerpflege** (`experten/lagerpflege.js`): Bestand absolut setzen/Inventur, Umbenennen, Kategorie,
  Einheit, Duplikate zusammenführen.
- **Zwei Excel-Dateien**: Arbeits-Excel (`lib/excel.js`, Blatt `Lager`, 7 Spalten) und getrennte
  visuelle Ausgabe (`lib/lager_export.js`, Kategorien als Zwischenüberschriften, Summen, 0-Bestände grau).
- **Massen-Import** aus PDF/Excel/Word in 1200-Zeichen-Stücken mit Retry und sichtbarer Lückenmeldung.
- **Wissensbasis Stufe 1** (`wissen/*.yaml` + `lib/wissen.js`): Artikelklassen mit Merkmalsstufen
  (pflicht / erwartet / optional), globale Merkmale mit `gilt_nicht_fuer`/`ersatz`, hierarchischer
  Warengruppenbaum + `einsatzbereiche`, Synonyme/Umgangssprache (Messing→Rotguss, schwarz→Stahlrohr),
  Maßsysteme (Zoll/DN/AD, nach Material getrennt), Einheiten/Gebinde (1 Stange = 6 m),
  Zulassungen mit Rangfolge, **lernende Attributerwartung** (`pruefeAnhebung()` → `gelernt.yaml`).

Tests: `tests/wissen.js`, `smoke.js`, `lager.js`, `e2e.js` – zuletzt **168 grün**.
`tests/live_*.js` sind manuell und kosten Tokens.

---

## 3. AKTUELLES ARBEITSZIEL (hier weitermachen)

**Die Wissensbasis gegen die echten Herstellerkataloge korrigieren.**

Ich habe die Kataloge (GC Installation / Heizung / Sanitär / Lüftung / Klima) tabellenweise ausgewertet und
das reale Merkmalsvokabular gezählt:
`RG 17969×, Oberfläche 3064×, VPE 2169×, Farbe 2043×, DN 1497×, Werksnr. 1491×, Ausführung 1438×`.

### Schon erledigt (aber **noch nicht committet**, `git status` zeigt sie als geändert)
- `wissen/merkmale.yaml`: neue globale Merkmale `oberflaeche` (Stufe *erwartet* – zweithäufigste
  Merkmalsspalte überhaupt), `ausfuehrung`, `vpe`, `farbe` (mit `gilt_nicht_fuer` für rohr/bogen/t_stueck/
  muffe/reduktion). Notiz: `artnr` heißt im Katalog *Werksnr.*
- `wissen/synonyme.yaml`: **Modellfehler behoben** – `verzinkt` war fälschlich als *Werkstoff* geführt
  (`verzinkt → stahl_verzinkt`). Jetzt eigene Gruppe `oberflaeche:` (vz/feuerverzinkt→verzinkt,
  chrom/cr→verchromt, nickel→vernickelt, blank/roh→blank, pulverbeschichtet). Zusätzlich Werkstoffe
  temperguss, c_stahl, bronze→siliziumbronze, guss→gusseisen, pex/pe-x→pe_x; Presssysteme prestabo,
  temponox, raxofix, smartpress, geopress (SC-Contur ist Viegas Sicherheitsmerkmal, **kein** Presssystem –
  bewusst nicht gelistet).

Verifiziert: `Kugelhahn → pflicht[dimension,zulassung] / erwartet[oberflaeche,anschluss] / optional[...]`,
`vz → {gruppe: oberflaeche, wert: verzinkt}`, `prestabo → {gruppe: presssystem, wert: viega_prestabo}`.

### Offen – nächste konkrete Schritte
1. **`wissen/dimensionen.yaml`**: DN6 = 1/8", DN8 = 1/4" ergänzen; unter `zoll_schreibweisen` die
   Katalogschreibweisen `1 1/4"` und `1 1/2"` neben 5/4 bzw. 6/4 aufnehmen.
2. **`wissen/zulassungen.yaml`**: Prüfzeichen aus den Katalogen ergänzen –
   DVGW (819×), KTW (136×), W270, WRAS (23×), KIWA (34×), ÖVGW (50×), PED (29×).
3. **`wissen/warengruppen.yaml` neu aufbauen**, informiert durch die echten Katalogkapitel
   (GC Installation A–R, Heizung A–O, Sanitär A–V, Lüftung A–M, Klima).
   **WICHTIG – nicht 1:1 abschreiben:** der Katalog trennt nach Material, was in unserem Modell ein
   *Merkmal* ist. „Press-Systeme aus Edelstahl / C-Stahl / Kupfer“ sind drei Kapitel, aber **eine**
   Warengruppe + Merkmal `material`. Der Baum muss merkmals-orthogonal bleiben.
4. `npm test` laufen lassen (zuletzt 168) und committen.

---

## 3a. KORREKTUR: Die Katalogauswertung ist NICHT fertig

Der vorige Abschnitt war zu optimistisch formuliert. Ehrlicher Stand:

**Ausgewertet waren nur 3 von 56 Dateien** (GC_Installation, GC_Heizung, GC_Sanitaer) und dort nur
die *Tabellenköpfe* — daraus stammt das Merkmalsvokabular (RG, Oberfläche, VPE, DN, Werksnr., Ausführung …).
Das war eine **Merkmals**-Auswertung, keine **Warengruppen**-Auswertung.

**Inzwischen nachgeholt** (Skripte und Rohdaten liegen unter `wissen/_katalogauswertung/`):

- `01_index_extrahieren.py` – zieht aus jedem Katalog das alphabetische Stichwortverzeichnis
  (`Begriff .......... Kapitelbuchstabe Seite`). Ergebnis: **28.606 Index-Einträge** über 16 Kataloge,
  roh in `index_roh.json`, Umfang je Katalog in `index_umfang.txt`.
  → Das ist ein vollständiges, vom Großhandel gepflegtes **Fachvokabular mit Kapitelzuordnung** und die
  mit Abstand beste Quelle für `warengruppen.yaml`. Bis jetzt war es ungenutzt.
- `02_artikelbegriffe.py` – filtert Marken/Serien heraus und liefert je Katalogkapitel die reinen
  **Artikelbegriffe** → `artikelbegriffe_je_kapitel.txt`.

**Wichtiger Befund aus dieser Auswertung:** In den Katalogen ist das häufigste Kopfwort fast überall
die **Marke**, nicht der Artikeltyp (Kapitel Heizung A: Brötje 70×, Vaillant 40×, erst dann
„Gas-Brennwert-Wandkessel" 12×). Für ein Lager ist das genau umgekehrt — dort ist der Artikeltyp die
Identität und die Marke ein Merkmal. Das bestätigt unser Modell, heißt aber: **die Katalogstruktur darf
nicht übernommen werden, nur ihr Vokabular.** Die Markenliste in `02_artikelbegriffe.py` (rund 300 Namen)
ist nebenbei ein brauchbarer Startbestand für ein Merkmal `marke`.

**Vollständige Kapitelstruktur liegt jetzt vor** für: Installation (A–R), Heizung (S, A–O), Sanitär (A–W),
Lüftung (A–M), Klima (A–G), Wasserwelt (A–F).

### Immer noch offen
1. **`warengruppen.yaml` aus `artikelbegriffe_je_kapitel.txt` neu aufbauen** — Kapitel als grobe
   Einsatzbereiche, Artikelbegriffe als Warengruppen/Artikelklassen. Weiterhin gilt: **merkmals-orthogonal
   bleiben** (Press-Systeme Edelstahl / C-Stahl / Kupfer sind drei Katalogkapitel, aber eine Warengruppe
   plus Merkmal `material`).
2. **Noch gar nicht angesehen:** `RF_Komplett_1/2` (R&F, 1930 Seiten — dauerhaft freigegebener Shop des
   Auftraggebers), `Sikla_Industrie_Anlagenbau` (Befestigungstechnik, direkt relevant für Rohrschellen),
   `GC_Ersatzteile_1–3`, `GC_Wasserwelt`, `GC_HOEG`, `GC_Kuechenarmaturen`, `GC_Lueftung_2`.
   Die 35 `UniElektro_*`-Dateien und `GC_Elektro_*` sind Elektromaterial — vermutlich außerhalb des
   SHK-Scopes, das sollte der Auftraggeber entscheiden.
3. **Zulassungen und Dimensionen** (Punkte 1 und 2 aus Abschnitt 3) sind weiterhin unerledigt.
4. Aus dem Volltext (nicht nur dem Index) ließen sich noch **Artikelklassen-Pflichtmerkmale** empirisch
   belegen — welche Spalten stehen bei Rohren, welche bei Bögen, welche bei Kugelhähnen tatsächlich immer?
   Das wäre die sauberste Absicherung für `artikelklassen.yaml`, ist aber noch nicht gemacht.

---

## 4. Roadmap danach (mit dem Auftraggeber abgestimmt)

- **Stufe 2** – Merkmals-Spalte in der Arbeits-Excel; Identität einer Position über Merkmale statt über den
  Namensstring; gezielte Rückfragen im laufenden Vorgang.
- **Stufe 3** – **Chargen + FIFO**: jede Einlagerung eigene Charge im Arbeitsblatt; in der Lageristen-Übersicht
  werden alle Chargen exakt gleichen Typs zu **einer** Position zusammengefasst (Charge dort ignoriert).
- **Stufe 4** – **Austauschbarkeit**: Kandidatensuche über Merkmale, Zulassungs-Rangfolge,
  Rückfrage „müssen sie gleich aussehen?“ bei Entnahme/Reservierung.
- **Stufe 5** – **Dazulernen mit Bestätigung** (Vorschlag → Nutzer bestätigt → `gelernt.yaml`).

---

## 5. Fallen, die schon Blut gekostet haben

- **`.git/index.lock` lässt sich im Mount nicht löschen** („Operation not permitted“). Workaround vor jedem
  git-Befehl: `mv .git/*.lock .git/stale/ 2>/dev/null`. `.git/stale/` steht in `.gitignore`.
- **MiniMax liefert Fehler in HTTP 200** über `base_resp.status_code` – `res.ok` allein reicht nicht.
  `MiniMax-M2-mini` existiert nicht; kein Light-Modell raten.
- **Reasoning-Modelle**: Reasoning-Tokens zählen gegen `max_tokens` → leerer `content`.
  `reasoning_content` wird nur für JSON-Aufrufer geborgen.
- **`findePosition` darf nicht unscharf matchen.** Ein gemeinsames Wort reichte früher → „Winkel DN40“ wurde
  auf „Winkel DN25“ gebucht. Jetzt Gleichheit über `kennzahlen()` (Ziffern-Tokens) **und** `wortmenge()`
  (Nicht-Ziffern-Wörter). Bidirektionales „enthält“ ist ebenfalls unsicher und wurde entfernt.
- **Synonyme dürfen die Bezeichnung nicht umschreiben** („Schwarzrohr DN50“ wurde zu „stahl DN50“).
  Bezeichnung bleibt unangetastet; Materialerkennung über `materialErkennen()`.
- **YAML**: deutsche Schlusszeichen `"` in doppelt gequoteten Strings brechen den Parser → einfache Quotes.
- **Struktur-Test**: der Kern darf keine Expertennamen enthalten – auch nicht in Kommentaren in Anführungszeichen.

---

## 6. Git-Stand

- Branch **`umbau/modulare-architektur`**, letzter Commit `cf1e01e`.
- `origin/umbau/modulare-architektur` existiert bereits.
- **Offen im Working Tree:** `wissen/merkmale.yaml`, `wissen/synonyme.yaml` (Katalogkorrekturen aus §3)
  sowie das neue Verzeichnis `wissen/_katalogauswertung/` (§3a). `index_roh.json` ist 1,2 MB —
  entweder mitcommitten (ist reine Textstruktur, komprimiert gut) oder in `.gitignore` und per Skript
  neu erzeugen; die Skripte liegen daneben.
- Merge nach `main` löst das Railway-Deployment aus. Beim lokalen Testen Railway pausieren,
  sonst kollidiert das Telegram-Polling.
