// 🛒 Bestellung — Vorgangs-Experte.
//
// Zeigt, was der Umbau bringt: kein Session-Handling, kein JSON-Parsing, keine
// Merge-Logik, keine Nachfrage-Texte. Nur Schema + was am Ende passiert.

const fs = require('fs');
const path = require('path');
const libPdf = require('../lib/pdf');
const material = require('../material');
const { PFADE } = require('../config');
const { KATEGORIEN } = require('../kategorien');

module.exports = {
  id: 'bestellung',
  name: 'Bestellung',
  emoji: '🛒',
  beschreibung: 'Erstellt eine Materialbestellung (Lieferant, Baustelle, Positionen, Liefertermin) als PDF und prüft dabei den Lagerbestand.',

  zustaendigWenn:
    'Der Nutzer will Material BESTELLEN oder nachbestellen: beim Großhändler ordern, ' +
    'eine Bestellliste aufgeben, "besorg mir", "bestell", "nachbestellen". ' +
    'NICHT gemeint sind Fragen nach dem vorhandenen Bestand (das ist Lagerauskunft) ' +
    'und auch nicht "ich brauche eine Anleitung" (das ist Recherche).',

  implementiert: true,

  schema: {
    lieferant: {
      pflicht: true, typ: 'text', label: 'Lieferant',
      beschreibung: 'Großhändler, z. B. GC-Gruppe, G.U.T., R&F',
      frage: 'Bei welchem Großhändler soll bestellt werden?'
    },
    baustelle: {
      pflicht: true, typ: 'text', label: 'Baustelle / Projekt',
      frage: 'Für welche Baustelle oder welches Projekt ist die Bestellung?'
    },
    liefertermin: {
      pflicht: false, typ: 'text', label: 'Liefertermin',
      beschreibung: 'Wunschtermin, z. B. "Freitag" oder "12.09."'
    },
    positionen: {
      pflicht: true, typ: 'liste', min: 1, label: 'Positionen',
      felder: {
        menge: 'zahl', einheit: 'text', bezeichnung: 'text',
        artikelnummer: 'text?', kategorie: 'text?'
      },
      frage: 'Was soll bestellt werden? (Menge + Einheit + Artikel)'
    }
  },

  extraktionsHinweise:
    '- Mengenmuster: "20m Kupferrohr", "5 Stück Eckventil", "3x Fitting DN20".\n' +
    '- Einheiten normalisieren: "Stück"/"stk" -> "Stk.", "lfm", "m", "kg".\n' +
    '- Lieferanten-Kürzel ausschreiben: "GC" -> "GC-Gruppe", "GUT" -> "G.U.T.".\n' +
    '- kategorie aus dieser Liste wählen, sonst "Sonstiges":\n    ' + KATEGORIEN.join(', ') + '\n' +
    '- Typische Diktierfehler still korrigieren.',

  async finalisiere({ chatId, daten }, dienste) {
    // Deterministischer Bestandsabgleich: was liegt schon im Lager?
    let hinweise = [];
    try {
      const bestand = await material.leseAlle(PFADE.MATERIAL_XLSX);
      for (const p of daten.positionen) {
        const treffer = material.suchePositionen(p.bezeichnung, bestand);
        if (treffer.length > 0) {
          const da = material.gesamtbestand(treffer[0]);
          if (da > 0) {
            hinweise.push(`• ${p.bezeichnung}: ${da} ${treffer[0].einheit || ''} liegen bereits im Lager`);
          }
        }
      }
    } catch (err) {
      dienste.protokoll?.('Info', `Bestandsabgleich übersprungen: ${err.message}`);
    }

    const ordner = path.join(PFADE.user(chatId), 'bestellungen');
    fs.mkdirSync(ordner, { recursive: true });
    const datum = new Date().toISOString().slice(0, 10);
    const kuerzel = String(daten.lieferant).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
    const ziel = path.join(ordner, `Bestellung_${kuerzel}_${datum}.pdf`);

    await libPdf.erstelleAufmass({
      titel: 'Bestellung',
      untertitel: `${daten.lieferant} — ${daten.baustelle}` +
        (daten.liefertermin ? ` (Liefertermin: ${daten.liefertermin})` : ''),
      projekt: { nummer: daten.baustelle, bezeichnung: daten.lieferant },
      positionen: daten.positionen.map((p) => ({
        name: p.bezeichnung, menge: p.menge,
        einheit: p.einheit, artikelnummer: p.artikelnummer
      }))
    }, ziel);

    dienste.protokoll?.('Experte', `Bestellung erzeugt (${chatId}): ${path.basename(ziel)}`);
    return {
      text: `🛒 Bestellung an *${daten.lieferant}* für ${daten.baustelle}\n` +
        `${daten.positionen.length} Position${daten.positionen.length === 1 ? '' : 'en'}` +
        (daten.liefertermin ? `, Liefertermin ${daten.liefertermin}` : '') + '.' +
        (hinweise.length ? `\n\n⚠️ Schon im Lager vorhanden:\n${hinweise.join('\n')}` : ''),
      dateien: [ziel]
    };
  }
};
