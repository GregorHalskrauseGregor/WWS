// 🛒 Großhandel-Bestellung — Vorgangs-Experte.
//
// Schickt eine Bestellung an einen Großhändler (GC, RNF, ...). Der WWS-Bot
// sammelt die Daten wie bei jedem anderen Vorgang; das eigentliche Klicken
// im Großhändler-Portal übernimmt der Playwright-Service auf der Hetzner-Box
// (siehe grosshandel-service/).
//
// Voraussetzungen (per .env, siehe .env.example):
//   GROSSHANDEL_SERVICE_URL    z.B. http://2.29.36.221:8787
//   GROSSHANDEL_SERVICE_TOKEN  langes Random-Passwort, identisch auf der Box
//
// Ohne diese ENV-Vars läuft der Experte nicht und meldet das auch.

const { PFADE } = require('../config');

const GUELTIGE_GROSSHAENDLER = ['GC', 'RNF'];

function serviceErreichbar() {
  return !!(process.env.GROSSHANDEL_SERVICE_URL && process.env.GROSSHANDEL_SERVICE_TOKEN);
}

async function serviceHealth() {
  if (!serviceErreichbar()) {
    return { erreichbar: false, grund: 'GROSSHANDEL_SERVICE_URL/_TOKEN nicht gesetzt' };
  }
  try {
    const r = await fetch(`${process.env.GROSSHANDEL_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return { erreichbar: false, grund: `HTTP ${r.status}` };
    const j = await r.json();
    return { erreichbar: true, ...j };
  } catch (e) {
    return { erreichbar: false, grund: e.message };
  }
}

async function sendeBestellung(job) {
  const r = await fetch(`${process.env.GROSSHANDEL_SERVICE_URL}/bestellung`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.GROSSHANDEL_SERVICE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(job),
    signal: AbortSignal.timeout(120_000)  // 2 Min pro Job
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { roh: text }; }
  return { status: r.status, ok: r.ok, body };
}

module.exports = {
  id: 'grosshandel',
  name: 'Großhandel-Bestellung',
  emoji: '🛒',
  beschreibung:
    'Schickt eine Materialbestellung an einen Großhändler (GC, RNF). ' +
    'Voraussetzung: Playwright-Service auf der Hetzner-Box ist erreichbar.',

  zustaendigWenn:
    'Der Nutzer will Material bei einem Großhändler (GC-Gruppe, RNF, ...) ' +
    'bestellen. Auslöser sind Worte wie „bestell", „bestellung", „brauche von ' +
    'GC/RNF", „schick mal an die Baustelle", „order", „Bestellung auslösen". ' +
    'Immer mit Großhändler-Name (GC/RNF) und mindestens einer Position. ' +
    '\n' +
    'NICHT hier: reine Lager-Bewegungen (Lager-Experte), Aufmaße ohne Bestellung ' +
    '(Materialaufmaß), allgemeine Fragen zum Katalog (Recherche).',

  implementiert: true,

  schema: {
    grosshaendler: {
      pflicht: true, typ: 'text', label: 'Großhändler',
      beschreibung: 'genau eines von: GC, RNF (klein geschrieben auch ok)',
      frage: 'Bei welchem Großhändler soll bestellt werden? (GC oder RNF)'
    },
    positionen: {
      pflicht: true, typ: 'liste', min: 1, label: 'Positionen',
      felder: {
        artikelnr: 'text?', menge: 'zahl', einheit: 'text?', bezeichnung: 'text'
      },
      beschreibung: 'Eine Zeile je Artikel, mit Artikelnummer wenn vorhanden',
      frage: 'Welche Positionen? (Menge + Bezeichnung, Artikelnummer wenn bekannt, z. B. „5 Kugelhähne DN20 Art-Nr 12345")'
    },
    lieferadresse: {
      typ: 'text?', label: 'Lieferadresse',
      beschreibung: 'Wohin geliefert werden soll (Baustelle oder Lager)'
    },
    bemerkung: {
      typ: 'text?', label: 'Bemerkung',
      beschreibung: 'Anmerkung für den Großhändler (Lieferzeit, Ansprechpartner, ...)'
    }
  },

  extraktionsHinweise:
    '- grosshaendler: genau eines von GC, RNF. Auch "GC-Gruppe", "gconlineplus" -> GC; ' +
    '"R+F", "Richter und Frenzel" -> RNF.\n' +
    '- Positionen: jede Zeile eine Position. "5x Kugelhahn DN20" -> menge 5, bezeichnung "Kugelhahn DN20".\n' +
    '- Artikelnr nur wenn explizit genannt ("Art-Nr 12345", "ArtNr 0815"). Sonst leer lassen.\n' +
    '- Einheit nur wenn ungewöhnlich ("lfm", "m", "Stk.", "kg"). Standard weglassen.\n' +
    '- Typische Diktier-/OCR-Fehler still korrigieren ("Kupferorhr" -> "Kupferrohr").\n' +
    '- lieferadresse: Baustelle oder "Lager", falls genannt. Sonst leer lassen.\n' +
    '- bemerkung: alles, was nicht in eine Position passt, aber für die Bestellung wichtig ist.',

  commands: [
    {
      name: 'grosshandel_status',
      beschreibung: 'Prüft, ob der Playwright-Service auf der Hetzner-Box erreichbar ist',
      ausfuehren: async () => {
        const h = await serviceHealth();
        if (!h.erreichbar) {
          return { text: `🛒 Service nicht erreichbar: ${h.grund}` };
        }
        return {
          text:
            `🛒 *Service-Status*\n` +
            `• Status: ok\n` +
            `• Browser: ${h.browser}\n` +
            `• Aktive Sessions: ${(h.contexts || []).join(', ') || 'keine'}`
        };
      }
    }
  ],

  async finalisiere({ chatId, daten }, dienste) {
    if (!serviceErreichbar()) {
      return {
        text:
          '🛒 Großhandel-Service ist nicht konfiguriert. ' +
          'Lege GROSSHANDEL_SERVICE_URL und GROSSHANDEL_SERVICE_TOKEN in der .env an ' +
          '(Wert vom Hetzner-Server).'
      };
    }

    const grosshaendler = String(daten.grosshaendler || '').toUpperCase();
    if (!GUELTIGE_GROSSHAENDLER.includes(grosshaendler)) {
      return {
        text:
          `🛒 Unbekannter Großhändler: „${daten.grosshaendler}". ` +
          `Erlaubt sind: ${GUELTIGE_GROSSHAENDLER.join(', ')}.`
      };
    }

    const job = {
      grosshaendler,
      vorgangId: `${chatId}-${Date.now()}`,
      chatId: String(chatId),
      positionen: daten.positionen,
      lieferadresse: daten.lieferadresse || '',
      bemerkung: daten.bemerkung || ''
    };

    dienste.protokoll?.('Experte',
      `Grosshandel ${grosshaendler}: ${job.positionen.length} Position(en) (${chatId})`);

    let res;
    try {
      res = await sendeBestellung(job);
    } catch (e) {
      dienste.protokoll?.('Experte', `Grosshandel-Fehler: ${e.message}`);
      return {
        text:
          `🛒 *Bestellung fehlgeschlagen*\n` +
          `Service nicht erreichbar: ${e.message}\n\n` +
          `Die Daten sind im Vorgang gespeichert — versuch es gleich nochmal.`
      };
    }

    if (!res.ok) {
      const errText = res.body && res.body.error
        ? res.body.error
        : (res.body && res.body.roh) || `HTTP ${res.status}`;
      dienste.protokoll?.('Experte', `Grosshandel-Fehler ${res.status}: ${errText}`);
      return {
        text:
          `🛒 *Bestellung fehlgeschlagen* (HTTP ${res.status})\n` +
          `${errText}\n\n` +
          `Positionen waren:\n` +
          job.positionen.map((p) => `• ${p.menge} ${p.einheit || ''} ${p.bezeichnung} ${p.artikelnr ? `(Art-Nr ${p.artikelnr})` : ''}`).join('\n')
      };
    }

    const b = res.body;
    const lines = [
      `🛒 *Bestellung an ${grosshaendler} gesendet*`,
      `Positionen: ${job.positionen.length}`,
      b.bestellnummer ? `Auftragsnr.: ${b.bestellnummer}` : null,
      b.log ? `_${b.log}_` : null
    ].filter(Boolean);

    return {
      text: lines.join('\n'),
      dateien: b.screenshot ? [b.screenshot] : []
    };
  },

  _intern: { serviceErreichbar, serviceHealth, sendeBestellung, GUELTIGE_GROSSHAENDLER }
};
