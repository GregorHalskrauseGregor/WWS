// Arbeitsräume — Telegram-Themen als Sichtfenster auf die eigenen Fäden.
//
// ══════════════════════════════════════════════════════════════════════════
// WAS EIN ARBEITSRAUM IST — UND WAS ER AUSDRÜCKLICH NICHT IST
// ══════════════════════════════════════════════════════════════════════════
//
// In einer Telegram-Forumgruppe gibt es "Themen". Die sollen sich anfühlen wie
// getrennte Arbeitsplätze: im Thema „Sportklinik" geht es nur um die
// Sportklinik, und der Bot soll nicht mit dem Aufmaß von gestern aus einer
// ganz anderen Baustelle dazwischenfunken.
//
// Ein Arbeitsraum ist deshalb NICHTS WEITER als eine Liste von Fäden, die in
// diesem Thema sichtbar sind. Er ist ein Filter, kein Behälter.
//
//   ✅ Er VERKLEINERT, was der Router sieht.
//   ⛔️ Er legt KEINE eigenen Fäden an, die es nur dort gäbe.
//
// Das ist der Unterschied, an dem alles hängt: ein Aufmaß, das im Thema
// „Sportklinik" beginnt, gehört weiterhin dem Konto seines Besitzers. Er kann
// es im Einzelchat weiterführen, in einem anderen Thema aufrufen, überall.
// Das Thema bestimmt nur, WORAUF DER BOT DORT SCHAUT — nicht, wo etwas liegt.
//
// Wäre es andersherum, hätte man Daten, die nur an einem Ort erreichbar sind:
// verschwindet das Thema, verschwindet die Arbeit. Genau das soll nicht sein.
//
// ══════════════════════════════════════════════════════════════════════════
// WIE EIN FADEN IN EINEN RAUM KOMMT
// ══════════════════════════════════════════════════════════════════════════
//
//   von allein   Was im Thema entsteht, wird dort aufgenommen. Sonst müsste
//                man jeden neuen Vorgang von Hand hinzufügen, und niemand
//                täte es.
//   mit /add     Einen bestehenden Faden dazuholen: „/add Sportklinik".
//
// Ein LEERER Raum sieht bewusst nichts. Er ist ein frischer Arbeitsplatz, kein
// Fenster auf alles. Der erste Vorgang, der dort entsteht, zieht ein.
//
// Im Allgemein-Thema einer Forumgruppe (Telegram liefert dort keine Thema-ID)
// gibt es keinen Raum und damit keine Einschränkung — dort sieht man alles.

const fs = require('fs');
const path = require('path');
const { PFADE } = require('./config');

const DATEI = path.join(PFADE.DATA, 'arbeitsraeume.json');
const MAX_FAEDEN = 60;

function lade() {
  try {
    if (!fs.existsSync(DATEI)) return {};
    const roh = JSON.parse(fs.readFileSync(DATEI, 'utf-8'));
    return roh && typeof roh === 'object' ? roh : {};
  } catch {
    return {};
  }
}

function speichere(daten) {
  try {
    fs.mkdirSync(path.dirname(DATEI), { recursive: true });
    const temp = DATEI + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(daten, null, 2), 'utf-8');
    fs.renameSync(temp, DATEI);
    return true;
  } catch (err) {
    console.error('Arbeitsräume nicht schreibbar:', err.message);
    return false;
  }
}

function schluessel(gruppenId, threadId) {
  return `${gruppenId}:${threadId}`;
}

// Gibt es hier ueberhaupt einen Raum? Ohne Thema-ID (Allgemein-Thema,
// Einzelchat, normale Gruppe ohne Forum) gibt es keinen — und damit keine
// Einschraenkung.
function istRaumfaehig(gruppenId, threadId) {
  return gruppenId != null && threadId != null && threadId !== 0;
}

function finde(gruppenId, threadId) {
  if (!istRaumfaehig(gruppenId, threadId)) return null;
  return lade()[schluessel(gruppenId, threadId)] || null;
}

// Beim ersten Wort in einem Thema entsteht der Raum. Bewusst leer: was hier
// arbeitet, zieht danach von selbst ein.
function sorgeFuerRaum(gruppenId, threadId, { name, konto } = {}) {
  if (!istRaumfaehig(gruppenId, threadId)) return null;
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  if (!daten[k]) {
    daten[k] = {
      gruppenId: String(gruppenId),
      threadId: Number(threadId),
      name: name || null,
      konto: konto == null ? null : String(konto),
      faeden: [],
      angelegt: new Date().toISOString(),
      zuletzt: new Date().toISOString()
    };
  } else {
    if (name && !daten[k].name) daten[k].name = name;
    if (konto != null && !daten[k].konto) daten[k].konto = String(konto);
    daten[k].zuletzt = new Date().toISOString();
  }
  speichere(daten);
  return daten[k];
}

function fuegeHinzu(gruppenId, threadId, themaId) {
  if (!istRaumfaehig(gruppenId, threadId) || !themaId) return null;
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  const raum = daten[k];
  if (!raum) return null;
  raum.faeden = raum.faeden || [];
  if (!raum.faeden.includes(themaId)) {
    raum.faeden.push(themaId);
    // Obergrenze, damit ein jahrelang genutztes Thema den Router-Prompt nicht
    // irgendwann sprengt. Die aeltesten fallen hinten raus — sie sind ja nicht
    // geloescht, nur nicht mehr in diesem Fenster.
    if (raum.faeden.length > MAX_FAEDEN) raum.faeden = raum.faeden.slice(-MAX_FAEDEN);
  }
  raum.zuletzt = new Date().toISOString();
  speichere(daten);
  return raum;
}

function nimmRaus(gruppenId, threadId, themaId) {
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  const raum = daten[k];
  if (!raum || !Array.isArray(raum.faeden)) return false;
  const vorher = raum.faeden.length;
  raum.faeden = raum.faeden.filter((id) => id !== themaId);
  if (raum.faeden.length === vorher) return false;
  raum.zuletzt = new Date().toISOString();
  speichere(daten);
  return true;
}

// Die Liste, auf die der Router eingeschraenkt wird. null heisst: keine
// Einschraenkung (kein Raum vorhanden).
function erlaubteFaeden(gruppenId, threadId) {
  const raum = finde(gruppenId, threadId);
  if (!raum) return null;
  return Array.isArray(raum.faeden) ? raum.faeden.slice() : [];
}

function benenne(gruppenId, threadId, name) {
  const daten = lade();
  const k = schluessel(gruppenId, threadId);
  if (!daten[k]) return null;
  daten[k].name = name || daten[k].name;
  daten[k].zuletzt = new Date().toISOString();
  speichere(daten);
  return daten[k];
}

// Alle Raeume eines Kontos — fuer Uebersichten.
function fuerKonto(konto) {
  const id = String(konto);
  return Object.values(lade())
    .filter((r) => r && String(r.konto) === id)
    .sort((a, b) => String(b.zuletzt || '').localeCompare(String(a.zuletzt || '')));
}

// Wird eine Gruppe abgeloest, gehen ihre Raeume mit. Die FAEDEN bleiben —
// die gehoeren dem Konto, nicht dem Raum. Genau das ist der Punkt.
function entferneGruppe(gruppenId) {
  const daten = lade();
  const praefix = `${gruppenId}:`;
  let weg = 0;
  for (const k of Object.keys(daten)) {
    if (k.startsWith(praefix)) { delete daten[k]; weg++; }
  }
  if (weg) speichere(daten);
  return weg;
}

module.exports = {
  DATEI, MAX_FAEDEN,
  istRaumfaehig, finde, sorgeFuerRaum, fuegeHinzu, nimmRaus,
  erlaubteFaeden, benenne, fuerKonto, entferneGruppe,
  _intern: { lade, speichere, schluessel }
};
