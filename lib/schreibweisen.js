// Schreibweisen-Abgleich — die Antwort auf die teuerste Frage des ganzen Lagers:
// Ist das eine NEUE Zeile oder eine BESTEHENDE?
//
// Beides falsch zu beantworten kostet Geld. Faelschlich dieselbe Zeile: der
// Bestand stimmt nicht mehr, und niemand merkt es, bis jemand vor dem Regal
// steht. Faelschlich eine neue Zeile: derselbe Artikel steht dreimal in der
// Liste, jedes Mal mit ein bisschen anderer Schreibweise, und die Suche findet
// immer nur eins davon.
//
// ARBEITSTEILUNG (dieselbe wie ueberall im Programm):
//   Die KI deutet   — sie weiss aus der Wissensbasis, dass Messing hier Rotguss
//                     heisst und eine Stange 6 m hat. Sie liefert die Bezeichnung
//                     und, wenn sie mehrere fuer moeglich haelt, Alternativen.
//   Der Code zaehlt — er vergleicht mit dem, was WIRKLICH in der Excel steht,
//                     und sagt, worin sich Eingabe und Bestand unterscheiden.
//
// DIE REGEL, nach der entschieden wird:
//   gleicher Informationsgehalt          -> bestehende Schreibweise nehmen
//   die Eingabe weiss MEHR (neue Angabe) -> neue Zeile, die alte bleibt
//   die Eingabe weiss WENIGER            -> nachfragen, nie stillschweigend raten
//
// Der dritte Fall ist der wichtige. "Kugelhahn DN25" auf eine bestehende Zeile
// "Kugelhahn DN25 Trinkwasser" zu buchen hiesse anzunehmen, es sei derselbe
// Artikel — dabei ist die Zulassung genau das, was beim Kugelhahn den
// Unterschied macht.

const material = require('../material');

// Woerter, die keinen Informationsgehalt tragen und deshalb beim Vergleich
// nicht als "zusaetzliche Angabe" zaehlen duerfen.
const FUELLWOERTER = new Set(['der', 'die', 'das', 'ein', 'eine', 'und', 'mit', 'fuer', 'für',
  'von', 'aus', 'stk', 'stück', 'stueck', 'x', 'ca', 'ungefähr', 'ungefaehr']);

function zerlege(bezeichnung) {
  const norm = material.normalisiereFuerVergleich(bezeichnung);
  const tokens = norm.split(' ').filter(Boolean);
  return {
    norm,
    zahlen: new Set(tokens.filter((t) => /\d/.test(t))),
    woerter: new Set(tokens.filter((t) => !/\d/.test(t) && !FUELLWOERTER.has(t)))
  };
}

function differenz(a, b) {
  return [...a].filter((x) => !b.has(x));
}

// Wie stark ueberlappen sich zwei Bezeichnungen? 0 = nichts gemeinsam.
// Kennzahlen wiegen schwerer als Woerter: "DN25" trennt Artikel zuverlaessiger
// als "Kugelhahn", das auf zwanzig Zeilen steht.
function naehe(x, y) {
  const zGleich = [...x.zahlen].filter((z) => y.zahlen.has(z)).length;
  const wGleich = [...x.woerter].filter((w) => y.woerter.has(w)).length;
  const zMax = Math.max(x.zahlen.size, y.zahlen.size);
  const wMax = Math.max(x.woerter.size, y.woerter.size);
  if (!zMax && !wMax) return 0;
  // Eine abweichende Kennzahl ist ein Ausschlusskriterium, keine Abwertung:
  // DN25 und DN40 sind nie derselbe Artikel, egal wie aehnlich der Rest klingt.
  const zFehl = differenz(x.zahlen, y.zahlen).length + differenz(y.zahlen, x.zahlen).length;
  if (zMax && zFehl && zGleich === 0) return 0;
  return (zGleich * 2 + wGleich) / (zMax * 2 + wMax || 1);
}

// Der Kern: eine gewuenschte Bezeichnung gegen den echten Bestand halten.
//
// alternativen: andere Schreibweisen, die die KI fuer gleichbedeutend haelt
// ("Rotguss" fuer "Messing"). Der Code kennt keine Synonyme mehr — die kommen
// aus der Wissensbasis und damit von der KI.
function pruefe(bestand, bezeichnung, alternativen = []) {
  const kandidatenTexte = [bezeichnung, ...(alternativen || [])].filter(Boolean);
  const eingaben = kandidatenTexte.map(zerlege);

  const bewertet = [];
  for (const zeile of bestand || []) {
    const z = zerlege(zeile.bezeichnung);
    let beste = null;
    for (const e of eingaben) {
      const n = naehe(e, z);
      if (n > 0 && (!beste || n > beste.n)) beste = { n, e };
    }
    if (!beste) continue;

    const eingabeMehr = [...differenz(beste.e.zahlen, z.zahlen), ...differenz(beste.e.woerter, z.woerter)];
    const zeileMehr = [...differenz(z.zahlen, beste.e.zahlen), ...differenz(z.woerter, beste.e.woerter)];

    bewertet.push({
      bezeichnung: zeile.bezeichnung,
      kategorie: zeile.kategorie,
      einheit: zeile.einheit,
      bestand: material.gesamtbestand(zeile),
      naehe: Math.round(beste.n * 100) / 100,
      eingabeMehr,
      zeileMehr
    });
  }

  bewertet.sort((a, b) => b.naehe - a.naehe);
  const treffer = bewertet.filter((b) => b.naehe >= 0.5).slice(0, 5);

  if (!treffer.length) {
    return {
      urteil: 'neu',
      empfehlung: bezeichnung,
      begruendung: 'Keine vergleichbare Zeile im Bestand. Das wird eine neue Position.',
      kandidaten: bewertet.slice(0, 3)
    };
  }

  const top = treffer[0];

  if (!top.eingabeMehr.length && !top.zeileMehr.length) {
    return {
      urteil: 'identisch',
      empfehlung: top.bezeichnung,
      begruendung: `Gleicher Informationsgehalt wie die bestehende Zeile. Nimm exakt „${top.bezeichnung}“.`,
      kandidaten: treffer
    };
  }

  if (top.eingabeMehr.length && !top.zeileMehr.length) {
    return {
      urteil: 'neu_praeziser',
      empfehlung: bezeichnung,
      begruendung: `Die Eingabe nennt zusätzlich: ${top.eingabeMehr.join(', ')}. ` +
        `Das ist eine neue Position — „${top.bezeichnung}“ bleibt daneben bestehen.`,
      kandidaten: treffer
    };
  }

  if (top.zeileMehr.length && !top.eingabeMehr.length) {
    return {
      urteil: 'unklar_ungenauer',
      empfehlung: null,
      begruendung: `Die bestehende Zeile „${top.bezeichnung}“ nennt zusätzlich: ${top.zeileMehr.join(', ')}. ` +
        'Frag nach, ob dasselbe gemeint ist — oder ob eine Variante ohne diese Angabe eingelagert wird.',
      kandidaten: treffer
    };
  }

  return {
    urteil: 'unklar_abweichend',
    empfehlung: null,
    begruendung: `Eingabe und „${top.bezeichnung}“ weichen beidseitig ab ` +
      `(Eingabe: ${top.eingabeMehr.join(', ')} / Zeile: ${top.zeileMehr.join(', ')}). Frag nach.`,
    kandidaten: treffer
  };
}

// Was vor der Extraktion in den Prompt geht: die Zeilen, die zum Text ueberhaupt
// passen koennten. Nicht der ganze Bestand — bei tausend Positionen waere das
// der teuerste Prompt des Programms.
function kandidatenFuerText(bestand, text, max = 20) {
  const t = zerlege(text || '');
  if (!t.zahlen.size && !t.woerter.size) return [];
  return (bestand || [])
    .map((zeile) => ({ zeile, n: naehe(t, zerlege(zeile.bezeichnung)) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, max)
    .map((x) => x.zeile);
}

function alsPromptBlock(zeilen) {
  if (!zeilen || !zeilen.length) return '';
  return 'BESTEHENDE SCHREIBWEISEN IM LAGER (Auszug, passend zu dieser Nachricht):\n' +
    zeilen.map((z) => `  „${z.bezeichnung}“  [${z.kategorie}, ${z.einheit}]`).join('\n') + '\n\n' +
    'SO ENTSCHEIDEST DU, WIE DU DIE POSITION SCHREIBST:\n' +
    '- Sagt die Eingabe DASSELBE wie eine dieser Zeilen (auch wenn anders formuliert —\n' +
    '  Messing/Rotguss, 22er/22mm, halb Zoll/DN15): nimm die bestehende Schreibweise ZEICHENGENAU.\n' +
    '- Nennt die Eingabe etwas ZUSÄTZLICHES (Zulassung, Material, Presssystem, Marke):\n' +
    '  dann ist es eine NEUE Position. Schreib sie vollständig aus, die alte bleibt daneben.\n' +
    '- Nennt die bestehende Zeile etwas, das in der Eingabe FEHLT: nicht raten, nachfragen.\n' +
    '  Ein "Kugelhahn DN25" ist nicht automatisch der "Kugelhahn DN25 Trinkwasser".\n';
}

// Die lesbare Fassung fuer Menschen. Kein Prompt-Material — dafuer ist sie zu
// gross — sondern ein Nachschlagedokument, das zeigt, welche Schreibweisen sich
// im Lager eingebuergert haben.
function alsMarkdown(bestand) {
  const nachKategorie = new Map();
  for (const z of bestand || []) {
    const k = z.kategorie || 'Sonstiges';
    if (!nachKategorie.has(k)) nachKategorie.set(k, []);
    nachKategorie.get(k).push(z);
  }
  const zeilen = [
    '# Schreibweisen im Lager',
    '',
    '**Diese Datei wird erzeugt, nicht gepflegt.** Sie wird nach jeder Buchung neu aus',
    '`data/material.xlsx` geschrieben. Änderungen hier gehen beim nächsten Mal verloren —',
    'wenn eine Schreibweise falsch ist, benenn die Position im Chat um.',
    '',
    'Sie ist auch keine Wissenskarte: sie geht nie am Stück in einen Prompt. Vor jeder',
    'Erfassung sucht der Bot die paar Zeilen heraus, die zur Nachricht passen, und legt',
    'nur die vor.',
    '',
    `Stand: ${new Date().toISOString().slice(0, 10)} · ${(bestand || []).length} Positionen`,
    ''
  ];
  for (const [kategorie, liste] of nachKategorie) {
    zeilen.push(`## ${kategorie}`);
    for (const z of liste.sort((a, b) => String(a.bezeichnung).localeCompare(String(b.bezeichnung), 'de'))) {
      zeilen.push(`- ${z.bezeichnung}  _(${z.einheit})_`);
    }
    zeilen.push('');
  }
  return zeilen.join('\n');
}

module.exports = { pruefe, kandidatenFuerText, alsPromptBlock, alsMarkdown, _zerlege: zerlege, _naehe: naehe };
