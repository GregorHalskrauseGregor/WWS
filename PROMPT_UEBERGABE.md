# Übergabe-Prompt (zum Kopieren)

Ordner mitgeben: nur `C:\_M REDUX\Github\WWS` — die Kataloge liegen als Unterordner
`Kataloge Shops/` darin. Dann folgenden Text als ersten Prompt einfügen.

---

Du übernimmst ein laufendes Projekt. Arbeite auf Deutsch.

**Erster Schritt, bevor du irgendetwas änderst:** Lies `UEBERGABE.md` im Projektordner vollständig.
Dort steht die Architektur, der aktuelle Stand, die offenen Aufgaben und eine Liste von Fallstricken,
die schon Fehler verursacht haben. Lies danach in dieser Reihenfolge:

1. `wissen/*.yaml` (alle acht Dateien, zusammen unter 20 KB)
2. `lib/wissen.js` — die Engine, die diese YAMLs auswertet
3. `wissen/_katalogauswertung/artikelbegriffe_je_kapitel.txt` — das aus den Herstellerkatalogen
   extrahierte Fachvokabular je Katalogkapitel

Lies **nicht** `node_modules/`, nicht `tests/_alt_wiederaufgetaucht/`, nicht `tests/_veraltete_kopien/`
und vor allem nicht den Unterordner `Kataloge Shops/` am Stück — der enthält 56 Katalog-Rohtexte mit
zusammen 36 MB und sprengt jeden Kontext. Wenn du in die Kataloge musst, arbeite mit `grep` oder einem
kurzen Python-Skript über `Kataloge Shops/Aufbereitet/*.txt` und lies nur das Ergebnis.

## Deine Aufgabe

`wissen/warengruppen.yaml` neu aufbauen, informiert durch die echten Katalogkapitel.

Der bestehende Baum wurde von mir aus dem Bauchgefühl geschrieben, bevor die Kataloge vorlagen.
In `wissen/_katalogauswertung/` liegen jetzt 28.606 Index-Einträge aus 16 Großhandelskatalogen
(`index_roh.json`, erzeugt von `01_index_extrahieren.py`) und daraus die markenbereinigten
Artikelbegriffe je Kapitel (`artikelbegriffe_je_kapitel.txt`, erzeugt von `02_artikelbegriffe.py`).
Diese beiden Skripte erwarten die Katalogtexte im Arbeitsverzeichnis; führe sie also aus
`Kataloge Shops/Aufbereitet/` aus, wenn du sie neu laufen lassen willst. Die fertigen Ergebnisse
liegen aber schon da — du musst sie nur lesen, nicht neu erzeugen.

**Die wichtigste Regel dabei — daran ist die erste Fassung fast gescheitert:**
Der Katalog gliedert nach Material, was in diesem Modell ein *Merkmal* ist.
„Press-Systeme aus Edelstahl" / „aus C-Stahl" / „aus Kupfer" sind drei Katalogkapitel (B, C, D in
GC_Installation), aber **eine** Warengruppe `pressfitting` plus Merkmal `material`.
Der Baum muss merkmals-orthogonal bleiben: was als Merkmal darstellbar ist, wird **kein** Ast.
Übernimm also das **Vokabular** der Kataloge, nicht ihre **Struktur**.

Zweiter Befund, den du kennen musst: im Katalog ist das häufigste Kopfwort fast überall die **Marke**
(Heizung Kapitel A: Brötje 70×, Vaillant 40×, erst dann „Gas-Brennwert-Wandkessel" 12×). Im Lager ist
es umgekehrt — der Artikeltyp ist die Identität, die Marke ein Merkmal. Nimm Marken nicht als Warengruppe.

## Danach, in dieser Reihenfolge

1. `wissen/dimensionen.yaml`: DN6 = 1/8", DN8 = 1/4" ergänzen; unter `zoll_schreibweisen` die
   Katalogschreibweisen `1 1/4"` und `1 1/2"` neben 5/4 bzw. 6/4 aufnehmen.
2. `wissen/zulassungen.yaml`: DVGW, KTW, W270, WRAS, KIWA, ÖVGW, PED ergänzen (alle in den Katalogen belegt).
3. `npm test` — zuletzt 168 Tests grün. Wenn ein Test rot wird, **repariere den Code, nicht den Test.**
   Ein Test hat hier schon zweimal eine echte Regression gefangen.
4. Committen. Branch ist `umbau/modulare-architektur`.

## Harte Regeln für dieses Projekt

- **Deutsch im Code**: Bezeichner, Kommentare und alle Bot-Antworten sind deutsch. Halte das durch.
- **Der Kern kennt keine Experten.** `kern/*.js` darf keinen Expertennamen enthalten — auch nicht in
  einem Kommentar in Anführungszeichen. Ein Test prüft das.
- **Keine hartcodierten Programmabläufe.** Jeder Programmteil muss über normalen Chat erreichbar sein.
- **Synonyme dürfen die Bezeichnung einer Lagerposition nie umschreiben.** „Schwarzrohr DN50" wurde
  einmal zu „stahl DN50" — die Position war damit unauffindbar.
- **Positionsvergleich bleibt streng.** Gleichheit über Ziffern-Tokens *und* Wortmenge. Unscharfes
  Matching hat „Winkel DN40" auf „Winkel DN25" gebucht. Lockere das nicht.
- **YAML**: keine deutschen Schlusszeichen (") in doppelt gequoteten Strings — bricht den Parser.
  Nimm einfache Quotes.
- **git**: `.git/index.lock` lässt sich in diesem Mount nicht löschen. Vor jedem git-Befehl
  `mv .git/*.lock .git/stale/ 2>/dev/null` voranstellen.
- **`Kataloge Shops/` gehört nicht ins Repo.** Der Ordner liegt nur als Arbeitsmaterial im Projekt.
  Trag ihn in `.gitignore` ein, falls er dort noch fehlt, und commite ihn auf keinen Fall mit.
- Frag lieber einmal nach, als eine Struktur zu raten. Der Auftraggeber ist SHK-Fachmann und kann
  fachliche Fragen sofort beantworten.

## Was du NICHT anfassen sollst

Die Roadmap-Stufen 2–5 (Merkmalsspalte in der Excel, Chargen/FIFO, Austauschbarkeit, Dazulernen) sind
beschrieben, aber noch nicht dran. Erst die Wissensbasis sauber machen.
