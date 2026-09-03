// Kernlogik der Lagerverwaltung. Liest und schreibt die Arbeitsdatei über
// lib/excel.js. Hier gibt es keine KI — Bestände müssen reproduzierbar stimmen.
//
// Feste Regeln:
//   - Bestände fallen NIE unter null. Was fehlt, wird gemeldet, nicht gebucht.
//   - Zeilen werden NIE gelöscht. Eine Position mit Bestand 0 bleibt stehen,
//     damit auf Nachfrage gesagt werden kann: "davon haben wir gerade keins".
//   - Eine Zeile je Artikel; die drei Zustandsspalten summieren sich zum Bestand.
//   - Reservierungen sind verbindlich: fremd reserviertes Material ist für
//     andere gesperrt. Die eigene Reservierung wird bei Entnahme aufgezehrt.
//   - Kein Self-Healing bei fehlender Datei (siehe lib/excel.js).

const libExcel = require('./lib/excel');
const { KATEGORIEN } = require('./kategorien');

const ZUSTAENDE = ['mengeNeu', 'mengeGebraucht', 'mengeVerschmutzt'];

function sichereZahl(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const n = parseFloat(String(v).replace(',', '.').trim());
  return Number.isFinite(n) ? n : 0;
}

function spalteFuerZustand(zustand) {
  const z = String(zustand || 'neu').toLowerCase();
  if (z.startsWith('gebraucht')) return 'mengeGebraucht';
  if (z.startsWith('verschmutz')) return 'mengeVerschmutzt';
  return 'mengeNeu';
}

// "DN 20" = "DN20" = "DN-20"; Mehrfach-Leerzeichen weg, alles klein.
function normalisiereFuerVergleich(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[\s\-_]+/g, ' ')
    .replace(/dn\s*(\d+)/g, 'dn$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Dreistufig: exakt -> enthält -> Token-Überschneidung.
function findePosition(positionen, suchbegriff) {
  const norm = normalisiereFuerVergleich(suchbegriff);
  if (!norm) return null;
  for (const p of positionen) {
    if (normalisiereFuerVergleich(p.bezeichnung) === norm) return p;
  }
  for (const p of positionen) {
    if (normalisiereFuerVergleich(p.bezeichnung).includes(norm)) return p;
  }
  const suchTokens = norm.split(' ').filter((t) => t.length >= 3);
  let bester = null;
  let beste = 0;
  for (const p of positionen) {
    const pTokens = normalisiereFuerVergleich(p.bezeichnung).split(' ').filter((t) => t.length >= 3);
    const treffer = suchTokens.filter((t) => pTokens.includes(t)).length;
    if (treffer > beste) { beste = treffer; bester = p; }
  }
  return beste > 0 ? bester : null;
}

// ────────────────────────────────────────────────────────── Bestand & Reservierung

function gesamtbestand(p) {
  return ZUSTAENDE.reduce((s, z) => s + sichereZahl(p[z]), 0);
}

function reserviertGesamt(p) {
  return (p.reservierungen || []).reduce((s, r) => s + sichereZahl(r.menge), 0);
}

function reserviertVon(p, chatId) {
  const eintrag = (p.reservierungen || []).find((r) => String(r.chatId) === String(chatId));
  return eintrag ? sichereZahl(eintrag.menge) : 0;
}

function reserviertFremd(p, chatId) {
  return reserviertGesamt(p) - reserviertVon(p, chatId);
}

// Was diese Person tatsächlich entnehmen darf: alles außer fremden Reservierungen.
function verfuegbarFuer(p, chatId) {
  return Math.max(0, gesamtbestand(p) - reserviertFremd(p, chatId));
}

// Was noch NEU reserviert werden kann: alles, was niemand vorgemerkt hat.
function freiZumReservieren(p) {
  return Math.max(0, gesamtbestand(p) - reserviertGesamt(p));
}

function setzeReservierung(p, chatId, menge) {
  const id = String(chatId);
  const liste = (p.reservierungen || []).filter((r) => String(r.chatId) !== id);
  if (menge > 0) liste.push({ chatId: id, menge });
  p.reservierungen = liste;
}

// ──────────────────────────────────────────────────────────────── Datei-Zugriff

async function ladeAlle(pfad = libExcel.MATERIAL_PFAD) {
  return libExcel.lesePositionen(pfad);
}

async function speichereAlle(pfad, positionen) {
  await libExcel.schreibePositionen(pfad, positionen);
}

// ──────────────────────────────────────────────────────────────── Einlagern

async function addierePositionen(positionen, pfad = libExcel.MATERIAL_PFAD) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];

  for (const pos of positionen || []) {
    const bezeichnung = pos && (pos.bezeichnung || pos.name);
    const menge = sichereZahl(pos && pos.menge);
    if (!bezeichnung || menge <= 0) continue;

    const spalte = spalteFuerZustand(pos.zustand);
    const vorhanden = findePosition(bestand, bezeichnung);

    if (vorhanden) {
      const vorher = sichereZahl(vorhanden[spalte]);
      vorhanden[spalte] = vorher + menge;
      if (pos.kategorie && !KATEGORIEN.includes(vorhanden.kategorie)) {
        vorhanden.kategorie = pos.kategorie;
      }
      ergebnisse.push({
        bezeichnung: vorhanden.bezeichnung, kategorie: vorhanden.kategorie,
        zustand: pos.zustand || 'neu', menge, vorher, nachher: vorhanden[spalte],
        gesamt: gesamtbestand(vorhanden), einheit: vorhanden.einheit, neu: false
      });
    } else {
      const neu = {
        kategorie: pos.kategorie || 'Sonstiges',
        bezeichnung,
        mengeNeu: 0, mengeGebraucht: 0, mengeVerschmutzt: 0,
        einheit: pos.einheit || 'Stk.',
        reservierungen: []
      };
      neu[spalte] = menge;
      bestand.push(neu);
      ergebnisse.push({
        bezeichnung, kategorie: neu.kategorie, zustand: pos.zustand || 'neu',
        menge, vorher: 0, nachher: menge, gesamt: menge,
        einheit: neu.einheit, neu: true
      });
    }
  }

  if (ergebnisse.length > 0) await speichereAlle(pfad, bestand);
  return ergebnisse;
}

// ──────────────────────────────────────────────────────────────── Entnehmen

// Zieht der Reihe nach ab: erst der gewünschte Zustand, dann die übrigen.
// So wird nichts als "fehlt" gemeldet, was nur in einer anderen Spalte liegt.
function ziehAb(position, menge, wunschSpalte) {
  const reihenfolge = [wunschSpalte, ...ZUSTAENDE.filter((z) => z !== wunschSpalte)];
  let offen = menge;
  const ausSpalten = {};
  for (const spalte of reihenfolge) {
    if (offen <= 0) break;
    const da = sichereZahl(position[spalte]);
    const nimm = Math.min(da, offen);
    if (nimm > 0) {
      position[spalte] = da - nimm;
      ausSpalten[spalte] = nimm;
      offen -= nimm;
    }
  }
  return { entnommen: menge - offen, ausSpalten };
}

async function entnehmePositionen(positionen, pfad = libExcel.MATERIAL_PFAD, chatId = null) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];
  let geaendert = false;

  for (const pos of positionen || []) {
    const bezeichnung = pos && (pos.bezeichnung || pos.name);
    const wunsch = sichereZahl(pos && pos.menge);
    if (!bezeichnung || wunsch <= 0) continue;

    const vorhanden = findePosition(bestand, bezeichnung);
    if (!vorhanden) {
      ergebnisse.push({ bezeichnung, unbekannt: true, angefragt: wunsch,
        meldung: 'Diese Position gibt es im Lager nicht.' });
      continue;
    }

    const gesamtVorher = gesamtbestand(vorhanden);
    const fremd = reserviertFremd(vorhanden, chatId);
    const erlaubt = verfuegbarFuer(vorhanden, chatId);
    const nehmen = Math.min(wunsch, erlaubt);

    const { entnommen } = nehmen > 0
      ? ziehAb(vorhanden, nehmen, spalteFuerZustand(pos.zustand))
      : { entnommen: 0 };

    // Eigene Vormerkung wird durch die Entnahme aufgezehrt.
    const eigene = reserviertVon(vorhanden, chatId);
    if (entnommen > 0 && eigene > 0) {
      setzeReservierung(vorhanden, chatId, Math.max(0, eigene - entnommen));
    }
    if (entnommen > 0) geaendert = true;

    ergebnisse.push({
      bezeichnung: vorhanden.bezeichnung,
      kategorie: vorhanden.kategorie,
      einheit: vorhanden.einheit,
      angefragt: wunsch,
      entnommen,
      fehlend: wunsch - entnommen,
      gesperrtDurchReservierung: Math.max(0, Math.min(wunsch - entnommen, fremd)),
      vorher: gesamtVorher,
      nachher: gesamtbestand(vorhanden),
      unbekannt: false
    });
  }

  if (geaendert) await speichereAlle(pfad, bestand);
  return ergebnisse;
}

// ───────────────────────────────────────────────────────────── Reservieren

async function reservierePositionen(positionen, pfad, chatId) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];
  let geaendert = false;

  for (const pos of positionen || []) {
    const bezeichnung = pos && (pos.bezeichnung || pos.name);
    const wunsch = sichereZahl(pos && pos.menge);
    if (!bezeichnung || wunsch <= 0) continue;

    const vorhanden = findePosition(bestand, bezeichnung);
    if (!vorhanden) {
      ergebnisse.push({ bezeichnung, unbekannt: true, angefragt: wunsch,
        meldung: 'Diese Position gibt es im Lager nicht.' });
      continue;
    }
    const frei = freiZumReservieren(vorhanden);
    const neu = Math.min(wunsch, frei);
    if (neu > 0) {
      setzeReservierung(vorhanden, chatId, reserviertVon(vorhanden, chatId) + neu);
      geaendert = true;
    }
    ergebnisse.push({
      bezeichnung: vorhanden.bezeichnung, einheit: vorhanden.einheit,
      angefragt: wunsch, reserviert: neu, nichtMoeglich: wunsch - neu,
      bestand: gesamtbestand(vorhanden),
      reserviertGesamt: reserviertGesamt(vorhanden),
      eigeneReservierung: reserviertVon(vorhanden, chatId),
      unbekannt: false
    });
  }

  if (geaendert) await speichereAlle(pfad, bestand);
  return ergebnisse;
}

async function gibReservierungFrei(positionen, pfad, chatId) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];
  let geaendert = false;

  for (const pos of positionen || []) {
    const bezeichnung = pos && (pos.bezeichnung || pos.name);
    if (!bezeichnung) continue;
    const vorhanden = findePosition(bestand, bezeichnung);
    if (!vorhanden) {
      ergebnisse.push({ bezeichnung, unbekannt: true });
      continue;
    }
    const eigene = reserviertVon(vorhanden, chatId);
    const wunsch = sichereZahl(pos.menge) || eigene; // ohne Menge: alles freigeben
    const frei = Math.min(wunsch, eigene);
    if (frei > 0) {
      setzeReservierung(vorhanden, chatId, eigene - frei);
      geaendert = true;
    }
    ergebnisse.push({
      bezeichnung: vorhanden.bezeichnung, einheit: vorhanden.einheit,
      freigegeben: frei, verbleibendeReservierung: reserviertVon(vorhanden, chatId),
      unbekannt: false
    });
  }

  if (geaendert) await speichereAlle(pfad, bestand);
  return ergebnisse;
}

// Alle Vormerkungen einer Person, über alle Positionen.
function reservierungenVon(positionen, chatId) {
  return positionen
    .map((p) => ({ bezeichnung: p.bezeichnung, einheit: p.einheit, menge: reserviertVon(p, chatId) }))
    .filter((r) => r.menge > 0);
}

// ────────────────────────────────────────────────────────────── Lesen & Suchen

function suchePositionen(suchbegriff, positionen) {
  if (!suchbegriff) return [];
  const norm = normalisiereFuerVergleich(suchbegriff);
  if (!norm) return [];
  const suchTokens = norm.split(' ').filter((t) => t.length >= 3);
  const treffer = [];
  for (const p of positionen) {
    const name = normalisiereFuerVergleich(p.bezeichnung);
    const kat = normalisiereFuerVergleich(p.kategorie);
    if (name.includes(norm) || kat.includes(norm)) { treffer.push(p); continue; }
    const pTokens = (name + ' ' + kat).split(' ').filter((t) => t.length >= 3);
    const ueberlappung = suchTokens.filter((t) => pTokens.includes(t)).length;
    if (ueberlappung > 0 && ueberlappung >= Math.ceil(suchTokens.length / 2)) treffer.push(p);
  }
  return treffer;
}

// Reine Leseoperation: reicht der Bestand für den Bedarf? Bucht nichts.
function pruefeBedarf(anfragen, positionen, chatId = null) {
  return (anfragen || []).filter((a) => a && a.bezeichnung).map((a) => {
    const treffer = suchePositionen(a.bezeichnung, positionen);
    const bestand = treffer.reduce((s, t) => s + gesamtbestand(t), 0);
    const nutzbar = treffer.reduce((s, t) => s + verfuegbarFuer(t, chatId), 0);
    const angefragt = sichereZahl(a.menge);
    return {
      bezeichnung: a.bezeichnung, angefragt,
      bestand, verfuegbar: nutzbar,
      reserviert: bestand - nutzbar,
      reicht: nutzbar >= angefragt,
      einheit: treffer[0] ? treffer[0].einheit : (a.einheit || 'Stk.'),
      treffer: treffer.length
    };
  });
}

function ganzeListe(positionen) {
  const gruppen = {};
  for (const p of positionen) {
    const k = p.kategorie || 'Sonstiges';
    (gruppen[k] = gruppen[k] || []).push(p);
  }
  const raus = {};
  for (const k of KATEGORIEN) if (gruppen[k] && gruppen[k].length) raus[k] = gruppen[k];
  for (const k of Object.keys(gruppen).filter((x) => !KATEGORIEN.includes(x)).sort()) {
    raus[k] = gruppen[k];
  }
  return raus;
}

module.exports = {
  MATERIAL_PFAD: libExcel.MATERIAL_PFAD,
  ZUSTAENDE,
  addierePositionen,
  entnehmePositionen,
  reservierePositionen,
  gibReservierungFrei,
  reservierungenVon,
  suchePositionen,
  pruefeBedarf,
  ganzeListe,
  leseAlle: ladeAlle,
  speichereAlle,
  normalisiereFuerVergleich,
  findePosition,
  gesamtbestand,
  reserviertGesamt,
  reserviertVon,
  reserviertFremd,
  verfuegbarFuer,
  freiZumReservieren,
  sichereZahl
};
