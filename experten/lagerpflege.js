// 🛠 Lagerpflege — Vorgangs-Experte für Korrekturen am bestehenden Bestand.
//
// Abgegrenzt vom Lager-Experten: der bucht RELATIV (plus/minus), dieser hier
// ändert BESTEHENDE Zeilen — Inventurwerte absolut setzen, umbenennen,
// umkategorisieren, Einheit richtigstellen, Dubletten zusammenführen.
//
// Auch hier wird erst nach Bestätigung geschrieben, und keine Zeile verschwindet.

const material = require('../material');
const { PFADE } = require('../config');
const { KATEGORIEN } = require('../kategorien');
const wissen = require('../lib/wissen');

const AKTIONEN = {
  bestand_setzen: {
    beschreibung: 'Bestand absolut setzen (Inventur)',
    ausfuehren: (k) => material.setzeBestand(k, PFADE.MATERIAL_XLSX),
    zeile: (r) => {
      if (r.unbekannt) return `• *${r.bezeichnung}*: ⚠️ nicht gefunden`;
      if (r.abgelehnt) return `• *${r.bezeichnung}*: ⚠️ ${r.meldung}`;
      let t = `• *${r.bezeichnung}* (${r.zustand}): ${r.vorherSpalte} → ${r.nachherSpalte} ${r.einheit}`;
      if (r.andereZustaende > 0) {
        t += `\n   _andere Zustände unverändert, Gesamtbestand jetzt ${r.nachherGesamt}_`;
      }
      if (r.reservierungUeberschritten > 0) {
        t += `\n   ⚠️ Es sind mehr vorgemerkt als jetzt da sind (${r.reservierungUeberschritten} zu viel)`;
      }
      return t;
    }
  },
  umbenennen: {
    beschreibung: 'Bezeichnung ändern',
    ausfuehren: (k) => material.benenneUm(k, PFADE.MATERIAL_XLSX),
    zeile: (r) => r.unbekannt ? `• *${r.bezeichnung}*: ⚠️ nicht gefunden`
      : r.abgelehnt ? `• *${r.bezeichnung}*: ⚠️ ${r.meldung}`
      : r.unveraendert ? `• *${r.bezeichnung}*: heißt schon so`
      : `• „${r.vorher}" → *„${r.nachher}"*`
  },
  kategorie: {
    beschreibung: 'Kategorie ändern',
    ausfuehren: (k) => material.setzeKategorie(k, PFADE.MATERIAL_XLSX),
    zeile: (r) => r.unbekannt ? `• *${r.bezeichnung}*: ⚠️ nicht gefunden`
      : r.abgelehnt ? `• *${r.bezeichnung}*: ⚠️ ${r.meldung}`
      : r.unveraendert ? `• *${r.bezeichnung}*: steht schon dort`
      : `• *${r.bezeichnung}*: „${r.vorher}" → *„${r.nachher}"*`
  },
  einheit: {
    beschreibung: 'Einheit ändern',
    ausfuehren: (k) => material.setzeEinheit(k, PFADE.MATERIAL_XLSX),
    zeile: (r) => r.unbekannt ? `• *${r.bezeichnung}*: ⚠️ nicht gefunden`
      : r.unveraendert ? `• *${r.bezeichnung}*: hat schon diese Einheit`
      : `• *${r.bezeichnung}*: ${r.vorher} → *${r.nachher}*`
  },
  zusammenfuehren: {
    beschreibung: 'Doppelte Position in eine andere überführen',
    ausfuehren: (k) => material.fuehreZusammen(k, PFADE.MATERIAL_XLSX),
    zeile: (r) => r.unbekannt ? `• *${r.bezeichnung}*: ⚠️ ${r.meldung || 'nicht gefunden'}`
      : r.abgelehnt ? `• *${r.bezeichnung}*: ⚠️ ${r.meldung}`
      : `• ${r.uebernommen} ${r.einheit} nach *${r.ziel}* übernommen ` +
        `(jetzt ${r.zielBestand}); die alte Zeile bleibt mit 0 stehen`
  }
};

module.exports = {
  id: 'lagerpflege',
  name: 'Lagerpflege',
  emoji: '🛠',
  beschreibung: 'Korrigiert bestehende Lagerzeilen: Inventurbestand absolut setzen, umbenennen, Kategorie oder Einheit richtigstellen, Dubletten zusammenführen.',

  zustaendigWenn:
    'Der Nutzer will eine bestehende Lagerzeile BERICHTIGEN, ohne dass der ' +
    'Bestand verrechnet wird. Anlässe sind Inventur (eine Position hat ' +
    'einen anderen Bestand, als der Bot glaubt), falsche Bezeichnung, ' +
    'falsche Kategorie, falsche Einheit, oder zwei versehentlich getrennt ' +
    'angelegte Zeilen, die zusammengehören.\n' +
    '\n' +
    'NICHT hier: normales Ein- und Auslagern oder Reservieren (das ist Lager) — ' +
    'dort wird verrechnet, hier wird richtiggestellt. Auch keine bloße Frage, ' +
    'was in einer Position steht (Lagerauskunft).',

  implementiert: true,

  commands: [{
    name: 'wissen',
    beschreibung: 'Zeigt, was der Bot über SHK-Material weiß',
    ausfuehren: async () => {
      wissen.neuLaden();
      const klassen = wissen.alleKlassen().filter((k) => k !== 'sonstiges');
      const gelernt = wissen.gelernte();
      const zeilen = [
        '*Wissensbasis*  (Ordner `wissen/`, von Hand pflegbar)',
        '',
        `• ${klassen.length} Artikelarten: ${klassen.join(', ')}`,
        '• Umgangssprache, Maßtabellen, Gebinde und Zulassungen',
        '',
        gelernt.length
          ? `*Dazugelernt (${gelernt.length}):*\n` + gelernt.slice(-10).map((e) =>
              `• ${e.von} → ${e.nach}  _(${e.am})_`).join('\n')
          : '_Noch nichts dazugelernt. Der Bot fragt, bevor er sich etwas merkt._'
      ];
      return { text: zeilen.join('\n') };
    }
  }],

  schema: {
    aktion: {
      pflicht: true, typ: 'text', label: 'Art der Korrektur',
      beschreibung: 'genau eines von: ' + Object.keys(AKTIONEN).join(', '),
      frage: 'Was soll korrigiert werden — Bestand, Bezeichnung, Kategorie, Einheit oder eine Dublette?'
    },
    korrekturen: {
      pflicht: true, typ: 'liste', min: 1, label: 'Korrekturen',
      felder: { position: 'text', wert: 'text', zustand: 'text?' },
      beschreibung: 'position = die betroffene Zeile, wert = der neue Wert',
      frage: 'Welche Position, und was ist der richtige Wert?'
    }
  },

  extraktionsHinweise:
    '- aktion ist IMMER genau eines von: bestand_setzen, umbenennen, kategorie, einheit, zusammenfuehren.\n' +
    '- wert ist bei bestand_setzen die ZAHL, bei umbenennen der neue Name, bei kategorie\n' +
    '  die Zielkategorie, bei einheit die neue Einheit, bei zusammenfuehren die ZIELPOSITION,\n' +
    '  in die hinein zusammengeführt wird.\n' +
    '- "X und Y sind dasselbe" -> position = X (die Dublette), wert = Y (die bleibende Zeile).\n' +
    '- zustand nur bei bestand_setzen und nur wenn genannt: neu, gebraucht oder verschmutzt.\n' +
    '- Kategorien sind fest: ' + KATEGORIEN.join(', ') + '\n' +
    '- Mehrere Korrekturen derselben Art dürfen in einem Vorgang stehen (z. B. eine ganze Inventur).',

  async finalisiere({ chatId, daten }, dienste) {
    const name = String(daten.aktion || '').toLowerCase().trim();
    const aktion = AKTIONEN[name];
    if (!aktion) {
      return { text: `Unklar, was korrigiert werden soll ("${daten.aktion}"). ` +
        `Möglich: ${Object.keys(AKTIONEN).join(', ')}.` };
    }
    const ergebnisse = await aktion.ausfuehren(daten.korrekturen);
    dienste.protokoll?.('Experte', `Lagerpflege ${name}: ${ergebnisse.length} Zeile(n) (${chatId})`);
    if (!ergebnisse.length) {
      return { text: `🛠 Nichts geändert — die Positionen ließen sich nicht zuordnen.` };
    }
    return { text: `🛠 *${aktion.beschreibung}*\n${ergebnisse.map(aktion.zeile).join('\n')}` };
  },

  _intern: { AKTIONEN }
};
