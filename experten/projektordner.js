// Projektordner — Unterlagen sammeln, befragen, herausgeben und bearbeiten.
//
// Die Dateiarbeit selbst steckt in lib/projektablage.js und ist dort ohne KI
// und ohne Telegram testbar. Hier steht nur, WAS getan werden soll: die
// Absichtserkennung, die Prompts und die Antworten an den Nutzer.
//
// ══════════════════════════════════════════════════════════════════════════
// WAS DER BOT MIT DATEIEN KANN — UND WO DIE GRENZE LIEGT
// ══════════════════════════════════════════════════════════════════════════
//
//   ablegen    alles. Der ausgelesene Text wird einmal gesichert.
//   auslesen   alles, was beim Ablegen Text hergegeben hat.
//   ausgeben   jede Originaldatei zurück nach Telegram (bis 45 MB, max. 10).
//   bearbeiten NUR verlustfrei:
//                .txt .md .csv .json  — der Bot schreibt sie um
//                .xlsx                — zellweise, die Mappe bleibt erhalten
//              NICHT: PDF, Fotos, Word. Die kann kein Bot ehrlich ändern.
//              Stattdessen bietet er an, ein NEUES Dokument daraus zu bauen.
//   erzeugen   neue Dokumente aus dem Ordnerinhalt (.xlsx .pdf .md .csv .txt)
//   aufräumen  umbenennen, in Unterordner sortieren, ins Archiv schieben
//
// Zwei Sicherheiten sind hart verdrahtet (siehe lib/projektablage.js):
// vor jeder Änderung wandert die alte Fassung nach versionen/, und gelöscht
// wird nie — aussortiert heißt nach archiv/ verschoben.

const ablage = require('../lib/projektablage');
const { extrahiere } = require('../kern/json');

// Wie viel Text einer Datei direkt in den Chat darf, bevor gekürzt wird.
const CHAT_AUSZUG = 3000;
// Ab dieser Größe darf das Modell eine Textdatei nicht mehr komplett
// neu schreiben — dann nur noch gezielte Ersetzungen.
const NEUSCHREIB_GRENZE = 12_000;

// ───────────────────────────────────────────────────────── Absicht (KI)

const ABSICHT_PROMPT = `Du ordnest eine Nachricht in einem Handwerker-Bot genau einer Aktion zu.
Antworte NUR mit einem JSON-Objekt, ohne Erklärung, ohne Codeblock.

AKTIONEN:
- "anlegen"    neues Projekt / neuen Projektordner anlegen
- "liste"      wissen, welche Projekte es gibt
- "wechseln"   ein anderes bestehendes Projekt zum aktiven machen
- "dateien"    wissen, welche Dateien im Projektordner liegen
- "notiz"      eine Information festhalten (Regel, Ansprechpartner, Absprache, Zahl)
- "auslesen"   den INHALT einer bestimmten Datei sehen/vorgelesen bekommen
- "ausgeben"   eine Datei als DATEI zurückgeschickt bekommen (herunterladen, weiterleiten, drucken)
- "bearbeiten" eine vorhandene Datei ÄNDERN (korrigieren, ergänzen, Zeile einfügen, umformulieren)
- "erzeugen"   ein NEUES Dokument aus dem Ordnerinhalt erstellen (Übersicht, Zusammenstellung, Auswertung)
- "aufraeumen" Dateien umbenennen, sortieren, aussortieren
- "frage"      eine Frage, die aus den abgelegten Unterlagen beantwortet werden muss

ABGRENZUNGEN, die oft verwechselt werden:
- "Was steht im Lieferschein?" -> auslesen.   "Schick mir den Lieferschein" -> ausgeben.
- "Was hat das Material gekostet?" -> frage (Antwort aus mehreren Dokumenten).
- "Trag in der Materialliste 5 statt 3 ein" -> bearbeiten.
- "Mach mir eine Kostenübersicht" -> erzeugen (etwas Neues entsteht).
- "Benenn die Fotos vernünftig" -> aufraeumen.

FELDER:
- "projekt"  genannter Projektname oder -nummer, sonst null
- "datei"    bei auslesen/ausgeben/bearbeiten: das Suchwort für die Datei
             ("lieferschein", "materialliste", "das foto von gestern"),
             oder "alle" bzw. eine Kategorie, wenn mehrere gemeint sind. Sonst null.
- "auftrag"  bei bearbeiten/erzeugen/aufraeumen: was genau getan werden soll, in einem Satz
- "inhalt"   nur bei notiz: der festzuhaltende Text, sauber formuliert
- "format"   nur bei erzeugen: "xlsx" (Tabelle), "pdf" (zum Weitergeben/Drucken),
             "md" (Text), "csv". Im Zweifel "xlsx" bei Zahlen, sonst "md".
- "name"     nur bei erzeugen: ein sprechender Dateiname ohne Endung

FORMAT:
{"aktion":"…","projekt":null,"datei":null,"auftrag":null,"inhalt":null,"format":null,"name":null}`;

async function bestimmeAbsicht(dienste, text, projekte, aktiv, dateien) {
  const kontext = [
    `Bekannte Projekte: ${projekte.length ? projekte.map((p) => p.name).join(', ') : '(noch keine)'}`,
    `Aktives Projekt: ${aktiv ? aktiv.name : '(keins)'}`,
    dateien && dateien.length
      ? `Dateien im aktiven Projekt: ${dateien.slice(0, 40).map((d) => d.name).join(', ')}`
      : 'Dateien im aktiven Projekt: (noch keine)',
    '',
    'NACHRICHT:',
    text
  ].join('\n');
  try {
    const roh = await dienste.chat(ABSICHT_PROMPT, kontext);
    const j = extrahiere(roh);
    if (j && typeof j === 'object' && j.aktion) return j;
  } catch { /* Rückfall unten */ }
  return { aktion: 'frage', projekt: null, datei: null, auftrag: null, inhalt: null };
}

// ─────────────────────────────────────────────────────────── Prompts

function baueFragePrompt(projektName) {
  return `Du beantwortest Fragen zu einem Bauprojekt ausschließlich anhand der unten mitgelieferten Projektunterlagen.

Projekt: ${projektName}

REGELN — daran hängt die Verlässlichkeit:
- Antworte NUR mit dem, was in den Unterlagen steht. Erfinde nichts, ergänze kein Fachwissen von außen.
- Steht die Antwort nicht in den Unterlagen, sag das klar: "Dazu liegt im Projektordner nichts vor."
- Nenne bei jeder Aussage, aus welchem Dokument sie stammt (Dateiname in Klammern).
- Bei Fragen nach einem Zeitraum: prüfe die Datumsangaben in den Dokumenten und nenne nur Treffer im Zeitraum.
- Bei Summen und Überschlägen: rechne Schritt für Schritt, zeig die Posten, und kennzeichne ausdrücklich,
  was du addiert hast und was in den Unterlagen fehlt. Lieber eine ehrliche Lücke als eine glatte Zahl.
- Antworte knapp und in Fließtext. Keine Wiederholung der Frage.`;
}

const TEXT_BEARBEITEN_PROMPT = `Du änderst eine Textdatei aus einem Projektordner im Handwerksbetrieb.
Antworte NUR mit einem JSON-Objekt, ohne Erklärung, ohne Codeblock.

ZWEI WEGE:
1. Gezielte Ersetzungen — der Normalfall, weil nichts anderes kaputtgehen kann:
   {"modus":"ersetzen","aenderungen":[{"suchen":"<exakter Text aus der Datei>","ersetzen":"<neuer Text>"}]}
   "suchen" muss ZEICHENGENAU so in der Datei stehen und darf dort nur EINMAL vorkommen.
   Nimm genug Umgebung mit, damit die Stelle eindeutig ist. Zum Löschen: "ersetzen":""
2. Anhängen — wenn nur etwas hinzukommt:
   {"modus":"anhaengen","text":"<was ans Ende kommt>"}
3. Komplett neu — NUR wenn der Auftrag die ganze Datei betrifft (umstrukturieren, neu ordnen):
   {"modus":"neu","inhalt":"<vollständiger neuer Dateiinhalt>"}

REGELN:
- Ändere ausschließlich, was der Auftrag verlangt. Fasse dich nicht an Stellen an, die nicht gemeint sind.
- Erfinde keine Zahlen, Namen oder Daten. Fehlt eine Angabe, lass die Stelle in Ruhe.
- Geht der Auftrag nicht: {"modus":"nicht_moeglich","grund":"<ein Satz>"}`;

const EXCEL_BEARBEITEN_PROMPT = `Du änderst eine Excel-Tabelle aus einem Projektordner im Handwerksbetrieb.
Du bekommst die Tabelle mit Zellbezügen (A1, B7 …). Antworte NUR mit einem JSON-Objekt.

{"aenderungen":[
  {"blatt":"<Blattname>","zelle":"B7","wert":"<neuer Wert>"},
  {"blatt":"<Blattname>","aktion":"zeile_anhaengen","werte":["…","…"]},
  {"blatt":"<Blattname>","aktion":"zeile_loeschen","zeile":12}
]}

REGELN:
- Nur Zellen anfassen, die der Auftrag betrifft. Jede andere Zelle bleibt unangetastet.
- Zahlen als ZAHL zurückgeben (7.5), nicht als Text ("7,5").
- Neue Zeilen in der Spaltenreihenfolge der Kopfzeile.
- Zeilennummern beziehen sich auf die Tabelle, wie sie dir gezeigt wurde.
- Geht der Auftrag nicht: {"aenderungen":[],"grund":"<ein Satz>"}`;

function baueErzeugenPrompt(format, projektName) {
  const gemeinsam = `Du erstellst ein neues Dokument für das Bauprojekt "${projektName}" aus den mitgelieferten Projektunterlagen.

REGELN:
- Nur Angaben verwenden, die in den Unterlagen stehen. Nichts erfinden, nichts schätzen.
- Fehlt etwas, schreib es ausdrücklich als Lücke hin ("nicht in den Unterlagen") statt es zu ergänzen.
- Zahlen nachrechnen und die Posten zeigen, aus denen eine Summe entsteht.`;

  if (format === 'xlsx' || format === 'csv') {
    return `${gemeinsam}

Antworte NUR mit einem JSON-Objekt:
{"blaetter":[{"blatt":"<Name>","spalten":["Spalte 1","Spalte 2"],"zeilen":[["Wert","Wert"]]}]}

- Erste Zeile sind die Spaltenüberschriften (im Feld "spalten", nicht in "zeilen").
- Zahlen als Zahl, nicht als Text.
- Eine Summenzeile am Ende, wenn es etwas zu summieren gibt.`;
  }
  return `${gemeinsam}

Antworte mit dem fertigen Dokument als Text. Überschriften mit #, Aufzählungen mit -.
Kein Vorwort, keine Erklärung, kein Codeblock — nur das Dokument selbst.`;
}

const AUFRAEUMEN_PROMPT = `Du räumst einen Projektordner im Handwerksbetrieb auf.
Du bekommst die Dateiliste mit einem kurzen Auszug aus jedem Dokument.
Antworte NUR mit einem JSON-Objekt.

{"plan":[
  {"datei":"<exakter Dateiname aus der Liste>","neuerName":"<oder null>","kategorie":"<oder null>","archivieren":false}
]}

REGELN:
- Kategorien sind Unterordner. Nimm wenige, klare: lieferscheine, rechnungen, plaene, fotos,
  aufmasse, schriftverkehr, sonstiges. Erfinde keine Kategorie für eine einzelne Datei.
- Neue Namen: Datum voran, dann Inhalt, dann Nummer. Beispiel:
  "2026-01-14_lieferschein_gc_88213.pdf". Endung IMMER behalten.
- "archivieren": nur bei offensichtlichem Ausschuss (Doppelte, unlesbare Fotos, Fehlversuche).
  Im Zweifel nicht archivieren. Gelöscht wird ohnehin nichts.
- Dateien, an denen nichts zu tun ist, lässt du weg.`;

// ──────────────────────────────────────────────────────── kleine Helfer

// Trennt den beim Ablegen erzeugten Kopf ("# name", "Abgelegt: …") vom
// eigentlichen Dokumenttext. Roh in den Chat gehört der Kopf nicht — er
// verdoppelt nur, was in der Überschrift ohnehin steht.
function trenneKopf(gespeicherterText) {
  const zeilen = String(gespeicherterText || '').split('\n');
  const kopf = [];
  let i = 0;
  if (zeilen[0] && zeilen[0].startsWith('# ')) i = 1;
  while (i < zeilen.length && /^(Abgelegt|Erstellt|Bearbeitet|Notiz dazu|Änderung):/.test(zeilen[i])) {
    kopf.push(zeilen[i]); i++;
  }
  while (i < zeilen.length && !zeilen[i].trim()) i++;
  return { kopf, rumpf: zeilen.slice(i).join('\n') };
}

function kuerze(text, max = CHAT_AUSZUG) {
  const t = String(text || '');
  if (t.length <= max) return { text: t, gekuerzt: false };
  return { text: t.slice(0, max), gekuerzt: true };
}

function dateiZeile(e) {
  return `• \`${e.name}\`` +
    (e.kategorie ? ` _[${e.kategorie}]_` : '') +
    ` — ${e.art}, ${Math.max(1, Math.round(e.groesse / 1024))} kB` +
    (e.hatOriginal ? '' : ', nur Text') +
    (e.bearbeitbar ? ', bearbeitbar' : '');
}

function trefferListe(treffer, max = 8) {
  return treffer.slice(0, max).map((e) => `• \`${e.name}\`` + (e.kategorie ? ` _[${e.kategorie}]_` : '')).join('\n');
}

// Ein Dokument aus einem Suchwort bestimmen. Bei Mehrdeutigkeit KEINE Wahl
// treffen, sondern zurückfragen — bei Baustellendokumentation ist ein falsch
// erwischter Lieferschein teurer als eine Rückfrage.
function bestimmeDatei(slug, suchwort) {
  const treffer = ablage.finde(slug, suchwort);
  if (!treffer.length) return { fehler: 'nicht_gefunden', treffer };
  if (treffer.length > 1 && treffer[0].punkte === treffer[1].punkte) {
    return { fehler: 'mehrdeutig', treffer };
  }
  return { eintrag: treffer[0], treffer };
}

// "alle", "alle fotos", "die lieferscheine" — mehrere Dateien auf einmal.
function meintMehrere(suchwort) {
  const s = String(suchwort || '').toLowerCase();
  return /\balle\b|\bsämtliche\b|\bsaemtliche\b|\bkomplett/.test(s);
}

function mehrfachAuswahl(slug, suchwort) {
  const alle = ablage.index(slug);
  const s = String(suchwort || '').toLowerCase()
    .replace(/\balle\b|\bsämtliche\b|\bsaemtliche\b|\bkomplett\w*\b|\bdie\b|\bden\b|\bder\b/g, '').trim();
  if (!s) return alle;
  const gefiltert = ablage.finde(slug, s);
  return gefiltert.length ? gefiltert : alle;
}

// ────────────────────────────────────────────────────────── auslesen

async function auslesen(ziel, absicht) {
    const such = absicht.datei || absicht.auftrag || '';
    const r = bestimmeDatei(ziel.slug, such);
    if (r.fehler === 'nicht_gefunden') {
      const alle = ablage.index(ziel.slug);
      return {
        text: `📁 „${such}" finde ich in *${ziel.name}* nicht.\n\n` +
          (alle.length ? 'Im Ordner liegt:\n' + alle.slice(0, 15).map(dateiZeile).join('\n') : 'Der Ordner ist leer.')
      };
    }
    if (r.fehler === 'mehrdeutig') {
      return { text: `📁 Welche meinst du?\n${trefferListe(r.treffer)}` };
    }
    const e = r.eintrag;
    const inhalt = ablage.leseText(e);
    if (!inhalt) {
      return {
        text: `📁 Von \`${e.name}\` ist kein Text gesichert — beim Ablegen war nichts auslesbar ` +
          `(z. B. ein Foto ohne erkennbare Schrift).\n\nIch kann dir die Datei aber schicken: ` +
          `„schick mir ${e.name}".`
      };
    }
    const { kopf, rumpf } = trenneKopf(inhalt);
    if (!rumpf.trim()) {
      return { text: `📁 In \`${e.name}\` steht kein auslesbarer Text — nur die Datei selbst liegt vor.` };
    }
    const k = kuerze(rumpf);
    return {
      text: `📄 *${e.name}*${e.kategorie ? ` _[${e.kategorie}]_` : ''}\n` +
        (kopf.length ? `_${kopf.join(' · ')}_\n` : '') + `\n${k.text}` +
        (k.gekuerzt ? `\n\n_… gekürzt (${rumpf.length} Zeichen gesamt). Ganze Datei: „schick mir ${e.name}"._` : '')
    };
}

// ─────────────────────────────────────────────────────────── ausgeben

async function ausgeben(ziel, absicht) {
    const such = absicht.datei || absicht.auftrag || '';
    let auswahl;
    if (!such.trim() || meintMehrere(such)) {
      auswahl = mehrfachAuswahl(ziel.slug, such);
    } else {
      const r = bestimmeDatei(ziel.slug, such);
      if (r.fehler === 'nicht_gefunden') {
        const alle = ablage.index(ziel.slug);
        return {
          text: `📁 „${such}" finde ich in *${ziel.name}* nicht.\n\n` +
            (alle.length ? 'Im Ordner liegt:\n' + alle.slice(0, 15).map(dateiZeile).join('\n') : 'Der Ordner ist leer.')
        };
      }
      if (r.fehler === 'mehrdeutig') return { text: `📁 Welche meinst du?\n${trefferListe(r.treffer)}` };
      auswahl = [r.eintrag];
    }

    if (!auswahl.length) return { text: `📁 Im Ordner *${ziel.name}* liegt nichts zum Verschicken.` };

    const { raus, abgelehnt } = ablage.sendbar(auswahl);
    if (!raus.length) {
      return {
        text: `📁 Konnte nichts verschicken:\n` +
          abgelehnt.map((a) => `• \`${a.name}\` — ${a.grund}`).join('\n')
      };
    }
    return {
      text: `📁 Aus *${ziel.name}*: ${raus.length} Datei(en).` +
        (abgelehnt.length ? '\n\nNicht dabei:\n' + abgelehnt.map((a) => `• \`${a.name}\` — ${a.grund}`).join('\n') : ''),
      dateien: raus.map((e) => e.abs)
    };
}

// ───────────────────────────────────────────────────────── bearbeiten

async function bearbeiten(ziel, absicht, text, dienste) {
    const auftrag = (absicht.auftrag || text || '').trim();
    const such = absicht.datei || '';

    // Sonderfall Notizen: die haben keinen Dateinamen im Index.
    if (/notiz/i.test(such) || /notiz/i.test(auftrag)) {
      return bearbeiteNotizen(ziel, auftrag, dienste);
    }

    const r = bestimmeDatei(ziel.slug, such);
    if (r.fehler === 'nicht_gefunden') {
      const alle = ablage.index(ziel.slug);
      return {
        text: `📁 „${such}" finde ich in *${ziel.name}* nicht.\n\n` +
          (alle.length ? 'Bearbeitbar sind:\n' + alle.filter((e) => e.bearbeitbar).map(dateiZeile).join('\n')
                       : 'Der Ordner ist leer.')
      };
    }
    if (r.fehler === 'mehrdeutig') return { text: `📁 Welche meinst du?\n${trefferListe(r.treffer)}` };

    const e = r.eintrag;

    // Die ehrliche Grenze: PDF, Foto und Word kann kein Bot verlustfrei ändern.
    if (!e.bearbeitbar) {
      return {
        text: `📁 \`${e.name}\` kann ich nicht ändern.\n\n` +
          `Verlustfrei bearbeiten kann ich nur Textdateien (.txt .md .csv .json) und Excel-Tabellen ` +
          `(.xlsx). Eine ${e.art === 'pdf' ? 'PDF' : e.art === 'bild' ? 'Bilddatei' : 'Word-Datei'} ` +
          `umzuschreiben würde bedeuten, sie neu zu bauen — dabei geht Layout verloren und im ` +
          `Zweifel merkt es niemand.\n\n` +
          `Was geht: Ich baue dir aus dem Inhalt ein NEUES Dokument. Sag z. B. ` +
          `„mach daraus eine Übersicht als Excel".`
      };
    }

    if (e.art === 'tabelle') return bearbeiteExcel(ziel, e, auftrag, dienste);
  return bearbeiteText(ziel, e, auftrag, dienste);
}

async function bearbeiteText(ziel, e, auftrag, dienste) {
    const inhalt = ablage.leseRoh(e);
    if (inhalt == null) return { text: `📁 \`${e.name}\` lässt sich nicht lesen.` };

    const prompt = TEXT_BEARBEITEN_PROMPT +
      (inhalt.length > NEUSCHREIB_GRENZE
        ? `\n\nDie Datei ist groß (${inhalt.length} Zeichen). "modus":"neu" ist hier NICHT erlaubt — nutze "ersetzen" oder "anhaengen".`
        : '');

    const roh = await dienste.chat(prompt, [
      `DATEI: ${e.name}`,
      `AUFTRAG: ${auftrag || '(kein Auftrag erkennbar)'}`,
      '',
      'AKTUELLER INHALT:',
      inhalt
    ].join('\n'));

    const j = extrahiere(roh);
    if (!j || j.modus === 'nicht_moeglich') {
      return { text: `📁 Das geht so nicht: ${(j && j.grund) || 'Der Auftrag war nicht eindeutig genug.'}` };
    }

    let neu = inhalt;
    const bericht = [];

    if (j.modus === 'neu') {
      if (inhalt.length > NEUSCHREIB_GRENZE) {
        return { text: '📁 Die Datei ist zu groß zum kompletten Neuschreiben. Sag mir genauer, welche Stelle geändert werden soll.' };
      }
      neu = String(j.inhalt || '');
      bericht.push('Datei komplett neu geschrieben');
    } else if (j.modus === 'anhaengen') {
      const zusatz = String(j.text || '').trim();
      if (!zusatz) return { text: '📁 Da war nichts zum Anhängen.' };
      neu = inhalt.replace(/\s*$/, '') + '\n' + zusatz + '\n';
      bericht.push(`angehängt (${zusatz.length} Zeichen)`);
    } else {
      const aenderungen = Array.isArray(j.aenderungen) ? j.aenderungen : [];
      if (!aenderungen.length) return { text: '📁 Es kam keine Änderung zurück. Formulier den Auftrag bitte etwas genauer.' };
      const misslungen = [];
      for (const a of aenderungen) {
        const suchen = String(a.suchen || '');
        if (!suchen) continue;
        const teile = neu.split(suchen);
        if (teile.length === 1) { misslungen.push(`nicht gefunden: „${suchen.slice(0, 50)}…"`); continue; }
        if (teile.length > 2) { misslungen.push(`mehrfach vorhanden: „${suchen.slice(0, 50)}…"`); continue; }
        neu = teile.join(String(a.ersetzen ?? ''));
        bericht.push(`„${suchen.slice(0, 40)}" → „${String(a.ersetzen ?? '').slice(0, 40)}"`);
      }
      if (!bericht.length) {
        return { text: `📁 Keine der Änderungen ließ sich sicher zuordnen:\n${misslungen.map((m) => '• ' + m).join('\n')}\n\nNichts wurde angefasst.` };
      }
      if (misslungen.length) bericht.push(`⚠️ übersprungen: ${misslungen.length}`);
    }

    if (neu === inhalt) return { text: '📁 Am Inhalt hätte sich nichts geändert — ich habe nichts geschrieben.' };

    const r = await ablage.schreibeText(ziel.slug, e, neu, auftrag);
    if (!r.ok) return { text: `📁 Speichern fehlgeschlagen: ${r.grund}` };

    return {
      text: `✏️ *${e.name}* geändert:\n` + bericht.map((b) => '• ' + b).join('\n') +
        `\n\nAlte Fassung liegt in \`versionen/\`. Neue Datei schicken? „schick mir ${e.name}"`
    };
}

async function bearbeiteNotizen(ziel, auftrag, dienste) {
    const fs = require('fs');
    const path = require('path');
    const pfad = path.join(ablage.ordner(ziel.slug), 'notizen.md');
    let inhalt = '';
    try { inhalt = fs.readFileSync(pfad, 'utf-8'); } catch { inhalt = ''; }
    if (!inhalt.trim()) return { text: `📁 In *${ziel.name}* gibt es noch keine Notizen.` };

    const roh = await dienste.chat(TEXT_BEARBEITEN_PROMPT, [
      'DATEI: notizen.md (die Projektnotizen)',
      `AUFTRAG: ${auftrag || '(kein Auftrag erkennbar)'}`,
      '',
      'AKTUELLER INHALT:',
      inhalt
    ].join('\n'));

    const j = extrahiere(roh);
    if (!j || j.modus === 'nicht_moeglich') {
      return { text: `📁 Das geht so nicht: ${(j && j.grund) || 'Der Auftrag war nicht eindeutig.'}` };
    }

    let neu = inhalt;
    if (j.modus === 'neu') neu = String(j.inhalt || '');
    else if (j.modus === 'anhaengen') neu = inhalt.replace(/\s*$/, '') + '\n' + String(j.text || '') + '\n';
    else {
      for (const a of (j.aenderungen || [])) {
        const teile = neu.split(String(a.suchen || ''));
        if (teile.length === 2) neu = teile.join(String(a.ersetzen ?? ''));
      }
    }
    if (neu === inhalt) return { text: '📁 An den Notizen hätte sich nichts geändert.' };

    const r = await ablage.schreibeNotizen(ziel.slug, neu, auftrag);
    if (!r.ok) return { text: `📁 Speichern fehlgeschlagen: ${r.grund}` };
    return { text: `✏️ Notizen von *${ziel.name}* geändert. Alte Fassung liegt in \`versionen/\`.` };
}

async function bearbeiteExcel(ziel, e, auftrag, dienste) {
    let blaetter;
    try { blaetter = await ablage.excelRaster(e.abs); }
    catch (err) { return { text: `📁 \`${e.name}\` lässt sich nicht öffnen: ${err.message}` }; }

    const roh = await dienste.chat(EXCEL_BEARBEITEN_PROMPT, [
      `DATEI: ${e.name}`,
      `AUFTRAG: ${auftrag || '(kein Auftrag erkennbar)'}`,
      '',
      ablage.rasterAlsText(blaetter)
    ].join('\n'));

    const j = extrahiere(roh);
    const aenderungen = (j && Array.isArray(j.aenderungen)) ? j.aenderungen : [];
    if (!aenderungen.length) {
      return { text: `📁 Keine Änderung ermittelt${j && j.grund ? `: ${j.grund}` : '. Formulier den Auftrag bitte genauer.'}` };
    }

    const r = await ablage.excelAendern(ziel.slug, e, aenderungen, auftrag);
    if (!r.ok) return { text: `📁 Änderung fehlgeschlagen: ${r.grund}` };

    return {
      text: `✏️ *${e.name}* geändert:\n` + r.getan.map((g) => '• ' + g).join('\n') +
        (r.fehler && r.fehler.length ? `\n\n⚠️ Übersprungen:\n${r.fehler.map((f) => '• ' + f).join('\n')}` : '') +
        `\n\nAlte Fassung liegt in \`versionen/\`. Die Mappe selbst bleibt erhalten — Diagramme und ` +
        `Pivot-Tabellen überstehen das Speichern allerdings nicht immer. Wenn welche drin waren: kurz nachsehen.`,
      dateien: [e.abs]
    };
}

// ──────────────────────────────────────────────────────────── erzeugen

async function erzeugen(ziel, absicht, text, dienste) {
    const inhalt = ablage.ordnerInhalt(ziel.slug);
    if (inhalt.leer) return { text: `📁 Im Ordner *${ziel.name}* liegt nichts, woraus ich etwas bauen könnte.` };

    const format = ['xlsx', 'csv', 'pdf', 'md', 'txt'].includes(String(absicht.format || '').toLowerCase())
      ? String(absicht.format).toLowerCase() : 'md';
    const auftrag = (absicht.auftrag || text || '').trim();
    const basis = ablage.sicherName((absicht.name || auftrag.slice(0, 40) || 'dokument').replace(/[^\wäöüÄÖÜß \-]/g, ' ').trim() || 'dokument');

    const nutzerText = [
      'PROJEKTUNTERLAGEN:',
      inhalt.text,
      inhalt.gekuerzt ? '\n[HINWEIS: gekürzt — sag das im Dokument dazu.]' : '',
      '\n\nAUFTRAG:',
      auftrag || '(kein Auftrag erkennbar)'
    ].filter(Boolean).join('\n');

    const roh = await dienste.antwortChat(baueErzeugenPrompt(format, ziel.name), nutzerText);

    let erstellt;
    try {
      if (format === 'xlsx' || format === 'csv') {
        const j = extrahiere(roh);
        const blaetter = (j && Array.isArray(j.blaetter) && j.blaetter.length) ? j.blaetter : null;
        if (!blaetter) return { text: '📁 Aus der Antwort ließ sich keine Tabelle bauen. Versuch es mit einer klareren Beschreibung.' };
        if (format === 'csv') {
          const b = blaetter[0];
          const zeilen = [b.spalten || [], ...(b.zeilen || [])]
            .map((z) => z.map((v) => {
              const s = String(v == null ? '' : v);
              return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
            }).join(';'));
          erstellt = await ablage.neuesDokument(ziel.slug, { name: `${basis}.csv`, text: zeilen.join('\n') });
        } else {
          erstellt = await ablage.neuesDokument(ziel.slug, { name: `${basis}.xlsx`, blaetter });
        }
      } else if (format === 'pdf') {
        erstellt = await ablage.neuesDokument(ziel.slug, { name: `${basis}.pdf`, text: roh, pdfTitel: `${ziel.name} — ${basis}` });
      } else {
        erstellt = await ablage.neuesDokument(ziel.slug, { name: `${basis}.${format}`, text: roh });
      }
    } catch (err) {
      return { text: `📁 Konnte das Dokument nicht bauen: ${err.message}` };
    }

    return {
      text: `📄 *${erstellt.name}* erstellt und in *${ziel.name}* abgelegt.\n\n` +
        '_Gebaut aus dem, was im Ordner liegt. Zahlen bitte gegenprüfen, bevor das Dokument rausgeht._',
      dateien: [erstellt.abs]
    };
}

// ─────────────────────────────────────────────────────────── aufräumen

async function aufraeumen(ziel, absicht, dienste) {
    const alle = ablage.index(ziel.slug);
    if (!alle.length) return { text: `📁 Im Ordner *${ziel.name}* liegt nichts zum Aufräumen.` };

    const liste = alle.map((e) => {
      const t = ablage.leseText(e);
      const auszug = t ? trenneKopf(t).rumpf.replace(/\s+/g, ' ').slice(0, 220) : '(kein Text)';
      return `- ${e.name}${e.kategorie ? ` [${e.kategorie}]` : ''} (${e.art}) :: ${auszug}`;
    }).join('\n');

    const roh = await dienste.chat(AUFRAEUMEN_PROMPT, [
      `PROJEKT: ${ziel.name}`,
      `AUFTRAG: ${absicht.auftrag || 'sinnvoll benennen und in Kategorien sortieren'}`,
      '',
      'DATEIEN:',
      liste
    ].join('\n'));

    const j = extrahiere(roh);
    const plan = (j && Array.isArray(j.plan)) ? j.plan : [];
    if (!plan.length) return { text: '📁 Es gab nichts aufzuräumen — oder der Vorschlag war leer.' };

    const getan = [];
    const misslungen = [];
    for (const p of plan) {
      // Bewusst NUR exakte Namen. Eine unscharfe Suche hat im Test aus
      // "gibtesnicht.pdf" den Baustellenbericht gemacht und ihn umbenannt —
      // beim Umbenennen und Archivieren ist Fuzzy-Matching zu gefährlich.
      const e = alle.find((x) => x.name === p.datei);
      if (!e) { misslungen.push(`${p.datei}: steht nicht in der Dateiliste`); continue; }

      if (p.archivieren) {
        const r = ablage.archiviere(ziel.slug, e, 'beim Aufräumen aussortiert');
        r.ok ? getan.push(`📦 ${e.name} → archiv/`) : misslungen.push(`${e.name}: ${r.grund}`);
        continue;
      }
      let aktuell = e;
      if (p.neuerName && p.neuerName !== e.name) {
        const r = ablage.benenneUm(ziel.slug, aktuell, p.neuerName);
        if (r.ok) {
          getan.push(`✏️ ${r.von} → ${r.nach}`);
          aktuell = ablage.index(ziel.slug).find((x) => x.name === r.nach) || aktuell;
        } else { misslungen.push(`${e.name}: ${r.grund}`); }
      }
      if (p.kategorie && ablage.sichereKategorie(p.kategorie) !== aktuell.kategorie) {
        const r = ablage.verschiebe(ziel.slug, aktuell, p.kategorie);
        r.ok ? getan.push(`📂 ${aktuell.name} → ${r.kategorie}/`) : misslungen.push(`${aktuell.name}: ${r.grund}`);
      }
    }

    if (!getan.length) {
      return { text: '📁 Nichts geändert.' + (misslungen.length ? '\n\n' + misslungen.map((m) => '• ' + m).join('\n') : '') };
    }
    return {
      text: `🧹 *${ziel.name}* aufgeräumt — ${getan.length} Änderung(en):\n` + getan.join('\n') +
        (misslungen.length ? `\n\n⚠️ Nicht gegangen:\n${misslungen.map((m) => '• ' + m).join('\n')}` : '') +
        '\n\n_Gelöscht wurde nichts — Aussortiertes liegt in `archiv/`. Die Schritte stehen in `projekt.json`._'
    };
}

// ───────────────────────────────────────────────────────────── Experte

module.exports = {
  id: 'projektordner',
  name: 'Projektordner',
  emoji: '📁',
  beschreibung:
    'Sammelt alle Unterlagen zu einem Projekt an einem Ort: ablegen, befragen, einzelne Dateien ' +
    'zurückschicken, Textdateien und Tabellen bearbeiten, neue Dokumente daraus erzeugen, aufräumen.',

  zustaendigWenn:
    'Der Nutzer will mit den Unterlagen EINES PROJEKTS arbeiten. Das umfasst: etwas ABLEGEN ' +
    '("pack das zum Projekt Sportklinik"), den Ordner BEFRAGEN ("alle Lieferscheine im Januar", ' +
    '"welche Regeln gelten auf der Baustelle", "wer ist mein Ansprechpartner", "überschlag die ' +
    'Projektkosten gegen die Angebotssumme"), sich eine abgelegte Datei ZURÜCKSCHICKEN oder ' +
    'VORLESEN lassen, eine abgelegte Textdatei oder Tabelle ÄNDERN ("trag in der Materialliste 5 ' +
    'statt 3 ein"), aus dem Ordnerinhalt ein NEUES Dokument erzeugen ("mach mir eine ' +
    'Kostenübersicht als Excel") und den Ordner AUFRÄUMEN. Auch zuständig fürs Anlegen eines ' +
    'Projektordners und für die Frage, welche Projekte es gibt. NICHT zuständig für das Buchen ' +
    'von Lagerbeständen (das ist lager), nicht für das Erstellen eines Aufmaßes (das ist ' +
    'materialaufmass) und nicht für Bestellungen beim Großhandel (das ist bestellung) — wohl ' +
    'aber dafür, ein fertiges Aufmaß oder eine Bestellbestätigung im Projektordner abzulegen.',

  implementiert: true,

  async verarbeite(eingabe, dienste) {
    const { chatId, text } = eingabe;
    const dokInhalt = eingabe.dokInhalt || '';
    const dokInfo = eingabe.dokInfo || null;
    const datei = eingabe.datei || null;

    const projekte = ablage.listeProjekte();
    const aktiv = ablage.aktivesProjekt(chatId);

    // ── 1. Kommt eine Datei mit? Dann ablegen — eindeutig, keine KI nötig.
    if (dokInhalt || datei || dokInfo) {
      const genannt = text ? ablage.findeProjekt(text) : null;
      const ziel = genannt || aktiv;
      if (!ziel) {
        return {
          text: '📁 Zu welchem Projekt gehört das?\n\n' +
            (projekte.length
              ? 'Vorhandene Projekte:\n' + projekte.map((p) => `• ${p.name}`).join('\n') +
                '\n\nSchreib z. B. „gehört zu Sportklinik" — oder `/projekt <Name>` für ein neues.'
              : 'Es gibt noch keinen Projektordner. Leg einen an mit `/projekt <Name>`.')
        };
      }
      const name = (dokInfo && dokInfo.name) || (datei && datei.name) || `notiz-${Date.now()}.txt`;
      const abgelegt = ablage.legeDokumentAb(ziel.slug, {
        name,
        inhalt: dokInhalt,
        buffer: datei && datei.buffer,
        beschriftung: text
      });
      ablage.setzeAktiv(chatId, ziel.slug);
      const anzahl = ablage.index(ziel.slug).length;
      return {
        text: `📁 Abgelegt in *${ziel.name}*: \`${abgelegt.name}\`\n` +
          (dokInhalt
            ? `Text gesichert (${dokInhalt.length} Zeichen) — Fragen dazu beantworte ich daraus.`
            : '⚠️ Kein Text auslesbar. Die Datei liegt im Ordner und kann zurückgeschickt werden, ' +
              'in Antworten taucht ihr Inhalt aber nicht auf.') +
          `\n\nIm Ordner: ${anzahl} Dokument(e).`
      };
    }

    // ── 2. Absicht bestimmen.
    const dateienImAktiven = aktiv ? ablage.index(aktiv.slug) : [];
    const absicht = await bestimmeAbsicht(dienste, text || '', projekte, aktiv, dateienImAktiven);
    const genannt = absicht.projekt ? ablage.findeProjekt(absicht.projekt) : null;

    // ── 3. Aktionen ohne Zielprojekt.
    if (absicht.aktion === 'liste') {
      if (!projekte.length) return { text: '📁 Es gibt noch keinen Projektordner. Leg einen an: `/projekt <Name>`' };
      const zeilen = projekte.map((p) => {
        const n = ablage.index(p.slug).length;
        return `• *${p.name}* — ${n} Dokument(e)` + (aktiv && aktiv.slug === p.slug ? '  ← aktiv' : '');
      });
      return { text: '📁 Deine Projekte:\n' + zeilen.join('\n') };
    }

    if (absicht.aktion === 'anlegen') {
      const name = (absicht.projekt || '').trim();
      if (!name) return { text: 'Wie soll das Projekt heißen? `/projekt <Name>`' };
      const r = ablage.legeAn(name, chatId);
      if (!r) return { text: 'Der Name taugt nicht als Ordnername. Nimm etwas wie „26-0061 Sportklinik".' };
      ablage.setzeAktiv(chatId, r.slug);
      return {
        text: r.neu
          ? `📁 Projekt *${r.name}* angelegt und aktiv.\n\nSchick mir jetzt Dokumente, Fotos oder Notizen dazu. ` +
            'Ich kann sie später zurückschicken, vorlesen, bearbeiten und Fragen daraus beantworten.'
          : `📁 Projekt *${r.name}* gibt es schon — ist jetzt aktiv.`
      };
    }

    if (absicht.aktion === 'wechseln') {
      if (!genannt) {
        return {
          text: 'Welches Projekt meinst du?\n' +
            (projekte.length ? projekte.map((p) => `• ${p.name}`).join('\n') : '(noch keine vorhanden)')
        };
      }
      ablage.setzeAktiv(chatId, genannt.slug);
      return { text: `📁 Aktives Projekt ist jetzt *${genannt.name}*.` };
    }

    // ── 4. Ab hier braucht alles ein Projekt.
    const ziel = genannt || aktiv;
    if (!ziel) {
      return {
        text: '📁 Für welches Projekt?\n' +
          (projekte.length
            ? projekte.map((p) => `• ${p.name}`).join('\n') + '\n\nSag z. B. „für Sportklinik: …"'
            : 'Es gibt noch keinen Projektordner. Leg einen an: `/projekt <Name>`')
      };
    }
    ablage.setzeAktiv(chatId, ziel.slug);

    if (absicht.aktion === 'notiz') {
      const inhalt = (absicht.inhalt || text || '').trim();
      if (!inhalt) return { text: 'Was soll ich festhalten?' };
      ablage.legeNotizAb(ziel.slug, inhalt, 'per Telegram');
      return { text: `📝 Notiert bei *${ziel.name}*:\n${inhalt}` };
    }

    if (absicht.aktion === 'dateien') {
      const alle = ablage.index(ziel.slug);
      if (!alle.length) return { text: `📁 Im Ordner *${ziel.name}* liegt noch nichts.` };
      return {
        text: `📁 *${ziel.name}* — ${alle.length} Dokument(e):\n` + alle.map(dateiZeile).join('\n') +
          '\n\n_Zurückschicken: „schick mir <name>". Inhalt zeigen: „was steht in <name>"._'
      };
    }

    if (absicht.aktion === 'auslesen') return auslesen(ziel, absicht);
    if (absicht.aktion === 'ausgeben') return ausgeben(ziel, absicht);
    if (absicht.aktion === 'bearbeiten') return bearbeiten(ziel, absicht, text, dienste);
    if (absicht.aktion === 'erzeugen') return erzeugen(ziel, absicht, text, dienste);
    if (absicht.aktion === 'aufraeumen') return aufraeumen(ziel, absicht, dienste);

    // ── 5. Frage: gesamter Ordnerinhalt in den Prompt.
    const inhalt = ablage.ordnerInhalt(ziel.slug);
    if (inhalt.leer) {
      return { text: `📁 Im Ordner *${ziel.name}* liegt noch nichts. Schick mir Dokumente oder Notizen dazu.` };
    }
    const nutzerText = [
      'PROJEKTUNTERLAGEN:',
      inhalt.text,
      inhalt.gekuerzt
        ? '\n[HINWEIS: Die Unterlagen wurden gekürzt, weil sie sehr umfangreich sind. ' +
          'Sag in deiner Antwort dazu, dass möglicherweise nicht alles berücksichtigt wurde.]'
        : '',
      '\n\nFRAGE:',
      text || '(keine Frage erkennbar)'
    ].filter(Boolean).join('\n');

    const antwort = await dienste.antwortChat(baueFragePrompt(ziel.name), nutzerText);
    return {
      text: `📁 *${ziel.name}*\n\n${antwort}` +
        (inhalt.gekuerzt ? '\n\n_⚠️ Unterlagen gekürzt — bei kritischen Zahlen bitte gegenprüfen._' : '')
    };
  },

  // ──────────────────────────────────────────────────────────── Befehle

  commands: [
    {
      name: 'projekt',
      beschreibung: 'Projektordner anlegen oder wechseln: /projekt <Name>',
      ausfuehren: async ({ chatId, argument }) => {
        if (!argument) {
          const a = ablage.aktivesProjekt(chatId);
          const p = ablage.listeProjekte();
          return {
            text: (a ? `📁 Aktiv: *${a.name}*\n\n` : '📁 Kein Projekt aktiv.\n\n') +
              (p.length ? 'Vorhanden:\n' + p.map((x) => `• ${x.name}`).join('\n') : 'Noch keine Projekte.') +
              '\n\n`/projekt <Name>` legt an oder wechselt.'
          };
        }
        const r = ablage.legeAn(argument.trim(), chatId);
        if (!r) return { text: 'Der Name taugt nicht als Ordnername.' };
        ablage.setzeAktiv(chatId, r.slug);
        return { text: r.neu ? `📁 *${r.name}* angelegt und aktiv.` : `📁 *${r.name}* ist jetzt aktiv.` };
      }
    },
    {
      name: 'projekte',
      beschreibung: 'Alle Projektordner auflisten',
      ausfuehren: async ({ chatId }) => {
        const p = ablage.listeProjekte();
        if (!p.length) return { text: '📁 Noch keine Projekte. `/projekt <Name>` legt eins an.' };
        const a = ablage.aktivesProjekt(chatId);
        return {
          text: '📁 Projekte:\n' + p.map((x) => {
            const n = ablage.index(x.slug).length;
            return `• *${x.name}* — ${n} Dokument(e)` + (a && a.slug === x.slug ? '  ← aktiv' : '');
          }).join('\n')
        };
      }
    },
    {
      name: 'projekt_inhalt',
      beschreibung: 'Was liegt im aktiven Projektordner?',
      ausfuehren: async ({ chatId }) => {
        const a = ablage.aktivesProjekt(chatId);
        if (!a) return { text: '📁 Kein Projekt aktiv. `/projekt <Name>`' };
        const i = ablage.ordnerInhalt(a.slug);
        if (i.leer) return { text: `📁 *${a.name}* ist leer.` };
        return {
          text: `📁 *${a.name}*\n` + i.dateien.map(dateiZeile).join('\n') +
            `\n\nGesamttext: ${i.zeichen.toLocaleString('de-DE')} Zeichen` + (i.gekuerzt ? ' (bei Fragen gekürzt)' : '')
        };
      }
    },
    {
      name: 'projekt_datei',
      beschreibung: 'Datei aus dem Projektordner zurückschicken: /projekt_datei <Suchwort>',
      ausfuehren: async ({ chatId, argument }) => {
        const a = ablage.aktivesProjekt(chatId);
        if (!a) return { text: '📁 Kein Projekt aktiv. `/projekt <Name>`' };
        if (!argument || !argument.trim()) {
          const alle = ablage.index(a.slug);
          return {
            text: alle.length
              ? `📁 *${a.name}*:\n` + alle.map(dateiZeile).join('\n') + '\n\n`/projekt_datei <Suchwort>`'
              : `📁 *${a.name}* ist leer.`
          };
        }
        const r = bestimmeDatei(a.slug, argument.trim());
        if (r.fehler === 'nicht_gefunden') return { text: `📁 „${argument.trim()}" finde ich nicht.` };
        if (r.fehler === 'mehrdeutig') return { text: `📁 Welche meinst du?\n${trefferListe(r.treffer)}` };
        const { raus, abgelehnt } = ablage.sendbar([r.eintrag]);
        if (!raus.length) return { text: `📁 Geht nicht: ${abgelehnt[0] ? abgelehnt[0].grund : 'unbekannt'}` };
        return { text: `📁 \`${raus[0].name}\``, dateien: [raus[0].abs] };
      }
    },
    {
      name: 'projekt_versionen',
      beschreibung: 'Frühere Fassungen bearbeiteter Dateien anzeigen',
      ausfuehren: async ({ chatId }) => {
        const a = ablage.aktivesProjekt(chatId);
        if (!a) return { text: '📁 Kein Projekt aktiv. `/projekt <Name>`' };
        const fs = require('fs');
        let dateien = [];
        try { dateien = fs.readdirSync(ablage.versionenDir(a.slug)).sort().reverse(); } catch { dateien = []; }
        if (!dateien.length) return { text: `📁 In *${a.name}* wurde noch nichts bearbeitet — keine alten Fassungen.` };
        return {
          text: `🕘 Frühere Fassungen in *${a.name}*:\n` +
            dateien.slice(0, 30).map((d) => `• \`${d}\``).join('\n') +
            '\n\n_Liegen in `versionen/` im Projektordner. Zurückspielen geht von Hand._'
        };
      }
    }
  ]
};
