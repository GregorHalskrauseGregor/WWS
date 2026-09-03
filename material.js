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

// "DN 20" = "DN20" = "DN-20", "22 mm" = "22mm"; alles klein, Trennzeichen weg.
function normalisiereFuerVergleich(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[\s\-_]+/g, ' ')
    .replace(/dn\s*(\d+)/g, 'dn$1')
    .replace(/(\d)\s*(mm|cm|zoll|"|″)/g, '$1$2')  // 22 mm -> 22mm
    .replace(/\s+/g, ' ')
    .trim();
}

// Alle Tokens mit einer Ziffer — also Dimensionen, Größen, Typnummern.
// Genau daran unterscheiden sich zwei Artikel, die sonst gleich heißen:
// "Winkel DN25" und "Winkel DN40" teilen sich das Wort, nicht die Kennzahl.
function kennzahlen(norm) {
  return norm.split(' ').filter((t) => /\d/.test(t)).sort().join(' ');
}

// Die Woerter ohne Ziffern, als Menge — damit ist die Reihenfolge egal,
// ein zusaetzliches Wort aber nicht.
function wortmenge(norm) {
  return [...new Set(norm.split(' ').filter((t) => t && !/\d/.test(t)))].sort().join(' ');
}

// Dreistufig: exakt -> enthält -> Token-Überschneidung.
// Findet die EINE Zeile, auf die gebucht werden soll.
//
// Bewusst streng: ein Fehlgriff bucht Material auf den falschen Artikel, und das
// faellt erst auf, wenn jemand vor dem Regal steht. Frueher genuegte EIN
// gemeinsames Wort — damit landete "Winkel DN40" auf der Zeile "Winkel DN25".
// Jetzt muessen die Kennzahlen (Dimensionen, Groessen) uebereinstimmen.
// Fuer die reine Suche gibt es suchePositionen(), das darf unscharf sein.
function findePosition(alle, suchbegriff) {
  const norm = normalisiereFuerVergleich(suchbegriff);
  if (!norm) return null;

  // Zusammengefuehrte Altzeilen bleiben in der Liste, treten aber nicht mehr
  // als Treffer auf — sonst bucht man auf die tote Zeile.
  const positionen = alle.filter((p) => !String(p.bezeichnung || '').endsWith(' [zusammengeführt]'));
  const suchKennzahlen = kennzahlen(norm);

  // 1) exakt
  for (const p of positionen) {
    if (normalisiereFuerVergleich(p.bezeichnung) === norm) return p;
  }
  // 2) gleiche Wortmenge UND gleiche Kennzahlen — deckt andere Wortstellung ab,
  //    ohne verschiedene Artikel zu verschmelzen.
  //
  // BEWUSST STRENG: "Stahlbogen DN50 verzinkt" ist nicht dasselbe wie
  // "Stahlbogen DN50". Ob zwei Varianten zusammengehoeren, ist eine fachliche
  // Frage (Zulassung, Presssystem, Marke) und keine, die eine Textaehnlichkeit
  // beantworten kann. Lieber eine Zeile zu viel als still zusammengebuchtes
  // Material — die fachliche Zusammenfassung kommt ueber die Wissensbasis.
  const suchWorte = wortmenge(norm);
  for (const p of positionen) {
    const pNorm = normalisiereFuerVergleich(p.bezeichnung);
    if (kennzahlen(pNorm) === suchKennzahlen && wortmenge(pNorm) === suchWorte) return p;
  }
  return null;
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

// ──────────────────────────────────────────────────── Korrektur & Stammdaten
//
// Alles hier ändert bestehende Zeilen statt zu addieren. Auch hier gilt: es
// wird nie eine Zeile entfernt. Eine zusammengeführte Zeile bleibt mit Bestand 0
// stehen und wird nur so umbenannt, dass sie bei der Suche nicht mehr mit der
// aktiven Zeile konkurriert — der Verlauf bleibt damit nachvollziehbar.

const ZUSAMMENGEFUEHRT = ' [zusammengeführt]';

function findeOderMelde(bestand, bezeichnung, ergebnisse) {
  const p = findePosition(bestand, bezeichnung);
  if (!p) {
    ergebnisse.push({ bezeichnung, unbekannt: true, meldung: 'Position nicht gefunden.' });
    return null;
  }
  return p;
}

// Inventur: setzt den Bestand auf einen ABSOLUTEN Wert, statt zu verrechnen.
async function setzeBestand(korrekturen, pfad = libExcel.MATERIAL_PFAD) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];
  let geaendert = false;

  for (const k of korrekturen || []) {
    const bezeichnung = k && (k.position || k.bezeichnung);
    if (!bezeichnung) continue;
    const p = findeOderMelde(bestand, bezeichnung, ergebnisse);
    if (!p) continue;

    const neu = sichereZahl(k.wert !== undefined ? k.wert : k.menge);
    if (neu < 0) {
      ergebnisse.push({ bezeichnung: p.bezeichnung, abgelehnt: true,
        meldung: 'Ein Bestand kann nicht negativ sein.' });
      continue;
    }
    const spalte = spalteFuerZustand(k.zustand);
    const vorherSpalte = sichereZahl(p[spalte]);
    const vorherGesamt = gesamtbestand(p);
    p[spalte] = neu;
    geaendert = true;

    // Nach unten korrigieren kann Vormerkungen ungültig machen — das muss auffallen.
    const jetzt = gesamtbestand(p);
    const vorgemerkt = reserviertGesamt(p);
    ergebnisse.push({
      bezeichnung: p.bezeichnung, einheit: p.einheit,
      zustand: k.zustand || 'neu',
      vorherSpalte, nachherSpalte: neu,
      vorherGesamt, nachherGesamt: jetzt,
      andereZustaende: jetzt - neu,
      reservierungUeberschritten: vorgemerkt > jetzt ? vorgemerkt - jetzt : 0,
      unbekannt: false
    });
  }

  if (geaendert) await speichereAlle(pfad, bestand);
  return ergebnisse;
}

// Gemeinsamer Rahmen für die Stammdaten-Änderungen (Name, Kategorie, Einheit).
async function aendereStammdaten(korrekturen, pfad, feld, pruefe) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];
  let geaendert = false;

  for (const k of korrekturen || []) {
    const bezeichnung = k && (k.position || k.bezeichnung);
    const wert = String(k && k.wert !== undefined ? k.wert : '').trim();
    if (!bezeichnung || !wert) continue;
    const p = findeOderMelde(bestand, bezeichnung, ergebnisse);
    if (!p) continue;

    const fehler = pruefe ? pruefe(wert, bestand, p) : null;
    if (fehler) {
      ergebnisse.push({ bezeichnung: p.bezeichnung, abgelehnt: true, meldung: fehler });
      continue;
    }
    const vorher = p[feld];
    if (vorher === wert) {
      ergebnisse.push({ bezeichnung: p.bezeichnung, unveraendert: true, wert });
      continue;
    }
    p[feld] = wert;
    geaendert = true;
    ergebnisse.push({ bezeichnung: p.bezeichnung, feld, vorher, nachher: wert, unbekannt: false });
  }

  if (geaendert) await speichereAlle(pfad, bestand);
  return ergebnisse;
}

async function benenneUm(korrekturen, pfad = libExcel.MATERIAL_PFAD) {
  return aendereStammdaten(korrekturen, pfad, 'bezeichnung', (wert, bestand, p) => {
    const konflikt = bestand.find((x) => x !== p &&
      normalisiereFuerVergleich(x.bezeichnung) === normalisiereFuerVergleich(wert));
    return konflikt
      ? `Es gibt bereits eine Position "${konflikt.bezeichnung}". Führ die beiden lieber zusammen.`
      : null;
  });
}

async function setzeKategorie(korrekturen, pfad = libExcel.MATERIAL_PFAD) {
  return aendereStammdaten(korrekturen, pfad, 'kategorie', (wert) =>
    KATEGORIEN.includes(wert) ? null
      : `"${wert}" ist keine der festen Kategorien. Möglich: ${KATEGORIEN.join(', ')}`);
}

async function setzeEinheit(korrekturen, pfad = libExcel.MATERIAL_PFAD) {
  return aendereStammdaten(korrekturen, pfad, 'einheit', null);
}

// Zwei versehentlich doppelt angelegte Zeilen zu einer machen.
async function fuehreZusammen(korrekturen, pfad = libExcel.MATERIAL_PFAD) {
  const bestand = await ladeAlle(pfad);
  const ergebnisse = [];
  let geaendert = false;

  for (const k of korrekturen || []) {
    const quelleName = k && (k.position || k.bezeichnung);
    const zielName = String(k && k.wert !== undefined ? k.wert : '').trim();
    if (!quelleName || !zielName) continue;

    const quelle = findeOderMelde(bestand, quelleName, ergebnisse);
    if (!quelle) continue;
    const ziel = findePosition(bestand, zielName);
    if (!ziel) {
      ergebnisse.push({ bezeichnung: zielName, unbekannt: true,
        meldung: 'Zielposition nicht gefunden.' });
      continue;
    }
    if (ziel === quelle) {
      ergebnisse.push({ bezeichnung: quelle.bezeichnung, abgelehnt: true,
        meldung: 'Quelle und Ziel sind dieselbe Position.' });
      continue;
    }

    const uebernommen = gesamtbestand(quelle);
    for (const z of ZUSTAENDE) {
      ziel[z] = sichereZahl(ziel[z]) + sichereZahl(quelle[z]);
      quelle[z] = 0;
    }
    // Vormerkungen wandern mit, je Person zusammengezählt.
    for (const r of quelle.reservierungen || []) {
      setzeReservierung(ziel, r.chatId, reserviertVon(ziel, r.chatId) + sichereZahl(r.menge));
    }
    quelle.reservierungen = [];
    // Zeile bleibt stehen, tritt aber nicht mehr als Treffer auf.
    if (!quelle.bezeichnung.endsWith(ZUSAMMENGEFUEHRT)) {
      quelle.bezeichnung = quelle.bezeichnung + ZUSAMMENGEFUEHRT;
    }
    geaendert = true;

    ergebnisse.push({
      bezeichnung: quelle.bezeichnung, ziel: ziel.bezeichnung, einheit: ziel.einheit,
      uebernommen, zielBestand: gesamtbestand(ziel), unbekannt: false
    });
  }

  if (geaendert) await speichereAlle(pfad, bestand);
  return ergebnisse;
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
  setzeBestand,
  benenneUm,
  setzeKategorie,
  setzeEinheit,
  fuehreZusammen,
  reservierungenVon,
  suchePositionen,
  pruefeBedarf,
  ganzeListe,
  leseAlle: ladeAlle,
  speichereAlle,
  normalisiereFuerVergleich,
  kennzahlen,
  wortmenge,
  findePosition,
  gesamtbestand,
  reserviertGesamt,
  reserviertVon,
  reserviertFremd,
  verfuegbarFuer,
  freiZumReservieren,
  sichereZahl
};
