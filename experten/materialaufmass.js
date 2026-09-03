// 📐 Materialaufmaß — Vorgangs-Experte.
//
// Deklariert nur noch WAS erfasst wird (schema) und WAS am Ende passiert
// (finalisiere). Das Sammeln über mehrere Nachrichten, das Nachfragen bei
// fehlenden Angaben, das Anwenden von Korrekturen ("Position 2 auf 5") und die
// Bestätigung erledigt kern/vorgangsmotor.js für alle Experten gleich.
//
// Vorher: 639 Zeilen mit eigener Session-, JSON-, Merge- und Nachfrage-Logik.

const fs = require('fs');
const path = require('path');

const libPdf = require('../lib/pdf');
const libPdfReader = require('../lib/pdf_reader');
const libPdfFiller = require('../lib/pdf_filler');
const libUnterschrift = require('../lib/unterschrift');
const { PFADE } = require('../config');
const vorgangSpeicher = require('../kern/vorgang');

function findeVorlage() {
  if (!fs.existsSync(PFADE.VORLAGEN)) return null;
  const d = fs.readdirSync(PFADE.VORLAGEN).filter((n) => n.toLowerCase().endsWith('.pdf')).sort();
  return d.length ? path.join(PFADE.VORLAGEN, d[0]) : null;
}

// ─────────────────────────────────────────────── PDF-Erzeugung (deterministisch)

// Das Zienert-Formular erwartet die alte verschachtelte Form — hier einmal
// konvertiert, statt das Schema danach zu verbiegen.
function alsFormularDaten(daten) {
  return {
    titel: 'Materialaufmaß',
    untertitel: daten.bauvorhaben || '',
    projekt: { nummer: daten.projektnummer || '', bezeichnung: daten.bauvorhaben || '' },
    positionen: (daten.positionen || []).map((p) => ({
      name: p.bezeichnung, menge: p.menge, einheit: p.einheit,
      artikelnummer: p.artikelnummer, einzelpreis: p.einzelpreis
    }))
  };
}

// Mappt die Vorgangsdaten auf das AcroForm-Schema (231 sprechende Felder):
//   Kopf    projekt_nr, bauvorhaben, seite, seite_von
//   Zeile N pos_N, menge_N, me_N, artikelnr_N, bezeichnung_N, ep_N, gp_N
//   Fuß     datum, unterschrift_kunde, unterschrift_monteur
// ep_N/gp_N werden gerechnet, datum vorbelegt, Unterschriften bleiben leer
// (wird nach dem Druck von Hand unterschrieben).
function mappeDatenAufFelder(feldNamen, daten) {
  const map = {};
  const positionen = Array.isArray(daten.positionen) ? daten.positionen : [];

  for (const f of feldNamen) {
    if (f === 'projekt_nr') { map[f] = String(daten.projektnummer || ''); continue; }
    if (f === 'bauvorhaben') { map[f] = String(daten.bauvorhaben || ''); continue; }
    if (f === 'datum') { map[f] = new Date().toLocaleDateString('de-DE'); continue; }
    if (f === 'seite') { map[f] = '1'; continue; }
    if (f === 'seite_von') { map[f] = '1'; continue; }
    if (f === 'unterschrift_kunde' || f === 'unterschrift_monteur') { map[f] = ''; continue; }

    const m = f.match(/^(pos|menge|me|artikelnr|bezeichnung|ep|gp)_(\d+)$/);
    if (!m) continue;
    const zeile = parseInt(m[2], 10);
    const pos = positionen[zeile - 1];
    if (!pos) { map[f] = ''; continue; }

    switch (m[1]) {
      case 'pos':          map[f] = String(zeile); break;
      case 'menge':        map[f] = pos.menge != null ? String(pos.menge) : ''; break;
      case 'me':           map[f] = String(pos.einheit || ''); break;
      case 'artikelnr':    map[f] = String(pos.artikelnummer || ''); break;
      case 'bezeichnung':  map[f] = String(pos.bezeichnung || ''); break;
      case 'ep':           map[f] = pos.einzelpreis != null ? String(pos.einzelpreis) : ''; break;
      case 'gp': {
        if (pos.einzelpreis != null && pos.menge != null) {
          map[f] = (Number(pos.einzelpreis) * Number(pos.menge)).toFixed(2).replace('.', ',');
        } else { map[f] = ''; }
        break;
      }
    }
  }
  return map;
}

async function erzeugePdf(chatId, daten) {
  const ordner = path.join(PFADE.user(chatId), 'aufnahmen');
  fs.mkdirSync(ordner, { recursive: true });
  const datum = new Date().toISOString().slice(0, 10);
  const nr = String(daten.projektnummer || 'ohne-nr').replace(/[^A-Za-z0-9_-]/g, '_');
  const ziel = path.join(ordner, `Aufmass_${nr}_${datum}.pdf`);

  const vorlage = findeVorlage();
  if (vorlage && await libPdfReader.hatAcroFormFelder(vorlage)) {
    const feldNamen = await libPdfFiller.ladeFeldNamen(vorlage);
    return await libPdfFiller.fuelleFelder(vorlage, mappeDatenAufFelder(feldNamen, daten), ziel);
  }
  return await libPdf.erstelleAufmass(alsFormularDaten(daten), ziel);
}

// ──────────────────────────────────────────────────────────────── Experte

module.exports = {
  id: 'materialaufmass',
  name: 'Materialaufmaß',
  emoji: '📐',
  beschreibung: 'Erfasst ein Materialaufmaß (Projekt, Bauvorhaben, Positionen) und erzeugt daraus das ausgefüllte Aufmaß-PDF.',

  zustaendigWenn:
    'Der Nutzer will erfassen, was auf einer Baustelle verbaut/verlegt/montiert wurde, ' +
    'ein Aufmaß oder eine Mengenermittlung anlegen oder ergänzen, oder ein Aufmaß-PDF erzeugen. ' +
    'Auch: Korrekturen und Ergänzungen an einem laufenden Aufmaß.',

  implementiert: true,

  schema: {
    projektnummer: {
      pflicht: true, typ: 'text', label: 'Projektnummer',
      beschreibung: 'Formate wie PRJ-2026-001, 26-0111, 2026/123',
      frage: 'Wie lautet die Projektnummer? (z. B. 26-0111)'
    },
    bauvorhaben: {
      pflicht: true, typ: 'text', label: 'Bauvorhaben',
      beschreibung: 'Kunde oder Bauvorhaben, z. B. „Badsanierung Müller"',
      frage: 'Wie heißt das Bauvorhaben oder der Kunde?'
    },
    positionen: {
      pflicht: true, typ: 'liste', min: 1, label: 'Positionen',
      felder: {
        menge: 'zahl', einheit: 'text', bezeichnung: 'text',
        artikelnummer: 'text?', einzelpreis: 'zahl?'
      },
      beschreibung: 'Eine Zeile je verbautem Material',
      frage: 'Welche Positionen? (Menge + Einheit + Material, z. B. „12 m Kupferrohr 22mm")'
    }
  },

  extraktionsHinweise:
    '- Mengenmuster: "12m Kupferrohr", "3 Stück Wandscheibe DN20", "5x Fitting", "10 lfm Rohr".\n' +
    '- Einheiten normalisieren: "Stück"/"stk" -> "Stk.", "lfm" -> "lfm", "m" -> "m", "kg" -> "kg".\n' +
    '- Artikelnummer nur bei ausdrücklicher Nennung ("Art-Nr 12345").\n' +
    '- Material ohne Menge trotzdem aufnehmen: menge 1, einheit "Stk.".\n' +
    '- Typische Diktierfehler still korrigieren: "Kupferrhor" -> "Kupferrohr", ' +
    '"Profipressböngen" -> "Profipressbogen".',

  commands: [
    {
      name: 'aufmass',
      beschreibung: 'Zeigt alle offenen Aufmaße (pro Gesprächsfaden eines)',
      ausfuehren: async ({ chatId }) => {
        const offene = vorgangSpeicher.offeneVorgaenge(chatId)
          .filter((v) => v.experteId === 'materialaufmass');
        if (offene.length === 0) return { text: '📐 Kein offenes Aufmaß.' };
        return {
          text: '📐 *Offene Aufmaße:*\n' + offene.map((o) =>
            `• ${o.themaName} — ${o.status === 'bestaetigen' ? 'wartet auf Bestätigung' : 'sammelt noch'}`
          ).join('\n')
        };
      }
    },
    {
      name: 'aufmass_reset',
      beschreibung: 'Verwirft alle offenen Aufmaße',
      ausfuehren: async ({ chatId }) => {
        const offene = vorgangSpeicher.offeneVorgaenge(chatId)
          .filter((v) => v.experteId === 'materialaufmass');
        offene.forEach((o) => vorgangSpeicher.loesche(chatId, o.themaId));
        return { text: `📐 ${offene.length} Aufmaß-Vorgang/Vorgänge verworfen.` };
      }
    }
  ],

  // Foto mit „Unterschrift" in der Bildunterschrift wird als Unterschrift abgelegt.
  onDatei: async ({ chatId, buffer, beschriftung, mimeType }) => {
    if (!/unterschrift/i.test(String(beschriftung || ''))) return null;
    if (!String(mimeType || '').startsWith('image/')) return null;
    await libUnterschrift.speichereUnterschrift(chatId, buffer);
    return { text: '✍️ Unterschrift gespeichert. Sie wird bei künftigen PDFs verwendet.' };
  },

  async finalisiere({ chatId, daten }, dienste) {
    const pdf = await erzeugePdf(chatId, daten);
    const anzahl = (daten.positionen || []).length;
    dienste.protokoll?.('Experte', `Aufmaß-PDF erzeugt (${chatId}): ${path.basename(pdf)}`);
    return {
      text: `📐 Aufmaß *${daten.projektnummer}* — ${daten.bauvorhaben}\n` +
        `${anzahl} Position${anzahl === 1 ? '' : 'en'}. PDF ist fertig.`,
      dateien: [pdf]
    };
  },

  _intern: { mappeDatenAufFelder, findeVorlage, erzeugePdf }
};
