// 🔎 Lagerauskunft — Prompt-Experte mit eigenen Werkzeugen.
//
// Beantwortet Fragen zum Bestand, ohne etwas zu buchen. Die KI entscheidet, was
// gefragt ist; die Zahlen liefert ausschließlich Code über diese Werkzeuge.

const material = require('../material');
const { PFADE } = require('../config');

const laden = () => material.leseAlle(PFADE.MATERIAL_XLSX);

function beschreibePosition(p, chatId) {
  const gesamt = material.gesamtbestand(p);
  const reserviert = material.reserviertGesamt(p);
  const eigen = material.reserviertVon(p, chatId);
  const teile = [
    `${p.bezeichnung} (${p.kategorie})`,
    `Bestand ${gesamt} ${p.einheit}`,
    `neu ${p.mengeNeu || 0} / gebraucht ${p.mengeGebraucht || 0} / verschmutzt ${p.mengeVerschmutzt || 0}`
  ];
  if (reserviert > 0) {
    teile.push(`reserviert ${reserviert}` + (eigen > 0 ? ` (davon ${eigen} von dir)` : ''));
    teile.push(`für dich verfügbar ${material.verfuegbarFuer(p, chatId)}`);
  }
  if (gesamt === 0) teile.push('AKTUELL NICHT VORRÄTIG');
  return teile.join(' · ');
}

module.exports = {
  id: 'lagerauskunft',
  name: 'Lagerauskunft',
  emoji: '🔎',
  beschreibung: 'Beantwortet Fragen zum Lagerbestand: was ist da, wie viel, in welchem Zustand, was ist reserviert. Ändert nichts.',

  zustaendigWenn:
    'Der Nutzer will den LAGERBESTAND WISSEN oder NACHGUCKEN, ohne zu buchen: ' +
    '"was haben wir noch", "wie viel X ist da", "hab ich genug Y", "zeig mir alles in DN70", ' +
    '"ist das reserviert", "ist X im Lager", "gibt es X", "such im Lager nach X", ' +
    '"schau im Material nach", "guck mal im Bestand", "haben wir X auf Lager", ' +
    '"X müsste doch da sein", "warum ist X nicht da". ' +
    'Auch Rückfragen wie "aber Kupferrohr 22mm ist doch im lager" — der Nutzer will, ' +
    'dass du im Lager nachschaust, nicht im Internet. ' +
    'NICHT gemeint: Ein- und Auslagern oder Reservieren (das ist Lager) und die ' +
    'komplette Liste als Excel-Datei (das ist Lagerliste).',

  implementiert: true,

  systemPromptAdd: `LAGERAUSKUNFT AKTIV.
Du beantwortest Fragen zum Lagerbestand mit den Werkzeugen bestand_suchen, bedarf_pruefen und ganze_liste.

Regeln:
- Nutze immer ein Werkzeug. Rate NIEMALS eine Menge.
- Findet die Suche nichts, sag das klar und schlag eine andere Schreibweise vor.
- Antworte knapp: Menge, Einheit, Zustand. Bei Reservierungen sag dazu, wie viel
  davon für den Nutzer noch verfügbar ist.
- Steht eine Position auf 0, sag ausdrücklich, dass davon gerade nichts da ist —
  die Position bleibt im Lager geführt.
- Du änderst nie einen Bestand und schlägst auch keine Buchungen vor. Wenn der
  Nutzer fragt, ob etwas im Lager ist, antworte mit der aktuellen Lagermenge und
  Status, NICHT mit „soll ich es einlagern?" — das verunsichert nur, weil der
  User längst weiß, dass er buchen kann.
- Beende deine Antwort mit dem Fakt. Keine Nachfragen, keine Vorschläge zum
  Weitermachen, keine Aufforderung zum Bestätigen.
- Will der Nutzer tatsächlich buchen oder reservieren, sagt er das selbst
  („nimm 5 raus", „reservier mir 3", „füge 2 hinzu") — dann ist der lager-Experte
  zuständig, nicht du.`,

  nurEigeneTools: true,

  tools: [
    {
      name: 'bestand_suchen',
      beschreibung: 'Sucht Artikel im Lager (unscharf, DN-Schreibweise egal) und gibt Bestand, Zustand und Reservierungen zurück.',
      parameter: {
        type: 'object',
        properties: { suchbegriff: { type: 'string', description: 'Artikelname oder Teil davon, z. B. "Kupferrohr 22" oder "DN70"' } },
        required: ['suchbegriff']
      },
      ausfuehren: async ({ suchbegriff }, kontext = {}) => {
        const treffer = material.suchePositionen(suchbegriff, await laden());
        if (!treffer.length) return `Kein Treffer für "${suchbegriff}".`;
        return treffer.map((p) => beschreibePosition(p, kontext.chatId)).join('\n');
      }
    },
    {
      name: 'bedarf_pruefen',
      beschreibung: 'Prüft für eine Liste von Bedarfen, ob der verfügbare Bestand reicht. Bucht nichts.',
      parameter: {
        type: 'object',
        properties: {
          bedarfe: {
            type: 'array', description: 'Liste der benötigten Artikel',
            items: {
              type: 'object',
              properties: { bezeichnung: { type: 'string' }, menge: { type: 'number' } },
              required: ['bezeichnung', 'menge']
            }
          }
        },
        required: ['bedarfe']
      },
      ausfuehren: async ({ bedarfe }, kontext = {}) => {
        const r = material.pruefeBedarf(bedarfe || [], await laden(), kontext.chatId);
        if (!r.length) return 'Keine auswertbaren Bedarfe übergeben.';
        return r.map((x) =>
          `${x.bezeichnung}: angefragt ${x.angefragt} ${x.einheit}, Bestand ${x.bestand}, ` +
          `verfügbar ${x.verfuegbar}` + (x.reserviert ? ` (${x.reserviert} reserviert)` : '') +
          ` -> ${x.reicht ? 'reicht' : 'REICHT NICHT'}`).join('\n');
      }
    },
    {
      name: 'ganze_liste',
      beschreibung: 'Kompletter Bestand nach Kategorien. Nur nutzen, wenn wirklich alles gefragt ist — für eine Datei gibt es die Lagerliste.',
      parameter: { type: 'object', properties: {} },
      ausfuehren: async (_args, kontext = {}) => {
        const gruppen = material.ganzeListe(await laden());
        const zeilen = [];
        for (const [kat, eintraege] of Object.entries(gruppen)) {
          zeilen.push(`== ${kat} ==`);
          for (const p of eintraege) zeilen.push('  ' + beschreibePosition(p, kontext.chatId));
        }
        return zeilen.length ? zeilen.join('\n') : 'Das Lager ist leer.';
      }
    }
  ]
};
