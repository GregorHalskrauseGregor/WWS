// Wissensbasis — das Fachwissen über SHK-Material, als Nachschlagewerk.
//
// Die Dateien liegen unter wissen/ und sind von Hand pflegbar (YAML, mit
// Kommentaren, versioniert). Dieses Modul lädt sie und beantwortet damit
// Fragen, die eine RICHTIGE Antwort haben:
//
//   "eine Stange Schwarzrohr"  -> 6 m, Material Stahl
//   "halb Zoll"                -> DN15
//   "Messing-Fitting"          -> Rotguss
//   "T-Stück DN20"             -> dn1=20, dn2=20, dn3=20
//   "Bogen gepresst"           -> Kontur fehlt, danach fragen
//
// Deutung bleibt bei der KI, Übersetzung und Regelanwendung hier.
//
// REGELSPRACHE in artikelklassen.yaml (bewusst winzig gehalten):
//   Bedingung:  "<feld> fehlt"  |  "<feld> = <wert>"   verknüpft mit " und "
//   Folge:      "<feld> = <feld-oder-wert>"            mehrere mit ", "
//               "nachfragen <feld>"

const fs = require('fs');
const path = require('path');

const ORDNER = path.join(__dirname, '..', 'wissen');
const DATEIEN = ['artikelklassen', 'warengruppen', 'merkmale', 'synonyme',
  'dimensionen', 'einheiten', 'zulassungen', 'gelernt'];

let _cache = null;

function ladeDatei(name) {
  const p = path.join(ORDNER, name + '.yaml');
  if (!fs.existsSync(p)) return {};
  try {
    return require('js-yaml').load(fs.readFileSync(p, 'utf-8')) || {};
  } catch (err) {
    console.warn(`Wissensbasis: ${name}.yaml ist fehlerhaft und wird übersprungen — ${err.message}`);
    return {};
  }
}

function lade() {
  if (_cache) return _cache;
  _cache = {};
  for (const name of DATEIEN) _cache[name] = ladeDatei(name);
  return _cache;
}

function neuLaden() { _cache = null; return lade(); }

// ────────────────────────────────────────────────────────────────── Helfer

function klein(s) {
  return String(s == null ? '' : s).toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[\s\-_]+/g, ' ').trim();
}

function zahl(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────────────────────────────────────── Artikelklassen

function klasse(name) {
  return lade().artikelklassen[name] || null;
}

function alleKlassen() {
  return Object.keys(lade().artikelklassen);
}

// Welche Artikelart ist gemeint? Längster Treffer gewinnt, damit "t-stueck"
// nicht von "stueck" geschlagen wird.
function klasseFuer(text) {
  const t = klein(text);
  if (!t) return 'sonstiges';
  let treffer = null;
  let laenge = 0;
  for (const [name, def] of Object.entries(lade().artikelklassen)) {
    for (const wort of def.erkennen_an || []) {
      const w = klein(wort);
      if (w && t.includes(w) && w.length > laenge) { laenge = w.length; treffer = name; }
    }
  }
  return treffer || 'sonstiges';
}

// ──────────────────────────────────────────────────────────── Warengruppen

// Alle Knoten des Baums als flache Liste: { pfad, schluessel, name, klassen, ebene }
function warengruppenListe() {
  const raus = [];
  const gehe = (knoten, pfad, ebene) => {
    for (const [schluessel, def] of Object.entries(knoten || {})) {
      const p = pfad ? `${pfad}.${schluessel}` : schluessel;
      raus.push({
        pfad: p, schluessel, ebene,
        name: (def && def.name) || schluessel,
        klassen: (def && def.klassen) || []
      });
      if (def && def.kinder) gehe(def.kinder, p, ebene + 1);
    }
  };
  gehe(lade().warengruppen, '', 0);
  return raus;
}

// Die oberste Ebene — sie ist zugleich die Kategorie in der Lagerdatei.
function oberkategorien() {
  return warengruppenListe().filter((k) => k.ebene === 0).map((k) => k.name);
}

// Findet einen Knoten über Pfad, Schlüssel oder Anzeigenamen.
function warengruppe(bezeichner) {
  const b = klein(bezeichner);
  const liste = warengruppenListe();
  return liste.find((k) => klein(k.pfad) === b)
    || liste.find((k) => klein(k.schluessel) === b)
    || liste.find((k) => klein(k.name) === b)
    || null;
}

// Alle Artikelarten unterhalb eines Knotens — die Antwort auf
// "nenne mir alle Absperrarmaturen" oder "alle Fittinge".
function klassenUnter(bezeichner) {
  const knoten = warengruppe(bezeichner);
  if (!knoten) return [];
  const raus = new Set(knoten.klassen);
  for (const k of warengruppenListe()) {
    if (k.pfad === knoten.pfad || k.pfad.startsWith(knoten.pfad + '.')) {
      for (const kl of k.klassen) raus.add(kl);
    }
  }
  // Auch Klassen, die den Knoten direkt als warengruppe nennen.
  for (const [name, def] of Object.entries(lade().artikelklassen)) {
    const p = String(def.warengruppe || '');
    if (p === knoten.pfad || p.startsWith(knoten.pfad + '.')) raus.add(name);
  }
  return [...raus];
}

// Der Pfad einer Artikelart, von oben nach unten — für Anzeige und Gruppierung.
function pfadVon(klassenName) {
  const def = klasse(klassenName);
  if (!def || !def.warengruppe) return [];
  const teile = String(def.warengruppe).split('.');
  const raus = [];
  for (let i = 0; i < teile.length; i++) {
    const k = warengruppe(teile.slice(0, i + 1).join('.'));
    if (k) raus.push(k.name);
  }
  return raus;
}

// Oberste Kategorie einer Artikelart — das, was in der Lagerdatei steht.
function kategorieVon(klassenName) {
  return pfadVon(klassenName)[0] || 'Sonstiges';
}

// Welche Artikelarten kommen in einem Gewerk vor? Beantwortet
// "alle Artikel für Heizung" — der Baum kann das nicht, weil ein Kugelhahn
// je nach Zulassung in mehreren Gewerken zu Hause ist.
function klassenFuerEinsatzbereich(bereich) {
  const b = klein(bereich);
  return Object.entries(lade().artikelklassen)
    .filter(([, def]) => (def.einsatzbereiche || []).map(klein).includes(b))
    .map(([name]) => name);
}

// ─────────────────────────────────────────────────────── Merkmale und Stufen

// Gilt ein globales Merkmal für diese Artikelart — und wenn ja, wie heißt es dort?
function merkmalAnwendbar(merkmal, klassenName) {
  const g = (lade().merkmale.global || {})[merkmal];
  if (!g) return { anwendbar: true, feld: merkmal, stufe: 'optional' };
  if ((g.gilt_nicht_fuer || []).map(klein).includes(klein(klassenName))) {
    // Vielleicht heißt es hier nur anders (Pumpe: Baulänge statt Dimension).
    const ersatz = g.ersatz && g.ersatz[klassenName];
    if (ersatz) return { anwendbar: true, feld: ersatz, stufe: g.stufe };
    return { anwendbar: false, feld: merkmal, stufe: null };
  }
  const def = klasse(klassenName) || {};
  let stufe = g.stufe;
  if ((g.pflicht_fuer || []).map(klein).includes(klein(klassenName))) stufe = 'pflicht';
  // Klassen dürfen ein globales Pflichtmerkmal herabstufen, wenn es dort
  // wirklich nicht trennt (Kugelhahn: die Zulassung entscheidet, nicht das Material).
  if (def[merkmal + '_optional'] === true) stufe = 'optional';
  const feld = def.dimension_heisst && merkmal === 'dimension' ? def.dimension_heisst : merkmal;
  return { anwendbar: true, feld, stufe };
}

// Merkmale dazugelernt? (art: 'attribut' in gelernt.yaml)
function gelernteMerkmale(klassenName) {
  return (lade().gelernt.eintraege || [])
    .filter((e) => e.art === 'attribut' && klein(e.klasse) === klein(klassenName))
    .map((e) => ({ feld: e.merkmal, stufe: e.stufe || 'erwartet' }));
}

// Die vollständige Merkmalserwartung einer Artikelart: global + klasseneigen
// + dazugelernt, nach Stufen sortiert.
function merkmaleFuer(klassenName) {
  const def = klasse(klassenName) || {};
  const stufen = { pflicht: [], erwartet: [], optional: [] };
  const setze = (feld, stufe) => {
    if (!feld || !stufen[stufe]) return;
    for (const s of Object.keys(stufen)) {
      const i = stufen[s].indexOf(feld);
      if (i >= 0) {
        // Höhere Stufe gewinnt: pflicht schlägt erwartet schlägt optional.
        const rang = { pflicht: 3, erwartet: 2, optional: 1 };
        if (rang[s] >= rang[stufe]) return;
        stufen[s].splice(i, 1);
      }
    }
    stufen[stufe].push(feld);
  };

  for (const merkmal of Object.keys(lade().merkmale.global || {})) {
    const a = merkmalAnwendbar(merkmal, klassenName);
    if (a.anwendbar) setze(a.feld, a.stufe);
  }
  for (const feld of def.pflicht || []) setze(feld, 'pflicht');
  for (const feld of def.erwartet || []) setze(feld, 'erwartet');
  for (const feld of def.optional || []) setze(feld, 'optional');
  for (const g of gelernteMerkmale(klassenName)) setze(g.feld, g.stufe);

  // menge wird von der Position selbst geführt, nicht von den Merkmalen.
  for (const s of Object.keys(stufen)) stufen[s] = stufen[s].filter((f) => f !== 'menge');
  return stufen;
}

// ───────────────────────────────────────────────────── Lernende Erwartung

// Der Nutzer hat diesmal mehr angegeben als bisher üblich. Welche Merkmale
// sind das, und lohnt es, künftig danach zu fragen?
//
// Das ist die Beobachtung — gelernt wird erst nach Bestätigung im Chat.
function pruefeAnhebung(klassenName, merkmale) {
  const bekannt = merkmaleFuer(klassenName);
  const alle = new Set([...bekannt.pflicht, ...bekannt.erwartet, ...bekannt.optional]);
  const neu = [];
  for (const [feld, wert] of Object.entries(merkmale || {})) {
    if (wert === undefined || wert === null || String(wert).trim() === '') continue;
    if (feld.startsWith('_')) continue;
    // Schon als optional bekannt? Dann ist es einen Vorschlag wert, künftig
    // danach zu FRAGEN, statt es nur mitzunehmen.
    if (bekannt.optional.includes(feld)) neu.push({ feld, von: 'optional', nach: 'erwartet' });
    else if (!alle.has(feld)) neu.push({ feld, von: 'unbekannt', nach: 'erwartet' });
  }
  return neu;
}

// ───────────────────────────────────────────────────────────────── Synonyme

// Sucht einen Begriff in allen Synonym-Gruppen. artikelart schränkt ein,
// damit "schwarz" nur beim Rohr zu Stahl wird.
function synonym(begriff, artikelart = null) {
  const b = klein(begriff);
  if (!b) return null;
  for (const [gruppe, eintraege] of Object.entries(lade().synonyme)) {
    for (const [von, def] of Object.entries(eintraege || {})) {
      if (klein(von) !== b) continue;
      const gilt = def.gilt_fuer;
      if (gilt && gilt.length && artikelart && !gilt.map(klein).includes(klein(artikelart))) continue;
      return { gruppe, wert: def.bedeutet, beschreibung: def.beschreibung || null };
    }
  }
  // Auch Gelerntes berücksichtigen.
  for (const e of (lade().gelernt.eintraege || [])) {
    if (e.art === 'synonym' && klein(e.von) === b) {
      return { gruppe: 'gelernt', wert: e.nach, beschreibung: null };
    }
  }
  return null;
}

// Ersetzt bekannte Umgangssprache im Text. Gibt den Text und die Treffer zurück.
function normalisiereText(text, artikelart = null) {
  const worte = String(text || '').split(/(\s+)/);
  const ersetzt = [];
  const raus = worte.map((w) => {
    if (/^\s+$/.test(w) || !w) return w;
    const t = synonym(w.replace(/[.,;:]$/, ''), artikelart);
    if (!t) return w;
    ersetzt.push({ von: w, nach: t.wert, gruppe: t.gruppe });
    return t.wert;
  });
  return { text: raus.join(''), ersetzt };
}

// Material in einem Text finden — auch mitten in einer Zusammensetzung.
//
// Deutsche Komposita sind hier der Normalfall: "Kupferrohr", "Edelstahlbogen",
// "Schwarzrohrstange". Ein Vergleich Wort fuer Wort greift da zu kurz, deshalb
// wird auch als Teilwort gesucht. Der laengste Treffer gewinnt, damit
// "edelstahl" nicht von "stahl" geschlagen wird.
function materialErkennen(text, artikelart = null) {
  const t = klein(text);
  if (!t) return null;

  const kandidaten = [];
  // 1) Synonyme der Gruppe "material"
  for (const [von, def] of Object.entries(lade().synonyme.material || {})) {
    const gilt = def.gilt_fuer;
    if (gilt && gilt.length && artikelart && !gilt.map(klein).includes(klein(artikelart))) continue;
    kandidaten.push({ suche: klein(von), wert: def.bedeutet });
  }
  // 2) die Zielwerte selbst ("kupfer" steht in keiner Synonymliste links)
  for (const def of Object.values(lade().synonyme.material || {})) {
    kandidaten.push({ suche: klein(def.bedeutet), wert: def.bedeutet });
  }
  // 3) Materialien, die in den Dimensionstabellen vorkommen
  for (const def of Object.values(lade().dimensionen)) {
    for (const m of (def && def.gilt_fuer) || []) kandidaten.push({ suche: klein(m), wert: klein(m) });
  }

  let treffer = null;
  let laenge = 0;
  for (const k of kandidaten) {
    if (k.suche.length >= 3 && t.includes(k.suche) && k.suche.length > laenge) {
      laenge = k.suche.length; treffer = k.wert;
    }
  }
  return treffer;
}

// ────────────────────────────────────────────────────────────── Dimensionen

function zollNormalisieren(angabe) {
  const a = klein(angabe).replace(/["″]/g, '').trim();
  for (const [bruch, formen] of Object.entries(lade().dimensionen.zoll_schreibweisen || {})) {
    if (klein(bruch) === a) return bruch;
    if ((formen || []).some((f) => klein(f) === a)) return bruch;
  }
  return null;
}

// Löst eine Dimensionsangabe auf. material entscheidet, welche Tabelle gilt.
// Rückgabe: { dn, zoll, ad, tabelle } — was nicht bestimmbar ist, bleibt null.
function dimension(angabe, material = null) {
  const roh = klein(angabe);
  const leer = { dn: null, zoll: null, ad: null, tabelle: null };
  if (!roh) return leer;

  const tabellen = Object.entries(lade().dimensionen)
    .filter(([name, def]) => def && Array.isArray(def.tabelle) &&
      (!material || !def.gilt_fuer || def.gilt_fuer.map(klein).includes(klein(material))));

  // 1) ausdrückliche Zollangabe
  const zollForm = zollNormalisieren(roh) ||
    (roh.match(/(\d+\/\d+|\d+)\s*(zoll|"|″)/) ? zollNormalisieren(RegExp.$1) : null);
  if (zollForm) {
    for (const [name, def] of tabellen) {
      const z = def.tabelle.find((r) => String(r.zoll) === zollForm);
      if (z) return { dn: z.dn ?? null, zoll: zollForm, ad: z.ad ?? null, tabelle: name };
    }
    return { ...leer, zoll: zollForm };
  }

  // 2) ausdrückliche DN-Angabe
  const dnTreffer = roh.match(/dn\s*(\d+)/);
  if (dnTreffer) {
    const dn = Number(dnTreffer[1]);
    for (const [name, def] of tabellen) {
      const z = def.tabelle.find((r) => r.dn === dn);
      if (z) return { dn, zoll: z.zoll ?? null, ad: z.ad ?? null, tabelle: name };
    }
    return { ...leer, dn };
  }

  // 3) blanke Zahl — als Außendurchmesser lesen, wenn das Material das nahelegt
  const n = zahl((roh.match(/(\d+(?:[.,]\d+)?)/) || [])[1]);
  if (n === null) return leer;
  for (const [name, def] of tabellen) {
    const z = def.tabelle.find((r) => zahl(r.ad) === n);
    if (z) return { dn: z.dn ?? z.dn_etwa ?? null, zoll: z.zoll ?? null, ad: n, tabelle: name };
  }
  return { ...leer, ad: n };
}

// ──────────────────────────────────────────────────────────────── Einheiten

function einheitNormalisieren(einheit) {
  const e = klein(einheit);
  if (!e) return null;
  for (const [ziel, formen] of Object.entries(lade().einheiten.schreibweisen || {})) {
    if (klein(ziel) === e) return ziel;
    if ((formen || []).some((f) => klein(f) === e)) return ziel;
  }
  return String(einheit).trim();
}

// "1 Stange" -> 6 m. Gibt { menge, einheit, umgerechnet, hinweis } zurück.
function gebinde(menge, einheit, artikelart = null, material = null) {
  const m = zahl(menge);
  const e = klein(einheit);
  const unveraendert = { menge: m, einheit: einheitNormalisieren(einheit), umgerechnet: false, hinweis: null };
  if (m === null || !e) return unveraendert;

  for (const [name, def] of Object.entries(lade().einheiten.gebinde || {})) {
    const namen = [name, ...(def.aliasse || [])].map(klein);
    if (!namen.includes(e)) continue;
    if (def.gilt_fuer && def.gilt_fuer.length && artikelart &&
        !def.gilt_fuer.map(klein).includes(klein(artikelart))) continue;

    let je = zahl(def.je);
    if (material && def.abweichungen) {
      for (const [mat, wert] of Object.entries(def.abweichungen)) {
        if (klein(mat) === klein(material)) { je = zahl(wert); break; }
      }
    }
    if (je === null) continue;
    return {
      menge: m * je,
      einheit: def.basis,
      umgerechnet: true,
      hinweis: `${m} ${name}${m === 1 ? '' : 'n'} = ${m * je} ${def.basis}`
    };
  }
  return unveraendert;
}

// ────────────────────────────────────────────────────────────── Zulassungen

function zulassungRang(z) {
  const r = (lade().zulassungen.rangfolge || []).map(klein);
  const i = r.indexOf(klein(z));
  return i < 0 ? -1 : i;
}

// Erfüllt eine vorhandene Zulassung einen geforderten Bedarf?
function zulassungErfuellt(vorhanden, gefordert) {
  const v = zulassungRang(vorhanden);
  const g = zulassungRang(gefordert);
  if (g < 0) return true;      // nichts gefordert
  if (v < 0) return false;     // unbekannt erfüllt keinen ausdrücklichen Bedarf
  return v >= g;
}

function zulassungErkennen(text) {
  const t = klein(text);
  let treffer = null;
  let laenge = 0;
  for (const [name, def] of Object.entries(lade().zulassungen.bezeichnungen || {})) {
    for (const wort of def.erkennen_an || []) {
      const w = klein(wort);
      if (w && t.includes(w) && w.length > laenge) { laenge = w.length; treffer = name; }
    }
  }
  return treffer;
}

// ─────────────────────────────────────────────────────────────────── Regeln

function bedingungErfuellt(bedingung, merkmale) {
  return String(bedingung).split(/\s+und\s+/i).every((teil) => {
    const fehlt = teil.match(/^\s*(\w+)\s+fehlt\s*$/i);
    if (fehlt) {
      const w = merkmale[fehlt[1]];
      return w === undefined || w === null || String(w).trim() === '';
    }
    const gleich = teil.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
    if (gleich) return klein(merkmale[gleich[1]]) === klein(gleich[2]);
    return false;
  });
}

// Wendet die Regeln einer Klasse an. Gibt ergänzte Merkmale und offene
// Rückfragen zurück. Ändert das Original nicht.
function regelnAnwenden(klassenName, merkmale) {
  const def = klasse(klassenName);
  const raus = { ...merkmale };
  const nachfragen = [];
  const angewandt = [];
  if (!def) return { merkmale: raus, nachfragen, angewandt };

  for (const regel of def.regeln || []) {
    if (!bedingungErfuellt(regel.wenn, raus)) continue;
    for (const teil of String(regel.dann).split(',')) {
      const frage = teil.match(/^\s*nachfragen\s+(\w+)\s*$/i);
      if (frage) { nachfragen.push(frage[1]); angewandt.push(teil.trim()); continue; }
      const setzen = teil.match(/^\s*(\w+)\s*=\s*(.+?)\s*$/);
      if (!setzen) continue;
      const [, feld, quelle] = setzen;
      // Rechts kann ein anderes Merkmal stehen oder ein fester Wert.
      raus[feld] = raus[quelle] !== undefined ? raus[quelle] : quelle;
      angewandt.push(`${feld} = ${raus[feld]}`);
    }
  }
  return { merkmale: raus, nachfragen, angewandt };
}

// Was fehlt noch? Getrennt nach den beiden Stufen, denn sie haben
// verschiedene Folgen:
//   fehlt  Pflicht — hier wird nicht gebucht, der Bot wartet auf die Angabe
//   offen  erwartet — wird einmal gefragt, darf aber übersprungen werden
//
// Regeln laufen vorher, damit "T-Stück DN20" nicht nach dn2 und dn3 gefragt wird.
function fehlendePflicht(klassenName, merkmale) {
  const def = klasse(klassenName);
  if (!def) return { fehlt: [], offen: [], merkmale, fragen: {} };

  const { merkmale: ergaenzt, nachfragen } = regelnAnwenden(klassenName, merkmale);
  const stufen = merkmaleFuer(klassenName);
  const leer = (feld) => {
    const w = ergaenzt[feld];
    return w === undefined || w === null || String(w).trim() === '';
  };

  const fehlt = stufen.pflicht.filter(leer);
  const offen = stufen.erwartet.filter(leer);
  // Regel-Rückfragen wiegen so schwer wie Pflicht — eine Presskontur zu raten
  // ist gefährlicher, als einmal zu fragen.
  for (const feld of nachfragen) if (!fehlt.includes(feld)) fehlt.push(feld);

  const global = lade().merkmale.global || {};
  const fragen = {};
  for (const feld of [...fehlt, ...offen]) {
    fragen[feld] = (def.frage && def.frage[feld])
      || (global[feld] && global[feld].frage)
      || `Welche Angabe für „${feld}"?`;
  }
  return { fehlt, offen, merkmale: ergaenzt, fragen };
}

// ──────────────────────────────────────────────────── Kontext für die KI

// Kompakter Textblock für den Extraktions-Prompt. Bewusst knapp: das Modell
// soll die Begriffe kennen, nicht die ganze Tabelle auswendig lernen.
function promptKontext(artikelart = null) {
  const w = lade();
  const zeilen = [];

  const klassen = artikelart && w.artikelklassen[artikelart]
    ? { [artikelart]: w.artikelklassen[artikelart] }
    : w.artikelklassen;
  zeilen.push('ARTIKELARTEN (Pflichtangaben in Klammern):');
  for (const [name, def] of Object.entries(klassen)) {
    if (name === 'sonstiges') continue;
    zeilen.push(`- ${name}: ${(def.pflicht || []).join(', ')}`);
  }

  const syn = [];
  for (const eintraege of Object.values(w.synonyme || {})) {
    for (const [von, def] of Object.entries(eintraege || {})) {
      syn.push(`${von}=${def.bedeutet}`);
    }
  }
  if (syn.length) zeilen.push('\nUMGANGSSPRACHE: ' + syn.join(', '));

  const geb = Object.entries(w.einheiten.gebinde || {})
    .map(([n, d]) => `1 ${n} = ${d.je} ${d.basis}`);
  if (geb.length) zeilen.push('GEBINDE: ' + geb.join(', ') +
    ' — Gebinde NICHT selbst umrechnen, so übernehmen wie gesagt.');

  const zul = (w.zulassungen.rangfolge || []).join(' < ');
  if (zul) zeilen.push(`ZULASSUNGEN (aufsteigend): ${zul}`);

  return zeilen.join('\n');
}

// ─────────────────────────────────────────────────────────────── Dazulernen

// Hängt einen bestätigten Eintrag an gelernt.yaml an. Wird NUR nach
// ausdrücklicher Zustimmung im Chat aufgerufen — eine Wissensbasis, die
// still mitschreibt, lernt irgendwann etwas Falsches.
function lerne(eintrag) {
  const p = path.join(ORDNER, 'gelernt.yaml');
  const yaml = require('js-yaml');
  let daten = { eintraege: [] };
  if (fs.existsSync(p)) {
    try { daten = yaml.load(fs.readFileSync(p, 'utf-8')) || { eintraege: [] }; } catch { /* neu anlegen */ }
  }
  if (!Array.isArray(daten.eintraege)) daten.eintraege = [];
  daten.eintraege.push({ ...eintrag, am: new Date().toISOString().slice(0, 10) });

  const kopf = fs.existsSync(p)
    ? fs.readFileSync(p, 'utf-8').split('\n').filter((z) => z.startsWith('#')).join('\n') + '\n\n'
    : '';
  fs.mkdirSync(ORDNER, { recursive: true });
  fs.writeFileSync(p, kopf + yaml.dump(daten, { lineWidth: 100 }), 'utf-8');
  neuLaden();
  return daten.eintraege.length;
}

function gelernte() {
  return lade().gelernt.eintraege || [];
}

module.exports = {
  ORDNER, DATEIEN,
  lade, neuLaden,
  klasse, alleKlassen, klasseFuer,
  warengruppenListe, warengruppe, oberkategorien, klassenUnter, pfadVon,
  kategorieVon, klassenFuerEinsatzbereich,
  merkmalAnwendbar, merkmaleFuer, gelernteMerkmale, pruefeAnhebung,
  synonym, normalisiereText, materialErkennen,
  dimension, zollNormalisieren,
  einheitNormalisieren, gebinde,
  zulassungRang, zulassungErfuellt, zulassungErkennen,
  regelnAnwenden, fehlendePflicht,
  promptKontext,
  lerne, gelernte
};
