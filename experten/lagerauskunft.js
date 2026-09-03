// 🔎 Lagerauskunft — Prompt-Experte mit eigenen Werkzeugen.
//
// Hier zahlt sich kern/werkzeuge.js aus: der Experte bringt drei eigene Tools
// mit, die die KI im Gespräch aufrufen darf. Damit ist der Lagerbestand per
// normaler Ansprache erreichbar, ohne dass irgendein Ablauf fest verdrahtet ist —
// "was hab ich in DN70?", "reicht das für 12 Meter?", "zeig mir die Pumpen".
//
// Nur lesend: dieser Experte ändert nie einen Bestand.

const material = require('../material');
const { PFADE } = require('../config');

const laden = () => material.leseAlle(PFADE.MATERIAL_XLSX);

module.exports = {
  id: 'lagerauskunft',
  name: 'Lagerauskunft',
  emoji: '🔎',
  beschreibung: 'Beantwortet Fragen zum Lagerbestand: was ist da, wie viel, in welchem Zustand. Ändert nichts.',

  zustaendigWenn:
    'Der Nutzer FRAGT nach dem Lagerbestand, ohne etwas zu buchen: "was haben wir noch", ' +
    '"wie viel X ist da", "hab ich genug Y", "zeig mir alles in DN70", "was liegt in Kategorie Z". ' +
    'NICHT gemeint sind Entnahmen, Rückgaben oder Bestellungen — die ändern den Bestand.',

  implementiert: true,

  systemPromptAdd: `LAGERAUSKUNFT AKTIV.
Du beantwortest Fragen zum Lagerbestand mit den Werkzeugen bestand_suchen, bedarf_pruefen und ganze_liste.

Regeln:
- Nutze immer ein Werkzeug, statt Bestände zu raten. Rate NIEMALS eine Menge.
- Findet die Suche nichts, sag das klar und schlag eine andere Schreibweise vor.
- Antworte kurz: Menge, Einheit, Zustand. Keine langen Erklärungen.
- Du änderst nie einen Bestand. Will der Nutzer buchen, sag ihm, er soll die
  Entnahme oder Rückgabe direkt formulieren.`,

  // Nur die eigenen Werkzeuge — Web-Suche hat hier nichts zu suchen.
  nurEigeneTools: true,

  tools: [
    {
      name: 'bestand_suchen',
      beschreibung: 'Sucht Artikel im Lager (unscharf, DN-Schreibweisen egal) und gibt Bestand je Zustand zurück.',
      parameter: {
        type: 'object',
        properties: { suchbegriff: { type: 'string', description: 'Artikelname oder Teil davon, z. B. "Kupferrohr 22" oder "DN70"' } },
        required: ['suchbegriff']
      },
      ausfuehren: async ({ suchbegriff }) => {
        const treffer = material.suchePositionen(suchbegriff, await laden());
        if (treffer.length === 0) return `Kein Treffer für "${suchbegriff}".`;
        return treffer.map((p) =>
          `${p.bezeichnung} (${p.kategorie}): neu ${p.mengeNeu || 0}, gebraucht ${p.mengeGebraucht || 0}, ` +
          `verschmutzt ${p.mengeVerschmutzt || 0} ${p.einheit || ''} — gesamt ${material.gesamtbestand(p)}`
        ).join('\n');
      }
    },
    {
      name: 'bedarf_pruefen',
      beschreibung: 'Prüft für eine Liste von Bedarfen, ob der Bestand reicht. Ändert nichts.',
      parameter: {
        type: 'object',
        properties: {
          bedarfe: {
            type: 'array',
            description: 'Liste der benötigten Artikel',
            items: {
              type: 'object',
              properties: {
                bezeichnung: { type: 'string' },
                menge: { type: 'number' }
              },
              required: ['bezeichnung', 'menge']
            }
          }
        },
        required: ['bedarfe']
      },
      ausfuehren: async ({ bedarfe }) => {
        const ergebnis = material.pruefeBedarf(bedarfe || [], await laden());
        return JSON.stringify(ergebnis);
      }
    },
    {
      name: 'ganze_liste',
      beschreibung: 'Gibt den kompletten Lagerbestand nach Kategorien gruppiert zurück. Nur nutzen, wenn wirklich alles gefragt ist.',
      parameter: { type: 'object', properties: {} },
      ausfuehren: async () => {
        const liste = material.ganzeListe(await laden());
        return typeof liste === 'string' ? liste : JSON.stringify(liste);
      }
    }
  ]
};
