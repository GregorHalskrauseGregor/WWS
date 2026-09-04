// Wissensbasis — Karten statt Regelmaschine.
//
// Frueher standen hier 661 Zeilen: neun YAML-Dateien, eine eigene Regelgrammatik,
// deterministische Umrechnung von Gebinden, Zoll und Werkstoffen. Das Problem war
// nicht, dass es nicht funktioniert hat, sondern dass Fachwissen dabei zu Code
// wurde: um "eine Stange Kupfer sind 5 m" zu ergaenzen, musste man YAML-Syntax
// treffen und wissen, in welcher der neun Dateien es steht.
//
// Jetzt gilt: Wissen ist TEXT, den die KI liest — nicht Code, der Werte aendert.
//
//   wissen/Wissensbank.md   Eingangskorb. Hier schreibt Torsten lose rein, und
//                           der Bot loggt hier chronologisch, was er dazulernt.
//   wissen/karten/*.md      Aufgeraeumtes Wissen, thematisch geschnitten. Jede
//                           Karte traegt eine Zeile "> Laden wenn: ...".
//
// Diese Zeile ist der ganze Trick: der Router bekommt nur die Titel plus diese
// eine Zeile (ein paar hundert Zeichen) und entscheidet, WELCHE Karten mit in
// den Prompt muessen. So kostet Wissen nur dort Tokens, wo es gebraucht wird.
//
// Deterministisch bleibt hier genau eines: die Kategorienliste fuer die
// Lagerdatei. Die muss ein festes Vokabular sein, sonst schreibt jede Buchung
// eine neue Kategorie-Schreibweise in die Excel.

const fs = require('fs');
const path = require('path');

// Umlenkbar, damit Tests nicht in die echte Wissensbasis schreiben — /addKnowledge
// und "merk dir" veraendern Dateien, und ein Testlauf darf Torstens Notizen nicht
// anfassen.
const ORDNER = process.env.WWS_WISSEN
  ? path.resolve(process.env.WWS_WISSEN)
  : path.join(__dirname, '..', 'wissen');
const KARTEN_ORDNER = path.join(ORDNER, 'karten');
const BANK = path.join(ORDNER, 'Wissensbank.md');

let _karten = null;

// ------------------------------------------------------------------- Karten

function leseKarte(datei) {
  const roh = fs.readFileSync(path.join(KARTEN_ORDNER, datei), 'utf-8');
  const zeilen = roh.split('\n');
  const titel = (zeilen.find((z) => z.startsWith('# ')) || '# ' + datei).slice(2).trim();
  const wannZeile = zeilen.find((z) => z.trim().startsWith('> Laden wenn:'));
  const wann = wannZeile ? wannZeile.replace(/^\s*>\s*Laden wenn:\s*/, '').trim() : '';
  return {
    id: datei.replace(/\.md$/, ''),
    titel,
    wann,
    text: roh.trim(),
    zeichen: roh.length
  };
}

function karten() {
  if (_karten) return _karten;
  let dateien = [];
  try {
    dateien = fs.readdirSync(KARTEN_ORDNER).filter((d) => d.endsWith('.md')).sort();
  } catch { dateien = []; }
  _karten = dateien.map(leseKarte);
  return _karten;
}

function karte(id) {
  return karten().find((k) => k.id === id) || null;
}

function neuLaden() { _karten = null; return karten(); }

// Was der Router zu sehen bekommt: nur Name und Ladehinweis, nie der Inhalt.
function katalog() {
  const k = karten();
  if (!k.length) return '(keine Wissenskarten vorhanden)';
  return k.map((x) => `- ${x.id}: ${x.wann || x.titel}`).join('\n');
}

// Der Text der ausgewaehlten Karten, fuer den System-Prompt eines Experten.
// Unbekannte IDs werden still ignoriert — ein Modell, das sich eine Karte
// ausdenkt, soll den Vorgang nicht zum Absturz bringen.
function text(ids) {
  const gewuenscht = Array.isArray(ids) ? ids : [ids];
  const treffer = gewuenscht.map((id) => karte(String(id || '').trim())).filter(Boolean);
  if (!treffer.length) return '';
  return 'FACHWISSEN (aus deiner Wissensbasis, gilt vor deinem Allgemeinwissen):\n\n'
    + treffer.map((k) => k.text).join('\n\n---\n\n');
}

// Alles: jede Karte plus die Wissensbank. Fuer /addAllK und /addKnowledge.
function alles() {
  const teile = karten().map((k) => k.text);
  const bank = leseBank();
  if (bank) teile.push('WISSENSBANK (Eingangskorb, noch nicht eingeordnet):\n\n' + bank);
  return teile.join('\n\n---\n\n');
}

// ------------------------------------------------------- Kategorien (fest)

// Die einzige deterministische Auswertung: die "##"-Ueberschriften der
// Warengruppenkarte sind das Kategorie-Vokabular der Lagerdatei. Ohne feste
// Liste schreibt jede Buchung eine neue Schreibweise in die Excel-Spalte.
function kategorien() {
  const k = karte('warengruppen');
  if (!k) return [];
  return k.text.split('\n')
    .filter((z) => /^##\s+\S/.test(z))
    .map((z) => z.replace(/^##\s+/, '').trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------- Wissensbank

function leseBank() {
  try { return fs.readFileSync(BANK, 'utf-8'); } catch { return ''; }
}

function heute() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Haengt eine Zeile chronologisch an. Wird sowohl vom Nutzer genutzt (/merkeW)
// als auch vom Bot, wenn er im Gespraech etwas dazulernt.
function notiere(satz, quelle) {
  const sauber = String(satz || '').replace(/\s+/g, ' ').trim();
  if (!sauber) return false;
  let inhalt = leseBank();
  const ueberschrift = `## ${heute()}`;
  if (!inhalt.includes(ueberschrift)) inhalt = inhalt.replace(/\s*$/, '') + `\n\n${ueberschrift}\n`;
  const herkunft = quelle ? `  _(${quelle})_` : '';
  inhalt = inhalt.replace(/\s*$/, '') + `\n- [ ] ${sauber}${herkunft}\n`;
  fs.writeFileSync(BANK, inhalt, 'utf-8');
  return true;
}

// Alle noch nicht eingeordneten Zeilen, mit ihrer Zeilennummer in der Datei.
function offeneEintraege() {
  const zeilen = leseBank().split('\n');
  const raus = [];
  zeilen.forEach((z, i) => {
    const m = z.match(/^\s*-\s*\[\s\]\s*(.+)$/);
    if (m) raus.push({ nr: i, satz: m[1].replace(/\s*_\(.*\)_\s*$/, '').trim() });
  });
  return raus;
}

// Hakt eingeordnete Zeilen ab und notiert dahinter, wo sie gelandet sind.
// Die Zeile bleibt stehen: die Wissensbank ist ein Verlauf, kein Postausgang.
function hakeAb(zuordnungen) {
  const zeilen = leseBank().split('\n');
  let n = 0;
  for (const { nr, karte: ziel } of zuordnungen) {
    if (typeof zeilen[nr] !== 'string') continue;
    if (!/^\s*-\s*\[\s\]/.test(zeilen[nr])) continue;
    zeilen[nr] = zeilen[nr].replace(/^(\s*-\s*)\[\s\]/, '$1[x]') + `  → ${ziel}`;
    n++;
  }
  fs.writeFileSync(BANK, zeilen.join('\n'), 'utf-8');
  return n;
}

// ------------------------------------------------------------ Karten pflegen

// Haengt Text unten an eine bestehende Karte an.
function ergaenzeKarte(id, absatz) {
  const k = karte(id);
  if (!k) return false;
  const p = path.join(KARTEN_ORDNER, id + '.md');
  fs.writeFileSync(p, k.text.replace(/\s*$/, '') + '\n\n' + String(absatz).trim() + '\n', 'utf-8');
  neuLaden();
  return true;
}

// Legt eine neue Karte an. Der Ladehinweis ist Pflicht — ohne ihn kann der
// Router nicht wissen, wann er sie braucht, und sie waere totes Gewicht.
function legeKarteAn(id, titel, wann, inhalt) {
  const sauber = String(id || '').toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  if (!sauber || !wann) return null;
  if (karte(sauber)) return null;
  const doku = `# ${titel || sauber}\n> Laden wenn: ${wann}\n\n${String(inhalt || '').trim()}\n`;
  fs.mkdirSync(KARTEN_ORDNER, { recursive: true });
  fs.writeFileSync(path.join(KARTEN_ORDNER, sauber + '.md'), doku, 'utf-8');
  neuLaden();
  return sauber;
}

// --------------------------------------------------------------- /addAllK

// Merkt sich, dass die NAECHSTE Nachricht dieses Chats die komplette
// Wissensbasis bekommen soll. Bewusst nur im Speicher: das Flag soll einen
// Neustart nicht ueberleben, sonst zahlt der Nutzer wochenlang fuer eine
// Entscheidung, die fuer eine einzige Frage gedacht war.
const _allesFuer = new Set();
function merkeAllesFuer(chatId) { _allesFuer.add(String(chatId)); }
function brauchtAlles(chatId) { return _allesFuer.delete(String(chatId)); }

module.exports = {
  ORDNER, KARTEN_ORDNER, BANK,
  merkeAllesFuer, brauchtAlles,
  karten, karte, katalog, text, alles, neuLaden,
  kategorien,
  leseBank, notiere, offeneEintraege, hakeAb,
  ergaenzeKarte, legeKarteAn
};
