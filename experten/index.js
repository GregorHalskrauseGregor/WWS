// Registry für alle Experten-Module. Lädt automatisch alle .js-Dateien
// aus diesem Ordner (außer dieser Index-Datei und der _template.js) und
// stellt Funktionen zur Verfügung:
//
//   ladeExperten()    - alle registrierten Experten
//   findeExperte(text) - welcher Experte passt zur Nachricht?
//   listeStatus()     - Übersicht für /experten Command

const fs = require('fs');
const path = require('path');

const EXPERTEN_ORDNER = __dirname;

// Schwarze Liste: diese Dateien NICHT als Experten laden
const IGNORIEREN = new Set(['index.js', '_template.js']);

function ladeExperten() {
  const dateien = fs.readdirSync(EXPERTEN_ORDNER, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js') && !IGNORIEREN.has(d.name))
    .map((d) => d.name);

  const experten = [];
  const fehler = [];
  for (const datei of dateien) {
    const pfad = path.join(EXPERTEN_ORDNER, datei);
    try {
      const modul = require(pfad);
      // Sanity-Check: das Modul muss die Pflichtfelder haben
      const pflicht = ['id', 'name', 'description', 'triggers', 'systemPromptAdd', 'verarbeite', 'implementiert'];
      for (const feld of pflicht) {
        if (modul[feld] === undefined) {
          throw new Error(`Pflichtfeld "${feld}" fehlt in ${datei}`);
        }
      }
      if (!Array.isArray(modul.triggers) || modul.triggers.length === 0) {
        throw new Error(`"triggers" muss eine nicht-leere Liste sein in ${datei}`);
      }
      if (typeof modul.verarbeite !== 'function') {
        throw new Error(`"verarbeite" muss eine Funktion sein in ${datei}`);
      }
      experten.push({ ...modul, _datei: datei });
    } catch (err) {
      fehler.push({ datei, fehler: err.message });
    }
  }
  if (fehler.length > 0) {
    console.warn('Experten-Module mit Lade-Fehlern:');
    for (const f of fehler) console.warn(`  ${f.datei}: ${f.fehler}`);
  }
  return experten;
}

function _expertenCache() {
  if (!_expertenCache._cache) {
    _expertenCache._cache = ladeExperten();
  }
  return _expertenCache._cache;
}

// Findet den passendsten Experten für eine Nachricht. Matching:
//   1) Trigger-Wort kommt im Text vor (case-insensitive)
//   2) Bei mehreren Treffern gewinnt der Experte mit den meisten Match-Punkten
//      (längere Trigger zählen mehr, weil sie spezifischer sind)
//   3) Kein Treffer → null
function findeExperte(text) {
  if (!text || typeof text !== 'string') return null;
  const norm = text.toLowerCase();
  const experten = _expertenCache();
  let bester = null;
  let bestePunkte = 0;
  for (const e of experten) {
    let punkte = 0;
    for (const trig of e.triggers) {
      const t = String(trig).toLowerCase();
      if (!t) continue;
      // Substring-Match, längere Trigger zählen mehr
      if (norm.includes(t)) punkte += t.length;
    }
    if (punkte > bestePunkte) {
      bestePunkte = punkte;
      bester = e;
    }
  }
  return bester;
}

// Übersicht für /experten
function listeStatus() {
  return _expertenCache().map((e) => ({
    id: e.id,
    name: e.name,
    emoji: e.emoji || '·',
    description: e.description,
    triggers: e.triggers,
    implementiert: e.implementiert,
    datei: e._datei
  }));
}

// Direkt nach ID suchen (z.B. /experte materialaufmass)
function findeExperteMitId(id) {
  return _expertenCache().find((e) => e.id === id) || null;
}

module.exports = {
  ladeExperten,
  findeExperte,
  findeExperteMitId,
  listeStatus
};
