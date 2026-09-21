# Werkzeug-Registry

Das hier ist die Andockstelle für alle Werkzeuge des Bots. Wer ein Tool
anschließen will, schreibt hier einen Block. Wer eins abklemmen will, setzt
`Aktiv: nein` oder löscht den Block. **Kein Code-Umbau nötig.**

Der Router liest diese Datei bei jedem Start. Nur Werkzeuge mit `Aktiv: ja`
werden ihm überhaupt zur Wahl gestellt.

### Format

Jeder Block beginnt mit `## <id>`. Die id muss der `id` im Modul entsprechen
(z. B. `id: 'bestellung'` in `experten/bestellung.js`).

| Feld | Pflicht | Bedeutung |
|---|---|---|
| `Name` | nein | Klarname für Anzeigen. Fehlt er, wird die id genommen. |
| `Aktiv` | nein | `ja` (Standard) oder `nein`. `nein` = der Router sieht das Werkzeug nicht. |
| `Modul` | nein | Pfad zum Code, relativ zur Projektwurzel. Nur zur Dokumentation — geladen wird weiterhin automatisch alles aus `experten/`. |
| `Prompt` | nein | Pfad zu einer `.md`, deren Inhalt zusätzlich in den Prompt des Werkzeugs wandert. |
| `Braucht` | nein | Kommaliste anderer Werkzeug-ids, die dieses Werkzeug mitbenutzt. Wird transitiv aufgelöst. |
| `Wann` | nein | Fließtext: wann soll der Router dieses Werkzeug wählen? **Leer lassen = der Text aus dem Modul (`zustaendigWenn`) gilt weiter.** Steht hier etwas, überschreibt es den Modul-Text. |

`Wann:` ist immer der **letzte** Schlüssel im Block — alles danach bis zur
nächsten `##`-Überschrift gehört dazu und darf beliebig lang sein.

### Ein neues Werkzeug anschließen

1. Modul unter `experten/<id>.js` anlegen (Vorlage: `experten/_template.js`).
2. Hier einen Block ergänzen.
3. Bot neu starten. Fertig — der Router kennt das Werkzeug.

---

## bestellung
Name: Material bestellen
Aktiv: ja
Modul: experten/bestellung.js
Braucht: lager, grosshandel
Wann:

## grosshandel
Name: Großhandel-Bestellung (GC/RNF)
Aktiv: ja
Modul: experten/grosshandel.js
Braucht: lager
Wann:

## lager
Name: Lager buchen
Aktiv: ja
Modul: experten/lager.js
Braucht: lagerauskunft
Wann:

## lagerauskunft
Name: Lagerauskunft
Aktiv: ja
Modul: experten/lagerauskunft.js
Braucht:
Wann:

## lagerliste
Name: Lagerliste als Datei
Aktiv: ja
Modul: experten/lagerliste.js
Braucht: lagerauskunft
Wann:

## lagerpflege
Name: Lagerzeilen berichtigen
Aktiv: ja
Modul: experten/lagerpflege.js
Braucht: lagerauskunft
Wann:

## materialaufmass
Name: Aufmaß dokumentieren
Aktiv: ja
Modul: experten/materialaufmass.js
Braucht: lager, wissenspflege
Wann:

## recherche
Name: Recherche
Aktiv: ja
Modul: experten/recherche.js
Braucht:
Wann:

## wissenspflege
Name: Wissenspflege
Aktiv: ja
Modul: experten/wissenspflege.js
Braucht:
Wann:

## projektordner
Name: Projektordner
Aktiv: ja
Modul: experten/projektordner.js
Braucht:
Wann:
Der Nutzer will mit den Unterlagen EINES PROJEKTS arbeiten. Sechs Dinge fallen
darunter.
ABLEGEN: ein Dokument, ein Foto, eine Datei oder ein Freitext-Hinweis gehört zu
einem Projekt ("pack das zum Projekt Sportklinik", "leg den Lieferschein ab",
"notier für 26-0061: Zufahrt nur über die Südseite").
BEFRAGEN: eine Frage, die sich nur aus den gesammelten Unterlagen beantworten
lässt — Lieferscheine in einem Zeitraum, geltende Regeln auf der Baustelle,
Ansprechpartner, ein Überschlag der bisherigen Projektkosten gegen die
Angebotssumme, "was haben wir zu X abgelegt".
AUSLESEN: der Inhalt einer bestimmten abgelegten Datei soll gezeigt werden
("was steht im Lieferschein 88213").
AUSGEBEN: eine abgelegte Datei soll als Datei zurückkommen ("schick mir den
Lieferschein", "ich brauch die Materialliste zum Weiterleiten").
BEARBEITEN: eine abgelegte Textdatei oder Excel-Tabelle soll geändert werden
("trag in der Materialliste 14 statt 10 ein", "ergänze in den Baustellenregeln
die Helmpflicht"). PDF, Fotos und Word kann der Bot nicht ändern und sagt das.
ERZEUGEN und AUFRÄUMEN: ein neues Dokument aus dem Ordnerinhalt bauen ("mach
mir eine Kostenübersicht als Excel", "Baustellenbericht als PDF") oder den
Ordner sortieren und benennen.
Auch zuständig, wenn der Nutzer einen neuen Projektordner anlegen oder wissen
will, welche Projekte oder welche Dateien es gibt. NICHT zuständig für das
Buchen von Lagerbeständen (das ist `lager`), nicht für das Erstellen eines
Aufmaßes (das ist `materialaufmass`) und nicht für Bestellungen beim Großhandel
(das ist `bestellung`) — wohl aber dafür, ein fertiges Aufmaß oder eine
Bestellbestätigung im Projektordner abzulegen.

## leistungserfassung
Name: Leistungserfassung
Aktiv: nein
Modul: experten/leistungserfassung.js
Braucht:
Wann:
