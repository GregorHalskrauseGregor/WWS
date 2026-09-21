// Werkzeug-Registry — die Schnittstelle, an der Tools andocken.
//
// Idee (bewusst wie bei den Wissenskarten): Ein Werkzeug wird nicht im Code
// angemeldet, sondern in EINEM Textdokument beschrieben — werkzeuge.md. Wer ein
// neues Tool anschliessen will, schreibt dort einen Block. Wer ein altes
// abklemmen will, setzt "Aktiv: nein" oder loescht den Block. Kein Code-Umbau.
//
// Was die Registry steuert:
//   - WELCHE Werkzeuge der Router ueberhaupt zur Wahl bekommt (Aktiv)
//   - WIE sie beschrieben werden (Wann: der Fliesstext, den der Router liest)
//   - WELCHE Zusatz-Prompts geladen werden (Prompt:)
//   - WELCHE anderen Werkzeuge mitgeladen werden muessen (Braucht:)
//
// Format (tolerant geparst, Reihenfolge egal, Gross-/Kleinschreibung egal):
//
//   ## bestellung
//   Name: Material bestellen
//   Aktiv: ja
//   Modul: experten/bestellung.js
//   Prompt: wissen/prompts/bestellung.md
//   Braucht: lager, grosshandel
//   Wann:
//   Wenn der Nutzer Material bestellen will, eine Bestellung ergaenzt oder
//   nach dem Stand einer Bestellung fragt. Auch bei unvollstaendigen Angaben.
//
// "Wann:" ist der letzte Schluessel im Block — alles danach bis zur naechsten
// "##"-Ueberschrift gehoert dazu und darf beliebig lang und mehrzeilig sein.

const fs = require('fs');
const path = require('path');

const WURZEL = path.join(__dirname, '..');
// Umlenkbar, damit Tests nicht gegen die echte Registry laufen.
const DATEI = process.env.WWS_WERKZEUGE
  ? path.resolve(process.env.WWS_WERKZEUGE)
  : path.join(WURZEL, 'werkzeuge.md');

let _cache = null;

function jaNein(wert, standard = true) {
  const s = String(wert || '').trim().toLowerCase();
  if (!s) return standard;
  if (['ja', 'yes', 'true', '1', 'an', 'aktiv'].includes(s)) return true;
  if (['nein', 'no', 'false', '0', 'aus', 'inaktiv'].includes(s)) return false;
  return standard;
}

function listeAusText(wert) {
  return String(wert || '')
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// Schluessel normalisieren: "Braucht", "braucht", "Benötigt" -> braucht
function normKey(roh) {
  const s = String(roh || '').trim().toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
  if (['benoetigt', 'abhaengigkeiten', 'braucht'].includes(s)) return 'braucht';
  if (['wann', 'kontext', 'wannverwenden'].includes(s)) return 'wann';
  if (['modul', 'code', 'datei'].includes(s)) return 'modul';
  if (['prompt', 'hauptprompt', 'promptdatei'].includes(s)) return 'prompt';
  if (['aktiv', 'an'].includes(s)) return 'aktiv';
  if (['name', 'titel'].includes(s)) return 'name';
  return s;
}

function parse(text) {
  const zeilen = String(text || '').split(/\r?\n/);
  const eintraege = [];
  let aktuell = null;
  let inWann = false;

  const abschliessen = () => {
    if (!aktuell) return;
    aktuell.wann = (aktuell.wann || '').trim();
    eintraege.push(aktuell);
    aktuell = null;
    inWann = false;
  };

  for (const zeile of zeilen) {
    // Nur "## <id>" zaehlt als Werkzeug. Eine id hat nie Leerzeichen — so
    // koennen Doku-Ueberschriften im selben Dokument stehen, ohne als Werkzeug
    // missverstanden zu werden.
    const ueberschrift = zeile.match(/^\s*##\s+([A-Za-z0-9_.:-]+)\s*$/);
    if (ueberschrift) {
      abschliessen();
      aktuell = {
        id: ueberschrift[1].trim(),
        name: null, aktiv: true, modul: null, prompt: null,
        braucht: [], wann: ''
      };
      continue;
    }
    if (!aktuell) continue; // Kopfzeilen / Doku vor dem ersten ## ignorieren

    if (inWann) { aktuell.wann += (aktuell.wann ? '\n' : '') + zeile; continue; }

    const kv = zeile.match(/^\s*[-*]?\s*([A-Za-zÄÖÜäöüß ]+?)\s*:\s*(.*)$/);
    if (kv) {
      const key = normKey(kv[1]);
      const wert = kv[2].trim();
      if (key === 'wann') {
        // Alles ab hier gehoert zum Fliesstext — auch wenn in derselben Zeile
        // schon etwas steht.
        aktuell.wann = wert;
        inWann = true;
        continue;
      }
      if (key === 'aktiv') { aktuell.aktiv = jaNein(wert, true); continue; }
      if (key === 'braucht') { aktuell.braucht = listeAusText(wert); continue; }
      if (key === 'name') { aktuell.name = wert || null; continue; }
      if (key === 'modul') { aktuell.modul = wert || null; continue; }
      if (key === 'prompt') { aktuell.prompt = wert || null; continue; }
      // Unbekannte Schluessel schaden nicht — sie landen als Zusatzfeld.
      aktuell[key] = wert;
    }
  }
  abschliessen();
  return eintraege;
}

function lade() {
  if (_cache) return _cache;
  let roh = '';
  try { roh = fs.readFileSync(DATEI, 'utf-8'); }
  catch { roh = ''; }
  _cache = parse(roh);
  return _cache;
}

function neuLaden() { _cache = null; return lade(); }

function alle() { return lade(); }

function aktive() { return lade().filter((e) => e.aktiv); }

function finde(id) {
  const ziel = String(id || '').trim().toLowerCase();
  return lade().find((e) => e.id.toLowerCase() === ziel) || null;
}

// Gibt es ueberhaupt eine Registry? Ohne Datei arbeitet der Bot wie frueher
// weiter (alle geladenen Experten sind aktiv) — die Registry ist additiv,
// nicht bruchgefaehrlich.
function vorhanden() { return lade().length > 0; }

// Transitive Abhaengigkeiten: Werkzeug A braucht B, B braucht C -> [B, C].
// Zyklen werden abgefangen (Bestellung braucht Lager, Lager braucht Bestellung
// ist ein realistischer Fall und darf nicht zur Endlosschleife werden).
function abhaengigkeiten(id, gesehen = new Set()) {
  const eintrag = finde(id);
  if (!eintrag) return [];
  const raus = [];
  for (const b of eintrag.braucht || []) {
    const key = String(b).toLowerCase();
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    raus.push(b);
    for (const tiefer of abhaengigkeiten(b, gesehen)) {
      if (!raus.includes(tiefer)) raus.push(tiefer);
    }
  }
  return raus;
}

// Inhalt der Prompt-Datei eines Werkzeugs (falls eingetragen und lesbar).
function promptText(id) {
  const e = finde(id);
  if (!e || !e.prompt) return '';
  try {
    return fs.readFileSync(path.resolve(WURZEL, e.prompt), 'utf-8').trim();
  } catch {
    return '';
  }
}

// Fuer /werkzeuge und die Diagnose: was ist eingetragen, was fehlt.
function status(bekannteIds = []) {
  return lade().map((e) => ({
    id: e.id,
    name: e.name || e.id,
    aktiv: e.aktiv,
    hatModul: bekannteIds.length === 0 ? null : bekannteIds.includes(e.id),
    braucht: e.braucht,
    prompt: e.prompt || null,
    wannKurz: (e.wann || '').split('\n')[0].slice(0, 100)
  }));
}

module.exports = {
  DATEI, parse, lade, neuLaden, alle, aktive, finde,
  vorhanden, abhaengigkeiten, promptText, status
};
