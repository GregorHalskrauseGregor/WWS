// material.js — Kernlogik für die Materialverwaltung (Warenwirtschaft).
// Liest und schreibt material.xlsx über lib/excel.js. Alle Werkzeuge
// (Hinzufügen, Entnehmen, Suchen, Bedarf prüfen, Liste) laufen hier.
//
// Designentscheidungen (laut Projekt-Stand):
//   - Eine Zeile pro Artikel (nicht pro Zustand). Die drei Zustands-Spalten
//     (Menge Neu, Gebraucht, Verschmutzt) summieren sich zum Gesamtbestand.
//   - Bestandsschutz: Entnahmen können nie negativ werden.
//   - Keine Selbstheilung bei fehlender Datei (soll laut auffallen).
//   - Keine Zeile wird jemals gelöscht (nur ergänzt). Bestand 0 bleibt stehen.

const libExcel = require('./lib/excel');

function sichereZahl(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).replace(',', '.').trim();
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// Findet die passende Spalte für einen Zustand.
function spalteFuerZustand(zustand) {
  const z = String(zustand || 'neu').toLowerCase();
  if (z === 'gebraucht') return 'mengeGebraucht';
  if (z === 'verschmutzt' || z === 'verschmutz') return 'mengeVerschmutzt';
  return 'mengeNeu';
}

// Vergleicht zwei Material-Bezeichnungen tolerant: exakte Übereinstimmung
// oder ein Token-Match (z.B. "Kupferrohr 22mm" findet "Kupferrohr 22 mm" / "Kupferrohr 22").
// DN-Normalisierung: "DN 20" == "DN20" == "DN-20".
function normalisiereFuerVergleich(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[\s\-_]+/g, ' ')      // Mehrere Spaces/Trennzeichen zu einem
    .replace(/dn\s*(\d+)/g, 'dn$1') // DN 20 -> dn20
    .replace(/\s+/g, ' ')          // Doppelte Spaces weg
    .trim();
}

function findePosition(positionen, suchbegriff) {
  const norm = normalisiereFuerVergleich(suchbegriff);
  if (!norm) return null;
  // 1) Exakte Übereinstimmung
  for (const p of positionen) {
    if (normalisiereFuerVergleich(p.bezeichnung) === norm) return p;
  }
  // 2) Enthält-Suche
  for (const p of positionen) {
    if (normalisiereFuerVergleich(p.bezeichnung).includes(norm)) return p;
  }
  // 3) Token-Überschneidung
  const suchTokens = norm.split(' ').filter((t) => t.length >= 3);
  let bester = null;
  let besteÜberlappung = 0;
  for (const p of positionen) {
    const pNorm = normalisiereFuerVergleich(p.bezeichnung);
    const pTokens = pNorm.split(' ').filter((t) => t.length >= 3);
    const überlappung = suchTokens.filter((t) => pTokens.includes(t)).length;
    if (überlappung > besteÜberlappung) {
      besteÜberlappung = überlappung;
      bester = p;
    }
  }
  return bester;
}

// Lädt die aktuellen Positionen einmalig (intern gecached für eine Operation).
async function ladeAlle(pfad) {
  return await libExcel.lesePositionen(pfad);
}

async function speichereAlle(pfad, positionen) {
  await libExcel.schreibePositionen(pfad, positionen);
  // Ansicht nach jeder Speicherung neu aufbauen
  await libExcel.baueAnsicht(pfad);
}

// addierePositionen: Wareneingang / Rückgabe. Zustand 'neu'/'gebraucht'/'verschmutzt'.
//   - Existiert die Position: Menge in der entsprechenden Zustandsspalte erhöhen.
//   - Neue Position: als neue Zeile ans Ende der Tabelle.
//   - Kategorie wird gesetzt, falls mitgegeben; sonst "Sonstiges".
// Rückgabe: Liste der tatsächlich durchgeführten Änderungen.
async function addierePositionen(positionen, pfad) {
  const aktuell = await ladeAlle(pfad);
  const resultate = [];

  for (const pos of positionen) {
    if (!pos) continue;
    const bezeichnung = pos.bezeichnung || pos.name;
    if (!bezeichnung) continue;
    const menge = sichereZahl(pos.menge);
    if (menge <= 0) continue;
    const spalte = spalteFuerZustand(pos.zustand);
    const bestehend = findePosition(aktuell, bezeichnung);

    if (bestehend) {
      const vorher = sichereZahl(bestehend[spalte]);
      bestehend[spalte] = vorher + menge;
      if (pos.kategorie && !bestehend.kategorie) bestehend.kategorie = pos.kategorie;
      resultate.push({
        bezeichnung: bestehend.bezeichnung,
        kategorie: bestehend.kategorie,
        zustand: pos.zustand || 'neu',
        menge,
        vorher,
        aenderung: '+' + menge,
        nachher: bestehend[spalte],
        einheit: bestehend.einheit,
        neu: false
      });
    } else {
      const neu = {
        kategorie: pos.kategorie || 'Sonstiges',
        bezeichnung: pos.bezeichnung,
        mengeNeu: 0, mengeGebraucht: 0, mengeVerschmutzt: 0,
        einheit: pos.einheit || 'Stk.'
      };
      neu[spalte] = menge;
      aktuell.push(neu);
      resultate.push({
        bezeichnung: bezeichnung,
        kategorie: neu.kategorie,
        zustand: pos.zustand || 'neu',
        menge,
        vorher: 0,
        aenderung: 'neu (+' + menge + ')',
        nachher: menge,
        einheit: neu.einheit,
        neu: true
      });
    }
  }

  if (resultate.length > 0) {
    await speichereAlle(pfad, aktuell);
  }
  return resultate;
}

// entnehmePositionen: tatsächlicher Verbrauch.
//   - Reduziert die Menge in der angegebenen Zustandsspalte (oder verteilt).
//   - Bestandsschutz: Bestand kann nicht negativ werden (deckelt bei 0).
//   - Fehlende Bestände werden zurückgemeldet.
async function entnehmePositionen(positionen, pfad) {
  const aktuell = await ladeAlle(pfad);
  const resultate = [];

  for (const pos of positionen) {
    if (!pos) continue;
    const bezeichnung = pos.bezeichnung || pos.name;
    if (!bezeichnung) continue;
    const menge = sichereZahl(pos.menge);
    if (menge <= 0) continue;
    const spalte = spalteFuerZustand(pos.zustand);
    const bestehend = findePosition(aktuell, bezeichnung);

    if (!bestehend) {
      resultate.push({
        bezeichnung: pos.bezeichnung,
        unbekannt: true,
        mengeAngefragt: menge,
        nachricht: 'Position war nicht im Lager.'
      });
      continue;
    }

    const vorher = sichereZahl(bestehend[spalte]);
    const entnommen = Math.min(menge, vorher);
    bestehend[spalte] = vorher - entnommen;
    const fehlend = menge - entnommen;
    resultate.push({
      bezeichnung: bestehend.bezeichnung,
      kategorie: bestehend.kategorie,
      zustand: pos.zustand || 'neu',
      menge,
      vorher,
      entnommen,
      fehlend,
      nachher: bestehend[spalte],
      einheit: bestehend.einheit,
      unbekannt: false
    });
  }

  if (resultate.length > 0) {
    await speichereAlle(pfad, aktuell);
  }
  return resultate;
}

// suchePositionen: Fuzzy-Suche.
// Gibt alle Positionen zurück, deren Bezeichnung (oder Kategorie) auf
// den Suchbegriff passt. Optional mit Mindest-Score.
function suchePositionen(suchbegriff, positionen) {
  if (!suchbegriff) return [];
  const norm = normalisiereFuerVergleich(suchbegriff);
  if (!norm) return [];
  const treffer = [];
  for (const p of positionen) {
    const pName = normalisiereFuerVergleich(p.bezeichnung);
    const pKat = normalisiereFuerVergleich(p.kategorie);
    if (pName.includes(norm) || pKat.includes(norm)) {
      treffer.push(p);
      continue;
    }
    // Token-Überschneidung
    const suchTokens = norm.split(' ').filter((t) => t.length >= 3);
    const pTokens = (pName + ' ' + pKat).split(' ').filter((t) => t.length >= 3);
    const überlappung = suchTokens.filter((t) => pTokens.includes(t)).length;
    if (überlappung > 0 && überlappung >= Math.ceil(suchTokens.length / 2)) {
      treffer.push(p);
    }
  }
  return treffer;
}

// pruefeBedarf: reine Lese-Operation, summiert den Bestand passender Positionen.
function pruefeBedarf(anfragen, positionen) {
  const ergebnisse = [];
  for (const a of anfragen) {
    if (!a || !a.bezeichnung) continue;
    const treffer = suchePositionen(a.bezeichnung, positionen);
    const gesamt = treffer.reduce((s, t) => {
      return s + sichereZahl(t.mengeNeu) + sichereZahl(t.mengeGebraucht) + sichereZahl(t.mengeVerschmutzt);
    }, 0);
    ergebnisse.push({
      bezeichnung: a.bezeichnung,
      angefragt: sichereZahl(a.menge),
      verfuegbar: gesamt,
      einheit: treffer[0] ? treffer[0].einheit : (a.einheit || 'Stk.'),
      treffer: treffer.length
    });
  }
  return ergebnisse;
}

// ganzeListe: alle Positionen, gruppiert nach Kategorie.
function ganzeListe(positionen) {
  const gruppen = {};
  for (const p of positionen) {
    const k = p.kategorie || 'Sonstiges';
    (gruppen[k] = gruppen[k] || []).push(p);
  }
  // Bekannte Kategorien zuerst (in fester Reihenfolge), dann unbekannte alphabetisch
  const { KATEGORIEN } = require('./kategorien');
  const result = {};
  for (const k of KATEGORIEN) {
    if (gruppen[k] && gruppen[k].length > 0) result[k] = gruppen[k];
  }
  const unbekannte = Object.keys(gruppen).filter((k) => !KATEGORIEN.includes(k)).sort();
  for (const k of unbekannte) {
    result[k] = gruppen[k];
  }
  return result;
}

// Bestandssumme einer einzelnen Position (über alle drei Zustandsspalten)
function gesamtbestand(p) {
  return sichereZahl(p.mengeNeu) + sichereZahl(p.mengeGebraucht) + sichereZahl(p.mengeVerschmutzt);
}

module.exports = {
  MATERIAL_PFAD: libExcel.MATERIAL_PFAD,
  addierePositionen,
  entnehmePositionen,
  suchePositionen,
  pruefeBedarf,
  ganzeListe,
  leseAlle: ladeAlle,
  normalisiereFuerVergleich,
  gesamtbestand
};
