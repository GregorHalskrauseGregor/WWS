// Dienste-Registry — dasselbe Austausch-Muster wie bei den KI-Anbietern,
// jetzt auch für die spezialisierten Fach-APIs.
//
// Vorher war OCR fest auf Mistral verdrahtet, Transkription fest auf AssemblyAI
// und die Suche fest auf Brave — jeweils direkt im Modul. Ein Anbieterwechsel
// war ein Code-Umbau. Jetzt ist es eine Zeile in der .env:
//
//   OCR_KETTE=mistral,google
//   TRANSKRIPTION_KETTE=assemblyai
//   SUCHE_KETTE=brave
//   LESEN_KETTE=jina
//
// Mehrere Einträge = Fallback-Kette: fällt der erste aus, übernimmt der nächste.
// Ein neuer Anbieter ist eine neue Datei im passenden Unterordner mit
// { name, verfuegbar(), benoetigt, ausfuehren() } — mehr nicht.

const fs = require('fs');
const path = require('path');
const { schreibeEintrag } = require('../protokoll');

const ARTEN = ['ocr', 'transkription', 'suche', 'lesen'];

function ladeAnbieter(art) {
  const ordner = path.join(__dirname, art);
  if (!fs.existsSync(ordner)) return [];
  return fs.readdirSync(ordner)
    .filter((d) => d.endsWith('.js'))
    .map((d) => {
      try { return require(path.join(ordner, d)); }
      catch (err) { console.warn(`Dienst ${art}/${d} nicht ladbar: ${err.message}`); return null; }
    })
    .filter(Boolean);
}

const registry = {};
for (const art of ARTEN) registry[art] = ladeAnbieter(art);

// Reihenfolge aus der .env, sonst alle registrierten in Dateireihenfolge.
function kette(art) {
  const konfiguriert = (process.env[`${art.toUpperCase()}_KETTE`] || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (konfiguriert.length === 0) return registry[art];
  const nachName = new Map(registry[art].map((a) => [a.name, a]));
  return konfiguriert.map((n) => nachName.get(n)).filter(Boolean);
}

// Führt die Kette der Reihe nach durch: nicht verfügbare überspringen,
// bei Fehler den nächsten versuchen, sonst mit klarer Meldung scheitern.
async function fuehreAus(art, ...args) {
  const anbieter = kette(art);
  if (anbieter.length === 0) {
    throw new Error(`Kein Dienst für "${art}" registriert.`);
  }
  const uebersprungen = [];
  let letzterFehler = null;

  for (const a of anbieter) {
    if (!a.verfuegbar()) {
      uebersprungen.push(`${a.name} (${a.benoetigt || 'nicht konfiguriert'} fehlt)`);
      continue;
    }
    try {
      const ergebnis = await a.ausfuehren(...args);
      if (letzterFehler) {
        schreibeEintrag('Info', `Dienst-Fallback: ${art} über "${a.name}" nach Fehler bei vorherigem Anbieter.`);
      }
      return ergebnis;
    } catch (err) {
      letzterFehler = err;
      schreibeEintrag('Fehler', `Dienst ${art}/${a.name}: ${err.message.slice(0, 200)}`);
    }
  }

  if (letzterFehler) throw letzterFehler;
  throw new Error(
    `Kein nutzbarer ${art}-Dienst. Übersprungen: ${uebersprungen.join(', ') || '—'}. ` +
    `Trag den passenden Key in die .env ein.`
  );
}

// Ist für diese Art überhaupt ein Anbieter einsatzbereit?
function verfuegbar(art) {
  return kette(art).some((a) => a.verfuegbar());
}

function status() {
  return ARTEN.map((art) => ({
    art,
    kette: kette(art).map((a) => ({ name: a.name, bereit: a.verfuegbar(), benoetigt: a.benoetigt }))
  }));
}

module.exports = {
  ARTEN,
  status,
  verfuegbar,
  ocr: (buffer, mimeType) => fuehreAus('ocr', buffer, mimeType),
  transkription: (buffer, mimeType) => fuehreAus('transkription', buffer, mimeType),
  suche: (query, maxResults) => fuehreAus('suche', query, maxResults),
  lesen: (url) => fuehreAus('lesen', url),
  _fuehreAus: fuehreAus,
  _kette: kette
};
