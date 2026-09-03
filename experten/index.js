// Registry für alle Experten-Module.
//
// Lädt automatisch jede .js-Datei aus diesem Ordner (außer index.js und
// _template.js), prüft den Vertrag und stellt die Liste bereit.
//
// WICHTIG: Diese Datei entscheidet NICHTS mehr. Die Auswahl, welcher Experte
// zuständig ist, trifft ausschließlich der Router (kern/router.js). Früher gab
// es hier einen zweiten, kompletten KI-Router (waehleExpertenMitKI) plus eine
// Trigger-Wort-Suche — beide wurden nie aufgerufen und sind entfernt. Pro
// Entscheidung gibt es jetzt genau eine Stelle im Code.

const fs = require('fs');
const path = require('path');

const EXPERTEN_ORDNER = __dirname;
const IGNORIEREN = new Set(['index.js']);
// Dateien mit fuehrendem _ sind Vorlagen oder Hilfsmodule, keine Experten.
const istHilfsdatei = (name) => name.startsWith('_');

// Pflichtfelder für JEDEN Experten (auch Stubs).
const PFLICHT_IMMER = ['id', 'name', 'beschreibung', 'zustaendigWenn', 'implementiert'];

function pruefeVertrag(modul, datei) {
  for (const feld of PFLICHT_IMMER) {
    if (modul[feld] === undefined) {
      throw new Error(`Pflichtfeld "${feld}" fehlt in ${datei}`);
    }
  }
  if (!modul.implementiert) return; // Stubs brauchen keine Logik

  // Ein implementierter Experte ist eine von drei Bauarten:
  //   Vorgang — deklaratives schema + finalisiere (der Motor führt)
  //   frei    — eigene verarbeite() (volle Kontrolle)
  //   Prompt  — nur systemPromptAdd (+ evtl. Tools); der Standard-Chat übernimmt
  const istVorgang = !!modul.schema;
  const istFrei = typeof modul.verarbeite === 'function';
  const istPrompt = typeof modul.systemPromptAdd === 'string' && modul.systemPromptAdd.trim().length > 0;
  if (!istVorgang && !istFrei && !istPrompt) {
    throw new Error(
      `${datei}: implementierter Experte braucht "schema"+"finalisiere" (Vorgang), ` +
      `"verarbeite" (frei) oder "systemPromptAdd" (Prompt-Experte)`
    );
  }
  if (istVorgang && typeof modul.finalisiere !== 'function') {
    throw new Error(`${datei}: "schema" gesetzt, aber "finalisiere" fehlt`);
  }
  for (const t of modul.tools || []) {
    if (!t.name || typeof t.ausfuehren !== 'function') {
      throw new Error(`${datei}: Tool ohne "name" oder "ausfuehren"`);
    }
  }
  for (const c of modul.commands || []) {
    if (!c.name || typeof c.ausfuehren !== 'function') {
      throw new Error(`${datei}: Command ohne "name" oder "ausfuehren"`);
    }
  }
}

function ladeExperten() {
  const dateien = fs.readdirSync(EXPERTEN_ORDNER, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith('.js') && !IGNORIEREN.has(d.name) && !istHilfsdatei(d.name))
    .map((d) => d.name)
    .sort();

  const experten = [];
  const fehler = [];
  for (const datei of dateien) {
    try {
      const modul = require(path.join(EXPERTEN_ORDNER, datei));
      pruefeVertrag(modul, datei);
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

let _cache = null;
function alleExperten() {
  if (!_cache) _cache = ladeExperten();
  return _cache;
}

// Nur implementierte Experten — Stubs werden dem Router gar nicht erst
// angeboten und können deshalb nicht versehentlich aktiviert werden.
function implementierteExperten() {
  return alleExperten().filter((e) => e.implementiert);
}

function findeExperteMitId(id) {
  return alleExperten().find((e) => e.id === id) || null;
}

// Ist dieser Experte deklarativ (Schema) oder frei (eigene verarbeite)?
function istVorgangsExperte(experte) {
  return !!(experte && experte.schema);
}

// Bauart eines Experten — entscheidet, wie der Orchestrator ihn ausführt.
function art(experte) {
  if (!experte || !experte.implementiert) return 'Stub';
  if (experte.schema) return 'Vorgang';
  if (typeof experte.verarbeite === 'function') return 'frei';
  return 'Prompt';
}

// Alle von Experten mitgebrachten Slash-Commands, flach.
// Ersetzt die früheren Sonderfälle in bot.js (/pdf, /reset_aufnahme).
function alleCommands() {
  const raus = [];
  for (const e of implementierteExperten()) {
    for (const c of e.commands || []) {
      raus.push({ ...c, experte: e });
    }
  }
  return raus;
}

// Alle Datei-Hooks. Früher wurde onPhoto/onDocument nur beim Aufmaß gerufen,
// obwohl drei Experten sie definiert hatten.
function expertenMitDateiHook() {
  return implementierteExperten().filter((e) => typeof e.onDatei === 'function');
}

function listeStatus() {
  return alleExperten().map((e) => ({
    id: e.id,
    name: e.name,
    emoji: e.emoji || '·',
    beschreibung: e.beschreibung,
    zustaendigWenn: e.zustaendigWenn,
    implementiert: e.implementiert,
    art: art(e),
    tools: (e.tools || []).map((t) => t.name),
    commands: (e.commands || []).map((c) => c.name),
    datei: e._datei
  }));
}

// Nur für Tests: Cache leeren, damit neu geladen wird.
function _resetCache() { _cache = null; }

module.exports = {
  ladeExperten,
  alleExperten,
  implementierteExperten,
  findeExperteMitId,
  istVorgangsExperte,
  art,
  alleCommands,
  expertenMitDateiHook,
  listeStatus,
  _resetCache
};
