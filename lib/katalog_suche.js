// lib/katalog_suche.js — Stichwort-Suche ueber die Katalog-Volltext-Indizes.
//
// API:
//   findeSeiten(index, wortgruppen [, optionen])
//
//   index       : Object, das JSON aus data/kataloge_index/<katalog>.json
//   wortgruppen : Array<Array<string>>
//                  Innerhalb einer Gruppe: UND (alle Worte muessen vorkommen)
//                  Zwischen Gruppen:    ODER (mindestens eine Gruppe muss passen)
//   optionen    : { caseSensitive?: bool, wortGrenzen?: bool }
//
//   Rueckgabe   : Array<{ seite: number, match: string[] }>
//                  - seite: Seitenzahl (1-basiert)
//                  - match: die Wortgruppe, die den Treffer ausgeloest hat
//
// Verwendung im WWS-Bot:
//   1. LLM generiert wortgruppen aus Material-Beschreibung + Synonymen
//   2. Bot ruft findeSeiten(...) pro Katalog auf
//   3. Bot konsolidiert die Treffer und uebergibt sie an Playwright-Flow

'use strict';

/**
 * Findet alle Seiten in einem Katalog-Index, auf denen mindestens eine
 * der uebergebenen Wortgruppen vollstaendig vorkommt (UND).
 *
 * @param {Object} index - JSON aus data/kataloge_index/<katalog>.json
 * @param {string[][]} wortgruppen - Array von Wort-Arrays
 * @param {Object} [opts] - Optionen
 * @param {boolean} [opts.caseSensitive=false] - Default: case-insensitive
 * @param {boolean} [opts.wortGrenzen=true] - Wort-Grenzen-Check (Default) vs. Substring
 * @returns {Array<{seite: number, match: string[]}>}
 */
function findeSeiten(index, wortgruppen, opts = {}) {
  if (!index || !index.seite_text) return [];
  if (!Array.isArray(wortgruppen) || wortgruppen.length === 0) return [];

  const caseSensitive = !!opts.caseSensitive;
  const wortGrenzen = opts.wortGrenzen !== false; // Default true

  // Vorbereiten: Wortgruppen normalisieren, leere raus, deduplizieren
  const gruppen = [];
  const gesehen = new Set();
  for (const g of wortgruppen) {
    if (!Array.isArray(g)) continue;
    const woerter = g
      .filter(w => typeof w === 'string' && w.trim().length > 0)
      .map(w => caseSensitive ? w.trim() : w.trim().toLowerCase());
    if (woerter.length === 0) continue;
    // Dedup: identische Gruppe nicht zweimal
    const key = woerter.join('\u0001');
    if (gesehen.has(key)) continue;
    gesehen.add(key);
    // RegEx vorab compilieren
    const patterns = woerter.map(w => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = wortGrenzen
        ? new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu')
        : new RegExp(escaped, 'iu');
      return re;
    });
    gruppen.push({ original: g, patterns });
  }
  if (gruppen.length === 0) return [];

  const ergebnisse = [];
  for (const [seiteKey, text] of Object.entries(index.seite_text)) {
    if (!text) continue;
    const seiteNr = parseInt(seiteKey, 10);
    if (isNaN(seiteNr)) continue;
    const haystack = caseSensitive ? text : text.toLowerCase();
    for (const gruppe of gruppen) {
      const alleTreffer = gruppe.patterns.every(re => re.test(haystack));
      if (alleTreffer) {
        ergebnisse.push({ seite: seiteNr, match: gruppe.original });
        break; // eine matchende Gruppe reicht pro Seite
      }
    }
  }
  return ergebnisse;
}

/**
 * Bequemlichkeits-Funktion: durchsucht ALLE Katalog-Indizes in einem
 * Verzeichnis und konsolidiert die Treffer pro Katalog.
 *
 * @param {string} indexDir - Pfad zu data/kataloge_index/
 * @param {string[][]} wortgruppen - Wortgruppen (siehe findeSeiten)
 * @param {Object} [opts] - Optionen (siehe findeSeiten)
 * @returns {Promise<Array<{katalog: string, quelle: string, treffer: Array}>}
 */
async function findeInAllenKatalogen(indexDir, wortgruppen, opts = {}) {
  const fs = require('fs').promises;
  const path = require('path');

  const ergebnisse = [];
  let files;
  try {
    files = await fs.readdir(indexDir);
  } catch (e) {
    throw new Error(`Konnte Index-Verzeichnis nicht lesen: ${indexDir}: ${e.message}`);
  }
  files = files.filter(f => f.endsWith('.json')).sort();

  for (const file of files) {
    const fullPath = path.join(indexDir, file);
    let index;
    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      index = JSON.parse(content);
    } catch (e) {
      console.warn(`[katalog_suche] Konnte ${file} nicht laden: ${e.message}`);
      continue;
    }
    const treffer = findeSeiten(index, wortgruppen, opts);
    if (treffer.length > 0) {
      ergebnisse.push({
        katalog: index.katalog || file.replace('.json', ''),
        quelle: index.quelle || file,
        seiten_gesamt: index.seiten || 0,
        treffer: treffer
      });
    }
  }
  return ergebnisse;
}

module.exports = { findeSeiten, findeInAllenKatalogen };
