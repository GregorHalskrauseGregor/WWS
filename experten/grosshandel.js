// 🛒 Großhandel-Bestellung — Vorgangs-Experte.
//
// Der Bot sammelt die Bestelldaten wie bei jedem anderen Vorgang. Das Klicken
// im Großhändler-Portal übernimmt Playwright mit echtem Chrome — und das MUSS
// auf dem Laptop laufen: GC sperrt Rechenzentrums-IPs schon auf Netzwerkebene.
//
// ══════════════════════════════════════════════════════════════════════════
// ZWEI BETRIEBSARTEN
// ══════════════════════════════════════════════════════════════════════════
//
// WARTESCHLANGE (Bot auf der Hetzner-Box, Browser auf dem Laptop)
//   Erkannt an: AGENT_TOKEN ist gesetzt.
//   Die Bestellung wird eingestellt; der Laptop-Agent holt sie ab, sobald er
//   läuft. Die Antwort kommt in zwei Teilen — erst die Bestätigung, dass der
//   Auftrag steht, später das Ergebnis per Telegram. Vorteil: bestellen geht
//   vom Handy, auch wenn der Laptop zugeklappt ist.
//
// DIREKT (alles auf demselben Rechner)
//   Erkannt an: GROSSHANDEL_SERVICE_URL + _TOKEN sind gesetzt, AGENT_TOKEN nicht.
//   Der alte Weg: HTTP-Aufruf, zwei Minuten warten, Ergebnis sofort. Bleibt
//   erhalten, damit der Laptop-Betrieb während des Umzugs weiterläuft und man
//   den Dienst einzeln testen kann.

const auftragsstelle = require('../kern/auftragsstelle');

const GUELTIGE_GROSSHAENDLER = ['GC', 'RNF'];
const AUFTRAGSART = 'bestellung';

function modus() {
  if (process.env.AGENT_TOKEN) return 'warteschlange';
  if (process.env.GROSSHANDEL_SERVICE_URL && process.env.GROSSHANDEL_SERVICE_TOKEN) return 'direkt';
  return 'aus';
}

async function serviceHealth() {
  if (!process.env.GROSSHANDEL_SERVICE_URL) {
    return { erreichbar: false, grund: 'GROSSHANDEL_SERVICE_URL nicht gesetzt' };
  }
  try {
    const r = await fetch(`${process.env.GROSSHANDEL_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5000)
    });
    if (!r.ok) return { erreichbar: false, grund: `HTTP ${r.status}` };
    return { erreichbar: true, ...(await r.json()) };
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
    signal: AbortSignal.timeout(240_000)
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { roh: text }; }
  return { status: r.status, ok: r.ok, body };
}

function positionenZeilen(positionen) {
  return (positionen || []).map((p) =>
    `• ${p.menge} ${p.einheit || ''} ${p.bezeichnung}${p.artikelnr ? ` (Art-Nr ${p.artikelnr})` : ''}`
      .replace(/\s+/g, ' ').trim()
  ).join('\n');
}

function baueJob(chatId, daten) {
  return {
    grosshaendler: String(daten.grosshaendler || '').toUpperCase(),
    vorgangId: `${chatId}-${Date.now()}`,
    chatId: String(chatId),
    positionen: daten.positionen,
    kundennummer: daten.projektnummer || daten.kundennummer || '',
    kundentext: daten.bauvorhaben || daten.kundentext || '',
    lieferadresse: daten.lieferadresse || '',
    bemerkung: daten.bemerkung || '',
    empfaenger: daten.empfaenger || daten.gc_empfaenger || ''
  };
}

module.exports = {
  id: 'grosshandel',
  name: 'Großhandel-Bestellung',
  emoji: '🛒',
  beschreibung:
    'Schickt eine Materialbestellung an einen Großhändler (GC, RNF). ' +
    'Die Browser-Navigation läuft auf dem Laptop; der Auftrag wartet, bis der da ist.',

  zustaendigWenn:
    'Der Nutzer will Material bei einem Großhändler (GC-Gruppe, RNF, ...) ' +
    'bestellen. Auslöser sind Worte wie „bestell", „bestellung", „brauche von ' +
    'GC/RNF", „schick mal an die Baustelle", „order", „Bestellung auslösen". ' +
    'Immer mit Großhändler-Name (GC/RNF) und mindestens einer Position. ' +
    '\n' +
    'NICHT hier: reine Lager-Bewegungen (Lager-Experte), Aufmaße ohne Bestellung ' +
    '(Materialaufmaß), allgemeine Fragen zum Katalog (Recherche).',

  implementiert: true,

  // Welche Auftragsarten aus der Warteschlange dieser Experte verantwortet.
  // bot.js findet darüber den Experten, der die Ergebnismeldung formuliert —
  // so bleibt der Kern frei von Fachtexten.
  auftragsarten: [AUFTRAGSART],

  schema: {
    grosshaendler: {
      pflicht: true, typ: 'text', label: 'Großhändler',
      beschreibung: 'genau eines von: GC, RNF (klein geschrieben auch ok)',
      frage: 'Bei welchem Großhändler soll bestellt werden? (GC oder RNF)'
    },
    kundennummer: {
      typ: 'text?', label: 'Projektnummer / Kundennummer',
      beschreibung: 'Wird bei GC als "Kundennummer" im Warenkorb eingetragen',
      frage: 'Welche Projektnummer / Kundennummer?'
    },
    kundentext: {
      typ: 'text?', label: 'Projektbezeichnung',
      beschreibung: 'Klartext-Bezeichnung für den Warenkorb (z. B. "Badsanierung Müller")'
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
    '- kundennummer: die Projektnummer / Vorgangsnummer, falls der Nutzer sie nennt. Sonst leer.\n' +
    '- kundentext: die Bezeichnung des Projekts / der Baustelle, falls genannt.\n' +
    '- Positionen: jede Zeile eine Position. "5x Kugelhahn DN20" -> menge 5, bezeichnung "Kugelhahn DN20".\n' +
    '- Artikelnr nur wenn explizit genannt ("Art-Nr 12345", "ArtNr 0815"). Sonst leer lassen.\n' +
    '- Einheit nur wenn ungewöhnlich ("lfm", "m", "Stk.", "kg"). Standard weglassen.\n' +
    '- Typische Diktier-/OCR-Fehler still korrigieren ("Kupferorhr" -> "Kupferrohr").\n' +
    '- lieferadresse: Baustelle oder "Lager", falls genannt. Sonst leer lassen.\n' +
    '- bemerkung: alles, was nicht in eine Position passt, aber für die Bestellung wichtig ist.',

  commands: [
    {
      name: 'grosshandel_status',
      beschreibung: 'Zeigt, ob der Laptop erreichbar ist und was in der Warteschlange liegt',
      ausfuehren: async ({ chatId }) => {
        const m = modus();
        if (m === 'aus') {
          return {
            text: '🛒 Großhandel ist nicht eingerichtet.\n\n' +
              'Auf der Box fehlt `AGENT_TOKEN` in der .env (Warteschlangen-Betrieb), ' +
              'lokal `GROSSHANDEL_SERVICE_URL` + `GROSSHANDEL_SERVICE_TOKEN` (Direktbetrieb).'
          };
        }
        if (m === 'direkt') {
          const h = await serviceHealth();
          return {
            text: h.erreichbar
              ? `🛒 *Direktbetrieb*\n• Dienst: erreichbar\n• Browser: ${h.browser}\n` +
                `• Sitzungen: ${(h.contexts || []).join(', ') || 'keine'}`
              : `🛒 *Direktbetrieb*\n• Dienst nicht erreichbar: ${h.grund}`
          };
        }

        const z = auftragsstelle.zustand();
        const a = z.agent;
        const meine = auftragsstelle.liste({ chatId, nurOffen: true, max: 5 });
        return {
          text:
            '🛒 *Warteschlangen-Betrieb*\n' +
            `• Laptop: ${a.online ? '🟢 erreichbar' : a.bekannt ? `🔴 seit ${Math.round(a.stilleSekunden / 60)} min still` : '⚪️ hat sich noch nie gemeldet'}\n` +
            // Der Agent meldet mit, ob der Playwright-Dienst bei ihm läuft.
            // Ohne den holt er bewusst nichts ab — dann liegt es nicht am Netz.
            (a.online && a.info && a.info.dienst === 'aus'
              ? `• ⚠️ Browser-Dienst auf dem Laptop läuft nicht (${a.info.grund || 'kein Grund'}).\n` +
                '  Aufträge bleiben liegen, bis er gestartet ist.\n'
              : '') +
            (a.zuletzt ? `• Zuletzt gehört: ${a.zuletzt.slice(0, 16).replace('T', ' ')}\n` : '') +
            `• Wartet: ${z.wartet} · Läuft: ${z.laeuft} · Unklar: ${z.unklar}\n` +
            (meine.length
              ? '\nDeine offenen Aufträge:\n' + meine.map((x) => `• \`${x.id}\` ${x.beschreibung} (${x.zustand})`).join('\n')
              : '\nVon dir liegt nichts offen.')
        };
      }
    },
    {
      name: 'bestellungen',
      beschreibung: 'Zeigt deine letzten Bestellaufträge und ihren Stand',
      ausfuehren: async ({ chatId }) => {
        if (modus() !== 'warteschlange') {
          return { text: '🛒 Im Direktbetrieb gibt es keine Warteschlange — jede Bestellung läuft sofort.' };
        }
        const l = auftragsstelle.liste({ chatId, max: 10 })
          .filter((a) => a.art === AUFTRAGSART);
        if (!l.length) return { text: '🛒 Noch keine Bestellaufträge.' };
        const zeichen = { wartet: '⏳', laeuft: '⚙️', fertig: '✅', fehler: '❌', unklar: '❓', abgebrochen: '🚫' };
        return {
          text: '🛒 *Deine Bestellaufträge*\n' + l.map((a) =>
            `${zeichen[a.zustand] || '·'} \`${a.id}\` ${a.beschreibung}\n` +
            `   ${a.eingestellt.slice(0, 16).replace('T', ' ')}` +
            (a.ergebnis && a.ergebnis.bestellnummer ? ` · Auftragsnr. ${a.ergebnis.bestellnummer}` : '') +
            (a.fehler ? `\n   ⚠️ ${a.fehler.slice(0, 120)}` : '')
          ).join('\n')
        };
      }
    }
  ],

  async finalisiere({ chatId, daten }, dienste) {
    const m = modus();
    if (m === 'aus') {
      return {
        text: '🛒 Großhandel ist nicht eingerichtet — die Bestellung ist im Vorgang gespeichert, ' +
          'aber es gibt keinen Weg zum Portal.\n\n' +
          'Auf der Box gehört `AGENT_TOKEN` in die .env, auf dem Laptop muss der Agent laufen.'
      };
    }

    const grosshaendler = String(daten.grosshaendler || '').toUpperCase();
    if (!GUELTIGE_GROSSHAENDLER.includes(grosshaendler)) {
      return {
        text: `🛒 Unbekannter Großhändler: „${daten.grosshaendler}". ` +
          `Erlaubt sind: ${GUELTIGE_GROSSHAENDLER.join(', ')}.`
      };
    }

    const job = baueJob(chatId, daten);
    const kurz = `${grosshaendler}, ${job.positionen.length} Position(en)` +
      (job.kundentext ? ` — ${job.kundentext}` : '');

    dienste.protokoll?.('Experte', `Grosshandel ${grosshaendler}: ${job.positionen.length} Position(en) (${chatId})`);

    // ─────────────────────────────────────────────── Warteschlangen-Betrieb
    if (m === 'warteschlange') {
      // wiederholbar bleibt FALSE: bricht der Laptop mitten in der Bestellung
      // ab, kann der Warenkorb schon stehen. Ein zweiter Versuch würde doppelt
      // bestellen. Lieber einmal nachsehen als zweimal liefern lassen.
      const auftrag = auftragsstelle.stelleEin({
        art: AUFTRAGSART,
        chatId,
        // In welchem Forum-Thema bestellt wurde — sonst käme die Rückmeldung
        // Minuten später im falschen Thema an.
        ziel: typeof dienste.antwortZiel === 'function' ? dienste.antwortZiel() : null,
        beschreibung: kurz,
        nutzlast: job,
        wiederholbar: false
      });

      const a = auftragsstelle.agentZustand();
      return {
        text:
          `🛒 *Bestellung eingestellt* — ${grosshaendler}\n` +
          positionenZeilen(job.positionen) +
          (job.kundennummer ? `\n\nKundennummer: ${job.kundennummer}` : '') +
          (job.kundentext ? `\nProjekt: ${job.kundentext}` : '') +
          '\n\n' +
          (a.online
            ? '🟢 Dein Laptop ist erreichbar — er fängt gleich an. Ich melde mich, sobald der Warenkorb steht.'
            : '🔴 Dein Laptop ist gerade nicht erreichbar. Der Auftrag bleibt liegen und läuft automatisch, ' +
              'sobald du ihn wieder anmachst. Ich melde mich dann.') +
          `\n\n_Auftrag \`${auftrag.id}\` · Stand jederzeit mit /bestellungen_`
      };
    }

    // ─────────────────────────────────────────────────────── Direktbetrieb
    let res;
    try {
      res = await sendeBestellung(job);
    } catch (e) {
      dienste.protokoll?.('Experte', `Grosshandel-Fehler: ${e.message}`);
      return {
        text: `🛒 *Bestellung fehlgeschlagen*\nDienst nicht erreichbar: ${e.message}\n\n` +
          'Die Daten sind im Vorgang gespeichert — versuch es gleich nochmal.'
      };
    }

    if (!res.ok) {
      const errText = (res.body && (res.body.error || res.body.roh)) || `HTTP ${res.status}`;
      dienste.protokoll?.('Experte', `Grosshandel-Fehler ${res.status}: ${errText}`);
      return {
        text: `🛒 *Bestellung fehlgeschlagen* (HTTP ${res.status})\n${errText}\n\n` +
          `Positionen waren:\n${positionenZeilen(job.positionen)}`
      };
    }

    const b = res.body;
    return {
      text: [
        `🛒 *Warenkorb an ${grosshaendler} erstellt*`,
        `Positionen: ${job.positionen.length}`,
        b.bestellnummer ? `Auftragsnr.: ${b.bestellnummer}` : null,
        b.log ? `_${b.log}_` : null
      ].filter(Boolean).join('\n'),
      dateien: b.screenshot ? [b.screenshot] : []
    };
  },

  // Wird von bot.js gerufen, wenn der Laptop ein Ergebnis zurückgemeldet hat
  // (oder wenn er sich während eines Auftrags verabschiedet hat). Der Fachtext
  // gehört hierher, nicht in den Kern.
  auftragsMeldung(auftrag) {
    const e = auftrag.ergebnis || {};
    const g = (auftrag.nutzlast && auftrag.nutzlast.grosshaendler) || '';
    const dateien = Array.isArray(e.dateien) ? e.dateien : [];

    if (auftrag.zustand === 'fertig') {
      return {
        text: [
          `✅ *Warenkorb an ${g} steht*`,
          auftrag.beschreibung,
          e.bestellnummer ? `Auftragsnr.: ${e.bestellnummer}` : null,
          e.log ? `_${e.log}_` : null,
          `\n_Auftrag \`${auftrag.id}\`_`
        ].filter(Boolean).join('\n'),
        dateien
      };
    }

    if (auftrag.zustand === 'unklar') {
      // Zwei Wege führen hierher: der Laptop ist während der Ausführung
      // verstummt (dann kennen wir keinen Grund), oder er hat gemeldet, dass es
      // NACH dem Anlegen des Warenkorbs schiefging. Im zweiten Fall wissen wir
      // mehr und sollen das auch sagen, statt die pauschale Zeile zu zeigen.
      return {
        text:
          `❓ *Bestellung an ${g} — Stand unklar*\n` +
          `${auftrag.beschreibung}\n\n` +
          (auftrag.fehler
            ? `${auftrag.fehler}\n\nDer Warenkorb kann zu diesem Zeitpunkt schon angelegt gewesen sein.\n\n`
            : 'Der Laptop hat sich mitten in der Ausführung nicht mehr gemeldet. Von hier aus ' +
              'lässt sich nicht sagen, ob der Warenkorb angelegt wurde.\n\n') +
          '*Bitte im Portal nachsehen*, bevor du neu bestellst — sonst liegt die Ware am Ende doppelt da. ' +
          'Ist nichts angekommen, schick die Bestellung einfach nochmal.\n\n' +
          `_Auftrag \`${auftrag.id}\`_`,
        dateien
      };
    }

    return {
      text:
        `❌ *Bestellung an ${g} fehlgeschlagen*\n` +
        `${auftrag.beschreibung}\n\n` +
        `${auftrag.fehler || 'Kein Grund übermittelt.'}\n\n` +
        'Die Positionen stehen noch im Vorgang — du kannst es direkt nochmal versuchen.\n\n' +
        `_Auftrag \`${auftrag.id}\`_`,
      dateien
    };
  },

  _intern: { modus, serviceHealth, sendeBestellung, baueJob, GUELTIGE_GROSSHAENDLER, AUFTRAGSART }
};
