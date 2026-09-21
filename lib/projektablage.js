// Projektablage — die Dateiarbeit hinter dem Projektordner-Experten.
//
// Bewusst OHNE KI: hier steht nur, was deterministisch passiert. Der Experte
// (experten/projektordner.js) entscheidet mit dem Modell, WAS getan werden
// soll; dieses Modul tut es und ist dadurch einzeln testbar.
//
// Ordnerstruktur pro Projekt (data/projekte/<slug>/):
//
//   projekt.json              Stammdaten + Protokoll der Änderungen
//   notizen.md                Freitext, chronologisch angehängt
//   dateien/                  die Originale, optional in Unterordnern
//     lieferscheine/…           (Unterordner entstehen beim Aufräumen)
//   texte/<voller name>.txt   der ausgelesene Text jedes Dokuments
//   versionen/<name>__<zeit>  frühere Fassungen bearbeiteter Dateien
//   archiv/                   aussortiert — gelöscht wird nie
//
// DREI REGELN, die hier hart verdrahtet sind:
//
//   1. Nichts wird gelöscht. Aussortieren heißt verschieben nach archiv/.
//   2. Jede Änderung an einer vorhandenen Datei legt vorher die alte Fassung
//      in versionen/ ab. Eine falsche Korrektur ist damit nie endgültig.
//   3. Der ausgelesene Text wird beim Ablegen EINMAL gesichert und nach jeder
//      Bearbeitung aufgefrischt. Fragen lesen nur noch Textdateien — keine
//      erneute OCR, keine Kosten, keine Wartezeit.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('../config');

const PROJEKTE = path.join(PFADE.DATA, 'projekte');

// Obergrenze für das, was in einen Frage-Prompt wandert.
const MAX_ZEICHEN = 140_000;

// Telegram nimmt maximal 50 MB pro Dokument. Etwas Luft lassen.
const MAX_SENDE_BYTES = 45 * 1024 * 1024;
const MAX_SENDE_ANZAHL = 10;

// Was der Bot verlustfrei selbst umschreiben kann.
const TEXT_ENDUNGEN = new Set(['.txt', '.md', '.csv', '.json', '.yaml', '.yml', '.log']);
const TABELLEN_ENDUNGEN = new Set(['.xlsx', '.xlsm']);

// ────────────────────────────────────────────────────────────────── Helfer

function entumlaute(s) {
  return String(s || '')
    .replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue').replace(/ß/g, 'ss');
}

function slugify(name) {
  return entumlaute(String(name || '').trim().toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

// Dateiname entschärfen: keine Pfadtrenner, keine Steuerzeichen, kein ".."
function sicherName(name) {
  const roh = String(name || 'datei').replace(/[/\\]/g, '_').replace(/\.\.+/g, '.');
  return roh.replace(/[^\w.\- ()äöüÄÖÜß]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'datei';
}

// Ordnername für eine Kategorie ("Lieferscheine" -> "lieferscheine").
function sichereKategorie(k) {
  const s = slugify(k);
  return s && s !== '.' && s !== '..' ? s : '';
}

function ordner(slug) { return path.join(PROJEKTE, slug); }
function dateienDir(slug) { return path.join(ordner(slug), 'dateien'); }
function texteDir(slug) { return path.join(ordner(slug), 'texte'); }
function versionenDir(slug) { return path.join(ordner(slug), 'versionen'); }
function archivDir(slug) { return path.join(ordner(slug), 'archiv'); }

function stempel() { return new Date().toISOString().slice(0, 16).replace('T', ' '); }
function tag() { return new Date().toISOString().slice(0, 10); }

// Schutz gegen Pfad-Ausbruch: liegt "ziel" wirklich unter "wurzel"?
function innerhalb(wurzel, ziel) {
  const w = path.resolve(wurzel) + path.sep;
  const z = path.resolve(ziel);
  return z === path.resolve(wurzel) || z.startsWith(w);
}

// ──────────────────────────────────────────────────────────── Stammdaten

function ladeMeta(slug) {
  try { return JSON.parse(fs.readFileSync(path.join(ordner(slug), 'projekt.json'), 'utf-8')); }
  catch { return null; }
}

function speichereMeta(slug, meta) {
  fs.mkdirSync(ordner(slug), { recursive: true });
  fs.writeFileSync(path.join(ordner(slug), 'projekt.json'), JSON.stringify(meta, null, 2), 'utf-8');
  return meta;
}

// Jede strukturelle Änderung wird mitgeschrieben. Das ist die Spur, mit der
// sich ein missglücktes Aufräumen von Hand zurückdrehen lässt.
function protokolliere(slug, was) {
  const meta = ladeMeta(slug);
  if (!meta) return;
  meta.protokoll = meta.protokoll || [];
  meta.protokoll.push({ zeit: new Date().toISOString(), was: String(was).slice(0, 300) });
  if (meta.protokoll.length > 300) meta.protokoll = meta.protokoll.slice(-300);
  speichereMeta(slug, meta);
}

function listeProjekte() {
  try {
    return fs.readdirSync(PROJEKTE, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        const meta = ladeMeta(d.name) || {};
        return { slug: d.name, name: meta.name || d.name, angelegt: meta.angelegt || null };
      })
      .sort((a, b) => (b.angelegt || '').localeCompare(a.angelegt || ''));
  } catch {
    return [];
  }
}

function legeAn(name, chatId) {
  const slug = slugify(name);
  if (!slug) return null;
  const vorhanden = fs.existsSync(ordner(slug));
  fs.mkdirSync(dateienDir(slug), { recursive: true });
  fs.mkdirSync(texteDir(slug), { recursive: true });
  if (!vorhanden) {
    speichereMeta(slug, {
      name: String(name).trim(),
      slug,
      angelegt: new Date().toISOString(),
      angelegtVon: String(chatId || ''),
      protokoll: []
    });
  }
  const meta = ladeMeta(slug) || { name: String(name).trim(), slug };
  return { slug, name: meta.name, neu: !vorhanden };
}

// Projektnamen in Freitext wiedererkennen — auch wenn nur die Nummer fällt
// ("26-0061") oder nur ein Wort ("Sportklinik").
function findeProjekt(suche) {
  const s = entumlaute(String(suche || '').toLowerCase());
  if (!s.trim()) return null;
  const projekte = listeProjekte();
  let treffer = projekte.find((p) => entumlaute(p.name.toLowerCase()) === s.trim());
  if (treffer) return treffer;
  treffer = projekte.find((p) => s.includes(entumlaute(p.name.toLowerCase())));
  if (treffer) return treffer;
  treffer = projekte.find((p) => s.includes(p.slug));
  if (treffer) return treffer;
  // Einzelne Wörter des Projektnamens (ab 4 Zeichen, damit "der"/"und" nicht ziehen)
  for (const p of projekte) {
    const worte = entumlaute(p.name.toLowerCase()).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
    if (worte.some((w) => s.includes(w))) return p;
  }
  return null;
}

// ────────────────────────────────────────────── Aktives Projekt pro Chat

function aktivPfad(chatId) { return PFADE.userDatei(chatId, 'projekt.txt'); }

function aktivesProjekt(chatId) {
  try {
    const slug = fs.readFileSync(aktivPfad(chatId), 'utf-8').trim();
    if (!slug || !fs.existsSync(ordner(slug))) return null;
    const meta = ladeMeta(slug) || {};
    return { slug, name: meta.name || slug };
  } catch {
    return null;
  }
}

function setzeAktiv(chatId, slug) {
  try {
    fs.mkdirSync(PFADE.user(chatId), { recursive: true });
    fs.writeFileSync(aktivPfad(chatId), String(slug || ''), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

// ──────────────────────────────────────────────────────────────── Ablegen

function legeNotizAb(slug, text, quelle) {
  const datei = path.join(ordner(slug), 'notizen.md');
  const block = `\n## ${stempel()}${quelle ? ` — ${quelle}` : ''}\n${String(text).trim()}\n`;
  fs.mkdirSync(ordner(slug), { recursive: true });
  fs.appendFileSync(datei, block, 'utf-8');
  return datei;
}

// Freien Namen finden, falls es die Datei schon gibt (…-2.pdf, …-3.pdf).
function freierName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const stamm = name.slice(0, name.length - ext.length);
  for (let i = 2; i < 500; i++) {
    const k = `${stamm}-${i}${ext}`;
    if (!fs.existsSync(path.join(dir, k))) return k;
  }
  return `${stamm}-${Date.now()}${ext}`;
}

// Textdatei zu einem Dokument: texte/<voller dateiname>.txt
// Bewusst MIT Endung im Namen — sonst überschreiben sich plan.pdf und plan.jpg
// gegenseitig ihren Text.
function textPfadFuer(slug, name) { return path.join(texteDir(slug), `${name}.txt`); }

function textKopf(name, beschriftung) {
  return [
    `# ${name}`,
    `Abgelegt: ${stempel()}`,
    beschriftung ? `Notiz dazu: ${String(beschriftung).trim()}` : null,
    ''
  ].filter(Boolean).join('\n');
}

function legeDokumentAb(slug, { name, inhalt, buffer, beschriftung, kategorie }) {
  fs.mkdirSync(texteDir(slug), { recursive: true });
  const kat = sichereKategorie(kategorie);
  const zielDir = kat ? path.join(dateienDir(slug), kat) : dateienDir(slug);
  fs.mkdirSync(zielDir, { recursive: true });

  const basis = sicherName(name);
  const eindeutig = freierName(zielDir, `${tag()}_${basis}`);

  if (buffer && buffer.length) {
    try { fs.writeFileSync(path.join(zielDir, eindeutig), buffer); } catch { /* Text reicht */ }
  }
  fs.writeFileSync(
    textPfadFuer(slug, eindeutig),
    textKopf(eindeutig, beschriftung) + '\n' + String(inhalt || '(kein Text auslesbar)'),
    'utf-8'
  );
  protokolliere(slug, `abgelegt: ${kat ? kat + '/' : ''}${eindeutig}`);
  return { name: eindeutig, kategorie: kat, abs: path.join(zielDir, eindeutig) };
}

// ─────────────────────────────────────────────────────── Index und Suche

function artVon(endung) {
  const e = String(endung || '').toLowerCase();
  if (TEXT_ENDUNGEN.has(e)) return 'text';
  if (TABELLEN_ENDUNGEN.has(e) || e === '.xls') return 'tabelle';
  if (e === '.pdf') return 'pdf';
  if (['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif'].includes(e)) return 'bild';
  if (['.docx', '.doc'].includes(e)) return 'word';
  return 'anderes';
}

function gehtRekursiv(wurzel, unter = '', raus = []) {
  let eintraege = [];
  try { eintraege = fs.readdirSync(path.join(wurzel, unter), { withFileTypes: true }); }
  catch { return raus; }
  for (const e of eintraege) {
    const rel = unter ? path.join(unter, e.name) : e.name;
    if (e.isDirectory()) gehtRekursiv(wurzel, rel, raus);
    else if (e.isFile()) raus.push(rel);
  }
  return raus;
}

// Alle Dokumente eines Projekts. Enthält auch Dokumente, von denen nur der
// ausgelesene Text da ist (Originaldatei fehlt) — sonst wären die unsichtbar.
function index(slug) {
  const raus = [];
  const gesehen = new Set();

  for (const rel of gehtRekursiv(dateienDir(slug)).sort()) {
    const abs = path.join(dateienDir(slug), rel);
    const name = path.basename(rel);
    const kategorie = path.dirname(rel) === '.' ? '' : path.dirname(rel).replace(/\\/g, '/');
    const endung = path.extname(name).toLowerCase();
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    const tAbs = textPfadFuer(slug, name);
    const art = artVon(endung);
    gesehen.add(name);
    raus.push({
      name, rel, abs, kategorie, endung, art,
      groesse: st.size,
      geaendert: st.mtime.toISOString(),
      textAbs: fs.existsSync(tAbs) ? tAbs : null,
      hatOriginal: true,
      bearbeitbar: art === 'text' || art === 'tabelle'
    });
  }

  // Verwaiste Texte (Dokument kam ohne Originaldatei an).
  let texte = [];
  try { texte = fs.readdirSync(texteDir(slug)).filter((f) => f.endsWith('.txt')); }
  catch { texte = []; }
  for (const t of texte.sort()) {
    const name = t.slice(0, -4);            // "lieferschein.pdf.txt" -> "lieferschein.pdf"
    if (gesehen.has(name)) continue;
    const abs = path.join(texteDir(slug), t);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    raus.push({
      name, rel: name, abs: null, kategorie: '', endung: path.extname(name).toLowerCase(),
      art: 'text', groesse: st.size, geaendert: st.mtime.toISOString(),
      textAbs: abs, hatOriginal: false, bearbeitbar: true
    });
  }
  return raus;
}

// Ein Dokument anhand eines Suchworts finden. Gibt eine RANGLISTE zurück —
// der Experte entscheidet, ob er bei mehreren Treffern nachfragt.
function finde(slug, suchwort) {
  const s = entumlaute(String(suchwort || '').toLowerCase()).trim();
  const alle = index(slug);
  if (!s) return [];
  const worte = s.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);

  const bewertet = alle.map((e) => {
    const n = entumlaute(e.name.toLowerCase());
    const k = entumlaute(e.kategorie.toLowerCase());
    let punkte = 0;
    if (n === s) punkte += 100;
    if (n.includes(s)) punkte += 50;
    if (k && s.includes(k)) punkte += 20;
    for (const w of worte) {
      if (n.includes(w)) punkte += 15;
      if (k.includes(w)) punkte += 8;
    }
    if (punkte === 0 && e.textAbs) {
      // Zuletzt im Inhalt suchen — teurer, deshalb erst wenn der Name nichts hergibt.
      try {
        const inhalt = entumlaute(fs.readFileSync(e.textAbs, 'utf-8').toLowerCase());
        if (inhalt.includes(s)) punkte += 10;
        else for (const w of worte) if (inhalt.includes(w)) punkte += 3;
      } catch { /* egal */ }
    }
    return { ...e, punkte };
  }).filter((e) => e.punkte > 0);

  bewertet.sort((a, b) => b.punkte - a.punkte || b.geaendert.localeCompare(a.geaendert));
  return bewertet;
}

function leseText(eintrag) {
  if (!eintrag || !eintrag.textAbs) return null;
  try { return fs.readFileSync(eintrag.textAbs, 'utf-8'); } catch { return null; }
}

// Der bearbeitbare Rohinhalt einer Textdatei (ohne den Text-Kopf, den wir beim
// Ablegen davorgesetzt haben — der gehört nicht in die Datei selbst).
function leseRoh(eintrag) {
  if (!eintrag) return null;
  if (eintrag.hatOriginal && eintrag.art === 'text') {
    try { return fs.readFileSync(eintrag.abs, 'utf-8'); } catch { return null; }
  }
  const t = leseText(eintrag);
  if (t == null) return null;
  // Kopfzeilen abtrennen: "# name", "Abgelegt: …", "Notiz dazu: …", Leerzeile
  const zeilen = t.split('\n');
  let i = 0;
  if (zeilen[0] && zeilen[0].startsWith('# ')) i = 1;
  while (i < zeilen.length && /^(Abgelegt|Notiz dazu|Bearbeitet):/.test(zeilen[i])) i++;
  while (i < zeilen.length && !zeilen[i].trim()) i++;
  return zeilen.slice(i).join('\n');
}

// ───────────────────────────────────────────── Versionen und Bearbeiten

function versioniere(slug, abs) {
  if (!abs || !fs.existsSync(abs)) return null;
  fs.mkdirSync(versionenDir(slug), { recursive: true });
  const name = path.basename(abs);
  const ext = path.extname(name);
  const stamm = name.slice(0, name.length - ext.length);
  const zeit = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ziel = path.join(versionenDir(slug), `${stamm}__${zeit}${ext}`);
  try { fs.copyFileSync(abs, ziel); return ziel; } catch { return null; }
}

// Text aus einer Datei neu gewinnen — nach jeder Bearbeitung, damit Fragen
// den aktuellen Stand sehen. Bilder und PDFs bleiben außen vor: die kann der
// Bot ohnehin nicht bearbeiten, ihr Text stammt aus der OCR beim Ablegen.
async function textAusDatei(abs) {
  const e = path.extname(abs).toLowerCase();
  if (TEXT_ENDUNGEN.has(e)) {
    try { return fs.readFileSync(abs, 'utf-8'); } catch { return null; }
  }
  if (TABELLEN_ENDUNGEN.has(e) || e === '.xls') {
    try {
      const { excelZuText } = require('../dokument');
      return await excelZuText(fs.readFileSync(abs));
    } catch { return null; }
  }
  if (e === '.docx' || e === '.doc') {
    try {
      const { wordZuText } = require('../dokument');
      return await wordZuText(fs.readFileSync(abs));
    } catch { return null; }
  }
  return null;
}

async function frischeTextAuf(slug, eintrag, hinweis) {
  if (!eintrag || !eintrag.abs) return false;
  const neu = await textAusDatei(eintrag.abs);
  if (neu == null) return false;
  const kopf = [`# ${eintrag.name}`, `Bearbeitet: ${stempel()}`, hinweis ? `Änderung: ${hinweis}` : null, '']
    .filter(Boolean).join('\n');
  try {
    fs.mkdirSync(texteDir(slug), { recursive: true });
    fs.writeFileSync(textPfadFuer(slug, eintrag.name), kopf + '\n' + neu, 'utf-8');
    return true;
  } catch { return false; }
}

// Eine vorhandene Textdatei ersetzen. Alte Fassung geht immer nach versionen/.
async function schreibeText(slug, eintrag, neuerInhalt, hinweis) {
  if (!eintrag) return { ok: false, grund: 'Datei nicht gefunden.' };
  if (eintrag.art !== 'text') return { ok: false, grund: 'Das ist keine Textdatei.' };

  let ziel = eintrag.abs;
  if (!ziel) {
    // Nur Text vorhanden: die Textdatei selbst ist das Dokument.
    ziel = eintrag.textAbs;
  }
  if (!ziel || !innerhalb(ordner(slug), ziel)) return { ok: false, grund: 'Ungültiger Pfad.' };

  const version = versioniere(slug, ziel);
  try { fs.writeFileSync(ziel, String(neuerInhalt), 'utf-8'); }
  catch (err) { return { ok: false, grund: err.message }; }

  if (eintrag.abs) await frischeTextAuf(slug, eintrag, hinweis);
  protokolliere(slug, `bearbeitet: ${eintrag.name}${hinweis ? ' — ' + hinweis : ''}`);
  return { ok: true, version, pfad: ziel };
}

// Notizen sind ein Sonderfall: sie wachsen an, deshalb keine Versionen beim
// Anhängen. Beim vollständigen Umschreiben aber sehr wohl.
async function schreibeNotizen(slug, neuerInhalt, hinweis) {
  const ziel = path.join(ordner(slug), 'notizen.md');
  const version = versioniere(slug, ziel);
  try { fs.writeFileSync(ziel, String(neuerInhalt), 'utf-8'); }
  catch (err) { return { ok: false, grund: err.message }; }
  protokolliere(slug, `Notizen umgeschrieben${hinweis ? ' — ' + hinweis : ''}`);
  return { ok: true, version, pfad: ziel };
}

// ──────────────────────────────────────────────────────────────── Excel
//
// Zellweise ändern statt die Mappe neu zu bauen. Das ist der Unterschied
// zwischen "deine Formatierung bleibt" und "die Tabelle sieht jetzt anders
// aus". Was exceljs beim Öffnen und Speichern trotzdem nicht mitnimmt
// (Diagramme, Pivot-Tabellen, manche bedingte Formatierung), sagt der Experte
// dem Nutzer vorher — verschwiegen wird das nicht.

async function excelRaster(abs, maxZeilen = 200, maxSpalten = 30) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(abs);
  const blaetter = [];
  wb.eachSheet((sheet) => {
    const zeilen = [];
    sheet.eachRow({ includeEmpty: true }, (row, nr) => {
      if (nr > maxZeilen) return;
      const werte = [];
      const spalten = Math.min(Math.max(sheet.columnCount || 0, row.cellCount || 0), maxSpalten);
      for (let c = 1; c <= spalten; c++) {
        const v = row.getCell(c).value;
        werte.push(v == null ? '' : (typeof v === 'object' && 'result' in v ? v.result : (typeof v === 'object' && 'text' in v ? v.text : v)));
      }
      zeilen.push(werte);
    });
    blaetter.push({ blatt: sheet.name, zeilen, zeilenGesamt: sheet.rowCount, spaltenGesamt: sheet.columnCount });
  });
  return blaetter;
}

// Spaltenbuchstabe zu einem 0-basierten Index: 0 -> A, 25 -> Z, 26 -> AA.
// (String.fromCharCode(65 + j) kippt ab Spalte 27 in Sonderzeichen.)
function spaltenBuchstabe(j) {
  let n = j + 1;
  let s = '';
  while (n > 0) {
    const rest = (n - 1) % 26;
    s = String.fromCharCode(65 + rest) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// Raster als Text mit Zellbezügen — so kann das Modell "B7" sagen statt
// "die Zeile mit dem Kupferrohr".
function rasterAlsText(blaetter, maxZeichen = 40_000) {
  const teile = [];
  let laenge = 0;
  for (const b of blaetter) {
    const kopf = `=== BLATT: ${b.blatt} (${b.zeilenGesamt} Zeilen, ${b.spaltenGesamt} Spalten) ===`;
    const zeilen = b.zeilen.map((werte, i) => {
      const zellen = werte.map((v, j) => {
        const s = String(v == null ? '' : v).trim();
        return s ? `${spaltenBuchstabe(j)}${i + 1}=${s}` : null;
      }).filter(Boolean);
      return zellen.length ? zellen.join('  ') : null;
    }).filter(Boolean);
    const block = kopf + '\n' + zeilen.join('\n');
    if (laenge + block.length > maxZeichen) { teile.push(kopf + '\n[gekürzt]'); break; }
    laenge += block.length;
    teile.push(block);
  }
  return teile.join('\n\n');
}

// "B7" -> { spalte: 2, zeile: 7 }. Gibt null bei Unsinn.
function zelleZuIndex(ref) {
  const m = String(ref || '').toUpperCase().match(/^([A-Z]{1,3})(\d{1,7})$/);
  if (!m) return null;
  let spalte = 0;
  for (const c of m[1]) spalte = spalte * 26 + (c.charCodeAt(0) - 64);
  return { spalte, zeile: parseInt(m[2], 10) };
}

// Liegt die Zelle noch im Bereich, den die Tabelle plausibel erreichen kann?
// Grosszuegig genug fuer neue Zeilen, eng genug, dass ein erfundener Bezug
// nicht die halbe Mappe zerlegt.
function zelleImRahmen(sheet, ref) {
  const z = zelleZuIndex(ref);
  if (!z) return { ok: false, grund: 'kein gültiger Zellbezug' };
  const maxSpalte = Math.max(sheet.columnCount || 0, 26) + 5;
  const maxZeile = Math.max(sheet.rowCount || 0, 100) + 200;
  if (z.spalte > maxSpalte) return { ok: false, grund: `Spalte liegt weit außerhalb der Tabelle (max. ${maxSpalte})` };
  if (z.zeile > maxZeile) return { ok: false, grund: `Zeile liegt weit außerhalb der Tabelle (max. ${maxZeile})` };
  return { ok: true };
}

// aenderungen: [{ blatt, zelle:'B7', wert }]
//              [{ blatt, aktion:'zeile_anhaengen', werte:[…] }]
//              [{ blatt, aktion:'zeile_loeschen', zeile:12 }]
async function excelAendern(slug, eintrag, aenderungen, hinweis) {
  if (!eintrag || !eintrag.abs) return { ok: false, grund: 'Originaldatei fehlt.' };
  if (!innerhalb(ordner(slug), eintrag.abs)) return { ok: false, grund: 'Ungültiger Pfad.' };

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(eintrag.abs);

  const version = versioniere(slug, eintrag.abs);
  const getan = [];
  const fehler = [];

  for (const a of aenderungen || []) {
    const sheet = a.blatt ? (wb.getWorksheet(a.blatt) || wb.worksheets[0]) : wb.worksheets[0];
    if (!sheet) { fehler.push(`Blatt "${a.blatt}" gibt es nicht.`); continue; }
    try {
      if (a.aktion === 'zeile_anhaengen') {
        sheet.addRow(a.werte || []);
        getan.push(`${sheet.name}: Zeile angehängt (${(a.werte || []).join(' | ')})`);
      } else if (a.aktion === 'zeile_loeschen') {
        const nr = Number(a.zeile);
        if (!Number.isInteger(nr) || nr < 1 || nr > (sheet.rowCount || 0)) {
          fehler.push(`Zeile ${a.zeile}: gibt es nicht — nicht gelöscht`); continue;
        }
        sheet.spliceRows(nr, 1);
        getan.push(`${sheet.name}: Zeile ${a.zeile} entfernt`);
      } else if (a.zelle) {
        const pruefung = zelleImRahmen(sheet, a.zelle);
        if (!pruefung.ok) { fehler.push(`${a.zelle}: ${pruefung.grund} — nicht geschrieben`); continue; }
        const zelle = sheet.getCell(String(a.zelle).toUpperCase());
        const alt = zelle.value;
        zelle.value = a.wert === '' ? null : a.wert;
        getan.push(`${sheet.name}!${String(a.zelle).toUpperCase()}: ${alt == null ? '(leer)' : alt} → ${a.wert === '' ? '(leer)' : a.wert}`);
      } else {
        fehler.push('Änderung ohne Zelle oder Aktion übersprungen.');
      }
    } catch (err) {
      fehler.push(`${a.zelle || a.aktion}: ${err.message}`);
    }
  }

  if (!getan.length) return { ok: false, grund: fehler.join('; ') || 'Nichts zu ändern.', version };

  try { await wb.xlsx.writeFile(eintrag.abs); }
  catch (err) { return { ok: false, grund: err.message, version }; }

  await frischeTextAuf(slug, eintrag, hinweis);
  protokolliere(slug, `Excel bearbeitet: ${eintrag.name} (${getan.length} Änderungen)`);
  return { ok: true, version, getan, fehler };
}

// ────────────────────────────────────────────────── Neue Dokumente bauen

async function schreibeExcel(abs, blaetter) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  for (const b of blaetter) {
    const sheet = wb.addWorksheet(String(b.blatt || 'Tabelle1').slice(0, 31));
    if (b.spalten && b.spalten.length) {
      sheet.addRow(b.spalten);
      sheet.getRow(1).font = { bold: true };
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      b.spalten.forEach((s, i) => { sheet.getColumn(i + 1).width = Math.max(12, Math.min(48, String(s).length + 6)); });
    }
    for (const z of b.zeilen || []) sheet.addRow(z);
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  await wb.xlsx.writeFile(abs);
  return abs;
}

// Schlichtes Text-PDF. Kein Layoutwunder — aber lesbar, druckbar und ohne
// zusätzliche Abhängigkeit. pdfkit lazy, wie überall in diesem Projekt.
function schreibePdf(abs, titel, text) {
  return new Promise((resolve, reject) => {
    let PDFDocument;
    try { PDFDocument = require('pdfkit'); }
    catch (err) { return reject(new Error('pdfkit nicht verfügbar: ' + err.message)); }

    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const doc = new PDFDocument({ size: 'A4', margins: { top: 56, bottom: 56, left: 56, right: 56 } });
    const strom = fs.createWriteStream(abs);
    doc.pipe(strom);

    doc.font('Helvetica-Bold').fontSize(16).text(String(titel || 'Dokument'));
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(8).fillColor('#666')
      .text(`Erstellt am ${stempel()}`);
    doc.moveDown(1).fillColor('#000');

    for (const zeile of String(text || '').split('\n')) {
      const t = zeile.replace(/\s+$/, '');
      if (!t.trim()) { doc.moveDown(0.5); continue; }
      const h = t.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(h[1].length === 1 ? 14 : 11).text(h[2]);
        doc.font('Helvetica').fontSize(10);
        continue;
      }
      if (/^\s*[-*•]\s+/.test(t)) {
        doc.font('Helvetica').fontSize(10).text('• ' + t.replace(/^\s*[-*•]\s+/, ''), { indent: 12 });
        continue;
      }
      doc.font('Helvetica').fontSize(10).text(t.replace(/\*\*(.+?)\*\*/g, '$1'));
    }
    doc.end();
    strom.on('finish', () => resolve(abs));
    strom.on('error', reject);
  });
}

// Ein frisch erzeugtes Dokument in den Ordner legen (inkl. Textfassung).
async function neuesDokument(slug, { name, kategorie, text, blaetter, pdfTitel }) {
  const kat = sichereKategorie(kategorie);
  const zielDir = kat ? path.join(dateienDir(slug), kat) : dateienDir(slug);
  fs.mkdirSync(zielDir, { recursive: true });
  fs.mkdirSync(texteDir(slug), { recursive: true });

  const basis = sicherName(name);
  const eindeutig = freierName(zielDir, `${tag()}_${basis}`);
  const abs = path.join(zielDir, eindeutig);
  const endung = path.extname(eindeutig).toLowerCase();

  let textFassung = text || '';
  if (TABELLEN_ENDUNGEN.has(endung)) {
    await schreibeExcel(abs, blaetter || []);
    textFassung = (await textAusDatei(abs)) || '';
  } else if (endung === '.pdf') {
    await schreibePdf(abs, pdfTitel || basis, text || '');
  } else {
    fs.writeFileSync(abs, String(text || ''), 'utf-8');
  }

  fs.writeFileSync(
    textPfadFuer(slug, eindeutig),
    [`# ${eindeutig}`, `Erstellt: ${stempel()} (vom Bot)`, ''].join('\n') + '\n' + textFassung,
    'utf-8'
  );
  protokolliere(slug, `erstellt: ${kat ? kat + '/' : ''}${eindeutig}`);
  return { name: eindeutig, abs, kategorie: kat };
}

// ─────────────────────────────────────────────────────────── Aufräumen

function benenneUm(slug, eintrag, neuerName) {
  if (!eintrag || !eintrag.abs) return { ok: false, grund: 'Nur der Text ist da, keine Originaldatei.' };
  const ziel = path.join(path.dirname(eintrag.abs), freierName(path.dirname(eintrag.abs), sicherName(neuerName)));
  if (!innerhalb(ordner(slug), ziel)) return { ok: false, grund: 'Ungültiger Name.' };
  try {
    fs.renameSync(eintrag.abs, ziel);
    const altText = textPfadFuer(slug, eintrag.name);
    const neuText = textPfadFuer(slug, path.basename(ziel));
    if (fs.existsSync(altText)) fs.renameSync(altText, neuText);
    protokolliere(slug, `umbenannt: ${eintrag.name} → ${path.basename(ziel)}`);
    return { ok: true, von: eintrag.name, nach: path.basename(ziel) };
  } catch (err) {
    return { ok: false, grund: err.message };
  }
}

function verschiebe(slug, eintrag, kategorie) {
  if (!eintrag || !eintrag.abs) return { ok: false, grund: 'Nur der Text ist da, keine Originaldatei.' };
  const kat = sichereKategorie(kategorie);
  const zielDir = kat ? path.join(dateienDir(slug), kat) : dateienDir(slug);
  if (!innerhalb(dateienDir(slug), zielDir)) return { ok: false, grund: 'Ungültiger Ordner.' };
  fs.mkdirSync(zielDir, { recursive: true });
  const ziel = path.join(zielDir, freierName(zielDir, eintrag.name));
  try {
    fs.renameSync(eintrag.abs, ziel);
    protokolliere(slug, `verschoben: ${eintrag.name} → ${kat || '(Hauptordner)'}`);
    return { ok: true, name: path.basename(ziel), kategorie: kat };
  } catch (err) {
    return { ok: false, grund: err.message };
  }
}

// Aussortieren heißt verschieben, nicht löschen. Der Text bleibt ebenfalls
// erhalten, wandert aber mit — damit er nicht weiter in Antworten auftaucht.
function archiviere(slug, eintrag, grund) {
  fs.mkdirSync(archivDir(slug), { recursive: true });
  const verschobene = [];
  if (eintrag.abs && fs.existsSync(eintrag.abs)) {
    const ziel = path.join(archivDir(slug), freierName(archivDir(slug), eintrag.name));
    try { fs.renameSync(eintrag.abs, ziel); verschobene.push(path.basename(ziel)); }
    catch (err) { return { ok: false, grund: err.message }; }
  }
  const t = textPfadFuer(slug, eintrag.name);
  if (fs.existsSync(t)) {
    const ziel = path.join(archivDir(slug), freierName(archivDir(slug), `${eintrag.name}.txt`));
    try { fs.renameSync(t, ziel); } catch { /* Hauptsache das Original ist weg */ }
  }
  protokolliere(slug, `archiviert: ${eintrag.name}${grund ? ' — ' + grund : ''}`);
  return { ok: true, name: eintrag.name };
}

// ──────────────────────────────────────────── Ordnerinhalt für den Prompt

function ordnerInhalt(slug) {
  const dir = ordner(slug);
  const teile = [];
  let zeichen = 0;
  let gekuerzt = false;

  const meta = ladeMeta(slug) || {};
  const dateien = index(slug);

  teile.push(`PROJEKT: ${meta.name || slug}\nAngelegt: ${(meta.angelegt || '').slice(0, 10)}`);

  // Dateiverzeichnis voranstellen: damit das Modell weiß, was es herausgeben,
  // öffnen oder bearbeiten lassen kann — auch wenn der Text gekürzt wurde.
  if (dateien.length) {
    teile.push('=== DATEIVERZEICHNIS ===\n' + dateien.map((e) =>
      `${e.name}` +
      (e.kategorie ? `  [${e.kategorie}]` : '') +
      `  (${e.art}, ${Math.round(e.groesse / 1024)} kB` +
      (e.hatOriginal ? '' : ', nur Text') +
      (e.bearbeitbar ? ', bearbeitbar' : '') + ')'
    ).join('\n'));
  }

  try {
    const n = fs.readFileSync(path.join(dir, 'notizen.md'), 'utf-8').trim();
    if (n) { teile.push('=== NOTIZEN ===\n' + n); zeichen += n.length; }
  } catch { /* keine Notizen */ }

  for (const e of dateien) {
    if (!e.textAbs) continue;
    if (zeichen >= MAX_ZEICHEN) { gekuerzt = true; continue; }
    let inhalt = '';
    try { inhalt = fs.readFileSync(e.textAbs, 'utf-8'); } catch { continue; }
    const rest = MAX_ZEICHEN - zeichen;
    if (inhalt.length > rest) { inhalt = inhalt.slice(0, rest); gekuerzt = true; }
    zeichen += inhalt.length;
    teile.push(`=== DOKUMENT: ${e.name} ===\n${inhalt}`);
  }

  return {
    text: teile.join('\n\n'),
    dateien,
    zeichen,
    gekuerzt,
    leer: dateien.length === 0 && zeichen === 0
  };
}

// Welche Dateien dürfen tatsächlich verschickt werden?
function sendbar(eintraege) {
  const raus = [];
  const abgelehnt = [];
  for (const e of eintraege) {
    if (raus.length >= MAX_SENDE_ANZAHL) { abgelehnt.push({ name: e.name, grund: 'Höchstzahl erreicht' }); continue; }
    if (!e.abs) { abgelehnt.push({ name: e.name, grund: 'nur Text vorhanden' }); continue; }
    if (e.groesse > MAX_SENDE_BYTES) { abgelehnt.push({ name: e.name, grund: 'größer als 45 MB' }); continue; }
    raus.push(e);
  }
  return { raus, abgelehnt };
}

module.exports = {
  PROJEKTE, MAX_ZEICHEN, MAX_SENDE_ANZAHL, MAX_SENDE_BYTES,
  TEXT_ENDUNGEN, TABELLEN_ENDUNGEN,
  slugify, sicherName, sichereKategorie, spaltenBuchstabe, ordner, dateienDir, texteDir, versionenDir, archivDir,
  ladeMeta, speichereMeta, protokolliere,
  listeProjekte, legeAn, findeProjekt,
  aktivesProjekt, setzeAktiv,
  legeNotizAb, legeDokumentAb,
  index, finde, leseText, leseRoh,
  versioniere, textAusDatei, frischeTextAuf,
  schreibeText, schreibeNotizen,
  excelRaster, rasterAlsText, excelAendern, zelleZuIndex,
  schreibeExcel, schreibePdf, neuesDokument,
  benenneUm, verschiebe, archiviere,
  ordnerInhalt, sendbar
};
